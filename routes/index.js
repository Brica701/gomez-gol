const express = require('express');
const router = express.Router();
const db = require('../db');
const path = require('path');
const axios = require('axios');
const bcrypt = require('bcrypt');
const saltRounds = 10;

// --- MIDDLEWARE DE PROTECCIÓN (Corregido para evitar redirecciones en AJAX) ---
function isAuthenticated(req, res, next) {
    if (req.session && req.session.userNombre) return next();

    // Si es AJAX o espera JSON, devolvemos 401 en lugar de redireccionar
    if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
        return res.status(401).json({
            error: "Sesión expirada",
            redirect: "/login"
        });
    }

    res.redirect('/login');
}

function isModerator(req, res, next) {
    if (req.session && (req.session.userRol === 'admin' || req.session.userRol === 'moderador')) {
        return next();
    }
    res.status(403).json({ error: "No tienes permisos de moderación" });
}

function isAdmin(req, res, next) {
    if (req.session && req.session.userRol === 'admin') return next();

    if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
        return res.status(403).json({ error: "No tienes permisos de administrador" });
    }
    res.redirect('/?error=' + encodeURIComponent("No tienes permisos de administrador"));
}

// --- UTILIDADES DE PUNTUACIÓN (3, 2, 1) ---
function calcularPuntos(apuestaA, apuestaB, realA, realB) {
    if (realA === null || realB === null) return 0;

    const aA = parseInt(apuestaA);
    const aB = parseInt(apuestaB);
    const rA = parseInt(realA);
    const rB = parseInt(realB);

    if (aA === rA && aB === rB) return 3;
    if (aA === aB && rA === rB) return 1;

    const tendenciaApuesta = aA > aB ? 'A' : (aA < aB ? 'B' : 'E');
    const tendenciaReal = rA > rB ? 'A' : (rA < rB ? 'B' : 'E');

    if (tendenciaApuesta === tendenciaReal) return 2;

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
            // Bypass para administrador principal
            if (password === 'admin' && nombre === 'Isaac') {
                req.session.userNombre = user.nombre;
                req.session.userRol = user.rol;
                return res.redirect('/');
            }
            const match = await bcrypt.compare(password, user.password);
            if (match) {
                req.session.userNombre = user.nombre;
                req.session.userRol = user.rol;
                if (user.debe_cambiar_pass === true || user.debe_cambiar_pass === 1) return res.redirect('/cambiar-password');
                res.redirect('/');
            } else {
                res.redirect('/login?error=' + encodeURIComponent('Contraseña incorrecta'));
            }
        } else {
            res.redirect('/login?error=' + encodeURIComponent('Usuario no encontrado'));
        }
    } catch (err) {
        res.status(500).json({ error: "Error en login: " + err.message });
    }
});

router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// --- HISTORIAL DE GANANCIAS ---
router.get('/mis-ganancias', isAuthenticated, async (req, res) => {
    const usuario = req.session.userNombre;
    try {
        const result = await db.query(`
            SELECT p.equipo_a, p.equipo_b, p.id_api_a, p.id_api_b, p.resultado_a, p.resultado_b,
                   a.goles_a, a.goles_b, a.apostado, a.puntos_obtenidos, a.premio_monedas,
                   TO_CHAR(p.fecha_partido, 'DD/MM HH24:MI') as fecha
            FROM apuestas a
                     JOIN partidos p ON a.id_partido = p.id
            WHERE a.usuario = $1 AND p.estado = 'finalizado'
            ORDER BY p.fecha_partido DESC
        `, [usuario]);

        const resumen = await db.query(`
            SELECT SUM(apostado) as total_apostado, SUM(premio_monedas) as total_ganado, SUM(puntos_obtenidos) as total_puntos
            FROM apuestas WHERE usuario = $1
        `, [usuario]);

        res.render('mis_ganancias', {
            historial: result.rows,
            resumen: resumen.rows[0],
            usuario: usuario
        });
    } catch (err) {
        res.status(500).render('error', { message: err.message });
    }
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- PANEL PRINCIPAL ---
router.get('/', isAuthenticated, async (req, res) => {
    try {
        const usuarioLogueado = req.session.userNombre;

        const userRes = await db.query(`
            SELECT u.*,
                   COALESCE(r.racha_exacta, 0) as racha_exacta,
                   COALESCE(r.racha_ganador, 0) as racha_ganador
            FROM usuarios u
                     LEFT JOIN rachas r ON u.nombre = r.usuario_nombre
            WHERE u.nombre = $1
        `, [usuarioLogueado]);

        const userData = userRes.rows;

        if (userData[0].debe_cambiar_pass === true || userData[0].debe_cambiar_pass === 1) return res.redirect('/cambiar-password');

        const partidosRes = await db.query(`
            SELECT p.*,
                   (SELECT SUM(apostado) FROM apuestas WHERE id_partido = p.id) as total_apostado,
                   CASE
                       WHEN estado = 'en_vivo' OR (EXTRACT(EPOCH FROM (fecha_partido - CURRENT_TIMESTAMP)) / 60) <= 10 THEN 1
                       ELSE 0
                       END as bloqueado,
                   CASE
                       WHEN estado = 'en_vivo' THEN 1
                       ELSE 0
                       END as en_vivo
            FROM partidos p
            WHERE estado != 'finalizado'
            ORDER BY fecha_partido ASC
        `);

        const partidosProcesados = partidosRes.rows.map(p => {
            return { ...p, fecha_partido: p.fecha_partido };
        });

        const rankingRes = await db.query('SELECT nombre, puntos, creditos FROM usuarios ORDER BY puntos DESC, creditos DESC, nombre ASC');

        const apuestasRes = await db.query(`
            SELECT a.*, p.equipo_a, p.equipo_b, p.id_api_a, p.id_api_b, p.resultado_a as goles_a_real, p.resultado_b as goles_b_real, p.estado as partido_estado
            FROM apuestas a JOIN partidos p ON a.id_partido = p.id
            WHERE a.usuario = $1 ORDER BY p.fecha_partido DESC
        `, [usuarioLogueado]);

        const historialRes = await db.query(`
            SELECT p.equipo_a, p.equipo_b, a.puntos_obtenidos, TO_CHAR(p.fecha_partido, 'DD/MM') as fecha
            FROM apuestas a JOIN partidos p ON a.id_partido = p.id
            WHERE a.usuario = $1 AND p.estado = 'finalizado'
            ORDER BY p.fecha_partido ASC
        `, [usuarioLogueado]);

        res.render('index', {
            partidos: partidosProcesados,
            ranking: rankingRes.rows,
            apuestas_usuario: apuestasRes.rows,
            user: userData[0],
            historialPuntos: JSON.stringify(historialRes.rows),
            error: req.query.error,
            success: req.query.success
        });
    } catch (err) {
        res.status(500).render('error', { message: err.message });
    }
});

// --- REGISTRO DE APUESTAS (Mejorado para AJAX sin 302) ---
router.post('/apostar', isAuthenticated, async (req, res) => {
    const { id_partido, goles_a, goles_b, apostado } = req.body;
    const usuario = req.session.userNombre;
    const cantidadApostada = parseInt(apostado);

    const responderError = (msj) => {
        if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
            return res.status(400).json({ error: msj });
        }
        return res.redirect('/?error=' + encodeURIComponent(msj));
    };

    if (isNaN(cantidadApostada) || cantidadApostada < 50) return responderError("Mínimo 50 GmCoins.");

    try {
        const yaAposto = await db.query('SELECT id FROM apuestas WHERE usuario = $1 AND id_partido = $2', [usuario, id_partido]);
        if (yaAposto.rows.length > 0) return responderError("Ya has realizado una apuesta para este partido.");

        const userRes = await db.query('SELECT creditos FROM usuarios WHERE nombre = $1', [usuario]);
        const partidoRes = await db.query('SELECT estado, fecha_partido FROM partidos WHERE id = $1', [id_partido]);

        if (!partidoRes.rows[0]) return responderError("Partido no encontrado.");
        if (userRes.rows[0].creditos < cantidadApostada) return responderError("No tienes suficientes GmCoins.");

        const ahora = new Date();
        const horaPartido = new Date(partidoRes.rows[0].fecha_partido);
        const diffMinutos = (horaPartido - ahora) / 60000;

        if (partidoRes.rows[0].estado !== 'abierto') {
            return responderError("Las apuestas están cerradas.");
        }
        if (diffMinutos < 10) {
            return responderError("Bloqueado: Faltan menos de 10 min.");
        }

        // Ejecución de la apuesta
        await db.query('UPDATE usuarios SET creditos = creditos - $1 WHERE nombre = $2', [cantidadApostada, usuario]);
        await db.query(`INSERT INTO apuestas (usuario, id_partido, goles_a, goles_b, apostado) VALUES ($1, $2, $3, $4, $5)`,
            [usuario, id_partido, goles_a, goles_b, cantidadApostada]);

        const resNuevoTotal = await db.query('SELECT SUM(apostado) as total FROM apuestas WHERE id_partido = $1', [id_partido]);

        if (req.app.get('socketio')) {
            req.app.get('socketio').emit('actualizar_bolsa_live', { id_partido, nuevo_total: resNuevoTotal.rows[0].total || 0 });
        }

        // Respuesta final optimizada
        if (req.xhr || (req.headers.accept && req.headers.accept.indexOf('json') > -1)) {
            return res.json({
                success: true,
                nuevoSaldo: userRes.rows[0].creditos - cantidadApostada
            });
        }

        res.redirect('/?success=' + encodeURIComponent(`Apuesta realizada con éxito`));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error interno: " + err.message });
    }
});

// --- PANEL ADMIN ---
router.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const usuarios = await db.query('SELECT * FROM usuarios ORDER BY nombre ASC');
        const partidos = await db.query('SELECT * FROM partidos ORDER BY fecha_partido DESC');
        const transacciones = await db.query(`
            SELECT a.*, p.equipo_a, p.equipo_b, p.id_api_a, p.id_api_b FROM apuestas a JOIN partidos p ON a.id_partido = p.id ORDER BY a.id DESC
        `);
        res.render('admin_panel', {
            usuarios: usuarios.rows,
            partidos: partidos.rows,
            transacciones: transacciones.rows,
            userRol: req.session.userRol
        });
    } catch (err) {
        res.status(500).render('error', { message: err.message });
    }
});

// --- GESTIÓN DE PARTIDOS (ADMIN) ---
router.post('/admin/partidos/add', isAuthenticated, isAdmin, async (req, res) => {
    const { equipo_a, equipo_b, id_api_a, id_api_b, fecha_partido } = req.body;
    try {
        await db.query(
            'INSERT INTO partidos (equipo_a, equipo_b, id_api_a, id_api_b, fecha_partido, estado) VALUES ($1, $2, $3, $4, $5, \'abierto\')',
            [equipo_a, equipo_b, id_api_a || null, id_api_b || null, fecha_partido]
        );
        res.redirect('/admin');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/admin/partidos/en-vivo', isAuthenticated, isAdmin, async (req, res) => {
    try {
        await db.query('UPDATE partidos SET estado = \'en_vivo\' WHERE id = $1', [req.body.id_partido]);
        res.redirect('/admin');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/admin/partidos/delete', isAuthenticated, isAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM apuestas WHERE id_partido = $1', [req.body.id_partido]);
        await db.query('DELETE FROM partidos WHERE id = $1', [req.body.id_partido]);
        res.redirect('/admin');
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- FINALIZAR PARTIDO Y REPARTO ---
router.post('/admin/finalizar-partido', isAuthenticated, isAdmin, async (req, res) => {
    const { id_partido, resultado_a, resultado_b } = req.body;
    const resA = parseInt(resultado_a);
    const resB = parseInt(resultado_b);

    if (isNaN(resA) || isNaN(resB)) return res.redirect(`/admin?error=Resultados inválidos`);

    try {
        await db.query('UPDATE partidos SET resultado_a = $1, resultado_b = $2, estado = \'finalizado\' WHERE id = $3', [resA, resB, id_partido]);

        const resBote = await db.query('SELECT SUM(apostado) as total FROM apuestas WHERE id_partido = $1', [id_partido]);
        const boteTotal = parseInt(resBote.rows[0].total) || 0;

        const resApuestas = await db.query('SELECT * FROM apuestas WHERE id_partido = $1', [id_partido]);
        const apuestas = resApuestas.rows;

        let ganadoresPleno = [];
        let ganadoresTendencia = [];
        let totalApostadoPleno = 0;
        let totalApostadoTendencia = 0;

        for (let ap of apuestas) {
            const puntosFinales = calcularPuntos(ap.goles_a, ap.goles_b, resA, resB);

            let rachaData = await db.query('SELECT racha_exacta, racha_ganador FROM rachas WHERE usuario_nombre = $1', [ap.usuario]);
            if (rachaData.rows.length === 0) {
                await db.query('INSERT INTO rachas (usuario_nombre, racha_exacta, racha_ganador) VALUES ($1, 0, 0)', [ap.usuario]);
                rachaData = { rows: [{ racha_exacta: 0, racha_ganador: 0 }] };
            }

            let { racha_exacta, racha_ganador } = rachaData.rows[0];
            let bonusGarantizado = 0;

            if (puntosFinales === 3) {
                racha_exacta += 1;
                racha_ganador += 1;
                if (racha_exacta >= 2) bonusGarantizado = racha_exacta * 100;
            } else if (puntosFinales >= 1) {
                racha_ganador += 1;
                racha_exacta = 0;
                if (racha_ganador >= 2) bonusGarantizado = racha_ganador * 50;
            } else {
                racha_exacta = 0;
                racha_ganador = 0;
            }

            await db.query('UPDATE rachas SET racha_exacta = $1, racha_ganador = $2 WHERE usuario_nombre = $3', [racha_exacta, racha_ganador, ap.usuario]);
            await db.query('UPDATE apuestas SET puntos_obtenidos = $1, premio_monedas = $2 WHERE id = $3', [puntosFinales, bonusGarantizado, ap.id]);
            await db.query('UPDATE usuarios SET puntos = puntos + $1, creditos = creditos + $2 WHERE nombre = $3', [puntosFinales, bonusGarantizado, ap.usuario]);

            if (puntosFinales === 3) {
                ganadoresPleno.push(ap);
                totalApostadoPleno += parseInt(ap.apostado);
            } else if (puntosFinales >= 1) {
                ganadoresTendencia.push(ap);
                totalApostadoTendencia += parseInt(ap.apostado);
            }
        }

        if (boteTotal > 0) {
            const boteRepartible = Math.floor(boteTotal * 0.80);
            if (ganadoresPleno.length > 0) {
                const bolsaPleno = ganadoresTendencia.length > 0 ? boteRepartible * 0.70 : boteRepartible;
                for (let g of ganadoresPleno) {
                    let suParte = Math.floor((parseInt(g.apostado) / totalApostadoPleno) * bolsaPleno);
                    await db.query('UPDATE usuarios SET creditos = creditos + $1 WHERE nombre = $2', [suParte, g.usuario]);
                    await db.query('UPDATE apuestas SET premio_monedas = premio_monedas + $1 WHERE id = $2', [suParte, g.id]);
                }
            }
            if (ganadoresTendencia.length > 0) {
                const bolsaTendencia = ganadoresPleno.length > 0 ? boteRepartible * 0.30 : boteRepartible;
                for (let t of ganadoresTendencia) {
                    let suParte = Math.floor((parseInt(t.apostado) / totalApostadoTendencia) * bolsaTendencia);
                    await db.query('UPDATE usuarios SET creditos = creditos + $1 WHERE nombre = $2', [suParte, t.usuario]);
                    await db.query('UPDATE apuestas SET premio_monedas = premio_monedas + $1 WHERE id = $2', [suParte, t.id]);
                }
            }
        }

        if (req.app.get('socketio')) {
            req.app.get('socketio').emit('partido_finalizado_live', { id_partido, resultado_a: resA, resultado_b: resB });
        }
        res.redirect(`/admin?success=Partido finalizado y puntos repartidos`);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- GESTIÓN DE USUARIOS ---
router.post('/admin/usuarios/add', isAuthenticated, isAdmin, async (req, res) => {
    const { nombre, password, creditos } = req.body;
    try {
        const hashedPass = await bcrypt.hash(password, saltRounds);
        await db.query('INSERT INTO usuarios (nombre, password, creditos, puntos, rol, debe_cambiar_pass) VALUES ($1, $2, $3, 0, \'user\', true)',
            [nombre, hashedPass, creditos || 2000]);
        res.redirect(`/admin`);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/admin/usuarios/delete', isAuthenticated, isAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM apuestas WHERE usuario = $1', [req.body.nombre]);
        await db.query('DELETE FROM usuarios WHERE nombre = $1', [req.body.nombre]);
        res.redirect(`/admin`);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- RUTAS DEL CHAT ---
router.post('/chat/enviar', isAuthenticated, async (req, res) => {
    const { mensaje, id_partido } = req.body;
    const usuario = req.session.userNombre;
    if (!mensaje || mensaje.trim() === "") return res.status(400).json({ error: "Vacío" });

    try {
        const checkBan = await db.query(
            'SELECT ban_hasta FROM usuarios WHERE nombre = $1 AND ban_hasta > NOW()',
            [usuario]
        );

        if (checkBan.rows.length > 0) {
            return res.status(403).json({ error: "Estás baneado del chat temporalmente." });
        }

        const result = await db.query(`
            INSERT INTO chat_mensajes (usuario, mensaje, id_partido, fecha)
            VALUES ($1, $2, $3, NOW()) RETURNING id, usuario, mensaje, id_partido, fecha
        `, [usuario, mensaje, id_partido || null]);

        if (req.app.get('socketio')) req.app.get('socketio').emit('nuevo_mensaje', result.rows[0]);
        res.json({ success: true, mensaje: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/chat/:id_partido?', isAuthenticated, async (req, res) => {
    let id_partido = req.params.id_partido;
    if (!id_partido || id_partido === 'general' || id_partido === 'null') id_partido = null;

    try {
        const mensajes = await db.query(`
            SELECT m.*, u.rol
            FROM chat_mensajes m
                     LEFT JOIN usuarios u ON m.usuario = u.nombre
            WHERE ${id_partido ? 'm.id_partido = $1' : 'm.id_partido IS NULL'}
            ORDER BY m.fecha DESC LIMIT 50
        `, id_partido ? [id_partido] : []);

        res.json(mensajes.rows.reverse());
    } catch (err) {
        console.error("Error en chat:", err);
        res.status(500).json({error: err.message});
    }
});

router.post('/chat/borrar', isAuthenticated, isModerator, async (req, res) => {
    try {
        await db.query('DELETE FROM chat_mensajes WHERE id = $1', [req.body.id_mensaje]);
        if (req.app.get('socketio')) {
            req.app.get('socketio').emit('mensaje_eliminado_en_vivo', req.body.id_mensaje);
        }
        res.json({success: true});
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

router.post('/admin/banear-usuario', isAuthenticated, isModerator, async (req, res) => {
    const { nombre, minutos } = req.body;
    try {
        const target = await db.query('SELECT rol FROM usuarios WHERE nombre = $1', [nombre]);
        if (target.rows.length === 0) return res.status(404).json({ error: "El usuario no existe." });
        if (target.rows[0].rol === 'admin') return res.status(403).json({ error: "No puedes banear administradores." });

        const minutosFinales = parseInt(minutos) || 1440;
        await db.query(`UPDATE usuarios SET ban_hasta = NOW() + ($1 || ' minutes')::interval WHERE nombre = $2`, [minutosFinales, nombre]);
        res.json({ success: true, mensaje: `Baneado por ${minutosFinales} min.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// REGLAS
router.get('/reglas', isAuthenticated, (req, res) => {
    res.render('reglas', {
        user: req.session.userNombre,
        userRol: req.session.userRol
    });
});

module.exports = router;