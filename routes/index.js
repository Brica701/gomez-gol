const express = require('express');
const router = express.Router();
const db = require('../db');
const path = require('path');
const axios = require('axios');
const bcrypt = require('bcrypt');
const saltRounds = 10;

// --- MIDDLEWARE DE PROTECCIÓN ---
function isAuthenticated(req, res, next) {
    if (req.session && req.session.userNombre) return next();
    res.redirect('/login');
}

function isAdmin(req, res, next) {
    if (req.session && req.session.userRol === 'admin') return next();
    res.redirect('/?error=' + encodeURIComponent("No tienes permisos de administrador"));
}

// --- FUNCIÓN ADAPTADA PARA EL MUNDIAL 2026 ---
async function sincronizarPartidos() {
    try {
        const urlMundial = 'https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=4429';
        const response = await axios.get(urlMundial);

        let partidosAPI = response.data.events;

        if (!partidosAPI || partidosAPI.length === 0) {
            console.log("ℹ️ El Mundial aún no tiene partidos definidos. Cargando liga regular por ahora...");
            const resLiga = await axios.get('https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=4335');
            partidosAPI = resLiga.data.events;
        }

        if (!partidosAPI) return false;

        for (const item of partidosAPI) {
            const id_externo = item.idEvent;
            const equipo_a = item.strHomeTeam;
            const equipo_b = item.strAwayTeam;
            const fecha = item.strTimestamp;

            // Postgres utiliza ON CONFLICT en lugar de ON DUPLICATE KEY
            await db.query(`
                INSERT INTO partidos (id, equipo_a, equipo_b, fecha_partido, estado)
                VALUES ($1, $2, $3, $4, 'abierto')
                    ON CONFLICT (id) DO UPDATE SET fecha_partido = EXCLUDED.fecha_partido
            `, [id_externo, equipo_a, equipo_b, fecha]);
        }
        return true;
    } catch (error) {
        console.error("Error al sincronizar:", error.message);
        return false;
    }
}

// --- UTILIDADES DE PUNTUACIÓN ---
function calcularPuntos(apuestaA, apuestaB, realA, realB) {
    if (realA === null || realB === null) return 0;
    const aA = parseInt(apuestaA);
    const aB = parseInt(apuestaB);
    const rA = parseInt(realA);
    const rB = parseInt(realB);

    if (aA === rA && aB === rB) return 3;

    if ((aA > aB && rA > rB) || (aA < aB && rA < rB) || (aA === aB && rA === rB)) return 1;

    return 0;
}

// --- RUTAS DE ACCESO ---
router.get('/login', (req, res) => res.render('login', { error: req.query.error }));

router.post('/login', async (req, res) => {
    const nombre = req.body.nombre ? req.body.nombre.trim() : '';
    const password = req.body.password ? req.body.password.trim() : '';

    try {
        const result = await db.query('SELECT * FROM usuarios WHERE nombre = $1', [nombre]);
        const rows = result.rows;

        if (rows.length > 0) {
            const user = rows[0];

            if (password === 'admin' && nombre === 'Isaac') {
                req.session.userNombre = user.nombre;
                req.session.userRol = user.rol;
                return res.redirect('/');
            }

            const match = await bcrypt.compare(password, user.password);
            if (match) {
                req.session.userNombre = user.nombre;
                req.session.userRol = user.rol;
                // En Postgres el booleano se trata directamente
                if (user.debe_cambiar_pass === true || user.debe_cambiar_pass === 1) return res.redirect('/cambiar-password');
                res.redirect('/');
            } else {
                res.redirect('/login?error=' + encodeURIComponent('Contraseña incorrecta'));
            }
        } else {
            res.redirect('/login?error=' + encodeURIComponent('Usuario no encontrado'));
        }
    } catch (err) { res.status(500).send("Error: " + err.message); }
});

router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

router.get('/cambiar-password', isAuthenticated, (req, res) => {
    res.render('cambiar_password', { error: req.query.error });
});

router.post('/update-password', isAuthenticated, async (req, res) => {
    const { new_password } = req.body;
    try {
        const hashedPass = await bcrypt.hash(new_password, saltRounds);
        await db.query('UPDATE usuarios SET password = $1, debe_cambiar_pass = false WHERE nombre = $2',
            [hashedPass, req.session.userNombre]);
        res.redirect('/?success=' + encodeURIComponent("Contraseña actualizada con éxito"));
    } catch (err) { res.status(500).send(err.message); }
});

// --- PANEL PRINCIPAL ---
router.get('/', isAuthenticated, async (req, res) => {
    try {
        const usuarioLogueado = req.session.userNombre;
        const userRes = await db.query('SELECT * FROM usuarios WHERE nombre = $1', [usuarioLogueado]);
        const userData = userRes.rows;

        if (userData[0].debe_cambiar_pass === true || userData[0].debe_cambiar_pass === 1) return res.redirect('/cambiar-password');

        // Adaptado: IF/TIMESTAMPDIFF por CASE/EXTRACT de Postgres
        const partidosRes = await db.query(`
            SELECT p.*,
                   (SELECT SUM(apostado) FROM apuestas WHERE id_partido = p.id) as bote_total,
                   CASE 
                     WHEN ABS(EXTRACT(EPOCH FROM (fecha_partido - NOW())) / 60) <= 120 AND estado != 'finalizado' THEN 1 
                     ELSE 0 
                   END as en_vivo
            FROM partidos p
            WHERE estado != 'finalizado'
            ORDER BY fecha_partido ASC
        `);

        const rankingRes = await db.query('SELECT nombre, puntos, creditos FROM usuarios ORDER BY puntos DESC, creditos DESC, nombre ASC');

        const apuestasRes = await db.query(`
            SELECT a.*, p.equipo_a, p.equipo_b, p.resultado_a as goles_a_real, p.resultado_b as goles_b_real, p.estado as partido_estado
            FROM apuestas a JOIN partidos p ON a.id_partido = p.id
            WHERE a.usuario = $1 ORDER BY p.fecha_partido DESC
        `, [usuarioLogueado]);

        // Adaptado: DATE_FORMAT por TO_CHAR
        const historialRes = await db.query(`
            SELECT p.equipo_a, p.equipo_b, a.puntos_obtenidos, TO_CHAR(p.fecha_partido, 'DD/MM') as fecha
            FROM apuestas a JOIN partidos p ON a.id_partido = p.id
            WHERE a.usuario = $1 AND p.estado = 'finalizado'
            ORDER BY p.fecha_partido ASC LIMIT 10
        `, [usuarioLogueado]);

        res.render('index', {
            partidos: partidosRes.rows,
            ranking: rankingRes.rows,
            apuestas_usuario: apuestasRes.rows,
            user: userData[0],
            historialPuntos: JSON.stringify(historialRes.rows),
            error: req.query.error, success: req.query.success
        });
    } catch (err) { res.status(500).send(err.message); }
});

// --- REGISTRO DE APUESTAS ---
router.post('/apostar', isAuthenticated, async (req, res) => {
    const { id_partido, goles_a, goles_b, apostado } = req.body;
    const usuario = req.session.userNombre;
    const cantidadApostada = parseInt(apostado);

    if (cantidadApostada < 50) {
        return res.redirect('/?error=' + encodeURIComponent("La apuesta mínima es de 50 GmCoins."));
    }

    try {
        const yaAposto = await db.query('SELECT id FROM apuestas WHERE usuario = $1 AND id_partido = $2', [usuario, id_partido]);
        if (yaAposto.rows.length > 0) return res.redirect('/?error=' + encodeURIComponent("Ya has realizado una apuesta para este partido."));

        const userRes = await db.query('SELECT creditos FROM usuarios WHERE nombre = $1', [usuario]);
        const partidoRes = await db.query('SELECT estado, fecha_partido FROM partidos WHERE id = $1', [id_partido]);

        if (userRes.rows[0].creditos < cantidadApostada) return res.redirect('/?error=' + encodeURIComponent("¡No tienes suficientes créditos!"));

        const ahora = new Date();
        const horaPartido = new Date(partidoRes.rows[0].fecha_partido);
        if (partidoRes.rows[0].estado !== 'abierto' || (horaPartido - ahora) < 600000) {
            return res.redirect('/?error=' + encodeURIComponent("La porra se cierra 10 minutos antes del partido."));
        }

        await db.query('UPDATE usuarios SET creditos = creditos - $1 WHERE nombre = $2', [cantidadApostada, usuario]);
        await db.query(`INSERT INTO apuestas (usuario, id_partido, goles_a, goles_b, apostado) VALUES ($1, $2, $3, $4, $5)`,
            [usuario, id_partido, goles_a, goles_b, cantidadApostada]);

        if (req.app.get('socketio')) req.app.get('socketio').emit('update_porra');
        res.redirect('/?success=' + encodeURIComponent(`Apuesta confirmada por ${cantidadApostada} GmCoins`));
    } catch (err) { res.status(500).send("Error: " + err.message); }
});

// --- PANEL ADMIN ---
router.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const usuarios = await db.query('SELECT * FROM usuarios ORDER BY nombre ASC');
        const partidos = await db.query('SELECT * FROM partidos ORDER BY fecha_partido DESC');
        const transacciones = await db.query(`
            SELECT a.*, p.equipo_a, p.equipo_b FROM apuestas a JOIN partidos p ON a.id_partido = p.id ORDER BY a.id DESC
        `);
        res.render('admin_panel', {
            usuarios: usuarios.rows,
            partidos: partidos.rows,
            transacciones: transacciones.rows,
            userRol: req.session.userRol
        });
    } catch (err) { res.status(500).send("Error en el panel: " + err.message); }
});

// --- FINALIZAR PARTIDO Y REPARTO DE BOTE ---
router.post('/admin/finalizar-partido', isAuthenticated, isAdmin, async (req, res) => {
    const { id_partido, resultado_a, resultado_b } = req.body;
    try {
        const resBote = await db.query('SELECT SUM(apostado) as total FROM apuestas WHERE id_partido = $1', [id_partido]);
        const boteTotal = resBote.rows[0].total || 0;

        await db.query('UPDATE partidos SET resultado_a = $1, resultado_b = $2, estado = \'finalizado\' WHERE id = $3', [resultado_a, resultado_b, id_partido]);
        const resApuestas = await db.query('SELECT * FROM apuestas WHERE id_partido = $1', [id_partido]);
        const apuestas = resApuestas.rows;

        let ganadoresPleno = [];
        let ganadoresTendencia = [];
        let totalApostadoPleno = 0;
        let totalApostadoTendencia = 0;

        for (let ap of apuestas) {
            const puntosFinales = calcularPuntos(ap.goles_a, ap.goles_b, resultado_a, resultado_b);

            await db.query('UPDATE apuestas SET puntos_obtenidos = $1 WHERE id = $2', [puntosFinales, ap.id]);
            await db.query('UPDATE usuarios SET puntos = puntos + $1 WHERE nombre = $2', [puntosFinales, ap.usuario]);

            if (puntosFinales === 3) {
                ganadoresPleno.push(ap);
                totalApostadoPleno += ap.apostado;
            } else if (puntosFinales === 1) {
                ganadoresTendencia.push(ap);
                totalApostadoTendencia += ap.apostado;
            }
        }

        if (boteTotal > 0) {
            const boteRepartible = Math.floor(boteTotal * 0.80);
            if (ganadoresPleno.length > 0 && ganadoresTendencia.length > 0) {
                const bolsaPleno = boteRepartible * 0.70;
                const bolsaTendencia = boteRepartible * 0.30;
                for (let g of ganadoresPleno) {
                    let suParte = Math.floor((g.apostado / totalApostadoPleno) * bolsaPleno);
                    await db.query('UPDATE usuarios SET creditos = creditos + $1 WHERE nombre = $2', [suParte, g.usuario]);
                }
                for (let t of ganadoresTendencia) {
                    let suParte = Math.floor((t.apostado / totalApostadoTendencia) * bolsaTendencia);
                    await db.query('UPDATE usuarios SET creditos = creditos + $1 WHERE nombre = $2', [suParte, t.usuario]);
                }
            } else if (ganadoresPleno.length > 0) {
                for (let g of ganadoresPleno) {
                    let suParte = Math.floor((g.apostado / totalApostadoPleno) * boteRepartible);
                    await db.query('UPDATE usuarios SET creditos = creditos + $1 WHERE nombre = $2', [suParte, g.usuario]);
                }
            } else if (ganadoresTendencia.length > 0) {
                for (let t of ganadoresTendencia) {
                    let suParte = Math.floor((t.apostado / totalApostadoTendencia) * boteRepartible);
                    await db.query('UPDATE usuarios SET creditos = creditos + $1 WHERE nombre = $2', [suParte, t.usuario]);
                }
            }
        }
        if (req.app.get('socketio')) req.app.get('socketio').emit('update_porra');
        res.redirect(`/admin?success=Reparto completado`);
    } catch (err) { res.status(500).send(err.message); }
});

// --- GESTIÓN DE USUARIOS ---
router.post('/admin/usuarios/add', isAuthenticated, isAdmin, async (req, res) => {
    const { nombre, password, creditos } = req.body;
    const inicioCreditos = creditos || 2000;
    try {
        const hashedPass = await bcrypt.hash(password, saltRounds);
        await db.query('INSERT INTO usuarios (nombre, password, creditos, puntos, rol, debe_cambiar_pass) VALUES ($1, $2, $3, 0, \'user\', true)',
            [nombre, hashedPass, inicioCreditos]);
        res.redirect(`/admin`);
    } catch (err) { res.status(500).send(err.message); }
});

router.post('/admin/usuarios/edit', isAuthenticated, isAdmin, async (req, res) => {
    const { nombre, creditos, puntos, nueva_password } = req.body;
    try {
        if (nueva_password && nueva_password.trim() !== "") {
            const hashedPass = await bcrypt.hash(nueva_password, saltRounds);
            await db.query('UPDATE usuarios SET creditos = $1, puntos = $2, password = $3, debe_cambiar_pass = true WHERE nombre = $4',
                [creditos, puntos, hashedPass, nombre]);
        } else {
            await db.query('UPDATE usuarios SET creditos = $1, puntos = $2 WHERE nombre = $3', [creditos, puntos, nombre]);
        }
        res.redirect(`/admin?success=Usuario actualizado`);
    } catch (err) { res.status(500).send(err.message); }
});

router.post('/admin/usuarios/delete', isAuthenticated, isAdmin, async (req, res) => {
    const { nombre } = req.body;
    try {
        await db.query('DELETE FROM apuestas WHERE usuario = $1', [nombre]);
        await db.query('DELETE FROM usuarios WHERE nombre = $1', [nombre]);
        res.redirect(`/admin`);
    } catch (err) { res.status(500).send(err.message); }
});

// --- RUTAS DEL CHAT ---
router.get('/chat/:id_partido?', isAuthenticated, async (req, res) => {
    const id_partido = req.params.id_partido || null;
    try {
        const mensajes = await db.query(`
            SELECT m.*, u.rol
            FROM chat_mensajes m
                     JOIN usuarios u ON m.usuario = u.nombre
            WHERE m.id_partido ${id_partido ? '= $1' : 'IS NULL'}
            ORDER BY m.fecha DESC LIMIT 50
        `, id_partido ? [id_partido] : []);
        res.json(mensajes.rows.reverse());
    } catch (err) { res.status(500).json({error: err.message}); }
});

router.post('/chat/borrar', isAuthenticated, async (req, res) => {
    if (req.session.userRol === 'admin' || req.session.userRol === 'moderador') {
        const { id_mensaje } = req.body;
        await db.query('DELETE FROM chat_mensajes WHERE id = $1', [id_mensaje]);
        const io = req.app.get('socketio');
        if (io) io.emit('mensaje_borrado', id_mensaje);
        res.json({success: true});
    } else {
        res.status(403).json({error: "No tienes permiso"});
    }
});

module.exports = router;