var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var session = require('express-session');

var db = require('./db');
var sincronizarMundial = require('./sync');
var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');

var app = express();

// --- GESTIÓN DE SOCKET.IO ---
app.set('socketio', null);
app.setSocketIo = function(io) {
    console.log("🔌 Socket.io inyectado correctamente en la App");
    this.set('socketio', io);

    io.on('connection', (socket) => {
        socket.on('enviar_mensaje', async (data) => {
            try {
                // --- BLOQUE DE BANEO: Verificar si el usuario está castigado ---
                const checkBan = await db.query(
                    'SELECT ban_hasta FROM usuarios WHERE nombre = $1 AND ban_hasta > NOW()',
                    [data.usuario]
                );

                if (checkBan.rows.length > 0) {
                    console.log(`🚫 Mensaje bloqueado: ${data.usuario} está baneado.`);
                    return; // No ejecutamos el INSERT ni el EMIT
                }
                // ------------------------------------------------------------

                const result = await db.query(
                    'INSERT INTO chat_mensajes (usuario, mensaje, id_partido, tipo) VALUES ($1, $2, $3, $4) RETURNING id',
                    [data.usuario, data.mensaje, data.id_partido || null, data.tipo || 'texto']
                );

                data.id = result.rows[0].id;
                data.fecha = new Date();

                io.emit('nuevo_mensaje', data);
            } catch (err) {
                console.error("Error en el chat:", err);
            }
        });
    });
};

// --- CONFIGURACIÓN DE SESIONES ---
app.use(session({
    secret: 'gomez-moreno-2026-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
    res.locals.userNombre = req.session.userNombre || null;
    res.locals.userRol = req.session.userRol || null;
    next();
});

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/users', usersRouter);

db.query('SELECT 1')
    .then(() => {
        console.log('--------------------------------------------------');
        console.log('📱 CONECTADO CON ÉXITO A LA DB (Isaac Cruz - 2026)');
        console.log('--------------------------------------------------');
    })
    .catch(err => console.error('⚠️ ERROR DB:', err.message));

sincronizarMundial()
    .then(() => console.log('⚽ Partidos del Mundial actualizados'))
    .catch(err => console.error('❌ Error API Mundial:', err));

setInterval(() => {
    sincronizarMundial().catch(console.error);
}, 3600000);

app.use(function(req, res, next) { next(createError(404)); });

app.use(function(err, req, res, next) {
    res.locals.message = err.message;
    res.locals.error = req.app.get('env') === 'development' ? err : {};
    res.status(err.status || 500);
    res.render('error');
});

module.exports = app;