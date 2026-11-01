const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let players = { 1: null, '-1': null }; // her role ait sekme kimliği
let names = {};                         // sekme kimliği -> kullanıcı adı
let state = null;                       // son oyun durumu
let chatHistory = [];                   // son sohbet mesajları

function cleanName(n) {
    if (typeof n !== 'string') return null;
    n = n.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 16);
    return n || null;
}

function playerNames() {
    return {
        1: names[players[1]] || null,
        '-1': names[players['-1']] || null
    };
}

// Roller takılırsa bu adresi aç: /sifirla
app.get('/sifirla', (req, res) => {
    players = { 1: null, '-1': null };
    state = null;
    chatHistory = [];
    io.emit('oyuncular', playerNames());
    res.send('Roller, oyun ve sohbet sifirlandi. Simdi oyun sayfasini acabilirsiniz.');
});

io.on('connection', (socket) => {
    const auth = socket.handshake.auth || {};
    const cid = auth.clientId || socket.id;

    const savedName = cleanName(auth.name);
    if (savedName) names[cid] = savedName;

    let color = null;
    if (players[1] === cid) color = 1;
    else if (players['-1'] === cid) color = -1;
    else if (!players[1]) { players[1] = cid; color = 1; }
    else if (!players['-1']) { players['-1'] = cid; color = -1; }

    socket.emit('rol', color);
    if (state) socket.emit('durum', state);
    socket.emit('sohbet-gecmis', chatHistory);
    io.emit('oyuncular', playerNames());

    socket.on('isim', (n) => {
        const name = cleanName(n);
        if (!name) return;
        names[cid] = name;
        io.emit('oyuncular', playerNames());
    });

    socket.on('durum-gonder', (s) => {
        state = s;
        socket.broadcast.emit('durum', s);
    });

    socket.on('chat', (text) => {
        if (typeof text !== 'string') return;
        text = text.trim().slice(0, 200);
        if (!text) return;
        const msg = {
            renk: color,
            isim: names[cid] || null,
            sid: socket.id,
            text
        };
        chatHistory.push(msg);
        if (chatHistory.length > 50) chatHistory.shift();
        io.emit('chat', msg);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Sunucu çalışıyor: http://localhost:' + PORT));
