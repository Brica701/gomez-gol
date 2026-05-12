const { Pool } = require('pg');

const pool = new Pool({
    // URL de Neon (Frankfurt)
    connectionString: 'postgresql://neondb_owner:npg_75tfdGxXmuDV@ep-raspy-mud-alfbqkij.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require',
    ssl: {
        rejectUnauthorized: false
    },
    // Configuración optimizada para 150 usuarios
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

// --- BLOQUE PARA CREAR LAS TABLAS AUTOMÁTICAMENTE EN NEON ---
const inicializarDB = async () => {
    try {
        console.log("🛠️ Verificando tablas en Neon (Europe Central)...");
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                                                    nombre varchar(100) PRIMARY KEY,
                puntos int DEFAULT 0,
                ha_pagado boolean DEFAULT false,
                password varchar(255) NOT NULL,
                creditos int DEFAULT 2000,
                rol text DEFAULT 'user',
                debe_cambiar_pass boolean DEFAULT true
                );

            CREATE TABLE IF NOT EXISTS partidos (
                                                    id varchar(100) PRIMARY KEY,
                equipo_a varchar(100),
                equipo_b varchar(100),
                fecha_partido timestamp with time zone,
                                            resultado_a int DEFAULT NULL,
                                            resultado_b int DEFAULT NULL,
                                            estado text DEFAULT 'abierto'
                                            );

            CREATE TABLE IF NOT EXISTS apuestas (
                                                    id SERIAL PRIMARY KEY,
                                                    usuario varchar(100) REFERENCES usuarios(nombre) ON DELETE CASCADE,
                id_partido varchar(100) REFERENCES partidos(id) ON DELETE CASCADE,
                goles_a int,
                goles_b int,
                apostado int DEFAULT 0,
                puntos_obtenidos int DEFAULT 0
                );

            CREATE TABLE IF NOT EXISTS chat_mensajes (
                                                         id SERIAL PRIMARY KEY,
                                                         usuario varchar(100),
                mensaje text,
                id_partido varchar(100),
                tipo text DEFAULT 'texto',
                fecha timestamp with time zone DEFAULT NOW()
                );

            -- Índice de velocidad para el chat (Crítico para 150 usuarios)
            CREATE INDEX IF NOT EXISTS idx_fecha_chat ON chat_mensajes(fecha);

            -- Creamos tu usuario Isaac (Pass: admin)
            INSERT INTO usuarios (nombre, password, creditos, rol, debe_cambiar_pass)
            VALUES ('Isaac', '$2b$10$/FeS0WDDnjfJ7aZ39iLt/e7rJ2vO7lT8o0qiN6eUfzxT.NmyH7kny', 2000, 'admin', false)
                ON CONFLICT (nombre) DO NOTHING;
        `);
        console.log("✅ Servidor conectado a Neon. Tablas listas.");
    } catch (err) {
        console.error("❌ Error inicializando tablas en Neon:", err.message);
    }
};

// Ejecutamos la función de creación
inicializarDB();

module.exports = {
    query: (text, params) => pool.query(text, params),
};