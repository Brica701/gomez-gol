const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://gomez_gol_db_user:DxdyDfnnnNsdJHhvbPFhu6cYuG465LuY@dpg-d81fk1gsfn5c73a67cg0-a.oregon-postgres.render.com/gomez_gol_db',
    ssl: {
        rejectUnauthorized: false
    }
});

// --- BLOQUE PARA CREAR LAS TABLAS AUTOMÁTICAMENTE ---
const inicializarDB = async () => {
    try {
        console.log("🛠️ Verificando tablas en Render...");
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

            -- Creamos tu usuario Isaac (Pass: admin)
            INSERT INTO usuarios (nombre, password, creditos, rol, debe_cambiar_pass)
            VALUES ('Isaac', '$2b$10$/FeS0WDDnjfJ7aZ39iLt/e7rJ2vO7lT8o0qiN6eUfzxT.NmyH7kny', 2000, 'admin', false)
            ON CONFLICT (nombre) DO NOTHING;
        `);
        console.log("✅ Tablas listas y usuario Isaac creado.");
    } catch (err) {
        console.error("❌ Error inicializando tablas:", err.message);
    }
};

// Ejecutamos la función de creación
inicializarDB();

module.exports = {
    query: (text, params) => pool.query(text, params),
};