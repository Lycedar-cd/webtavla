const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const WIN_GOLD = 100; // her galibiyette kazanılan altın

// Elo / dereceli maç ayarları (env değişkenleri sadece test içindir, canlıda varsayılanlar geçerli)
const RANK_START = 1000;
const RANK_DELTA = 10;                                                    // kazanan +10, kaybeden -10
const RANKED_MIN_MS = Number(process.env.RANKED_MIN_MS ?? 3 * 60 * 1000);   // bundan kısa maç sayılmaz
const RANKED_MIN_MOVES = Number(process.env.RANKED_MIN_MOVES ?? 20);        // bundan az hamleli maç sayılmaz
const PAIR_LIMIT = Number(process.env.RANKED_PAIR_LIMIT ?? 3);              // aynı iki hesap, günde en fazla
const SEAT_GRACE_MS = Number(process.env.SEAT_GRACE_MS ?? 2 * 60 * 1000);   // bağlantı kopunca koltuk bekleme süresi
const RANKED_JOIN_MS = Number(process.env.RANKED_JOIN_MS ?? 60 * 1000);     // eşleşince rakibin bağlanma süresi
const MATCH_TICK_MS = Number(process.env.MATCH_TICK_MS ?? 2000);            // kuyruk tarama aralığı
const RANGE_STEP_MS = Number(process.env.RANGE_STEP_MS ?? 10 * 1000);       // aralık genişleme adımı
const RANGE_START = 100, RANGE_STEP = 50, RANGE_MAX = 400;

// Mağaza kataloğu. Fiyatlar sadece burada belirlenir, istemci fiyat gönderemez.
const CATALOG = [
    { id: 'tahta_zumrut',  kat: 'tahta', ad: 'Zümrüt Orman',    fiyat: 300 },
    { id: 'tahta_gece',    kat: 'tahta', ad: 'Gece Mavisi',     fiyat: 300 },
    { id: 'tahta_kiraz',   kat: 'tahta', ad: 'Kiraz Ağacı',     fiyat: 400 },
    { id: 'tahta_obsidyen', kat: 'tahta', ad: 'Obsidyen',       fiyat: 600 },
    { id: 'tahta_fener',   kat: 'tahta', ad: 'Fenerbahçe',      fiyat: 500, seri: 'taraftar' },
    { id: 'tahta_gs',      kat: 'tahta', ad: 'Galatasaray',     fiyat: 500, seri: 'taraftar' },
    { id: 'tahta_bjk',     kat: 'tahta', ad: 'Beşiktaş',        fiyat: 500, seri: 'taraftar' },
    { id: 'tahta_ts',      kat: 'tahta', ad: 'Trabzonspor',     fiyat: 500, seri: 'taraftar' },
    { id: 'tas_altin',     kat: 'tas',   ad: 'Altın Taşlar',    fiyat: 500 },
    { id: 'tas_zumrut',    kat: 'tas',   ad: 'Zümrüt Taşlar',   fiyat: 400 },
    { id: 'tas_yakut',     kat: 'tas',   ad: 'Safir & Yakut',   fiyat: 500 },
    { id: 'tas_neon',      kat: 'tas',   ad: 'Neon Taşlar',     fiyat: 600 },
    { id: 'zar_kirmizi',   kat: 'zar',   ad: 'Kırmızı Zar',     fiyat: 300 },
    { id: 'zar_altin',     kat: 'zar',   ad: 'Altın Zar',       fiyat: 400 },
    { id: 'zar_obsidyen',  kat: 'zar',   ad: 'Siyah Zar',       fiyat: 400 },
    { id: 'zar_kristal',   kat: 'zar',   ad: 'Kristal Zar',     fiyat: 500 },
    { id: 'zar_neon',      kat: 'zar',   ad: 'Neon Zar',        fiyat: 600 },
    { id: 'renk_kirmizi',  kat: 'renk',  ad: 'Kırmızı İsim',    fiyat: 150 },
    { id: 'renk_mavi',     kat: 'renk',  ad: 'Mavi İsim',       fiyat: 150 },
    { id: 'renk_yesil',    kat: 'renk',  ad: 'Yeşil İsim',      fiyat: 150 },
    { id: 'renk_mor',      kat: 'renk',  ad: 'Mor İsim',        fiyat: 200 },
    { id: 'renk_altin',    kat: 'renk',  ad: 'Altın İsim',      fiyat: 300 }
];
const CATALOG_BY_ID = Object.fromEntries(CATALOG.map((i) => [i.id, i]));
const CATEGORIES = ['tahta', 'tas', 'zar', 'renk'];

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

/* ------------------------- PWA: iPhone'a uygulama gibi kurulum ------------------------- */
// İkonlar sunucuda koddan çizilir (ek dosya yüklemek gerekmez). iPhone SVG ikon kabul etmediği için PNG üretilir.

const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgb) {
    const raw = Buffer.alloc((size * 3 + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (size * 3 + 1)] = 0; // filtre yok
        rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8 bit, RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', require('zlib').deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

// Zar: kahverengi zemin, krem renkli altın çerçeveli zar, beş nokta. scale: zarın ikona oranı
function renderDice(size, scale) {
    const ss = size > 256 ? 2 : 3; // kenar yumuşatma
    const rgb = Buffer.alloc(size * size * 3);
    const h = scale / 2, r = h * 0.28, border = h * 0.075;
    const dotR = h * 0.13, off = h * 0.5;
    const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const colorAt = (x, y) => {
        const dx = x - 0.5, dy = y - 0.5;
        const dist = Math.sqrt(dx * dx + dy * dy);
        let col = mix([0x2c, 0x1d, 0x11], [0x0f, 0x0a, 0x06], Math.min(1, dist / 0.75)); // arka plan
        const qx = Math.abs(dx) - (h - r), qy = Math.abs(dy) - (h - r);
        const d = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) + Math.min(Math.max(qx, qy), 0) - r;
        if (d <= 0) {
            col = d > -border ? [0xb8, 0x86, 0x0b] : mix([0xff, 0xfb, 0xee], [0xe8, 0xdf, 0xc8], Math.min(1, (dx + dy + 2 * h) / (4 * h)));
            for (const [sx, sy] of [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]]) {
                if ((dx - sx * off) ** 2 + (dy - sy * off) ** 2 <= dotR * dotR) col = [0x22, 0x22, 0x22];
            }
        }
        return col;
    };
    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let R = 0, G = 0, B = 0;
            for (let i = 0; i < ss; i++) for (let j = 0; j < ss; j++) {
                const c = colorAt((px + (i + 0.5) / ss) / size, (py + (j + 0.5) / ss) / size);
                R += c[0]; G += c[1]; B += c[2];
            }
            const n = ss * ss, o = (py * size + px) * 3;
            rgb[o] = Math.round(R / n); rgb[o + 1] = Math.round(G / n); rgb[o + 2] = Math.round(B / n);
        }
    }
    return encodePng(size, rgb);
}

const iconCache = {};
function sendIcon(res, key, size, scale) {
    if (!iconCache[key]) iconCache[key] = renderDice(size, scale);
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.send(iconCache[key]);
}
app.get('/apple-touch-icon.png', (req, res) => sendIcon(res, 'apple', 180, 0.66));
app.get('/icon-192.png', (req, res) => sendIcon(res, 'i192', 192, 0.66));
app.get('/icon-512.png', (req, res) => sendIcon(res, 'i512', 512, 0.66));
app.get('/icon-maskable-512.png', (req, res) => sendIcon(res, 'mask512', 512, 0.5)); // kenarlardan kesilse de zar görünsün

app.get('/manifest.webmanifest', (req, res) => {
    res.set({ 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    res.send(JSON.stringify({
        name: 'Geleneksel Tavla',
        short_name: 'Tavla',
        description: 'Online tavla oyunu',
        lang: 'tr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#0f0a06',
        theme_color: '#0f0a06',
        icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
    }));
});

// Bağlantı yoksa boş sayfa yerine düzgün bir uyarı göster. Önbellek tutmaz, eski sürüm sorunu çıkmaz.
const OFFLINE_HTML = '<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Bağlantı yok</title>' +
    '<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'background:#0f0a06;color:#f3e5ab;font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:24px}' +
    'h1{font-size:22px;margin:12px 0 6px}p{opacity:.7;font-size:14px;margin:0 0 20px}' +
    'button{background:#b45309;color:#fff;border:0;border-radius:12px;padding:12px 28px;font-size:16px;font-weight:700}</style></head>' +
    '<body><div style="font-size:56px">🎲</div><h1>Bağlantı yok</h1>' +
    '<p>İnternetini kontrol edip tekrar dene.</p><button onclick="location.reload()">Tekrar dene</button></body></html>';
const SW_JS = [
    "self.addEventListener('install', () => self.skipWaiting());",
    "self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));",
    'const OFFLINE = ' + JSON.stringify(OFFLINE_HTML) + ';',
    "self.addEventListener('fetch', (event) => {",
    "    if (event.request.mode !== 'navigate') return;",
    "    event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, {",
    "        status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' }",
    '    })));',
    '});'
].join('\n');
app.get('/sw.js', (req, res) => {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    res.send(SW_JS);
});



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
    return {
        id: row.id, username: row.username, gold: row.gold, wins: row.wins,
        kusanilan: await loadEquipped(row.id),
        puan: await ensureRating(row.id)
    };
}

async function ensureRating(userId) {
    let r = await pool.query('SELECT rating, wins, losses FROM ratings WHERE user_id = $1', [userId]);
    if (!r.rows.length) {
        try {
            await pool.query('INSERT INTO ratings (user_id, rating, wins, losses) VALUES ($1, $2, 0, 0)', [userId, RANK_START]);
        } catch (e) {
            if (e.code !== '23505') throw e;
        }
        r = await pool.query('SELECT rating, wins, losses FROM ratings WHERE user_id = $1', [userId]);
    }
    return r.rows[0];
}

async function loadEquipped(userId, db) {
    const r = await (db || pool).query('SELECT item_id FROM inventory WHERE user_id = $1 AND equipped = true', [userId]);
    const out = { tahta: null, tas: null, zar: null, renk: null };
    r.rows.forEach((row) => {
        const it = CATALOG_BY_ID[row.item_id];
        if (it) out[it.kat] = it.id;
    });
    return out;
}

async function shopState(userId) {
    const g = await pool.query('SELECT gold FROM users WHERE id = $1', [userId]);
    const inv = await pool.query('SELECT item_id FROM inventory WHERE user_id = $1', [userId]);
    return {
        altin: g.rows[0] ? g.rows[0].gold : 0,
        katalog: CATALOG,
        sahip: inv.rows.map((r) => r.item_id).filter((id) => CATALOG_BY_ID[id]),
        kusanilan: await loadEquipped(userId)
    };
}

async function authReq(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer ([0-9a-f]{64})$/.exec(h);
    return m ? userFromToken(m[1]) : null;
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

app.get('/api/magaza', async (req, res) => {
    try {
        const user = await authReq(req);
        if (!user) return res.status(401).json({ hata: 'Giriş yapmalısın.' });
        res.json(await shopState(user.id));
    } catch (e) {
        console.error('Mağaza hatası:', e);
        res.status(500).json({ hata: 'Sunucu hatası.' });
    }
});

app.post('/api/satin-al', async (req, res) => {
    let client;
    try {
        const user = await authReq(req);
        if (!user) return res.status(401).json({ hata: 'Giriş yapmalısın.' });
        const item = CATALOG_BY_ID[req.body && req.body.id];
        if (!item) return res.status(400).json({ hata: 'Böyle bir eşya yok.' });

        client = await pool.connect();
        await client.query('BEGIN');

        // 1) Önce eşyayı envantere yaz. Aynı eşya için ikinci bir istek burada reddedilir (altın hiç düşülmez).
        try {
            await client.query('INSERT INTO inventory (user_id, item_id, equipped) VALUES ($1, $2, false)', [user.id, item.id]);
        } catch (e) {
            if (e.code === '23505') {
                try { await client.query('ROLLBACK'); } catch (_) {}
                return res.status(409).json({ hata: 'Bu eşyaya zaten sahipsin.' });
            }
            throw e;
        }

        // 2) Altın, tek sorguda hem kontrol edilir hem düşülür (eksiye düşmez)
        const upd = await client.query(
            'UPDATE users SET gold = gold + $1 WHERE id = $2 AND gold >= $3 RETURNING gold',
            [-item.fiyat, user.id, item.fiyat]);
        if (!upd.rows.length) {
            // Altın yetmedi: eşyayı geri al (ROLLBACK'e ek olarak açıkça siliyoruz)
            await client.query('DELETE FROM inventory WHERE user_id = $1 AND item_id = $2', [user.id, item.id]);
            try { await client.query('ROLLBACK'); } catch (_) {}
            return res.status(402).json({ hata: 'Yeterli altının yok.' });
        }
        await client.query('COMMIT');

        await refreshUser(user.id);
        res.json(await shopState(user.id));
    } catch (e) {
        if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
        if (e.code === '23505') return res.status(409).json({ hata: 'Bu eşyaya zaten sahipsin.' });
        console.error('Satın alma hatası:', e);
        res.status(500).json({ hata: 'Sunucu hatası.' });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/kusan', async (req, res) => {
    let client;
    try {
        const user = await authReq(req);
        if (!user) return res.status(401).json({ hata: 'Giriş yapmalısın.' });
        const kat = req.body && req.body.kat;
        const id = req.body && req.body.id; // null: varsayılana dön
        if (!CATEGORIES.includes(kat)) return res.status(400).json({ hata: 'Geçersiz kategori.' });
        let item = null;
        if (id !== null && id !== undefined) {
            item = CATALOG_BY_ID[id];
            if (!item || item.kat !== kat) return res.status(400).json({ hata: 'Böyle bir eşya yok.' });
            const own = await pool.query('SELECT 1 FROM inventory WHERE user_id = $1 AND item_id = $2', [user.id, id]);
            if (!own.rows.length) return res.status(403).json({ hata: 'Bu eşyaya sahip değilsin.' });
        }

        client = await pool.connect();
        await client.query('BEGIN');
        for (const it of CATALOG.filter((i) => i.kat === kat)) {
            await client.query('UPDATE inventory SET equipped = false WHERE user_id = $1 AND item_id = $2', [user.id, it.id]);
        }
        if (item) {
            await client.query('UPDATE inventory SET equipped = true WHERE user_id = $1 AND item_id = $2', [user.id, item.id]);
        }
        await client.query('COMMIT');

        await refreshUser(user.id);
        res.json(await shopState(user.id));
    } catch (e) {
        if (client) { try { await client.query('ROLLBACK'); } catch (_) {} }
        console.error('Kuşanma hatası:', e);
        res.status(500).json({ hata: 'Sunucu hatası.' });
    } finally {
        if (client) client.release();
    }
});

app.get('/api/liderlik', async (req, res) => {
    try {
        const user = await authReq(req);
        if (!user) return res.status(401).json({ hata: 'Giriş yapmalısın.' });
        const r = await pool.query(
            `SELECT u.username, r.rating, r.wins, r.losses
             FROM ratings r JOIN users u ON u.id = r.user_id
             WHERE r.wins + r.losses > 0
             ORDER BY r.rating DESC, r.wins DESC, u.username ASC
             LIMIT 10`);
        res.json({ liste: r.rows });
    } catch (e) {
        console.error('Liderlik hatası:', e);
        res.status(500).json({ hata: 'Sunucu hatası.' });
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

/* ------------------------------- Odalar ------------------------------ */

const MAX_ROOMS = 50;
const MAX_ROOMS_PER_USER = 3;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map(); // oda kodu -> oda

const roomKey = (code) => 'oda:' + code;

function newRoomCode() {
    for (let i = 0; i < 50; i++) {
        let c = '';
        for (let j = 0; j < 4; j++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
        if (!rooms.has(c)) return c;
    }
    return null;
}

function cleanRoomName(n, fallback) {
    if (typeof n !== 'string') return fallback;
    n = n.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 24);
    return n || fallback;
}

function createRoom(user, ad, gizli) {
    const code = newRoomCode();
    if (!code) return null;
    const room = {
        code,
        ad: cleanRoomName(ad, user.username + ' odası'),
        gizli: !!gizli,
        createdBy: user.id,
        createdAt: Date.now(),
        players: { 1: null, '-1': null }, // role oturan hesap numarası
        state: null,
        chat: [],
        awarded: false,
        online: {},      // hesap -> bu odadaki açık bağlantı sayısı
        seatTimers: {},  // hesap -> koltuğu boşaltma zamanlayıcısı
        deleteTimer: null
    };
    rooms.set(code, room);
    return room;
}

function colorOf(room, userId) {
    if (room.players[1] === userId) return 1;
    if (room.players['-1'] === userId) return -1;
    return null;
}

function seat(room, userId) {
    const c = colorOf(room, userId);
    if (c !== null) return c;
    if (!room.players[1]) { room.players[1] = userId; return 1; }
    if (!room.players['-1']) { room.players['-1'] = userId; return -1; }
    return null;
}

function socketCount(room, exceptId) {
    const set = io.sockets.adapter.rooms.get(roomKey(room.code));
    if (!set) return 0;
    let n = set.size;
    if (exceptId && set.has(exceptId)) n--;
    return n;
}

function scheduleCleanup(room, exceptId) {
    if (room.deleteTimer) { clearTimeout(room.deleteTimer); room.deleteTimer = null; }
    if (socketCount(room, exceptId) > 0) return;
    // Oda 3 dakika boş kalırsa silinir (sayfa yenileme gibi kısa kopmalara tolerans)
    room.deleteTimer = setTimeout(() => {
        if (socketCount(room) > 0) return;
        Object.values(room.seatTimers).forEach(clearTimeout);
        rooms.delete(room.code);
        broadcastLobby();
    }, 3 * 60 * 1000);
}

function roomList() {
    return [...rooms.values()]
        .filter((r) => !r.gizli)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((r) => ({
            kod: r.code,
            ad: r.ad,
            oyuncular: [r.players[1] ? usernameCache[r.players[1]] || '?' : null,
                        r.players['-1'] ? usernameCache[r.players['-1']] || '?' : null],
            dolu: !!(r.players[1] && r.players['-1']),
            izleyici: Math.max(0, socketCount(r) - [r.players[1], r.players['-1']].filter((id) => id && r.online[id] > 0).length)
        }));
}

const usernameCache = {}; // hesap numarası -> kullanıcı adı

let lobbyTimer = null;
function broadcastLobby() {
    // Art arda gelen değişiklikleri tek yayına indir
    if (lobbyTimer) return;
    lobbyTimer = setTimeout(() => {
        lobbyTimer = null;
        io.to('lobi').emit('odalar', roomList());
    }, 100);
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
        rollId: num(s.rollId) ? s.rollId : 0,
        diceBy: s.diceBy === -1 ? -1 : 1
    };
}

async function broadcastPlayers(room) {
    const by = {};
    for (const id of [room.players[1], room.players['-1']].filter(Boolean)) {
        const r = await pool.query('SELECT id, username, gold FROM users WHERE id = $1', [id]);
        if (r.rows[0]) { by[id] = r.rows[0]; usernameCache[id] = r.rows[0].username; }
    }
    const pick = (c, f) => (by[room.players[c]] ? by[room.players[c]][f] : null);
    const key = roomKey(room.code);
    const koz = {};
    for (const c of [1, -1]) {
        const id = room.players[c];
        const eq = id ? await loadEquipped(id) : { tas: null, zar: null, renk: null };
        koz[c] = { tas: eq.tas, zar: eq.zar, renk: eq.renk };
    }
    io.to(key).emit('kozmetik', koz);
    const pu = {};
    for (const c of [1, -1]) {
        pu[c] = room.players[c] ? (await ensureRating(room.players[c])).rating : null;
    }
    io.to(key).emit('puanlar', pu);
    io.to(key).emit('oyuncular', { 1: pick(1, 'username'), '-1': pick(-1, 'username') });
    io.to(key).emit('altinlar', { 1: pick(1, 'gold'), '-1': pick(-1, 'gold') });
    broadcastLobby();
}

async function sendAccountToUser(userId) {
    const r = await pool.query('SELECT username, gold, wins FROM users WHERE id = $1', [userId]);
    if (!r.rows[0]) return;
    const kusanilan = await loadEquipped(userId);
    const puan = await ensureRating(userId);
    const sockets = await io.fetchSockets();
    sockets.forEach((s) => {
        if (s.data.user && s.data.user.id === userId) {
            s.data.user.kusanilan = kusanilan;
            s.data.user.puan = puan;
            s.emit('hesap', { ...r.rows[0], kusanilan, puan });
        }
    });
}

// Satın alma ya da kuşanma sonrası: hesap kutusunu yenile, oturduğu odalara yeni görünümü yay
async function refreshUser(userId) {
    await sendAccountToUser(userId);
    for (const room of rooms.values()) {
        if (colorOf(room, userId) !== null) await broadcastPlayers(room);
    }
}

async function awardWin(room, winnerColor, userId) {
    await pool.query('UPDATE users SET gold = gold + $1, wins = wins + 1 WHERE id = $2', [WIN_GOLD, userId]);
    io.to(roomKey(room.code)).emit('kazanc', { renk: winnerColor, miktar: WIN_GOLD });
    await broadcastPlayers(room);
    await sendAccountToUser(userId);
}

function freeSeat(room, userId) {
    if (room.seatTimers[userId]) { clearTimeout(room.seatTimers[userId]); delete room.seatTimers[userId]; }
    const was = colorOf(room, userId);
    const otherId = was === 1 ? room.players['-1'] : was === -1 ? room.players[1] : null;
    if (room.players[1] === userId) room.players[1] = null;
    if (room.players['-1'] === userId) room.players['-1'] = null;

    if (room.ranked && was !== null) {
        if (room.rankedState === 'bekliyor') {
            cancelRanked(room, 'rakip-ayrildi').catch((e) => console.error(e));
        } else if (room.rankedState === 'oynaniyor' && otherId) {
            finishRanked(room, otherId, userId, 'terk').catch((e) => console.error(e));
        }
    }
    if (!room.players[1] && !room.players['-1']) { room.state = null; room.awarded = false; }
    broadcastPlayers(room).catch((e) => console.error(e));
}

/* --------------------------- Dereceli maç (Elo) --------------------------- */

const queue = new Map(); // hesap -> { userId, socketId, rating, since }

function rangeOf(e) {
    return Math.min(RANGE_MAX, RANGE_START + RANGE_STEP * Math.floor((Date.now() - e.since) / RANGE_STEP_MS));
}

function dequeueSocket(socketId) {
    for (const [uid, e] of queue) {
        if (e.socketId === socketId) queue.delete(uid);
    }
}

async function pairAtLimit(a, b) {
    const key = Math.min(a, b) + '-' + Math.max(a, b);
    const r = await pool.query('SELECT created_at FROM ranked_games WHERE pair_key = $1 AND counted = true', [key]);
    const since = Date.now() - 24 * 60 * 60 * 1000;
    return r.rows.filter((x) => new Date(x.created_at).getTime() > since).length >= PAIR_LIMIT;
}

function createRankedRoom(a, b) {
    const code = newRoomCode();
    if (!code) return null;
    const aWhite = Math.random() < 0.5; // renkler rastgele
    const room = {
        code, ad: 'Dereceli maç', gizli: true, ranked: true, rankedState: 'bekliyor',
        allowed: new Set([a.userId, b.userId]),
        createdBy: a.userId, createdAt: Date.now(),
        players: { 1: aWhite ? a.userId : b.userId, '-1': aWhite ? b.userId : a.userId },
        state: null, chat: [], awarded: false, online: {}, seatTimers: {}, deleteTimer: null,
        moves: 0, gameStart: null, joinTimer: null
    };
    rooms.set(code, room);
    room.joinTimer = setTimeout(() => cancelRanked(room, 'baglanamadi').catch((e) => console.error(e)), RANKED_JOIN_MS);
    return room;
}

// Maç başlamadan bozulduysa: puan değişmez, içerideki oyuncu lobiye döner
async function cancelRanked(room, neden) {
    if (room.rankedState !== 'bekliyor') return;
    room.rankedState = 'iptal';
    if (room.joinTimer) { clearTimeout(room.joinTimer); room.joinTimer = null; }
    const set = io.sockets.adapter.rooms.get(roomKey(room.code));
    for (const id of set ? [...set] : []) {
        const s = io.sockets.sockets.get(id);
        if (!s) continue;
        s.leave(roomKey(room.code));
        s.data.room = null;
        s.join('lobi');
        s.emit('mac-iptal', { neden });
        s.emit('odalar', roomList());
    }
    Object.values(room.seatTimers).forEach(clearTimeout);
    if (room.deleteTimer) clearTimeout(room.deleteTimer);
    rooms.delete(room.code);
    broadcastLobby();
}

// Dereceli maç bitti (normal bitiş ya da terk): puanı işle ve oyunculara bildir
async function finishRanked(room, winnerId, loserId, neden) {
    if (room.rankedState !== 'oynaniyor') return;
    room.rankedState = 'bitti';

    let sayildi = true, sebep = null;
    if (neden === 'bitti' && (Date.now() - room.gameStart < RANKED_MIN_MS || room.moves < RANKED_MIN_MOVES)) {
        sayildi = false; sebep = 'kisa';
    }
    const pairKey = Math.min(winnerId, loserId) + '-' + Math.max(winnerId, loserId);
    if (sayildi && await pairAtLimit(winnerId, loserId)) { sayildi = false; sebep = 'limit'; }

    const lBefore = await ensureRating(loserId);
    await ensureRating(winnerId);
    let wd = 0, ld = 0;
    if (sayildi) {
        wd = RANK_DELTA;
        ld = Math.min(RANK_DELTA, lBefore.rating); // puan 0'ın altına inmez
        await pool.query('UPDATE ratings SET rating = rating + $1, wins = wins + 1 WHERE user_id = $2', [wd, winnerId]);
        await pool.query('UPDATE ratings SET rating = rating + $1, losses = losses + 1 WHERE user_id = $2', [-ld, loserId]);
    }
    await pool.query(
        'INSERT INTO ranked_games (winner_id, loser_id, pair_key, counted, reason, delta) VALUES ($1, $2, $3, $4, $5, $6)',
        [winnerId, loserId, pairKey, sayildi, neden, wd]);

    const wNow = await ensureRating(winnerId);
    const lNow = await ensureRating(loserId);
    const set = io.sockets.adapter.rooms.get(roomKey(room.code));
    for (const id of set ? [...set] : []) {
        const s = io.sockets.sockets.get(id);
        if (!s || !s.data.user) continue;
        const uid = s.data.user.id;
        if (uid === winnerId) s.emit('mac-sonucu', { sonuc: 'kazandi', neden, sayildi, sebep, delta: wd, puan: wNow.rating });
        else if (uid === loserId) s.emit('mac-sonucu', { sonuc: 'kaybetti', neden, sayildi, sebep, delta: -ld, puan: lNow.rating });
    }
    await sendAccountToUser(winnerId);
    await sendAccountToUser(loserId);
    await broadcastPlayers(room);
}

let matching = false;
async function tryMatch() {
    if (matching || queue.size < 2) return;
    matching = true;
    try {
        const entries = [...queue.values()].sort((x, y) => x.since - y.since);
        const used = new Set();
        for (const a of entries) {
            if (used.has(a.userId) || !queue.has(a.userId)) continue;
            const cands = [];
            for (const b of entries) {
                if (b === a || used.has(b.userId) || !queue.has(b.userId)) continue;
                if (Math.abs(a.rating - b.rating) > Math.max(rangeOf(a), rangeOf(b))) continue;
                if (await pairAtLimit(a.userId, b.userId)) continue;
                cands.push(b);
            }
            if (!cands.length) continue;
            const b = cands[Math.floor(Math.random() * cands.length)]; // aralıktakilerden rastgele
            used.add(a.userId); used.add(b.userId);
            queue.delete(a.userId); queue.delete(b.userId);
            const sa = io.sockets.sockets.get(a.socketId);
            const sb = io.sockets.sockets.get(b.socketId);
            const room = sa && sb ? createRankedRoom(a, b) : null;
            if (!room) { // biri kopmuş ya da oda açılamadı: sağlam olanı kuyruğa geri koy
                if (sa) queue.set(a.userId, a);
                if (sb) queue.set(b.userId, b);
                continue;
            }
            sa.emit('eslesti', { kod: room.code });
            sb.emit('eslesti', { kod: room.code });
        }
    } catch (e) {
        console.error('Eşleştirme hatası:', e);
    } finally {
        matching = false;
    }
}
setInterval(tryMatch, MATCH_TICK_MS);

// Bir bağlantıyı bulunduğu odadan çıkarır. aniKoltuk: koltuğu hemen boşalt (odadan ayrıl düğmesi)
function leaveCurrentRoom(socket, aniKoltuk) {
    const code = socket.data.room;
    if (!code) return;
    const room = rooms.get(code);
    socket.leave(roomKey(code));
    socket.data.room = null;
    if (!room) return;

    const uid = socket.data.user.id;
    room.online[uid] = Math.max(0, (room.online[uid] || 1) - 1);

    if (room.online[uid] === 0 && colorOf(room, uid) !== null) {
        if (aniKoltuk) {
            freeSeat(room, uid);
        } else {
            // Bağlantı koptuysa belirli süre içinde dönmezse koltuğu boşalt (dereceli maçta terk sayılır)
            room.seatTimers[uid] = setTimeout(() => freeSeat(room, uid), SEAT_GRACE_MS);
        }
    }
    scheduleCleanup(room, socket.id);
    broadcastPlayers(room).catch((e) => console.error(e));
}

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

io.on('connection', (socket) => {
    const user = socket.data.user;
    usernameCache[user.id] = user.username;
    socket.data.room = null;

    socket.join('lobi');
    socket.emit('hesap', { username: user.username, gold: user.gold, wins: user.wins, kusanilan: user.kusanilan, puan: user.puan });
    socket.emit('odalar', roomList());

    let lastCreate = 0;

    socket.on('oda-kur', (data, ack) => {
        if (typeof ack !== 'function') return;
        try {
            dequeueSocket(socket.id);
            const now = Date.now();
            if (now - lastCreate < 2000) return ack({ hata: 'Biraz yavaş ol, birkaç saniye sonra tekrar dene.' });
            lastCreate = now;
            if (rooms.size >= MAX_ROOMS) return ack({ hata: 'Şu an çok fazla oda açık. Daha sonra tekrar dene.' });
            const mine = [...rooms.values()].filter((r) => r.createdBy === user.id && !r.ranked).length;
            if (mine >= MAX_ROOMS_PER_USER) return ack({ hata: 'Çok fazla açık odan var. Birini kapatmak için odadan ayrıl.' });

            const room = createRoom(user, data && data.ad, data && data.gizli);
            if (!room) return ack({ hata: 'Oda oluşturulamadı, tekrar dene.' });
            ack({ ok: true, kod: room.code });
            broadcastLobby();
        } catch (e) {
            console.error('Oda kurma hatası:', e);
            ack({ hata: 'Sunucu hatası.' });
        }
    });

    socket.on('oda-katil', (data, ack) => {
        if (typeof ack !== 'function') return;
        try {
            const kod = data && typeof data.kod === 'string' ? data.kod.trim().toUpperCase() : '';
            const room = rooms.get(kod);
            if (!room) return ack({ hata: 'Böyle bir oda bulunamadı.' });
            if (room.ranked && !room.allowed.has(user.id)) return ack({ hata: 'Bu bir dereceli maç odası.' });

            dequeueSocket(socket.id);
            if (socket.data.room && socket.data.room !== kod) leaveCurrentRoom(socket, true);
            if (socket.data.room === kod) return ack({ ok: true, kod: room.code, ad: room.ad, dereceli: !!room.ranked });

            if (room.seatTimers[user.id]) { clearTimeout(room.seatTimers[user.id]); delete room.seatTimers[user.id]; }
            if (room.deleteTimer) { clearTimeout(room.deleteTimer); room.deleteTimer = null; }

            socket.leave('lobi');
            socket.join(roomKey(kod));
            socket.data.room = kod;
            room.online[user.id] = (room.online[user.id] || 0) + 1;
            const color = seat(room, user.id);

            // Dereceli maç: iki oyuncu da odaya girince maç başlar
            if (room.ranked && room.rankedState === 'bekliyor') {
                const [x, y] = [...room.allowed];
                if (room.online[x] > 0 && room.online[y] > 0) {
                    room.rankedState = 'oynaniyor';
                    room.gameStart = Date.now();
                    if (room.joinTimer) { clearTimeout(room.joinTimer); room.joinTimer = null; }
                }
            }

            // Önce cevabı gönder, sonra oda verilerini (istemci sırayla işler)
            ack({ ok: true, kod: room.code, ad: room.ad, dereceli: !!room.ranked });
            socket.emit('rol', color);
            if (room.state) socket.emit('durum', room.state);
            socket.emit('sohbet-gecmis', room.chat);
            broadcastPlayers(room).catch((e) => console.error(e));
        } catch (e) {
            console.error('Odaya katılma hatası:', e);
            ack({ hata: 'Sunucu hatası.' });
        }
    });

    socket.on('esles-ara', async (a, b) => {
        const ack = typeof a === 'function' ? a : b;
        if (typeof ack !== 'function') return;
        try {
            if (socket.data.room) return ack({ hata: 'Önce bulunduğun odadan ayrıl.' });
            const puan = await ensureRating(user.id);
            const old = queue.get(user.id);
            if (old && old.socketId !== socket.id) {
                const os = io.sockets.sockets.get(old.socketId);
                if (os) os.emit('kuyruk-iptal');
            }
            queue.set(user.id, { userId: user.id, socketId: socket.id, rating: puan.rating, since: Date.now() });
            ack({ ok: true });
            tryMatch();
        } catch (e) {
            console.error('Kuyruk hatası:', e);
            ack({ hata: 'Sunucu hatası.' });
        }
    });

    socket.on('esles-iptal', (a, b) => {
        const ack = typeof a === 'function' ? a : b;
        dequeueSocket(socket.id);
        if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('oda-ayril', (a, b) => {
        const ack = typeof a === 'function' ? a : b;
        leaveCurrentRoom(socket, true);
        socket.join('lobi');
        socket.emit('odalar', roomList());
        if (typeof ack === 'function') ack({ ok: true });
    });

    socket.on('durum-gonder', async (raw) => {
        try {
            const room = rooms.get(socket.data.room);
            if (!room) return;
            const c = colorOf(room, user.id);
            if (c === null) return; // izleyiciler oyunu değiştiremez
            const s = cleanState(raw);
            if (!s) return;

            if (room.ranked) {
                if (room.rankedState !== 'oynaniyor') return;                 // başlamamış ya da bitmiş maçta durum değişmez
                if (room.state && s.rollId < room.state.rollId) return;       // yeniden başlatma (sıfırlama) yok
            }
            const prev = room.state;
            if (room.ranked && prev && s.rollId === prev.rollId && s.movesLeft.length < prev.movesLeft.length) {
                room.moves += prev.movesLeft.length - s.movesLeft.length;     // tüketilen her zar bir hamle
            }
            room.state = s;
            socket.to(roomKey(room.code)).emit('durum', s);

            const winner = s.off.p1 === 15 ? 1 : s.off.p2 === 15 ? -1 : null;
            if (winner === null) { room.awarded = false; return; }
            if (room.awarded || winner !== c) return;
            const key = winner === 1 ? 'p1' : 'p2';
            if (!prev || !prev.off || prev.off[key] < 11) return; // tek hamlede 15'e sıçrayamaz
            room.awarded = true;
            await awardWin(room, winner, user.id);
            if (room.ranked) {
                const loserId = room.players[winner === 1 ? '-1' : 1];
                if (loserId) await finishRanked(room, user.id, loserId, 'bitti');
            }
        } catch (e) {
            console.error('Durum hatası:', e);
        }
    });

    let lastChat = 0;
    socket.on('chat', (text) => {
        const room = rooms.get(socket.data.room);
        if (!room || typeof text !== 'string') return;
        text = text.trim().slice(0, 200);
        if (!text) return;
        const now = Date.now();
        if (now - lastChat < 300) return;
        lastChat = now;
        const msg = {
            renk: colorOf(room, user.id), isim: user.username, sid: socket.id, text,
            isimRengi: (socket.data.user.kusanilan && socket.data.user.kusanilan.renk) || null
        };
        room.chat.push(msg);
        if (room.chat.length > 50) room.chat.shift();
        io.to(roomKey(room.code)).emit('chat', msg);
    });

    socket.on('disconnect', () => {
        dequeueSocket(socket.id);
        leaveCurrentRoom(socket, false);
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
    await pool.query(`CREATE TABLE IF NOT EXISTS inventory (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        equipped BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (user_id, item_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ratings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL DEFAULT 1000,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ranked_games (
        id SERIAL PRIMARY KEY,
        winner_id INTEGER NOT NULL,
        loser_id INTEGER NOT NULL,
        pair_key TEXT NOT NULL,
        counted BOOLEAN NOT NULL,
        reason TEXT NOT NULL,
        delta INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log('Sunucu çalışıyor: http://localhost:' + PORT));
}

init().catch((e) => {
    console.error('Başlatma hatası:', e);
    process.exit(1);
});
