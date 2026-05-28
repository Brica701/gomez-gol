const axios = require('axios');
const db = require('./db');

// --- UTILIDAD: CALCULAR PUNTOS (3, 2, 1) ---
function calcularPuntos(apuestaA, apuestaB, realA, realB) {
    const aA = parseInt(apuestaA);
    const aB = parseInt(apuestaB);
    const rA = parseInt(realA);
    const rB = parseInt(realB);

    // Pleno: resultado exacto
    if (aA === rA && aB === rB) return 3;

    // Empate: acertar que quedan igual aunque no sea el número de goles
    if (aA === aB && rA === rB) return 1;

    // Tendencia: acertar quién gana
    const tendenciaApuesta = aA > aB ? 'A' : (aA < aB ? 'B' : 'E');
    const tendenciaReal = rA > rB ? 'A' : (rA < rB ? 'B' : 'E');

    return (tendenciaApuesta === tendenciaReal) ? 2 : 0;
}

// --- FUNCIÓN PARA REPARTIR PREMIOS Y ACTUALIZAR RACHAS ---
async function ejecutarRepartoAutomatico(id_partido, resA, resB) {
    console.log(`💰 Iniciando reparto de premios para el partido ${id_partido}...`);
    try {
        // Obtenemos el bote total (80% repartible)
        const resBote = await db.query('SELECT SUM(apostado) as total FROM apuestas WHERE id_partido = $1', [id_partido]);
        const boteTotal = parseInt(resBote.rows[0].total) || 0;

        const resApuestas = await db.query('SELECT * FROM apuestas WHERE id_partido = $1', [id_partido]);

        let ganadoresPleno = [];
        let ganadoresTendencia = [];
        let totalApostadoPleno = 0;
        let totalApostadoTendencia = 0;

        for (let ap of resApuestas.rows) {
            const puntos = calcularPuntos(ap.goles_a, ap.goles_b, resA, resB);

            // Gestión de Rachas
            let rachaData = await db.query('SELECT racha_exacta, racha_ganador FROM rachas WHERE usuario_nombre = $1', [ap.usuario]);
            if (rachaData.rows.length === 0) {
                await db.query('INSERT INTO rachas (usuario_nombre, racha_exacta, racha_ganador) VALUES ($1, 0, 0)', [ap.usuario]);
                rachaData = { rows: [{ racha_exacta: 0, racha_ganador: 0 }] };
            }

            let { racha_exacta, racha_ganador } = rachaData.rows[0];
            let bonusGarantizado = 0;

            if (puntos === 3) {
                racha_exacta++;
                racha_ganador++;
                if (racha_exacta >= 2) bonusGarantizado = racha_exacta * 100;
            } else if (puntos >= 1) {
                racha_ganador++;
                racha_exacta = 0;
                if (racha_ganador >= 2) bonusGarantizado = racha_ganador * 50;
            } else {
                racha_exacta = 0;
                racha_ganador = 0;
            }

            // Actualizar rachas, puntos y créditos (bonus de racha)
            await db.query('UPDATE rachas SET racha_exacta = $1, racha_ganador = $2 WHERE usuario_nombre = $3', [racha_exacta, racha_ganador, ap.usuario]);
            await db.query('UPDATE apuestas SET puntos_obtenidos = $1, premio_monedas = $2 WHERE id = $3', [puntos, bonusGarantizado, ap.id]);
            await db.query('UPDATE usuarios SET puntos = puntos + $1, creditos = creditos + $2 WHERE nombre = $3', [puntos, bonusGarantizado, ap.usuario]);

            if (puntos === 3) {
                ganadoresPleno.push(ap);
                totalApostadoPleno += parseInt(ap.apostado);
            } else if (puntos >= 1) {
                ganadoresTendencia.push(ap);
                totalApostadoTendencia += parseInt(ap.apostado);
            }
        }

        // Reparto proporcional del Bote (80% del total apostado)
        if (boteTotal > 0) {
            const boteRepartible = Math.floor(boteTotal * 0.80);

            if (ganadoresPleno.length > 0) {
                // Si hay plenos, ellos se llevan el 70% de la bolsa repartible (o el 100% si no hay otros ganadores)
                const bolsaPleno = ganadoresTendencia.length > 0 ? boteRepartible * 0.70 : boteRepartible;
                for (let g of ganadoresPleno) {
                    let suParte = Math.floor((parseInt(g.apostado) / totalApostadoPleno) * bolsaPleno);
                    await db.query('UPDATE usuarios SET creditos = creditos + $1 WHERE nombre = $2', [suParte, g.usuario]);
                    await db.query('UPDATE apuestas SET premio_monedas = premio_monedas + $1 WHERE id = $2', [suParte, g.id]);
                }
            }

            if (ganadoresTendencia.length > 0) {
                // Los de tendencia se llevan el 30% (o el 100% si no hay plenos)
                const bolsaTendencia = ganadoresPleno.length > 0 ? boteRepartible * 0.30 : boteRepartible;
                for (let t of ganadoresTendencia) {
                    let suParte = Math.floor((parseInt(t.apostado) / totalApostadoTendencia) * bolsaTendencia);
                    await db.query('UPDATE usuarios SET creditos = creditos + $1 WHERE nombre = $2', [suParte, t.usuario]);
                    await db.query('UPDATE apuestas SET premio_monedas = premio_monedas + $1 WHERE id = $2', [suParte, t.id]);
                }
            }
        }
        console.log(`✅ Reparto completado para el partido ${id_partido}`);
    } catch (err) {
        console.error("❌ Error en el reparto automático:", err.message);
    }
}

// --- FUNCIÓN PRINCIPAL DE SINCRONIZACIÓN ---
async function sincronizarPartidos() {
    try {
        const hoy = new Date();
        const fechaInicio = new Date(hoy);
        fechaInicio.setDate(hoy.getDate() - 1);

        const fechaFin = new Date(hoy);
        fechaFin.setDate(hoy.getDate() + 2);

        const inicioISO = fechaInicio.toISOString().split('T')[0];
        const finISO = fechaFin.toISOString().split('T')[0];

        console.log(`⚽ [Sync] Rango: ${inicioISO} al ${finISO}...`);

        const response = await axios.get(`https://api.football-data.org/v4/matches?dateFrom=${inicioISO}&dateTo=${finISO}`, {
            headers: { 'X-Auth-Token': 'a269175e09f54abf8055c45698e3099f' }
        });

        const partidos = response.data.matches;
        if (!partidos || partidos.length === 0) return;

        for (const p of partidos) {
            const id_externo = p.id.toString();

            // Consultamos el estado actual en nuestra BD antes de actualizar
            const estadoPrevioRes = await db.query('SELECT estado FROM partidos WHERE id = $1', [id_externo]);
            const estadoPrevio = estadoPrevioRes.rows.length > 0 ? estadoPrevioRes.rows[0].estado : null;

            const goles_a = p.score.fullTime.home ?? 0;
            const goles_b = p.score.fullTime.away ?? 0;

            let estadoFinal = 'abierto';
            if (p.status === 'FINISHED' || p.status === 'AWARDED') estadoFinal = 'finalizado';
            if (p.status === 'IN_PLAY' || p.status === 'LIVE') estadoFinal = 'en_vivo';

            // Actualizamos o insertamos el partido (Editado para incluir IDs de escudos)
            await db.query(`
                INSERT INTO partidos (id, equipo_a, equipo_b, id_api_a, id_api_b, fecha_partido, resultado_a, resultado_b, estado)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (id) DO UPDATE SET 
                    resultado_a = EXCLUDED.resultado_a,
                                            resultado_b = EXCLUDED.resultado_b,
                                            estado = EXCLUDED.estado,
                                            fecha_partido = EXCLUDED.fecha_partido,
                                            id_api_a = EXCLUDED.id_api_a,
                                            id_api_b = EXCLUDED.id_api_b;
            `, [
                id_externo,
                p.homeTeam.shortName || p.homeTeam.name,
                p.awayTeam.shortName || p.awayTeam.name,
                p.homeTeam.id, // ID escudo local
                p.awayTeam.id, // ID escudo visitante
                p.utcDate,
                goles_a,
                goles_b,
                estadoFinal
            ]);

            
            // Si el partido acaba de pasar a 'finalizado', disparamos el reparto
            if (estadoFinal === 'finalizado' && estadoPrevio !== 'finalizado') {
                await ejecutarRepartoAutomatico(id_externo, goles_a, goles_b);
            }
        }

        console.log(`✅ Proceso finalizado. ${partidos.length} partidos procesados.`);

    } catch (error) {
        console.error("❌ Error en sincronización:", error.message);
    }
}

module.exports = sincronizarPartidos;