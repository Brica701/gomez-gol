const axios = require('axios');
const db = require('./db');

async function sincronizarMundial() {
    try {
        console.log("⚽ Consultando partidos para el Mundial 2026...");

        // Intentamos primero con el Mundial (ID 4429)
        let url = 'https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=4429';
        let response = await axios.get(url);
        let partidos = response.data.events;

        if (!partidos || partidos.length === 0) {
            console.log("ℹ️ Mundial sin datos aún. Cargando liga regular por ahora...");
            url = 'https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=4335';
            response = await axios.get(url);
            partidos = response.data.events;
        }

        if (!partidos || partidos.length === 0) {
            console.log("⚠️ No se encontraron próximos partidos.");
            return;
        }

        for (const p of partidos) {
            const id_externo = p.idEvent;
            const equipo_a = p.strHomeTeam;
            const equipo_b = p.strAwayTeam;
            const fecha = p.strTimestamp;
            const goles_a = p.intHomeScore || 0;
            const goles_b = p.intAwayScore || 0;

            let estadoFinal = 'abierto';
            if (p.strStatus === 'Match Finished' || p.strStatus === 'FT') {
                estadoFinal = 'finalizado';
            }

            // CAMBIOS PARA POSTGRESQL:
            // 1. Usamos $1, $2... en lugar de ?
            // 2. Usamos ON CONFLICT en lugar de ON DUPLICATE KEY
            const query = `
                INSERT INTO partidos (id, equipo_a, equipo_b, fecha_partido, resultado_a, resultado_b, estado)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (id) DO UPDATE SET
                    resultado_a = EXCLUDED.resultado_a,
                                            resultado_b = EXCLUDED.resultado_b,
                                            estado = EXCLUDED.estado,
                                            fecha_partido = EXCLUDED.fecha_partido
            `;

            // 3. IMPORTANTE: Usamos db.query en lugar de db.execute
            await db.query(query, [
                id_externo,
                equipo_a,
                equipo_b,
                fecha,
                goles_a,
                goles_b,
                estadoFinal
            ]);
        }

        console.log(`✅ ¡ÉXITO! ${partidos.length} partidos sincronizados.`);

    } catch (error) {
        console.error("❌ Error en la sincronización:", error.message);
    }
}

module.exports = sincronizarMundial;