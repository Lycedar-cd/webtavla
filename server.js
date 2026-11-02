const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const WIN_GOLD = 100; // her galibiyette kazanılan altın

if (!process.env.DATABASE_URL) {
    console.error('HATA: DATABASE_URL tanımlı değil. Neon bağlantı adresini ortam değişkeni olarak ekleyin.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : true,
    max: 5,
    idleTimeoutMillis: 10000
});
pool.on('error', (e) => console.error('Veritabanı bağlantı hatası:', e.message));

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '2kb' }));

// Sadece oyun sayfası dışarı açılır (server.js vb. görünmez)
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ---------------------------- Hesap sistemi ---------------------------- */

const attempts = new Map();
function tooManyAttempts(ip) {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
    list.push(now);
    attempts.set(ip, list);
    return list.length > 20;
}
setInterval(() => attempts.clear(), 60 * 60 * 1000);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DUMMY_HASH = bcrypt.hashSync('dummy-password', 10);

async function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)', [sha256(token), userId]);
    return token;
}

async function userFromToken(token) {
    if (typeof token !== 'string' || token.length !== 64) return null;
    const r = await pool.query(
        `SELECT u.id, u.username, u.gold, u.wins, s.created_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1`, [sha256(token)]);
    if (!r.rows.length) return null;
    const row = r.rows[0];
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs > 90 * 24 * 60 * 60 * 1000) return null; // 90 gün sonra tekrar giriş
    return { id: row.id, username: row.username, gold: row.gold, wins: row.wins };
}

function validUsername(u) {
    return typeof u === 'string' && /^[\p{L}\p{N}_-]{3,16}$/u.test(u);
}
function validPassword(p) {
    return typeof p === 'string' && p.length >= 6 && Buffer.byteLength(p) <= 72;
}

app.post('/api/kayit', async (req, res) => {
    try {
        if (tooManyAttempts(req.ip)) return res.status(429).json({ hata: 'Çok fazla deneme. Biraz sonra tekrar dene.' });
        const { username, password } = req.body || {};
        if (!validUsername(username)) {
            return res.status(400).json({ hata: 'Kullanıcı adı 3-16 karakter olmalı (harf, rakam, _ ve - kullanılabilir).' });
        }
        if (!validPassword(password)) {
            return res.status(400).json({ hata: 'Şifre en az 6 karakter olmalı.' });
        }
        const hash = await bcrypt.hash(password, 10);
        let userId;
        try {
            const r = await pool.query(
                'INSERT INTO users (username, username_lower, pass_hash) VALUES ($1, $2, $3) RETURNING id',
                [username, username.toLocaleLowerCase('tr-TR'), hash]);
            userId = r.rows[0].id;
        } catch (e) {
            if (e.code === '23505') return res.status(409).json({ hata: 'Bu kullanıcı adı alınmış.' });
            throw e;
        }
        const token = await createSession(userId);
        res.json({ token, username });
    } catch (e) {
        console.error('Kayıt hatası:', e);
        res.status(500).json({ hata: 'Sunucu hatası, tekrar dene.' });
    }
});

app.post('/api/giris', async (req, res) => {
    try {
        if (tooManyAttempts(req.ip)) return res.status(429).json({ hata: 'Çok fazla deneme. Biraz sonra tekrar dene.' });
        const { username, password } = req.body || {};
        if (typeof username !== 'string' || typeof password !== 'string') {
            return res.status(400).json({ hata: 'Kullanıcı adı ve şifre gerekli.' });
        }
        const r = await pool.query(
            'SELECT id, username, pass_hash FROM users WHERE username_lower = $1',
            [username.trim().toLocaleLowerCase('tr-TR')]);
        const user = r.rows[0];
        const ok = await bcrypt.compare(password, user ? user.pass_hash : DUMMY_HASH);
        if (!user || !ok) return res.status(401).json({ hata: 'Kullanıcı adı veya şifre hatalı.' });
        const token = await createSession(user.id);
        res.json({ token, username: user.username });
    } catch (e) {
        console.error('Giriş hatası:', e);
        res.status(500).json({ hata: 'Sunucu hatası, tekrar dene.' });
    }
});

app.post('/api/cikis', async (req, res) => {
    try {
        const token = req.body && req.body.token;
        if (typeof token === 'string') {
            await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
        }
    } catch (e) {
        console.error('Çıkış hatası:', e);
    }
    res.json({ ok: true });
});

/* ------------------------------- Oyun durumu ------------------------------ */

let players = { 1: null, '-1': null }; // role oturan hesap numarası
let state = null;                       // son oyun durumu
let chatHistory = [];                   // son sohbet mesajları
let awarded = false;                    // bu oyun için altın verildi mi?
const online = {};                      // hesap -> açık bağlantı sayısı
const seatTimers = {};                  // hesap -> koltuğu boşaltma zamanlayıcısı

function colorOf(userId) {
    if (players[1] === userId) return 1;
    if (players['-1'] === userId) return -1;
    return null;
}

function seat(userId) {
    const c = colorOf(userId);
    if (c !== null) return c;
    if (!players[1]) { players[1] = userId; return 1; }
    if (!players['-1']) { players['-1'] = userId; return -1; }
    return null;
}

function cleanState(s) {
    const num = (x) => Number.isFinite(x);
    if (!s || typeof s !== 'object') return null;
    if (!Array.isArray(s.board) || s.board.length !== 24 || !s.board.every(num)) return null;
    if (s.turn !== 1 && s.turn !== -1) return null;
    const bar = s.bar, off = s.off;
    if (!bar || !off || !num(bar.p1) || !num(bar.p2) || !num(off.p1) || !num(off.p2)) return null;
    if (!Array.isArray(s.dice) || !Array.isArray(s.movesLeft)) return null;
    if (!s.dice.every(num) || !s.movesLeft.every(num)) return null;
    return {
        board: s.board,
        turn: s.turn,
        bar: { p1: bar.p1, p2: bar.p2 },
        off: { p1: off.p1, p2: off.p2 },
        dice: s.dice.slice(0, 2),
        movesLeft: s.movesLeft.slice(0, 4),
        logHistory: (Array.isArray(s.logHistory) ? s.logHistory : [])
            .filter((x) => typeof x === 'string').slice(0, 50).map((x) => x.slice(0, 200)),
        rollId: num(s.rollId) ? s.rollId : 0
    };
}

async function broadcastPlayers() {
    const ids = [players[1], players['-1']].filter(Boolean);
    const by = {};
    for (const id of ids) {
        const r = await pool.query('SELECT id, username, gold FROM users WHERE id = $1', [id]);
        if (r.rows[0]) by[id] = r.rows[0];
    }
    const pick = (c, f) => (by[players[c]] ? by[players[c]][f] : null);
    io.emit('oyuncular', { 1: pick(1, 'username'), '-1': pick(-1, 'username') });
    io.emit('altinlar', { 1: pick(1, 'gold'), '-1': pick(-1, 'gold') });
}

async function sendAccountToUser(userId) {
    const r = await pool.query('SELECT username, gold, wins FROM users WHERE id = $1', [userId]);
    if (!r.rows[0]) return;
    const sockets = await io.fetchSockets();
    sockets.forEach((s) => {
        if (s.data.user && s.data.user.id === userId) s.emit('hesap', r.rows[0]);
    });
}

async function awardWin(winnerColor, userId) {
    await pool.query('UPDATE users SET gold = gold + $1, wins = wins + 1 WHERE id = $2', [WIN_GOLD, userId]);
    io.emit('kazanc', { renk: winnerColor, miktar: WIN_GOLD });
    await broadcastPlayers();
    await sendAccountToUser(userId);
}

// Roller takılırsa bu adresi aç: /sifirla
app.get('/sifirla', async (req, res) => {
    players = { 1: null, '-1': null };
    state = null;
    chatHistory = [];
    awarded = false;
    res.send('Roller, oyun ve sohbet sifirlandi. Sayfayi yenileyin.');
    io.disconnectSockets(true);
});

io.use(async (socket, next) => {
    try {
        const token = socket.handshake.auth && socket.handshake.auth.token;
        const user = await userFromToken(token);
        if (!user) return next(new Error('auth'));
        socket.data.user = user;
        next();
    } catch (e) {
        console.error('Bağlantı doğrulama hatası:', e);
        next(new Error('sunucu'));
    }
});

io.on('connection', async (socket) => {
    const user = socket.data.user;

    online[user.id] = (online[user.id] || 0) + 1;
    if (seatTimers[user.id]) { clearTimeout(seatTimers[user.id]); delete seatTimers[user.id]; }

    const color = seat(user.id);
    socket.emit('rol', color);
    socket.emit('hesap', { username: user.username, gold: user.gold, wins: user.wins });
    if (state) socket.emit('durum', state);
    socket.emit('sohbet-gecmis', chatHistory);
    broadcastPlayers().catch((e) => console.error(e));

    socket.on('durum-gonder', async (raw) => {
        try {
            const c = colorOf(user.id);
            if (c === null) return; // izleyiciler oyunu değiştiremez
            const s = cleanState(raw);
            if (!s) return;

            const prev = state;
            state = s;
            socket.broadcast.emit('durum', s);

            const winner = s.off.p1 === 15 ? 1 : s.off.p2 === 15 ? -1 : null;
            if (winner === null) { awarded = false; return; }
            if (awarded || winner !== c) return;
            const key = winner === 1 ? 'p1' : 'p2';
            if (!prev || !prev.off || prev.off[key] < 11) return; // tek hamlede 15'e sıçrayamaz
            awarded = true;
            await awardWin(winner, user.id);
        } catch (e) {
            console.error('Durum hatası:', e);
        }
    });

    let lastChat = 0;
    socket.on('chat', (text) => {
        if (typeof text !== 'string') return;
        text = text.trim().slice(0, 200);
        if (!text) return;
        const now = Date.now();
        if (now - lastChat < 300) return;
        lastChat = now;
        const msg = { renk: colorOf(user.id), isim: user.username, sid: socket.id, text };
        chatHistory.push(msg);
        if (chatHistory.length > 50) chatHistory.shift();
        io.emit('chat', msg);
    });

    socket.on('disconnect', () => {
        online[user.id] = Math.max(0, (online[user.id] || 1) - 1);
        if (online[user.id] === 0 && colorOf(user.id) !== null) {
            // 2 dakika içinde dönmezse koltuğu boşalt
            seatTimers[user.id] = setTimeout(() => {
                if (players[1] === user.id) players[1] = null;
                if (players['-1'] === user.id) players['-1'] = null;
                if (!players[1] && !players['-1']) { state = null; awarded = false; }
                broadcastPlayers().catch((e) => console.error(e));
            }, 2 * 60 * 1000);
        }
    });
});

/* --------------------------------- Başlat --------------------------------- */

async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        username_lower TEXT NOT NULL UNIQUE,
        pass_hash TEXT NOT NULL,
        gold INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log('Sunucu çalışıyor: http://localhost:' + PORT));
}

init().catch((e) => {
    console.error('Başlatma hatası:', e);
    process.exit(1);
});
