const axios = require('axios');
const db = require('./db');

async function sincronizarPartidos() {
    try {
        // Creamos un rango: desde ayer hasta pasado mañana
        const hoy = new Date();

        const fechaInicio = new Date(hoy);
        fechaInicio.setDate(hoy.getDate() - 1); // Ayer

        const fechaFin = new Date(hoy);
        fechaFin.setDate(hoy.getDate() + 2); // Pasado mañana

        const inicioISO = fechaInicio.toISOString().split('T')[0];
        const finISO = fechaFin.toISOString().split('T')[0];

        console.log(`⚽ Sincronizando rango: ${inicioISO} al ${finISO}...`);

        const options = {
            method: 'GET',
            url: `https://api.football-data.org/v4/matches?dateFrom=${inicioISO}&dateTo=${finISO}`,
            headers: {
                'X-Auth-Token': 'a269175e09f54abf8055c45698e3099f'
            }
        };

        const response = await axios.request(options);

        // Manejo de Throttling (Daniel's advice)
        const restantes = response.headers['x-requests-remaining'];
        if (restantes && parseInt(restantes) < 5) console.warn(`⚠️ API Key al límite: ${restantes} usos.`);

        const partidos = response.data.matches;

        if (!partidos || partidos.length === 0) {
            console.log("ℹ️ La API no devuelve partidos en este rango para las ligas gratuitas.");
            return;
        }

        for (const p of partidos) {
            const id_externo = p.id.toString();
            const equipo_a = p.homeTeam.shortName || p.homeTeam.name;
            const equipo_b = p.awayTeam.shortName || p.awayTeam.name;
            const fecha = p.utcDate;

            const goles_a = p.score.fullTime.home ?? 0;
            const goles_b = p.score.fullTime.away ?? 0;

            let estadoFinal = 'abierto';
            if (p.status === 'FINISHED' || p.status === 'AWARDED') estadoFinal = 'finalizado';
            if (p.status === 'IN_PLAY') estadoFinal = 'en_vivo';

            const query = `
                INSERT INTO partidos (id, equipo_a, equipo_b, fecha_partido, resultado_a, resultado_b, estado)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ON CONFLICT (id) DO UPDATE SET
                    resultado_a = EXCLUDED.resultado_a,
                                            resultado_b = EXCLUDED.resultado_b,
                                            estado = EXCLUDED.estado;
            `;

            await db.query(query, [id_externo, equipo_a, equipo_b, fecha, goles_a, goles_b, estadoFinal]);
        }

        console.log(`✅ ¡ÉXITO! ${partidos.length} partidos sincronizados en Neon.`);

    } catch (error) {
        console.error("❌ Error en sincronización:", error.message);
    }
}

module.exports = sincronizarPartidos;