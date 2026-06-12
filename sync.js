const axios = require('axios');
const db = require('./db');

// --- CONFIGURACIÓN API ---
const API_TOKEN = 'a269175e09f54abf8055c45698e3099f'; // Tu token

// --- UTILIDAD: CALCULAR PUNTOS (3, 2, 1) ---
function calcularPuntos(apuestaA, apuestaB, realA, realB) {
    const aA = parseInt(apuestaA);
    const aB = parseInt(apuestaB);
    const rA = parseInt(realA);
    const rB = parseInt(realB);

    if (aA === rA && aB === rB) return 3;
    if (aA === aB && rA === rB) return 1;

    const tendenciaApuesta = aA > aB ? 'A' : (aA < aB ? 'B' : 'E');
    const tendenciaReal = rA > rB ? 'A' : (rA < rB ? 'B' : 'E');

    return (tendenciaApuesta === tendenciaReal) ? 2 : 0;
}

// --- FUNCIÓN PARA REPARTIR PREMIOS Y ACTUALIZAR RACHAS ---
async function ejecutarRepartoAutomatico(id_partido, resA, resB) {
    console.log(`💰 Iniciando reparto de premios para el partido ${id_partido}...`);
    try {
        const resBote = await db.query('SELECT SUM(apostado) as total FROM apuestas WHERE id_partido = $1', [id_partido]);
        const boteTotal = parseInt(resBote.rows[0].total) || 0;
        const resApuestas = await db.query('SELECT * FROM apuestas WHERE id_partido = $1', [id_partido]);

        let ganadoresPleno = [];
        let ganadoresTendencia = [];
        let totalApostadoPleno = 0;
        let totalApostadoTendencia = 0;

        for (let ap of resApuestas.rows) {
            const puntos = calcularPuntos(ap.goles_a, ap.goles_b, resA, resB);

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
        console.log(`✅ Reparto completado para el partido ${id_partido}`);
    } catch (err) {
        console.error("❌ Error en el reparto automático:", err.message);
    }
}

// --- FUNCIÓN PRINCIPAL DE SINCRONIZACIÓN ---
async function sincronizarPartidos() {
    try {

        const response = await axios.get(`https://api.football-data.org/v4/competitions/WC/matches`, {
            headers: { 'X-Auth-Token': API_TOKEN }
        });

        const partidos = response.data.matches;

        for (const p of partidos) {
            const id_externo = p.id.toString();

            const { rows } = await db.query('SELECT estado, resultado_a, resultado_b FROM partidos WHERE id = $1', [id_externo]);
            const pActual = rows[0];

            const goles_a = p.score.fullTime.home;
            const goles_b = p.score.fullTime.away;

            let estadoFinal = 'abierto';
            if (p.status === 'FINISHED' || p.status === 'AWARDED') estadoFinal = 'finalizado';
            else if (p.status === 'IN_PLAY' || p.status === 'LIVE') estadoFinal = 'en_vivo';

            const resA = goles_a !== null ? goles_a : (pActual?.resultado_a || 0);
            const resB = goles_b !== null ? goles_b : (pActual?.resultado_b || 0);

            await db.query(`
                INSERT INTO partidos (id, equipo_a, equipo_b, id_api_a, id_api_b, fecha_partido, resultado_a, resultado_b, estado)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (id) DO UPDATE SET
                    resultado_a = EXCLUDED.resultado_a,
                                            resultado_b = EXCLUDED.resultado_b,
                                            estado = EXCLUDED.estado
            `, [id_externo, p.homeTeam.shortName, p.awayTeam.shortName, p.homeTeam.id, p.awayTeam.id, p.utcDate, resA, resB, estadoFinal]);

            if (estadoFinal === 'finalizado' && (pActual?.estado !== 'finalizado') && goles_a !== null) {
                await ejecutarRepartoAutomatico(id_externo, resA, resB);
            }
        }
    } catch (error) {
        // Mejora: log detallado del error
        console.error("❌ Error en sincronización:", error.response?.data?.message || error.message);
    }
}

module.exports = sincronizarPartidos;