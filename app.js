
/**
 * app.js
 * Node.js + Telegraf Telegram bot with Violet Media payment integration and /callback.php
 *
 * - Reads configuration from .vars.json (or environment variables as fallback)
 * - SQLite DB for users, pending_deposits, topup_log
 * - /callback.php endpoint for Violet Media callbacks
 * - /topup <amount> command to create a Violet transaction and send payment info to user
 *
 * NOTE: Put sensitive keys (BOT_TOKEN, VIOLET_APIKEY, VIOLET_SECRET, USER_ID, GROUP_ID, DOMAIN)
 * into .vars.json (and add .vars.json to .gitignore). Example .vars.json content was provided earlier.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();

// -------------------- Load config --------------------
const VARS_PATH = path.resolve(__dirname, '.vars.json');
let vars = {};
if (fs.existsSync(VARS_PATH)) {
  try {
    vars = JSON.parse(fs.readFileSync(VARS_PATH, 'utf8'));
    console.log('[CONFIG] Loaded .vars.json');
  } catch (e) {
    console.error('[CONFIG] Failed to parse .vars.json:', e.message);
    process.exit(1);
  }
} else {
  console.warn('[CONFIG] .vars.json not found — falling back to environment variables.');
  vars.BOT_TOKEN = process.env.BOT_TOKEN;
  vars.VIOLET_APIKEY = process.env.VIOLET_APIKEY;
  vars.VIOLET_SECRET = process.env.VIOLET_SECRET;
  vars.DOMAIN = process.env.DOMAIN;
  vars.USER_ID = process.env.USER_ID;
  vars.GROUP_ID = process.env.GROUP_ID;
  vars.PORT = process.env.PORT || 3000;
}

const BOT_TOKEN = vars.BOT_TOKEN || process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('FATAL: BOT_TOKEN is not set in .vars.json or environment.');
  process.exit(1);
}

const VIOLET_API_URL = (vars.VIOLET_API_URL || 'https://violetmediapay.com/api/live').replace(/\/+$/, '');
const VIOLET_APIKEY = vars.VIOLET_APIKEY || process.env.VIOLET_APIKEY;
const VIOLET_SECRET = vars.VIOLET_SECRET || process.env.VIOLET_SECRET;
const DOMAIN = vars.DOMAIN || process.env.DOMAIN || 'sagivpn.my.id';

const ADMIN_USER = vars.USER_ID ? (Array.isArray(vars.USER_ID) ? vars.USER_ID : Number(vars.USER_ID)) : null;
const GROUP_ID = vars.GROUP_ID ? Number(vars.GROUP_ID) : null;
const PORT = Number(vars.PORT || 50123);
const TRUSTED_IPS = (vars.VIOLET_TRUSTED_IPS || '36.50.77.77').split(',').map(s=>s.trim()).filter(Boolean);

// -------------------- Setup DB (SQLite) --------------------
const DB_PATH = path.resolve(__dirname, 'bot_data.sqlite');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Failed to open database:', err.message);
    process.exit(1);
  }
  console.log('[DB] Opened', DB_PATH);
});

function dbRunAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
function dbGetAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}
function dbAllAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// Init tables
(async function initDb() {
  await dbRunAsync(`CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    saldo INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await dbRunAsync(`CREATE TABLE IF NOT EXISTS pending_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unique_code TEXT UNIQUE,
    user_id INTEGER,
    amount INTEGER,
    original_amount INTEGER,
    status TEXT,
    data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await dbRunAsync(`CREATE TABLE IF NOT EXISTS topup_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    amount INTEGER,
    reference TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  console.log('[DB] Tables ensured');
})().catch(err => { console.error('DB init error', err); process.exit(1); });

// -------------------- Setup Telegraf --------------------
const bot = new Telegraf(BOT_TOKEN);

// Middleware: ensure user exists in DB
bot.use(async (ctx, next) => {
  try {
    const uid = ctx.from && ctx.from.id;
    if (uid) {
      const user = await dbGetAsync('SELECT * FROM users WHERE user_id = ?', [uid]);
      if (!user) {
        await dbRunAsync('INSERT INTO users (user_id, username, saldo) VALUES (?, ?, ?)', [uid, ctx.from.username || '', 0]);
      } else if (user.username !== ctx.from.username) {
        // update username if changed
        await dbRunAsync('UPDATE users SET username = ? WHERE user_id = ?', [ctx.from.username || '', uid]);
      }
    }
  } catch (e) {
    console.warn('Middleware DB user check failed:', e.message);
  }
  return next();
});

bot.start(async (ctx) => {
  const uid = ctx.from.id;
  const user = await dbGetAsync('SELECT * FROM users WHERE user_id = ?', [uid]);
  const saldo = user ? (user.saldo || 0) : 0;
  const txt = `Halo, ${ctx.from.first_name || ctx.from.username || 'User'}!\n\nSaldo kamu: Rp${Number(saldo).toLocaleString('id-ID')}\n\nGunakan /topup <nominal> untuk mengisi saldo.`;
  return ctx.reply(txt);
});

bot.command('saldo', async (ctx) => {
  const uid = ctx.from.id;
  const user = await dbGetAsync('SELECT * FROM users WHERE user_id = ?', [uid]);
  const saldo = user ? (user.saldo || 0) : 0;
  return ctx.reply(`Saldo kamu: Rp${Number(saldo).toLocaleString('id-ID')}`);
});

// /topup <amount>
bot.command('topup', async (ctx) => {
  try {
    const parts = ctx.message.text.split(/\s+/);
    if (parts.length < 2) return ctx.reply('Usage: /topup 10000');
    const amount = parseInt(parts[1].replace(/\D/g,''), 10);
    if (!amount || amount <= 0) return ctx.reply('Nominal tidak valid.');

    // generate ref
    const ref_kode = generateRef();
    const url_callback = `https://${DOMAIN}/callback.php`;

    // save pending deposit before calling API
    await dbRunAsync(`INSERT INTO pending_deposits (unique_code, user_id, amount, original_amount, status, data) VALUES (?, ?, ?, ?, ?, ?)`, [ref_kode, ctx.from.id, amount, amount, 'pending', '']);

    // create transaction at Violet Media
    const createResp = await createVioletTransaction({
      amount,
      method: 'QRIS',
      ref_kode,
      cus_nama: ctx.from.first_name || ctx.from.username || `User_${ctx.from.id}`,
      cus_email: '',
      cus_phone: '',
      produk: 'TopUp Saldo',
      url_redirect: '',
      url_callback
    });

    // store response JSON into pending_deposits.data
    await dbRunAsync('UPDATE pending_deposits SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE unique_code = ?', [JSON.stringify(createResp.data || createResp), ref_kode]);

    // try to extract useful info for user
    let userMessage = `🔖 Ref: ${ref_kode}\nNominal: Rp${Number(amount).toLocaleString('id-ID')}\n\n`;
    if (createResp && createResp.data) {
      // try common fields: data.payment_url, data.qr, data.data, data.invoice, etc.
      const d = createResp.data;
      if (d.payment_url) {
        userMessage += `Silakan bayar melalui tautan berikut:\n${d.payment_url}`;
      } else if (d.data && d.data.url) {
        userMessage += `Silakan bayar melalui tautan berikut:\n${d.data.url}`;
      } else if (d.qr) {
        userMessage += `QR Data tersedia. Jika client mu mendukung, kirimkan QR ke user.`;
        // If API returns base64 image, we could send photo. Not assuming here.
        userMessage += `\n\nDebug: ${JSON.stringify(d).slice(0,300)}...`;
      } else {
        userMessage += `Response payment: ${JSON.stringify(d).slice(0,400)}...`;
      }
    } else {
      userMessage += 'Gagal mendapatkan data pembayaran dari gateway.';
    }

    await ctx.reply(userMessage);
  } catch (err) {
    console.error('Topup error', err && err.message || err);
    return ctx.reply('Terjadi kesalahan saat membuat transaksi. Coba lagi nanti.');
  }
});

// Admin-only: /check_tx <ref>
bot.command('check_tx', async (ctx) => {
  const uid = ctx.from.id;
  if (ADMIN_USER && uid !== Number(ADMIN_USER) && !(Array.isArray(ADMIN_USER) && ADMIN_USER.includes(uid))) {
    return ctx.reply('Perintah ini hanya untuk admin.');
  }
  const parts = ctx.message.text.split(/\s+/);
  if (parts.length < 2) return ctx.reply('Usage: /check_tx <ref_kode>');
  const ref = parts[1].trim();
  try {
    const resp = await axios.post(`${VIOLET_API_URL}/transactions`, new URLSearchParams({
      api_key: VIOLET_APIKEY,
      secret_key: VIOLET_SECRET,
      ref: String(ref),
      ref_id: ''
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
    return ctx.reply('Resp: ' + JSON.stringify(resp.data));
  } catch (e) {
    return ctx.reply('Gagal cek transaksi: ' + (e.message || 'error'));
  }
});

// Launch bot
bot.launch().then(()=>console.log('[BOT] Bot started')).catch(e=>{ console.error('Bot launch error', e); process.exit(1); });

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// -------------------- Express server --------------------
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// helper: generate ref
function generateRef() {
  const t = Date.now().toString();
  const rnd = Math.random().toString(36).slice(2,8);
  return `${t}${rnd}`;
}

// create signature for create transaction per docs: HMAC-SHA256(ref_kode + apikey + amount, secret_key)
function createCreateSignature(ref_kode, apikey, amount) {
  const payload = `${ref_kode}${apikey}${amount}`;
  return crypto.createHmac('sha256', VIOLET_SECRET).update(payload).digest('hex');
}

// create transaction wrapper
async function createVioletTransaction({ amount, method = 'QRIS', ref_kode, cus_nama = 'User', cus_email = '', cus_phone = '', produk = 'TopUp', url_redirect = '', url_callback = '' }) {
  if (!VIOLET_APIKEY || !VIOLET_SECRET) throw new Error('Violet API key/secret not configured');
  if (!ref_kode) ref_kode = generateRef();
  const signature = createCreateSignature(ref_kode, VIOLET_APIKEY, String(amount));

  const postData = new URLSearchParams();
  postData.append('api_key', VIOLET_APIKEY);
  postData.append('secret_key', VIOLET_SECRET);
  postData.append('channel_payment', method);
  postData.append('ref_kode', ref_kode);
  postData.append('nominal', String(amount));
  postData.append('cus_nama', cus_nama);
  postData.append('cus_email', cus_email);
  postData.append('cus_phone', cus_phone);
  postData.append('produk', produk);
  if (url_redirect) postData.append('url_redirect', url_redirect);
  if (url_callback) postData.append('url_callback', url_callback);
  postData.append('expired_time', String(Math.floor(Date.now()/1000) + 24*60*60));
  postData.append('signature', signature);

  const res = await axios.post(`${VIOLET_API_URL}/create`, postData.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000
  });
  return res.data;
}

// Express route: optional utility to create payment from external system
app.post('/create_payment', async (req, res) => {
  try {
    const { user_id, amount, method = 'QRIS' } = req.body;
    if (!user_id || !amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'user_id & amount harus valid' });
    }
    const ref_kode = generateRef();
    const url_callback = `https://${DOMAIN}/callback.php`;
    await dbRunAsync('INSERT INTO pending_deposits (unique_code, user_id, amount, original_amount, status) VALUES (?, ?, ?, ?, ?)', [ref_kode, user_id, Number(amount), Number(amount), 'pending']);
    const createResp = await createVioletTransaction({
      amount: Number(amount),
      method,
      ref_kode,
      cus_nama: `User_${user_id}`,
      cus_email: '',
      cus_phone: '',
      produk: 'TopUp Saldo',
      url_redirect: '',
      url_callback
    });
    await dbRunAsync('UPDATE pending_deposits SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE unique_code = ?', [JSON.stringify(createResp.data || createResp), ref_kode]);
    return res.json({ success: true, data: createResp, ref_kode });
  } catch (err) {
    console.error('create_payment error', err && err.message || err);
    return res.status(500).json({ success: false, message: err.message || 'error' });
  }
});

// Callback endpoint - per Violet Media docs, verifying signature: signature = HMAC-SHA256(ref, apikey)
app.post('/callback.php', async (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.ref) {
      console.warn('Callback missing ref or body empty');
      return res.status(400).send('bad request');
    }
    const refid = String(data.ref);
    const incomingSignature = String(data.signature || '');
    const expectedSig = crypto.createHmac('sha256', String(VIOLET_APIKEY)).update(refid).digest('hex');

    const remoteIp = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();

    if (incomingSignature !== expectedSig) {
      console.warn(`Callback signature mismatch for ref ${refid}. incoming=${incomingSignature} expected=${expectedSig} from ${remoteIp}`);
      return res.status(403).send('forbidden');
    }

    // optional IP check
    if (TRUSTED_IPS.length > 0 && !TRUSTED_IPS.includes(remoteIp)) {
      console.warn(`Callback from untrusted IP ${remoteIp} for ref ${refid}`);
      return res.status(403).send('forbidden');
    }

    const status = String(data.status || '').toLowerCase();
    const pending = await dbGetAsync('SELECT * FROM pending_deposits WHERE unique_code = ?', [refid]);
    if (!pending) {
      console.warn(`Callback for unknown ref ${refid}. Data:`, data);
      // For safety, respond 404 so operator can inspect; do not credit unknown ref automatically.
      return res.status(404).send('not_found');
    }

    if (status === 'success') {
      await dbRunAsync('UPDATE pending_deposits SET status = ?, data = ?, updated_at = CURRENT_TIMESTAMP WHERE unique_code = ?', ['success', JSON.stringify(data), refid]);

      // credit user
      const userRow = await dbGetAsync('SELECT * FROM users WHERE user_id = ?', [pending.user_id]);
      if (!userRow) {
        console.error('User not found when processing success callback:', pending.user_id);
      } else {
        const newSaldo = (parseInt(userRow.saldo || 0) + parseInt(pending.amount || 0));
        await dbRunAsync('UPDATE users SET saldo = ? WHERE user_id = ?', [newSaldo, pending.user_id]);
        await dbRunAsync('INSERT INTO topup_log (user_id, username, amount, reference) VALUES (?, ?, ?, ?)', [pending.user_id, userRow.username || '', pending.amount, refid]);

        // notify user
        try {
          await bot.telegram.sendMessage(pending.user_id, `✅ Pembayaran berhasil!\nRef: ${refid}\nJumlah: Rp${Number(pending.amount).toLocaleString('id-ID')}\nSaldo baru: Rp${Number(newSaldo).toLocaleString('id-ID')}`);
        } catch (e) {
          console.warn('Gagal kirim notifikasi user:', e.message);
        }

        // notify admin(s)
        const adminText = `💳 TOPUP BERHASIL\nUser: ${pending.user_id}\nRef: ${refid}\nJumlah: Rp${Number(pending.amount).toLocaleString('id-ID')}`;
        try {
          if (GROUP_ID) await bot.telegram.sendMessage(GROUP_ID, adminText, { parse_mode: 'Markdown' });
          if (ADMIN_USER) {
            if (Array.isArray(ADMIN_USER)) {
              for (const a of ADMIN_USER) {
                await bot.telegram.sendMessage(a, adminText).catch(()=>{});
              }
            } else {
              await bot.telegram.sendMessage(ADMIN_USER, adminText).catch(()=>{});
            }
          }
        } catch (e) {
          console.warn('Failed to notify admin/group:', e.message);
        }
      }

      return res.status(200).send('OK');
    } else if (status === 'kadaluarsa' || status === 'expired') {
      await dbRunAsync('UPDATE pending_deposits SET status = ?, data = ?, updated_at = CURRENT_TIMESTAMP WHERE unique_code = ?', ['expired', JSON.stringify(data), refid]);
      console.info('Payment expired for', refid);
      return res.status(200).send('OK');
    } else {
      await dbRunAsync('UPDATE pending_deposits SET status = ?, data = ?, updated_at = CURRENT_TIMESTAMP WHERE unique_code = ?', ['failed', JSON.stringify(data), refid]);
      console.info('Payment status not-success for', refid, 'status=', status);
      return res.status(200).send('OK');
    }

  } catch (err) {
    console.error('Error handling callback:', err && err.message || err);
    return res.status(500).send('error');
  }
});

// Basic homepage
app.get('/', (req, res) => {
  res.send('Telegram bot + Violet Media integration is running.');
});

// Start express server
app.listen(PORT, () => {
  console.log(`[HTTP] Server listening on port ${PORT} (callback endpoint: POST https://${DOMAIN}/callback.php)`);
});

// -------------------- Helper: graceful exit for DB --------------------
process.on('SIGINT', () => {
  console.log('Shutting down...');
  db.close(() => {
    console.log('DB closed');
    process.exit(0);
  });
});

// -------------------- End of app.js --------------------
