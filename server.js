const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = { 1: null, '-1': null }; // her role ait sekme kimliği
let state = null;                       // son oyun durumu

// Roller takılırsa bu adresi aç: /sifirla
app.get('/sifirla', (req, res) => {
    players = { 1: null, '-1': null };
    state = null;
    res.send('Roller ve oyun sifirlandi. Simdi oyun sayfasini acabilirsiniz.');
});

io.on('connection', (socket) => {
    const cid = (socket.handshake.auth && socket.handshake.auth.clientId) || socket.id;

    let color = null;
    if (players[1] === cid) color = 1;
    else if (players['-1'] === cid) color = -1;
    else if (!players[1]) { players[1] = cid; color = 1; }
    else if (!players['-1']) { players['-1'] = cid; color = -1; }

    socket.emit('rol', color);
    if (state) socket.emit('durum', state);

    socket.on('durum-gonder', (s) => {
        state = s;
        socket.broadcast.emit('durum', s);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Sunucu çalışıyor: http://localhost:' + PORT));