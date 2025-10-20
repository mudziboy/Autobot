// 🌐 Core Modules
const os = require('os');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const app = express();
const axios = require('axios');
const cron = require('node-cron');
const fetch = require('node-fetch');
const crypto = require('crypto');
const util = require('util');
const { URLSearchParams } = require('url'); // ✅ Final Fix: Deklarasi URLSearchParams

const TELEGRAM_UPLOAD_DIR = '/root/BotVPN2/uploaded_restore';
const BACKUP_DIR = '/root/BotVPN2/backups';
const DB_PATH = path.resolve('./sellvpn.db');
const UPLOAD_DIR = '/root/BotVPN2/uploaded_restore';

// Buat folder kalau belum ada
if (!fs.existsSync(TELEGRAM_UPLOAD_DIR)) fs.mkdirSync(TELEGRAM_UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// 🛠️ Load Config (.vars.json) lebih awal
const vars = JSON.parse(fs.readFileSync('./.vars.json', 'utf8'));
const {
  BOT_TOKEN,
  USER_ID,
  GROUP_ID,
  PORT = 50123,
  NAMA_STORE = 'SagiStore',
  VIOLET_API_KEY,
  VIOLET_SECRET_KEY,
  VIOLET_CALLBACK_URL,
  VIOLET_API_PRODUCTION
} = vars;

// 📦 Tools
const { promisify } = require('util');
const { Telegraf, session } = require('telegraf');
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const execAsync = util.promisify(exec);
const dns = require('dns').promises;

// 🧠 Admin List
const rawAdmin = USER_ID;
const adminIds = Array.isArray(rawAdmin) ? rawAdmin.map(String) : [String(rawAdmin)];


// 📝 Logger
const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${level.toUpperCase()}]: ${message}`
    )
  ),
  transports: [
    new winston.transports.File({ filename: 'bot-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'bot-combined.log' })
  ]
});
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}
logger.info('Bot initialized');

// =========================================
// ✅ KONEKSI DB & PROMISIFY (DIPINDAHKAN KE ATAS UNTUK STABILITAS)
// =========================================
// 🗄️ SQLite Init
const db = new sqlite3.Database('./sellvpn.db', (err) => {
  if (err) {
    logger.error('Kesalahan koneksi SQLite3:', err.message);
  } else {
    logger.info('Terhubung ke SQLite3');
  }
});

// Promisify db methods (Wajib untuk Express Callback)
const dbGetAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

const dbAllAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

const dbRunAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) reject(err);
    else resolve(this);
  });
});
// =========================================


// 🕛 Reset trial_count_today setiap hari jam 00:00
cron.schedule('0 0 * * *', async () => {
  try {
    await dbRunAsync(`UPDATE users SET trial_count_today = 0, last_trial_date = date('now')`);
    logger.info('✅ Berhasil reset trial harian semua user.');
  } catch (err) {
    logger.error('❌ Gagal reset trial harian:', err.message);
  }
});

// Jadwal restart harian 04:00
cron.schedule('0 4 * * *', () => {
  logger.warn('🌀 Restart harian bot (jadwal 04:00)...');
  exec('pm2 restart sellvpn', async (err, stdout, stderr) => {
    if (err) {
      logger.error('❌ Gagal restart via PM2:', err.message);
    } else {
      logger.info('✅ Bot berhasil direstart oleh scheduler harian.');

      const restartMsg = `♻️ Bot di-restart otomatis (jadwal harian).\n🕓 Waktu: ${new Date().toLocaleString('id-ID')}`;
      try {
        await bot.telegram.sendMessage(GROUP_ID || adminIds[0], restartMsg);
        logger.info('📢 Notifikasi restart harian dikirim.');
      } catch (e) {
        logger.warn('⚠️ Gagal kirim notifikasi restart:', e.message);
      }
    }
  });
});

// ✅ RESET KOMISI BULANAN OTOMATIS TIAP TANGGAL 1 JAM 01:00
cron.schedule('0 1 1 * *', () => {
  db.serialize(() => {
    db.run(`DELETE FROM reseller_sales`, (err) => {
      if (err) {
        logger.error('❌ Gagal reset reseller_sales otomatis:', err.message);
      } else {
        logger.info('✅ reseller_sales berhasil direset otomatis bulanan');
      }
    });

    db.run(`UPDATE users SET reseller_level = 'silver' WHERE role = 'reseller'`, (err) => {
      if (err) {
        logger.error('❌ Gagal reset level reseller otomatis:', err.message);
      } else {
        logger.info('✅ Level reseller direset jadi silver (otomatis)');
      }
    });

    if (GROUP_ID) {
      bot.telegram.sendMessage(GROUP_ID, `🧹 *Reset Komisi Bulanan:*\n\nSemua komisi reseller telah direset dan level dikembalikan ke *SILVER*.`, {
        parse_mode: 'Markdown'
      }).catch((err) => {
        logger.error('❌ Gagal kirim notifikasi reset bulanan:', err.message);
      });
    }
  });
});

// 📡 Express Middleware
app.use(express.json({
    // 🚨 KRITIS: Tambahkan ini untuk menyimpan raw body (dibutuhkan untuk signature check)
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

app.use(express.urlencoded({ extended: true })); // Pertahankan untuk form data biasa

// ===========================
// 📦 CALLBACK VIOLET MEDIA (Versi Final & Async/Await Aman)
// ===========================
app.post("/callback.php", async (req, res) => {
  const data = req.body;
  const clientIp =
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "";

  const API_KEY = VIOLET_API_KEY.trim();
  const SECRET_KEY = VIOLET_SECRET_KEY.trim();
  const logPath = path.join(__dirname, "report", "callback.log");

  // Alamat IP yang diizinkan (Wajib ada di UFW/Firewall)
  const ALLOWED_IPS = [
    "127.0.0.1",
    "::1",
    "202.155.132.37", // VioletMedia IPv4 resmi
    "2001:df7:5300:9::122"     // VioletMedia IPv6 resmi
  ];

  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logPath, line);
    logger.info(msg);
  };

  try {
    log(`📩 [CALLBACK] Diterima dari ${clientIp}: ${JSON.stringify(data)}`);

    const ref = String(data.ref || data.ref_kode || "");
    const status = (data.status || "").toLowerCase();
    const nominal = Number(data.nominal) || 0; // Nominal yang dibayar user

    const receivedSignature = data.signature || "";
    
    // 🔑 Hitung ulang signature lokal (ref_kode + apikey + nominal)
    const localSignature = createVioletSignature(ref, nominal); 

    const normalizedIp = clientIp.replace("::ffff:", "").trim();
    const isIpAllowed = ALLOWED_IPS.includes(normalizedIp);
    const isSignatureValid = localSignature === receivedSignature;

    log(`→ Local Signature  : ${localSignature}`);
    log(`→ Remote Signature : ${receivedSignature}`);
    log(`→ Status           : ${status}`);
    log(`→ IP Valid         : ${isIpAllowed}`);

    // ✅ Validasi Final
    if (isSignatureValid && isIpAllowed) {
      if (status === "success") {
        log(`✅ Callback sukses — transaksi ${ref} diverifikasi.`);
        
        // --- START LOGIC TRANSAKSI ASYNC ---
        const row = await dbGetAsync("SELECT * FROM pending_deposits WHERE unique_code = ? LIMIT 1", [ref]);

        if (!row) {
          log(`⚠️ Tidak ditemukan transaksi dengan ref ${ref} di pending_deposits.`);
          return res.json({ status: true });
        }

        if (String(row.status).toLowerCase() === "success" || String(row.status).toLowerCase() === "paid") {
          log(`ℹ️ Transaksi ${ref} sudah ditandai 'paid', abaikan callback duplikat.`);
          return res.json({ status: true });
        }

        const userId = row.user_id;
        const amount = Number(row.amount) || 0; // Nominal yang diinvoice

        // 1️⃣ Update status transaksi menjadi 'success'
        await dbRunAsync("UPDATE pending_deposits SET status = 'success' WHERE unique_code = ?", [ref]);

        // 2️⃣ Tambahkan saldo user
        const result = await dbRunAsync(
          "UPDATE users SET saldo = COALESCE(saldo, 0) + ? WHERE user_id = ?",
          [amount, userId]
        );

        if (result.changes === 0) {
          log(`⚠️ User ${userId} tidak ditemukan di tabel users.`);
        } else {
          log(`💰 Saldo user ${userId} bertambah sebesar ${amount}.`);
        }
        
        // 3️⃣ Kirim notifikasi ke user dan grup (menggunakan fungsi helper)
        await sendTopupNotification(userId, amount, true);
        
        log(`📨 Notifikasi Telegram terkirim untuk user ${userId} dan grup.`);
        // --- END LOGIC TRANSAKSI ASYNC ---

        return res.json({ status: true });

      } else if (status === "kadaluarsa" || status === "expired") {
        log(`⚠️ Callback kadaluarsa — transaksi ${ref} ditandai expired.`);
        await dbRunAsync("UPDATE pending_deposits SET status = 'expired' WHERE unique_code = ?", [ref]);
        await sendTopupNotification(row?.user_id || null, nominal, false, 'kadaluarsa');
        return res.json({ status: true });
      } else {
        log(`ℹ️ Callback status tidak dikenal (${status}) untuk ref ${ref}.`);
        return res.json({ status: true });
      }
    } else {
      log(`❌ Callback invalid — signature (${isSignatureValid}) atau IP (${isIpAllowed}) tidak valid.`);
      return res.status(400).json({ status: false });
    }
  } catch (err) {
    log(`💥 Error callback (Fatal): ${err.message}`);
    return res.status(500).json({ status: false, error: err.message });
  }
});

// 📂 Load Modules

const { createssh } = require('./modules/createSSH');
const { createvmess } = require('./modules/createVMESS');
const { createvless } = require('./modules/createVLESS');
const { createtrojan } = require('./modules/createTROJAN');
const { createshadowsocks } = require('./modules/createSHADOWSOCKS');

const { renewssh } = require('./modules/renewSSH');
const { renewvmess } = require('./modules/renewVMESS');
const { renewvless } = require('./modules/renewVLESS');
const { renewtrojan } = require('./modules/renewTROJAN');
const { renewshadowsocks } = require('./modules/renewSHADOWSOCKS');


// Inisialisasi tabel reseller_upgrade_log
(async () => {
  try {
    await dbRunAsync(`
      CREATE TABLE IF NOT EXISTS reseller_upgrade_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        amount INTEGER,
        level TEXT,
        created_at TEXT
      )
    `);
    console.log('✅ Tabel reseller_upgrade_log siap digunakan.');
  } catch (error) {
    console.error('❌ Gagal membuat tabel reseller_upgrade_log:', error.message);
  }
})();

// 🔄 Cache status sistem (biar gak query terus)
const cacheStatus = {
  jumlahServer: 0,
  jumlahPengguna: 0,
  lastUpdated: 0  // timestamp dalam ms
};

///Coba markdown
const escapeMarkdownV2 = (text) => {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
};

//testerr
db.run(`ALTER TABLE users ADD COLUMN username TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column name')) {
    logger.error('❌ Gagal menambahkan kolom username:', err.message);
  } else {
    logger.info('✅ Kolom username ditambahkan ke tabel users');
  }
});
//bawaan
db.serialize(() => {
  // Tabel Users
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE,
    saldo INTEGER DEFAULT 0,
    role TEXT DEFAULT 'user',
    reseller_level TEXT DEFAULT 'silver',
    has_trial INTEGER DEFAULT 0,
    username TEXT,
    first_name TEXT
  )`);

  // Tabel Reseller Sales
  db.run(`CREATE TABLE IF NOT EXISTS reseller_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reseller_id INTEGER,
    buyer_id INTEGER,
    akun_type TEXT,
    username TEXT,
    komisi INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Akun Aktif
  db.run(`CREATE TABLE IF NOT EXISTS akun_aktif (
    username TEXT PRIMARY KEY,
    jenis TEXT
  )`);

  // Tabel Invoice Log
  db.run(`CREATE TABLE IF NOT EXISTS invoice_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    layanan TEXT,
    akun TEXT,
    hari INTEGER,
    harga INTEGER,
    komisi INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Pending Deposit
  db.run(`CREATE TABLE IF NOT EXISTS pending_deposits (
    unique_code TEXT PRIMARY KEY,
    user_id INTEGER,
    amount INTEGER,
    original_amount INTEGER,
    timestamp INTEGER,
    status TEXT,
    qr_message_id INTEGER
  )`);

  // Tabel Trial Logs
  db.run(`CREATE TABLE IF NOT EXISTS trial_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    jenis TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Server
  db.run(`CREATE TABLE IF NOT EXISTS Server (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT,
    auth TEXT,
    harga INTEGER,
    nama_server TEXT,
    quota INTEGER,
    iplimit INTEGER,
    batas_create_akun INTEGER,
    total_create_akun INTEGER DEFAULT 0
  )`);

  // Tabel Transaksi
  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT,
    username TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Transfer Saldo
  db.run(`CREATE TABLE IF NOT EXISTS saldo_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER,
    to_id INTEGER,
    amount INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Tabel Log Transfer (alternatif historis)
  db.run(`CREATE TABLE IF NOT EXISTS transfer_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER,
    to_id INTEGER,
    jumlah INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
});

db.run(`
  CREATE TABLE IF NOT EXISTS topup_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    amount INTEGER,
    reference TEXT,
    created_at TEXT
  )
`, (err) => {
  if (err) {
    console.error('❌ Gagal membuat tabel topup_log:', err.message);
  } else {
    console.log('✅ Tabel topup_log siap digunakan.');
  }
});

db.run(`ALTER TABLE Server ADD COLUMN isp TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column name')) {
    logger.error('❌ Gagal tambah kolom isp:', err.message);
  }
});
db.run(`ALTER TABLE Server ADD COLUMN lokasi TEXT`, (err) => {
  if (err && !err.message.includes('duplicate column name')) {
    logger.error('❌ Gagal tambah kolom lokasi:', err.message);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS akun (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  jenis TEXT,
  username TEXT,
  server_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

db.run(`ALTER TABLE users ADD COLUMN last_trial_date TEXT`, () => {});
db.run(`ALTER TABLE users ADD COLUMN trial_count_today INTEGER DEFAULT 0`, () => {});

const userState = {};
global.adminState = {}; // Untuk menyimpan context step admin
logger.info('User state initialized');

// Fungsi untuk escape karakter Markdown Telegram
function escapeMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/_/g, '\\_')
    .replace(/\*/g, '\\*')
    .replace(//g, '\')
    .replace(//g, '\')
    .replace(//g, '\')
    .replace(//g, '\')
    .replace(/~/g, '\\~')
    .replace(/`/g, '\\`')
    .replace(/>/g, '\\>')
    .replace(/#/g, '\\#')
    .replace(/\+/g, '\\+')
    .replace(/-/g, '\\-')
    .replace(/=/g, '\\=')
    .replace(/\|/g, '\\|')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\./g, '\\.')
    .replace(/!/g, '\\!');
}
function getFlagEmojiByLocation(location) {
  const map = {
    'Singapore, SG': '🇸🇬',
    'Indonesia': '🇮🇩',
    'Japan': '🇯🇵',
    'USA': '🇺🇸',
    'Germany': '🇩🇪',
    'Malaysia': '🇲🇾',
    'France': '🇫🇷',
    'Netherlands': '🇳🇱',
    'United Kingdom': '🇬🇧',
    'India': '🇮🇳',
    'Thailand': '🇹🇭',
    'Hong Kong': '🇭🇰'
  };

  // Default emoji kalau tidak cocok
  return map[location?.trim()] || '??';
}
// ===== VIOLETMEDIA UTILITY =====

// PENTING: Perbaiki formula signature yang lebih fleksibel
function createVioletSignature(ref_kode, amount, rawBody = null) { 
    const secret_key = VIOLET_SECRET_KEY.trim();
    
    // --- MODE CALLBACK (MENGGUNAKAN RAW BODY) ---
    if (rawBody) {
        // Formula Tripay: hash_hmac('sha256', rawBody, secret_key)
        return crypto.createHmac('sha256', secret_key).update(rawBody).digest('hex');
    }
    
    // --- MODE REQUEST TRANSAKSI (QRIS) ---
    // Formula Umum API VioletMedia: ref_kode + apikey + amount
    const apikey = VIOLET_API_KEY.trim();
    const dataToHash = ref_kode + apikey + String(amount);
    
    return crypto.createHmac('sha256', secret_key).update(dataToHash).digest('hex');
}

async function requestVioletTransaction(userId, amount, email, phone, paymentMethodCode) {
    const randomSuffix = Math.floor(Math.random() * 9000 + 1000); // 4 digit acak
const ref_kode = `sagivpn_${userId}_${Date.now()}_${randomSuffix}`;
    const signature = createVioletSignature(ref_kode, String(amount)); 
    
    // --- 1. GUNAKAN URLSearchParams ---
    const formData = new URLSearchParams();
    formData.append("api_key", VIOLET_API_KEY.trim());
    formData.append("secret_key", VIOLET_SECRET_KEY.trim());
    formData.append("channel_payment", paymentMethodCode);
    formData.append("ref_kode", ref_kode);
    formData.append("nominal", amount);
    formData.append("cus_nama", email.split('@')[0]);
    formData.append("cus_email", email);
    formData.append("cus_phone", phone);
    formData.append("produk", `TopUp Saldo ${NAMA_STORE} - ${amount}`);
    formData.append("url_redirect", VIOLET_CALLBACK_URL.replace('callback.php', 'redirect.php'));
    formData.append("url_callback", VIOLET_CALLBACK_URL);
    formData.append("expired_time", Math.floor(Date.now() / 1000) + 3600); // 1 jam expired (dalam detik)
    formData.append("signature", signature);
    // ----------------------------------

    try {
        const url = `${VIOLET_API_PRODUCTION}create`;
        
        // --- 2. KONFIGURASI AXIOS: Form URL Encoded ---
        const config = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 30000 
        };
        
        // --- DEBUG LOGGING DITAMBAHKAN DI SINI ---
        logger.info(`[VIOLET TRANS] Mengirim transaksi Ref: ${ref_kode}, Amount: ${amount}`);
        
        const response = await axios.post(url, formData, config);
        
        // --- DEBUG LOGGING RESPON ---
        logger.info(`[VIOLET TRANS RESPON] Status: ${response.data.status}, Data: ${JSON.stringify(response.data.data)}`);
        logger.info(`[VIOLET TRANS DEBUG] QR String Check: ${response.data.data?.qr_string ? 'DITERIMA' : 'TIDAK ADA'}`);
        // -----------------------------

        if (response.data.status !== true) {
             logger.error(`❌ VIOLET Transaksi Gagal. Pesan: ${response.data.message || JSON.stringify(response.data)}`);
        }

        return response.data; // Mengembalikan {status: true/false, data: {...}}
        
    } catch (error) {
        logger.error('❌ VIOLET API Request Failed:', error.message);
        if (error.response) {
            logger.error(`❌ VIOLET Transaksi HTTP Error: ${JSON.stringify(error.response.data)}`);
        }
        return { status: false, message: 'Koneksi ke Payment Gateway gagal.' };
    }
}



// ===== UTILITY TAMBAHAN =====

// Fungsi untuk menghapus pesan (penting untuk cleaning state)
async function safeDeleteMessage(ctxOrBot, chatId, messageId = null) {
  try {
    const targetChatId = chatId || ctxOrBot.chat.id;
    const targetMessageId = messageId || ctxOrBot.callbackQuery.message.message_id;

    if (targetChatId && targetMessageId) {
        await ctxOrBot.telegram.deleteMessage(targetChatId, targetMessageId);
    }
  } catch (e) {
    // Abaikan jika pesan tidak ditemukan atau tidak bisa dihapus
  }
}

// Fungsi untuk mendapatkan email dan phone (harus ada userState)
async function getUserContact(userId) {
    // Karena bot Anda tidak menyimpan email/phone, kita buat dummy
    // Di aplikasi nyata, Anda harus query DB untuk ini
    const user = await dbGetAsync('SELECT username FROM users WHERE user_id = ?', [userId]);
    const name = user?.username || 'user' + userId;

    return {
        email: `${name}@sagivpn.my.id`,
        phone: '628123456789'
    };
}

// Fungsi bantu parsing output JSON dari shell
function parseJsonOutput(raw) {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      return JSON.parse(raw.substring(start, end + 1));
    }
    throw new Error('Output tidak mengandung JSON');
  } catch (e) {
    throw new Error('Gagal parsing JSON: ' + e.message);
  }
}

// Fungsi bantu kirim pesan dengan penanganan error
async function safeSend(bot, chatId, message, extra = {}) {
  try {
    await bot.telegram.sendMessage(chatId, message, extra);
  } catch (err) {
    console.warn(`⚠️ Gagal kirim ke ${chatId}: ${err.message}`);
  }
}

function cleanupOrphanResellers() {
  db.all(`
    SELECT DISTINCT reseller_id FROM reseller_sales
    WHERE reseller_id NOT IN (SELECT user_id FROM users)
  `, (err, rows) => {
    if (err) return console.error("❌ Gagal cek reseller yatim:", err.message);

    if (rows.length === 0) {
      console.log("✅ Tidak ada reseller yatim.");
      return;
    }

    const orphanIds = rows.map(row => row.reseller_id);
    console.log("⚠️ Reseller yatim ditemukan:", orphanIds);

    const placeholders = orphanIds.map(() => '?').join(',');
    db.run(`
      DELETE FROM reseller_sales WHERE reseller_id IN (${placeholders})
    `, orphanIds, function (err) {
      if (err) return console.error("❌ Gagal hapus reseller yatim:", err.message);
      console.log(`✅ ${this.changes} baris reseller_sales berhasil dibersihkan.`);
    });
  });
}

// Fungsi helper promisify db.all
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// Panggil saat startup
cleanupOrphanResellers();

// =========================================
// ✅ 4. COMMAND /start dan /menu
// =========================================
bot.command(['start', 'menu'], async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || 'User';

  try {
    await dbRunAsync(`
      INSERT INTO users (user_id, username, first_name)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET username = ?, first_name = ?
    `, [userId, username, firstName, username, firstName]);

    logger.info(`✅  User ${userId} berhasil terdaftar / diperbarui`);
  } catch (err) {
    logger.error('❌ Kesalahan saat menyimpan user:', err.message);
    return ctx.reply('❌ Gagal menyimpan data user. Silakan coba lagi.');
  }

  await sendMainMenu(ctx);
});
// Command Admin
bot.command('admin', async (ctx) => {
  const userId = ctx.from.id;
  logger.info(`🔐 Permintaan akses admin dari ${userId}`);

  if (!adminIds.includes(String(userId))) {
    return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu admin.');
  }

  await sendAdminMenu(ctx);
});

bot.command('invoice_last', async (ctx) => {
  const userId = String(ctx.from.id);
  const isAdmin = adminIds.includes(userId);
  const input = ctx.message.text.split(' ')[1];

  let targetUsername = input?.replace('@', '').trim();
  let query, params;

  if (isAdmin && targetUsername) {
    query = `
      SELECT * FROM invoice_log
      WHERE username = ?
      ORDER BY created_at DESC
      LIMIT 1
    `;
    params = [targetUsername];
  } else {
    query = `
      SELECT * FROM invoice_log
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `;
    params = [userId];
  }

  try {
    const row = await dbGetAsync(query, params);

    if (!row) {
      return ctx.reply('📭 Tidak ditemukan invoice terakhir.');
    }

    const invoice = `
🧾 *INVOICE TERAKHIR*
━━━━━━━━━━━━━━━━━━━━━━
👤 *User:* ${row.username}
📦 *Layanan:* *${row.layanan.toUpperCase()}*
🔐 *Username:* \`${row.akun}\`
📅 *Durasi:* *${row.hari} hari*
💸 *Harga:* *Rp${row.harga.toLocaleString('id-ID')}*
${row.komisi ? `💰 *Komisi:* *Rp${row.komisi.toLocaleString('id-ID')}*` : ''}
🕒 *Waktu:* ${new Date(row.created_at).toLocaleString('id-ID')}
━━━━━━━━━━━━━━━━━━━━━━
`.trim();

    ctx.reply(invoice, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error('❌ Gagal ambil invoice terakhir:', err.message);
    ctx.reply('❌ Gagal mengambil data invoice.');
  }
});

bot.command('cleardummy', async (ctx) => {
  if (!adminIds.includes(String(ctx.from.id))) return;

  db.run("DELETE FROM reseller_sales WHERE username = 'testakun'", function(err) {
    if (err) {
      logger.error('❌ Gagal hapus data dummy:', err.message);
      return ctx.reply('❌ Gagal hapus data dummy.');
    }

    ctx.reply(`🧹 Berhasil hapus ${this.changes} data dummy (username: testakun).`);
  });
});

bot.command('statadmin', async (ctx) => {
  const userId = String(ctx.from.id);

  if (!adminIds.includes(userId)) {
    return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.');
  }

  try {
    const [jumlahUser, jumlahReseller, jumlahServer, totalSaldo] = await Promise.all([
      dbGetAsync('SELECT COUNT(*) AS count FROM users'),
      dbGetAsync("SELECT COUNT(*) AS count FROM users WHERE role = 'reseller'"),
      dbGetAsync('SELECT COUNT(*) AS count FROM Server'),
      dbGetAsync('SELECT SUM(saldo) AS total FROM users')
    ]);

    const replyText = `
📊 *Statistik Sistem*:

👥 Total Pengguna : *${jumlahUser.count}*
👑 Total Reseller : *${jumlahReseller.count}*
🖥️ Total Server   : *${jumlahServer.count}*
💰 Total Saldo     : *Rp${(totalSaldo.total || 0).toLocaleString('id-ID')}*
`.trim();

    await ctx.reply(replyText, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error('❌ Gagal ambil statistik admin:', err.message);
    await ctx.reply('❌ Gagal mengambil statistik.');
  }
});

bot.command('komisi', async (ctx) => {
  const userId = ctx.from.id;

  try {
    const user = await dbGetAsync('SELECT role, reseller_level FROM users WHERE user_id = ?', [userId]);

    if (!user || user.role !== 'reseller') {
      return ctx.reply('❌ Kamu bukan reseller.');
    }

    const summary = await dbGetAsync('SELECT COUNT(*) AS total_akun, SUM(komisi) AS total_komisi FROM reseller_sales WHERE reseller_id = ?', [userId]);
    
    // Menggunakan dbAllAsync untuk mendapatkan riwayat
    const rows = await dbAllAsync('SELECT akun_type, username, komisi, created_at FROM reseller_sales WHERE reseller_id = ? ORDER BY created_at DESC LIMIT 5', [userId]);
    
    const level = user.reseller_level ? user.reseller_level.toUpperCase() : 'SILVER';

    const list = rows.map((r, i) =>
      `🔹 ${r.akun_type.toUpperCase()} - ${r.username} (+${r.komisi}) 🕒 ${r.created_at}`
    ).join('\n');

    const text = `💰 *Statistik Komisi Reseller*\n\n` +
      `🎖️ Level: ${level}\n` +
      `🧑‍💻 Total Akun Terjual: ${summary.total_akun}\n` +
      `💸 Total Komisi: Rp${summary.total_komisi || 0}\n\n` +
      `📜 *Transaksi Terbaru:*\n${list}`;

    ctx.reply(text, { parse_mode: 'Markdown' });

  } catch (err) {
    logger.error('❌ Gagal ambil data komisi:', err.message);
    ctx.reply('❌ Gagal mengambil data komisi.');
  }
});


        const level = user.reseller_level ? user.reseller_level.toUpperCase() : 'SILVER';

        const list = rows.map((r, i) =>
          `🔹 ${r.akun_type.toUpperCase()} - ${r.username} (+${r.komisi}) 🕒 ${r.created_at}`
        ).join('\n');

        const text = `💰 *Statistik Komisi Reseller*\n\n` +
          `🎖️ Level: ${level}\n` +
          `🧑‍💻 Total Akun Terjual: ${summary.total_akun}\n` +
          `💸 Total Komisi: Rp${summary.total_komisi || 0}\n\n` +
          `📜 *Transaksi Terbaru:*\n${list}`;

        ctx.reply(text, { parse_mode: 'Markdown' });
      });
    });
  });
});

bot.command('send_backup', async (ctx) => {
  const input = ctx.message.text.split(' ');
  const filename = input[1];

  if (!filename) {
    return ctx.reply('❗ Format salah.\nContoh: `/send_backup backup_2025-06-10T21-30-00.enc`', { parse_mode: 'Markdown' });
  }

  const filePath = path.join(__dirname, 'restore', filename);

  if (!fs.existsSync(filePath)) {
    return ctx.reply(`❌ File \`${filename}\` tidak ditemukan di folder restore.`, { parse_mode: 'Markdown' });
  }

  try {
    await ctx.replyWithDocument({ source: filePath, filename });
  } catch (err) {
    logger.error('❌ Gagal kirim file backup:', err.message);
    ctx.reply('❌ Gagal mengirim file.');
  }
});

bot.command('list_backup', (ctx) => {
  const folderPath = path.join(__dirname, 'restore');

  if (!fs.existsSync(folderPath)) {
    return ctx.reply('📂 Folder `restore/` belum ada.');
  }

  const files = fs.readdirSync(folderPath)
    .filter(file => file.endsWith('.enc') || file.endsWith('.sql') || file.endsWith('.db'));

  if (files.length === 0) {
    return ctx.reply('📭 Tidak ada file backup ditemukan di folder `restore/`.');
  }

  const message = files
    .sort((a, b) => fs.statSync(path.join(folderPath, b)).mtime - fs.statSync(path.join(folderPath, a)).mtime)
    .map(file => {
      const stats = fs.statSync(path.join(folderPath, file));
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      return `📄 *${file}* — \`${sizeMB} MB\``;
    })
    .join('\n');

  ctx.reply(`📦 *Daftar File Backup:*\n\n${message}`, { parse_mode: 'Markdown' });
});


bot.command('cancel_restore', (ctx) => {
  if (ctx.session?.restoreMode) {
    ctx.session.restoreMode = null;
    return ctx.reply('❎ Mode restore telah *dibatalkan*.', { parse_mode: 'Markdown' });
  }

  ctx.reply('ℹ️ Tidak ada mode restore yang sedang aktif.');
});


bot.command('logtransfer', (ctx) => {
  const userId = ctx.from.id;

  db.get('SELECT role FROM users WHERE user_id = ?', [userId], (err, user) => {
    if (err || !user || user.role !== 'reseller') {
      return ctx.reply('❌ Kamu bukan reseller.');
    }

    db.all(
      `SELECT * FROM saldo_transfers WHERE from_id = ? ORDER BY created_at DESC LIMIT 5`,
      [userId],
      (err, rows) => {
        if (err || rows.length === 0) {
          return ctx.reply('📭 Belum ada log transfer.');
        }

        const list = rows.map(r =>
          `🔁 Rp${r.amount} ke \`${r.to_id}\` - 🕒 ${r.created_at}`
        ).join('\n');

        ctx.reply(`📜 *Riwayat Transfer Saldo:*\n\n${list}`, { parse_mode: 'Markdown' });
      }
    );
  });
});

bot.command('exportkomisi', (ctx) => {
  const userId = ctx.from.id;

  db.get('SELECT role FROM users WHERE user_id = ?', [userId], (err, row) => {
    if (err || !row || row.role !== 'reseller') {
      return ctx.reply('❌ Kamu bukan reseller.');
    }

    db.all('SELECT akun_type, username, komisi, created_at FROM reseller_sales WHERE reseller_id = ? ORDER BY created_at DESC LIMIT 20', [userId], (err, rows) => {
      if (err) {
        return ctx.reply('❌ Gagal mengambil data komisi.');
      }

      const now = new Date().toLocaleString('id-ID');
      let content = `===== LAPORAN KOMISI RESELLER =====\n\n`;
      content += `🧑‍💻 Reseller ID : ${userId}\n📅 Tanggal Export: ${now}\n\n`;
      content += `#  | Akun Type | Username   | Komisi | Tanggal\n`;
      content += `--------------------------------------------------\n`;

      rows.forEach((r, i) => {
        content += `${i + 1}  | ${r.akun_type.toUpperCase()}     | ${r.username.padEnd(10)} | ${r.komisi}     | ${r.created_at}\n`;
      });

      const filename = `komisi_${userId}.txt`;
      fs.writeFileSync(filename, content);

      ctx.replyWithDocument({ source: filename, filename }, {
        caption: '📁 Laporan Komisi Terbaru',
      });

      // Opsional: hapus file setelah dikirim
      setTimeout(() => fs.unlinkSync(filename), 5000);
    });
  });
});


bot.command('export_log', async (ctx) => {
  const userId = ctx.from.id;
  if (`${userId}` !== `${USER_ID}`) return ctx.reply('❌ Akses ditolak.');

  const filename = `/tmp/transactions-${Date.now()}.csv`;

  db.all('SELECT * FROM transactions ORDER BY created_at DESC', [], (err, rows) => {
    if (err) return ctx.reply('❌ Gagal ambil data.');

    const headers = Object.keys(rows[0] || {}).join(',') + '\n';
    const content = rows.map(r => Object.values(r).join(',')).join('\n');

    require('fs').writeFileSync(filename, headers + content);

    ctx.replyWithDocument({ source: filename });
  });
});


bot.command('promotereseller', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(String(ctx.from.id))) {
  return ctx.reply('🚫 Anda tidak memiliki izin untuk mengakses menu admin.');
}

  const args = ctx.message.text.split(' ');
  if (args.length !== 2) {
    return ctx.reply('❗ Format: /promotereseller <user_id>');
  }

  const targetUserId = parseInt(args[1]);
  if (isNaN(targetUserId)) {
    return ctx.reply('❌ user_id harus berupa angka.');
  }

  db.run('UPDATE users SET role = "reseller" WHERE user_id = ?', [targetUserId], function (err) {
    if (err) {
      logger.error('❌ Error update role reseller:', err.message);
      return ctx.reply('❌ Gagal update role reseller.');
    }
    ctx.reply(`✅ User ${targetUserId} kini menjadi RESELLER.`);
  });
});

bot.command('hapuslog', async (ctx) => {
  if (!adminIds.includes(ctx.from.id)) return ctx.reply('Tidak ada izin!');
  try {
    if (fs.existsSync('bot-combined.log')) fs.unlinkSync('bot-combined.log');
    if (fs.existsSync('bot-error.log')) fs.unlinkSync('bot-error.log');
    ctx.reply('Log berhasil dihapus.');
    logger.info('Log file dihapus oleh admin.');
  } catch (e) {
    ctx.reply('Gagal menghapus log: ' + e.message);
    logger.error('Gagal menghapus log: ' + e.message);
  }
});

bot.command('helpadmin', async (ctx) => {
  const userId = ctx.message.from.id;

  // Pastikan userId di-casting ke string jika adminIds berupa string[]
  if (!adminIds.includes(String(userId))) {
    return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const helpMessage = `
*📋 Daftar Perintah Admin:*

1. /addserver - Menambahkan server baru.
2. /addsaldo - Menambahkan saldo ke akun pengguna.
3. /editharga - Mengedit harga layanan.
4. /editnama - Mengedit nama server.
5. /editdomain - Mengedit domain server.
6. /editauth - Mengedit auth server.
7. /editlimitquota - Mengedit batas quota server.
8. /editlimitip - Mengedit batas IP server.
9. /editlimitcreate - Mengedit batas pembuatan akun server.
10. /edittotalcreate - Mengedit total pembuatan akun server.
11. /broadcast - Mengirim pesan siaran ke semua pengguna.
12. /hapuslog - Menghapus log bot.

Gunakan perintah ini dengan format yang benar untuk menghindari kesalahan.
`.trim();

  await ctx.reply(helpMessage, { parse_mode: 'Markdown' });
});

bot.command('broadcast', async (ctx) => {
  const userId = String(ctx.from.id);

  // Validasi admin
  if (!adminIds.includes(userId)) {
    logger.info(`❌ User ${userId} bukan admin, tidak diizinkan broadcast.`);
    return ctx.reply('🚫 Anda tidak memiliki izin untuk melakukan broadcast.');
  }

  // Ambil isi pesan broadcast dari reply atau dari teks setelah /broadcast
  const message = ctx.message.reply_to_message
    ? ctx.message.reply_to_message.text
    : ctx.message.text.split(' ').slice(1).join(' ');

  if (!message || message.trim() === '') {
    return ctx.reply('⚠️ Mohon balas pesan yang ingin disiarkan, atau tulis setelah perintah `/broadcast`.', {
      parse_mode: 'Markdown'
    });
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      db.all("SELECT user_id FROM users", [], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });

    const results = await Promise.allSettled(rows.map(row => 
      ctx.telegram.sendMessage(row.user_id, message).catch(err => {
        logger.warn(`⚠️ Gagal kirim ke ${row.user_id}: ${err.message}`);
      })
    ));

    const sukses = results.filter(r => r.status === 'fulfilled').length;
    const gagal = results.length - sukses;

    await ctx.reply(`✅ Broadcast selesai.\n📤 Berhasil: ${sukses}\n❌ Gagal: ${gagal}`);
    logger.info(`📣 Broadcast selesai: ${sukses} sukses, ${gagal} gagal`);

  } catch (err) {
    logger.error('❌ Gagal melakukan broadcast:', err.message);
    return ctx.reply('⚠️ Terjadi kesalahan saat broadcast.');
  }
});
bot.command('saldo', (ctx) => {
  const state = userState[ctx.chat.id] || {}; // ⬅️ ini bikin gak error walau kosong
  const userId = ctx.from.id;

  db.get('SELECT saldo FROM users WHERE user_id = ?', [userId], (err, row) => {
    if (err) {
      logger.error('❌ Gagal mengambil saldo:', err.message);
      return ctx.reply('❌ Terjadi kesalahan saat mengambil saldo.');
    }

    if (!row) {
      return ctx.reply('⚠️ Akun tidak ditemukan.');
    }

    return ctx.reply(`💰 *Saldo Anda:* \`${row.saldo}\``, { parse_mode: 'Markdown' });
  });
});

bot.command('readlog', async (ctx) => {
  const userId = String(ctx.from.id);
  const logFile = '/var/log/sellvpn_backup.log';

  if (!adminIds.includes(userId)) {
    return ctx.reply('🚫 *Kamu tidak memiliki izin.*', { parse_mode: 'Markdown' });
  }

  try {
    if (!fs.existsSync(logFile)) {
      return ctx.reply('❌ *Log belum tersedia.*', { parse_mode: 'Markdown' });
    }

    const raw = fs.readFileSync(logFile, 'utf8');
    const lines = raw.trim().split('\n').slice(-10); // ambil 10 baris terakhir

    if (!lines.length) {
      return ctx.reply('⚠️ *Log kosong.*', { parse_mode: 'Markdown' });
    }

    const message = `📋 *Log Backup Terakhir:*\n\n\`\`\`\n${lines.join('\n')}\n\`\`\``;

    return ctx.reply(message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
  } catch (err) {
    logger.error('❌ Gagal baca log:', err.message);
    return ctx.reply('❌ *Gagal membaca log.*', { parse_mode: 'Markdown' });
  }
});

bot.command('clearlog', async (ctx) => {
  const userId = String(ctx.from.id);
  const logFile = '/var/log/sellvpn_backup.log';

  if (!adminIds.includes(userId)) {
    return ctx.reply('🚫 *Kamu tidak memiliki izin.*', { parse_mode: 'Markdown' });
  }

  try {
    if (!fs.existsSync(logFile)) {
      return ctx.reply('❌ *File log tidak ditemukan.*', { parse_mode: 'Markdown' });
    }

    fs.writeFileSync(logFile, '');
    logger.info(`[CLEARLOG] ${ctx.from.username} menghapus semua isi log.`);

    return ctx.reply('🧹 *Log berhasil dikosongkan.*', { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error('❌ Gagal clear log:', err.message);
    return ctx.reply('❌ *Gagal menghapus log.*', { parse_mode: 'Markdown' });
  }
});

bot.command('riwayatreseller', (ctx) => {
  const userId = ctx.from.id;

  db.get('SELECT role FROM users WHERE user_id = ?', [userId], (err, user) => {
    if (err || !user || user.role !== 'reseller') {
      return ctx.reply('❌ Kamu bukan reseller.');
    }

    db.all('SELECT akun_type, username, komisi, created_at FROM reseller_sales WHERE reseller_id = ? ORDER BY created_at DESC LIMIT 10', [userId], (err, rows) => {
      if (err || rows.length === 0) {
        return ctx.reply('ℹ️ Belum ada transaksi reseller.');
      }

      // 3. Format teks
      const list = rows.map((r, i) =>
        `${i + 1}. ${r.akun_type.toUpperCase()} - ${r.username} 💸 Rp${r.komisi} 🕒 ${r.created_at}`
      ).join('\n');

      const msg = `📜 *Riwayat Penjualan Terbaru (10)*\n\n${list}`;
      ctx.reply(msg, { parse_mode: 'Markdown' });
    });
  });
});


bot.command('addserver', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 7) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/addserver <domain> <auth> <harga> <nama_server> <quota> <iplimit> <batas_create_account>`', { parse_mode: 'Markdown' });
  }

  const [domain, auth, harga, nama_server, quota, iplimit, batas_create_akun] = args.slice(1);

  const numberOnlyRegex = /^\d+$/;
  if (!numberOnlyRegex.test(harga) || !numberOnlyRegex.test(quota) || !numberOnlyRegex.test(iplimit) || !numberOnlyRegex.test(batas_create_akun)) {
      return ctx.reply('⚠️ `harga`, `quota`, `iplimit`, dan `batas_create_akun` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("INSERT INTO Server (domain, auth, harga, nama_server, quota, iplimit, batas_create_akun) VALUES (?, ?, ?, ?, ?, ?, ?)", 
      [domain, auth, parseInt(harga), nama_server, parseInt(quota), parseInt(iplimit), parseInt(batas_create_akun)], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat menambahkan server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat menambahkan server.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Server \`${nama_server}\` berhasil ditambahkan.`, { parse_mode: 'Markdown' });
  });
});
bot.command('editharga', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editharga <domain> <harga>`', { parse_mode: 'Markdown' });
  }

  const [domain, harga] = args.slice(1);

  if (!/^\d+$/.test(harga)) {
      return ctx.reply('⚠️ `harga` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET harga = ? WHERE domain = ?", [parseInt(harga), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit harga server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit harga server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Harga server \`${domain}\` berhasil diubah menjadi \`${harga}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editnama', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editnama <domain> <nama_server>`', { parse_mode: 'Markdown' });
  }

  const [domain, nama_server] = args.slice(1);

  db.run("UPDATE Server SET nama_server = ? WHERE domain = ?", [nama_server, domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit nama server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit nama server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Nama server \`${domain}\` berhasil diubah menjadi \`${nama_server}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editdomain', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editdomain <old_domain> <new_domain>`', { parse_mode: 'Markdown' });
  }

  const [old_domain, new_domain] = args.slice(1);

  db.run("UPDATE Server SET domain = ? WHERE domain = ?", [new_domain, old_domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit domain server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit domain server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Domain server \`${old_domain}\` berhasil diubah menjadi \`${new_domain}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editauth', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editauth <domain> <auth>`', { parse_mode: 'Markdown' });
  }

  const [domain, auth] = args.slice(1);

  db.run("UPDATE Server SET auth = ? WHERE domain = ?", [auth, domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit auth server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit auth server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Auth server \`${domain}\` berhasil diubah menjadi \`${auth}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitquota', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitquota <domain> <quota>`', { parse_mode: 'Markdown' });
  }

  const [domain, quota] = args.slice(1);

  if (!/^\d+$/.test(quota)) {
      return ctx.reply('⚠️ `quota` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET quota = ? WHERE domain = ?", [parseInt(quota), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit quota server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit quota server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Quota server \`${domain}\` berhasil diubah menjadi \`${quota}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitip', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitip <domain> <iplimit>`', { parse_mode: 'Markdown' });
  }

  const [domain, iplimit] = args.slice(1);

  if (!/^\d+$/.test(iplimit)) {
      return ctx.reply('⚠️ `iplimit` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET iplimit = ? WHERE domain = ?", [parseInt(iplimit), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit iplimit server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit iplimit server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Iplimit server \`${domain}\` berhasil diubah menjadi \`${iplimit}\`.`, { parse_mode: 'Markdown' });
  });
});

bot.command('editlimitcreate', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/editlimitcreate <domain> <batas_create_akun>`', { parse_mode: 'Markdown' });
  }

  const [domain, batas_create_akun] = args.slice(1);

  if (!/^\d+$/.test(batas_create_akun)) {
      return ctx.reply('⚠️ `batas_create_akun` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET batas_create_akun = ? WHERE domain = ?", [parseInt(batas_create_akun), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit batas_create_akun server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit batas_create_akun server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Batas create akun server \`${domain}\` berhasil diubah menjadi \`${batas_create_akun}\`.`, { parse_mode: 'Markdown' });
  });
});

///reseller
bot.command('testnotifikasi', async (ctx) => {
  const axios = require('axios');
  const { BOT_TOKEN, GROUP_ID } = require('./.vars.json'); // sesuaikan path jika perlu

  const sender = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
  const notif = `📦 Test Notifikasi Grup\n\n` +
                `👤 Dari: ${sender}\n` +
                `🕒 ${new Date().toLocaleString('id-ID')}`;

  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: GROUP_ID,
      text: notif
      // parse_mode dihapus biar aman tanpa markdown
    });

    await ctx.reply('✅ Test notifikasi terkirim ke grup!');
  } catch (err) {
    console.error('❌ Gagal kirim ke grup:', err.message);
    await ctx.reply('❌ Gagal kirim notifikasi ke grup.');
  }
});


bot.command('transfer', async (ctx) => {
  const [cmd, targetId, amountStr] = ctx.message.text.split(' ');

  const fromId = ctx.from.id;
  const amount = parseInt(amountStr);

  if (!targetId || isNaN(amount) || amount <= 0) {
    return ctx.reply('❌ Format salah.\n\nContoh:\n/transfer 123456789 5000');
  }

  db.get('SELECT saldo, role FROM users WHERE user_id = ?', [fromId], (err, fromUser) => {
    if (err || !fromUser || fromUser.role !== 'reseller') {
      return ctx.reply('❌ Kamu bukan reseller atau data tidak ditemukan.');
    }

    if (fromUser.saldo < amount) {
      return ctx.reply('❌ Saldo kamu tidak cukup untuk transfer.');
    }

    if (fromId.toString() === targetId.toString()) {
      return ctx.reply('❌ Tidak bisa transfer ke diri sendiri.');
    }

    db.get('SELECT user_id FROM users WHERE user_id = ?', [targetId], (err, targetUser) => {
      if (err) return ctx.reply('❌ Gagal cek user tujuan.');
      if (!targetUser) return ctx.reply('❌ User tujuan tidak ditemukan.');

      db.run('UPDATE users SET saldo = saldo - ? WHERE user_id = ?', [amount, fromId], (err) => {
        if (err) return ctx.reply('❌ Gagal potong saldo pengirim.');

        db.run('UPDATE users SET saldo = saldo + ? WHERE user_id = ?', [amount, targetId], (err) => {
          if (err) return ctx.reply('❌ Gagal tambahkan saldo ke penerima.');

          // ✅ Simpan log transfer ke database
          db.run(`
            INSERT INTO transfer_log (from_id, to_id, jumlah, created_at)
            VALUES (?, ?, ?, datetime('now'))
          `, [fromId, targetId, amount], (err) => {
            if (err) {
              console.error('❌ Gagal simpan log transfer:', err.message);
            }
          });

          ctx.reply(`✅ Transfer saldo Rp${amount.toLocaleString('id-ID')} ke user ${targetId} berhasil.`);
        });
      });
    });
  });
});

bot.command('me', async (ctx) => {
  db.get('SELECT role, reseller_level, saldo FROM users WHERE user_id = ?', [ctx.from.id], (err, row) => {
    if (!row) return ctx.reply('🚫 Kamu belum terdaftar.');

    const teks = `
👤 Akun Info:
- Role  : ${row.role}
- Level : ${row.reseller_level || 'N/A'}
- Saldo : Rp${row.saldo.toLocaleString('id-ID')}
    `.trim();

    ctx.reply(teks);
  });
});

bot.command('demote_reseller', async (ctx) => {
  const adminId = String(ctx.from.id);
  const text = ctx.message.text.trim();
  const args = text.split(' ');

  if (args.length < 2) {
    return ctx.reply('⚠️ Gunakan format: /demote_reseller <user_id>');
  }

  const targetId = parseInt(args[1]);
  if (isNaN(targetId)) {
    return ctx.reply('❌ ID tidak valid. Masukkan ID numerik.');
  }

  const rawAdmin = vars.USER_ID;
  const adminIds = Array.isArray(rawAdmin)
    ? rawAdmin.map(String)
    : [String(rawAdmin)];

  if (!adminIds.includes(adminId)) {
    return ctx.reply('⛔ Hanya admin yang bisa menggunakan perintah ini.');
  }

  db.run(
    `UPDATE users SET role = 'user', reseller_level = NULL WHERE user_id = ?`,
    [targetId],
    function (err) {
      if (err) {
        logger.error('❌ DB error saat demote:', err.message);
        return ctx.reply('❌ Gagal melakukan demote user.');
      }

      if (this.changes === 0) {
        return ctx.reply('⚠️ User belum terdaftar atau sudah bukan reseller.');
      }

      ctx.reply(`✅ User ${targetId} telah diubah menjadi USER biasa.`);
    }
  );
});

bot.command('promote_reseller', async (ctx) => {
  const adminId = String(ctx.from.id);
  const text = ctx.message.text.trim();
  const args = text.split(' ');

  // Validasi format
  if (args.length < 2) {
    return ctx.reply('⚠️ Gunakan format: /promote_reseller <user_id>');
  }

  const targetId = parseInt(args[1]);
  if (isNaN(targetId)) {
    return ctx.reply('❌ ID tidak valid. Masukkan ID numerik.');
  }

  const rawAdmin = vars.USER_ID;
  const adminIds = Array.isArray(rawAdmin)
    ? rawAdmin.map(String)
    : [String(rawAdmin)];

  if (!adminIds.includes(adminId)) {
    return ctx.reply('⛔ Hanya admin yang bisa menggunakan perintah ini.');
  }

  // Update DB
  db.run(
    `UPDATE users SET role = 'reseller', reseller_level = 'silver' WHERE user_id = ?`,
    [targetId],
    function (err) {
      if (err) {
        logger.error('❌ DB error saat promote reseller:', err.message);
        return ctx.reply('❌ Gagal mempromosikan user.');
      }

      if (this.changes === 0) {
        return ctx.reply('⚠️ User belum terdaftar. Tambahkan dulu ke sistem.');
      }

      ctx.reply(`✅ User ${targetId} telah dipromosikan jadi RESELLER!`);
    }
  );
});

bot.command('edittotalcreate', async (ctx) => {
  const userId = ctx.message.from.id;
  if (!adminIds.includes(userId)) {
      return ctx.reply('⚠️ Anda tidak memiliki izin untuk menggunakan perintah ini.', { parse_mode: 'Markdown' });
  }

  const args = ctx.message.text.split(' ');
  if (args.length !== 3) {
      return ctx.reply('⚠️ Format salah. Gunakan: `/edittotalcreate <domain> <total_create_akun>`', { parse_mode: 'Markdown' });
  }

  const [domain, total_create_akun] = args.slice(1);

  if (!/^\d+$/.test(total_create_akun)) {
      return ctx.reply('⚠️ `total_create_akun` harus berupa angka.', { parse_mode: 'Markdown' });
  }

  db.run("UPDATE Server SET total_create_akun = ? WHERE domain = ?", [parseInt(total_create_akun), domain], function(err) {
      if (err) {
          logger.error('⚠️ Kesalahan saat mengedit total_create_akun server:', err.message);
          return ctx.reply('⚠️ Kesalahan saat mengedit total_create_akun server.', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
          return ctx.reply('⚠️ Server tidak ditemukan.', { parse_mode: 'Markdown' });
      }

      ctx.reply(`✅ Total create akun server \`${domain}\` berhasil diubah menjadi \`${total_create_akun}\`.`, { parse_mode: 'Markdown' });
  });
});

//restore
bot.command('restore', async (ctx) => {
  const userId = String(ctx.from.id);
  if (!adminIds.includes(userId)) return;

  // Simpan state user untuk tunggu upload
  userState[ctx.chat.id] = {
    step: 'await_restore_upload'
  };

  await ctx.reply(
    '📤 Silakan kirim file backup database (.db) yang ingin direstore.\nContoh: sellvpn_2025-06-01_10-00.db'
  );
});

bot.command('restoreupload', async (ctx) => {
  const userId = String(ctx.from.id);
  const UPLOAD_DIR = '/root/BotVPN2/uploaded_restore';

  if (!adminIds.includes(userId)) return;

  try {
    const files = fs.readdirSync(UPLOAD_DIR)
      .filter(f => f.endsWith('.db'))
      .sort((a, b) => fs.statSync(path.join(UPLOAD_DIR, b)).mtimeMs - fs.statSync(path.join(UPLOAD_DIR, a)).mtimeMs);

    if (!files.length) {
      return ctx.reply('❌ Tidak ada file restore yang diupload.');
    }

    const buttons = files.map(f => [{
      text: `📂 ${f}`,
      callback_data: `restore_uploaded_file::${f}`
    }]);

    return ctx.reply('📦 Pilih file restore hasil upload:', {
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    logger.error('Gagal /restoreupload:', err.message);
    return ctx.reply('❌ Gagal membaca file upload.');
  }
});

bot.on('document', async (ctx) => {
  const userId = String(ctx.from.id);
  const state = userState[ctx.chat?.id];
  const doc = ctx.message.document;
  const fileName = doc.file_name;
  const filePath = path.join(UPLOAD_DIR, fileName);

  // Cek admin dan mode restore aktif
  if (!adminIds.includes(userId) || !state || state.step !== 'await_restore_upload') return;

  // Validasi file ekstensi
  if (!fileName.endsWith('.db')) {
    return ctx.reply('❌ Hanya file dengan ekstensi .db yang didukung.');
  }

  try {
    // Unduh file dari Telegram
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const res = await fetch(fileLink.href);
    const buffer = await res.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(buffer));

    // ✅ CEK: Apakah file sama sudah direstore sebelumnya?
    if (fs.existsSync(DB_PATH)) {
      const dbStat = fs.statSync(DB_PATH);
      const uploadedStat = fs.statSync(filePath);
      const timeDiff = Math.abs(dbStat.mtimeMs - uploadedStat.mtimeMs);
      if (timeDiff < 1000) {
        return ctx.reply('⚠️ File ini sudah direstore sebelumnya.');
      }
    }

    // ✅ RESTORE
    fs.copyFileSync(filePath, DB_PATH);
    await ctx.reply(`✅ Restore berhasil dari file: ${fileName}\n\nBot siap digunakan kembali.`);

    // 🧠 Simpan log restore (kalau ada fungsi logRestoreAction)
    if (typeof logRestoreAction === 'function') {
      logRestoreAction('restore_cmd', fileName, ctx.from.username, ctx.from.id);
    }

  } catch (err) {
    logger?.error?.('Restore via /restore gagal:', err.message);
    ctx.reply('❌ Gagal restore file.');
  }

  // 🧹 Hapus state agar gak trigger ulang
  delete userState[ctx.chat.id];
});

// Fungsi updateGlobalStats
async function updateGlobalStats() {
  try {
    const resellerCount = await dbGetAsync('SELECT COUNT(*) AS count FROM users WHERE role = "reseller"');
    const totalAkun = await dbGetAsync('SELECT COUNT(*) AS count FROM akun');
    const totalServers = await dbGetAsync('SELECT COUNT(*) AS count FROM Server WHERE total_create_akun > 0');

    // Buat tabel jika belum ada (opsional, sekali saja)
    await dbRunAsync(`
      CREATE TABLE IF NOT EXISTS global_stats (
        id INTEGER PRIMARY KEY,
        reseller_count INTEGER DEFAULT 0,
        total_akun INTEGER DEFAULT 0,
        total_servers INTEGER DEFAULT 0
      )
    `);

    // Insert pertama jika kosong
    await dbRunAsync(`INSERT OR IGNORE INTO global_stats (id) VALUES (1)`);

    // Update isinya
    await dbRunAsync(`
      UPDATE global_stats
      SET reseller_count = ?, total_akun = ?, total_servers = ?
      WHERE id = 1
    `, [resellerCount.count, totalAkun.count, totalServers.count]);

    console.log('✅ Statistik global diperbarui');
  } catch (err) {
    console.error('❌ Gagal update statistik global:', err.message);
  }
}

///waktuuu
async function refreshCacheIfNeeded() {
  const now = Date.now();
  const delay = 60 * 1000; // 1 menit

  if (now - cacheStatus.lastUpdated < delay) return;

  try {
    const serverCount = await dbGetAsync('SELECT COUNT(*) AS count FROM Server');
    const userCount = await dbGetAsync('SELECT COUNT(*) AS count FROM users');

    cacheStatus.jumlahServer = serverCount?.count || 0;
    cacheStatus.jumlahPengguna = userCount?.count || 0;
    cacheStatus.lastUpdated = now;
    logger.info('✅ Cache status diperbarui otomatis');
  } catch (err) {
    logger.warn('⚠️ Gagal refresh cache status:', err.message);
  }
}

// 🔰 Kirim Menu Utama
async function sendMainMenu(ctx) {
  const userId = ctx.from.id;
  const uptime = os.uptime();
  const uptimeFormatted = `${Math.floor((uptime % 86400) / 3600)}j ${Math.floor((uptime % 3600) / 60)}m`;
  const tanggal = new Date().toLocaleDateString('id-ID');

  await refreshCacheIfNeeded();

  let saldo = 0, role = '', reseller_level = '', totalAkunDibuat = 0;
  let topResellerText = '';

  try {
    const akunData = await dbGetAsync('SELECT COUNT(*) AS total FROM invoice_log WHERE user_id = ?', [userId]);
    totalAkunDibuat = akunData?.total || 0;

    const user = await dbGetAsync('SELECT saldo, role, reseller_level FROM users WHERE user_id = ?', [userId]);
    saldo = user?.saldo || 0;
    role = user?.role || 'user';
    reseller_level = user?.reseller_level || 'silver';

    // Ambil Top 3 Reseller Mingguan
    const topReseller = await dbAllAsync(`
      SELECT 
  u.username,
  r.reseller_id,
  SUM(r.komisi) AS total_komisi,
  COUNT(DISTINCT i.id) AS total_create
FROM reseller_sales r
LEFT JOIN users u ON u.user_id = r.reseller_id
LEFT JOIN invoice_log i ON i.user_id = r.reseller_id AND i.created_at >= datetime('now', '-7 days')
WHERE r.created_at >= datetime('now', '-7 days')
GROUP BY r.reseller_id
ORDER BY total_komisi DESC
LIMIT 3
    `);

    if (topReseller.length > 0) {
      const medals = ['🥇', '🥈', '🥉'];
      topResellerText = `🏆 *Top Reseller Mingguan :*\n`;
      topReseller.forEach((r, i) => {
  const mention = r.username
    ? `@${escapeMarkdownV2(r.username)}`
    : `ID\\_${escapeMarkdownV2(r.reseller_id)}`;
  const komisi = escapeMarkdownV2((r.total_komisi || 0).toLocaleString('id-ID'));
  const totalAkun = escapeMarkdownV2(r.total_create || 0);
  topResellerText += `${medals[i]} ${mention} \\- ${totalAkun} akun\n`;
});
    }
  } catch (err) {
    logger.error(`❌ Gagal ambil data user/top reseller: ${err.message}`);
  }

  const roleLabel = role === 'admin'
    ? '👑 Admin'
    : role === 'reseller'
      ? `🏆 Reseller (${reseller_level.toUpperCase()})`
      : 'User';

  const keyboard = [];

  if (role === 'reseller') {
    keyboard.push([{ text: '⚙️ Menu Reseller', callback_data: 'menu_reseller' }]);
  }

  if (role === 'admin' || adminIds.includes(String(userId))) {
    keyboard.push([{ text: '🛠 Menu Admin', callback_data: 'menu_adminreseller' }]);
  }

  keyboard.push([
    { text: '🛒 Create Akun', callback_data: 'service_create' },
    { text: '🧪 Trial Akun', callback_data: 'service_trial' }
  ]);
  keyboard.push([
    { text: '♻️ Renew Akun', callback_data: 'service_renew' },
    { text: '💳 TopUp Saldo', callback_data: 'topup_saldo' }    
  ]);
  keyboard.push([
  { text: '🔼 Upgrade ke Reseller', callback_data: 'upgrade_to_reseller' },
  ]);
  
const text = `
━━━━━━━━━━━━━━━━━━━━━━
📂 *BOT PANEL SAGI STORE*
━━━━━━━━━━━━━━━━━━━━━━
📋 *Informasi Akun*
🛍 *Store* : ${escapeMarkdownV2(NAMA_STORE)}
💳 *Saldo* : Rp${escapeMarkdownV2(saldo.toLocaleString('id-ID'))}
📜 *Akun Dibuat* : ${escapeMarkdownV2(totalAkunDibuat)}
🏷 *Status* : ${escapeMarkdownV2(roleLabel)}
🆔 *ID Anda* : \`${userId}\`
🔒 *Admin Bot* : @rahmarie
🕒 *Update Cache* : ${escapeMarkdownV2(new Date(cacheStatus.lastUpdated).toLocaleTimeString('id-ID'))}
━━━━━━━━━━━━━━━━━━━━━━
${topResellerText.trim()}
━━━━━━━━━━━━━━━━━━━━━━
`.trim();

  try {
    if (ctx.updateType === 'callback_query') {
      await ctx.answerCbQuery();
      await ctx.editMessageText(text, {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard }
      });
    } else {
      await ctx.reply(text, {
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard }
      });
    }
    logger.info(`✅ Menu utama dikirim ke ${userId}`);
  } catch (err) {
    logger.error(`❌ Gagal kirim menu utama: ${err.message}`);
    await ctx.reply('❌ Gagal menampilkan menu utama.');
  }
}

// 🔁 Handle Layanan: create / renew / trial
async function handleServiceAction(ctx, action) {
  const { keyboard, pesan } = generateServiceMenu(action);

  try {
    await ctx.editMessageText(pesan, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (error) {
    await ctx.reply(pesan, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

// 🔧 Generate tombol sesuai jenis layanan
function generateServiceMenu(action) {
  let keyboard = [], teks = '';

  if (action === 'create') {
    teks = `
🚀 *Pembuatan Akun VPN Premium*

Layanan *Bot* tersedia 24 jam, tanpa ribet!
Pilih jenis akun di bawah ini dan sistem
kami akan memprosesnya
secara otomatis 💯

Koneksi cepat, aman, dan stabil
`.trim();

    keyboard = [
      [
        { text: '🧿 Create Ssh', callback_data: 'create_ssh' },
        { text: '🌐 Create Vmess', callback_data: 'create_vmess' }
      ],
      [
        { text: '🔓 Create Vless', callback_data: 'create_vless' },
        { text: '⚡ Create Trojan', callback_data: 'create_trojan' }
      ],
      [
        { text: '🔙 Kembali', callback_data: 'send_main_menu' }
      ]
    ];

  } else if (action === 'renew') {
    teks = `
♻️ *Perpanjangan Akun VPN*

Ingin melanjutkan masa aktif akun kamu?
Pilih jenis akun di bawah ini dan pastikan
*Saldo Anda Cukup* dan pastikan juga
masa aktif akun sebelum *Expired*

Silahkan pilih sesuai akun *Anda*
`.trim();

    keyboard = [
      [
        { text: '🧿 Renew Ssh', callback_data: 'renew_ssh' },
        { text: '🌐 Renew Vmess', callback_data: 'renew_vmess' }
      ],
      [
        { text: '🔓 Renew Vless', callback_data: 'renew_vless' },
        { text: '⚡ Renew Trojan', callback_data: 'renew_trojan' }
      ],
      [
        { text: '🔙 Kembali', callback_data: 'send_main_menu' }
      ]
    ];

  } else if (action === 'trial') {
    teks = `
🧪 *Akun Trial Gratis*

Coba dulu sebelum berlangganan!!!
Akun trial ini cocok buat kamu yang ingin
menguji kecepatan, kestabilan,
dan kualitas layanan kami.

Pilih jenis layanan dibawah ini.
`.trim();

    keyboard = [
      [
        { text: '🧿 Trial Ssh', callback_data: 'trial_ssh' },
        { text: '🌐 Trial Vmess', callback_data: 'trial_vmess' }
      ],
      [
        { text: '🔓 Trial Vless', callback_data: 'trial_vless' },
        { text: '⚡ Trial Trojan', callback_data: 'trial_trojan' }
      ],
      [
        { text: '🔙 Kembali', callback_data: 'send_main_menu' }
      ]
    ];
  }

  return { keyboard, pesan: teks };
}
///  Trial
async function showTrialServerMenu(ctx, jenis) {
  try {
    const servers = await dbAllAsync('SELECT id, nama_server, lokasi FROM Server');
    if (!servers || servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN!*\nTidak ada server yang tersedia saat ini. Coba lagi nanti!', {
        parse_mode: 'Markdown'
      });
    }

    const keyboard = servers.map(s => [{
      text: `🌐 ${s.nama_server}`,
      callback_data: `trial_server_${jenis}_${s.id}`
    }]);

    keyboard.push([{ text: '⬅️ Kembali', callback_data: 'service_trial' }]);

    const pesan = `
🧪 *Pilih server untuk Trial ${jenis.toUpperCase()}:*

⚠️ *Perhatian:*
- Trial hanya aktif selama 60 menit.
- Kuota trial terbatas, gunakan dengan bijak.
- Satu user hanya boleh ambil trial sekali.

Silakan pilih server di bawah:
    `.trim();

    await ctx.editMessageText(pesan, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    logger.error(`❌ Gagal tampilkan server trial untuk ${jenis}:`, err.message);
    await ctx.reply('❌ Terjadi kesalahan saat memuat daftar server.');
  }
}
///halaman
// app.js (Ganti seluruh fungsi startSelectServer)

async function startSelectServer(ctx, action, type, page = 0) {
  const userId = ctx.from.id; // Ambil ID pengguna
  
  try {
    logger.info(`Memulai proses ${action} untuk ${type} di halaman ${page + 1}`);

    // 1. AMBIL DATA USER (ROLE DAN LEVEL)
    const user = await dbGetAsync('SELECT role, reseller_level FROM users WHERE user_id = ?', [userId]);
    const userRole = user?.role || 'user';
    const userLevel = user?.reseller_level || 'silver';

    // 2. TENTUKAN DISKON BERDASARKAN ROLE/LEVEL
    let diskon = 0;
    if (userRole === 'reseller') {
      if (userLevel === 'platinum') {
        diskon = 0.3; // 30%
      } else if (userLevel === 'gold') {
        diskon = 0.2; // 20%
      } else {
        diskon = 0.1; // 10% (Silver/Default Reseller)
      }
    }
    // Jika role bukan reseller (user/admin), diskon tetap 0

    const servers = await dbAllAsync('SELECT * FROM Server');
    if (!servers || servers.length === 0) {
      return ctx.reply('⚠️ *PERHATIAN!*\nTidak ada server yang tersedia saat ini. Coba lagi nanti!', {
        parse_mode: 'Markdown'
      });
    }

    const serversPerPage = 3;
    const totalPages = Math.ceil(servers.length / serversPerPage);
    const currentPage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = currentPage * serversPerPage;
    const currentServers = servers.slice(start, start + serversPerPage);

    const keyboard = [];
    for (let i = 0; i < currentServers.length; i += 2) {
      const row = [];

      const s1 = currentServers[i];
      const s2 = currentServers[i + 1];

      row.push({
        text: `${s1.nama_server}`,
        callback_data: `${action}_username_${type}_${s1.id}`
      });

      if (s2) {
        row.push({
          text: `${s2.nama_server}`,
          callback_data: `${action}_username_${type}_${s2.id}`
        });
      }

      keyboard.push(row);
    }

    // Navigasi
    const navButtons = [];
    if (totalPages > 1) {
      if (currentPage > 0) {
        navButtons.push({
          text: '⬅️ Back',
          callback_data: `Maps_${action}_${type}_${currentPage - 1}`
        });
      }
      if (currentPage < totalPages - 1) {
        navButtons.push({
          text: '➡️ Next',
          callback_data: `Maps_${action}_${type}_${currentPage + 1}`
        });
      }
      keyboard.push(navButtons);
    }

    keyboard.push([{ text: '🔙 BACK TO MENU', callback_data: 'send_main_menu' }]);

    // 3. HITUNG HARGA JUAL DAN FORMAT TEKS SERVER
    const serverList = currentServers.map(server => {
      // Hitung harga per hari setelah diskon
      const hargaJualPerHari = Math.floor(server.harga * (1 - diskon));
      const hargaJualPerBulan = hargaJualPerHari * 30;

      const isFull = server.total_create_akun >= server.batas_create_akun;
      const flag = getFlagEmojiByLocation(server.lokasi);
      const status = isFull ? '❌ PENUH' : '✅ Tersedia';

      return `
━━━━━━━━━━━━━━━━━━━━━━
🌐 Server : *${server.nama_server}*
💵 Rp${hargaJualPerHari.toLocaleString('id-ID')} / hari
💳 Rp${hargaJualPerBulan.toLocaleString('id-ID')} / bulan
📊 Kuota   : *${server.quota} GB*
🔢 IP Max  : *${server.iplimit}*
📍 Lokasi  : *${server.lokasi || '-'}*
🏢 ISP  : *${server.isp || '-'}*
📈 Akun    : *${server.total_create_akun}/${server.batas_create_akun}*
🧭 Status  : *${status}*
━━━━━━━━━━━━━━━━━━━━━━`.trim();
    }).join('\n\n');

    const roleInfo = userRole === 'reseller' 
        ? `\n\n💰 *Harga untuk Reseller ${userLevel.toUpperCase()} (Diskon ${Math.floor(diskon * 100)}%):*`
        : '';
        
    const text = `📋 *List Server (Halaman ${currentPage + 1} dari ${totalPages}):*${roleInfo}\n\n${serverList}`;

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });

    userState[ctx.chat.id] = {
      step: `${action}_username_${type}`,
      page: currentPage
    };

  } catch (error) {
    logger.error(`❌ Error saat memulai proses ${action} untuk ${type}:`, error);
    await ctx.reply('❌ Terjadi kesalahan saat memuat server. Coba lagi nanti.', {
      parse_mode: 'Markdown'
    });
  }
}

async function sendAdminMenu(ctx) {
  const adminKeyboard = [
    [
      { text: '➕ Tambah Server', callback_data: 'addserver' },
      { text: '❌ Hapus Server', callback_data: 'deleteserver' }
    ],
    [
      { text: '💲 Edit Harga', callback_data: 'editserver_harga' },
      { text: '📝 Edit Nama', callback_data: 'nama_server_edit' }
    ],
    [
      { text: '🌐 Edit Domain', callback_data: 'editserver_domain' },
      { text: '🔑 Edit Auth', callback_data: 'editserver_auth' }
    ],
    [
      { text: '📊 Edit Quota', callback_data: 'editserver_quota' },
      { text: '📶 Edit Limit IP', callback_data: 'editserver_limit_ip' }
    ],
    [
      { text: '🔢 Edit Batas Create', callback_data: 'editserver_batas_create_akun' },
      { text: '🔢 Edit Total Create', callback_data: 'editserver_total_create_akun' }
    ],
    [
      { text: '💵 Tambah Saldo', callback_data: 'addsaldo_user' },
      { text: '📋 List Server', callback_data: 'listserver' }
    ],
    [
      { text: '♻️ Reset Server', callback_data: 'resetdb' },
      { text: 'ℹ️ Detail Server', callback_data: 'detailserver' }
    ],
    [
      { text: '🔙 Kembali', callback_data: 'send_main_menu' }
    ]
  ];

  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: adminKeyboard
    });
    logger.info('Admin menu sent');
  } catch (error) {
    if (error.response && error.response.error_code === 400) {
      await ctx.reply('⚙️ MENU ADMIN', {
        reply_markup: {
          inline_keyboard: adminKeyboard
        }
      });
      logger.info('Admin menu sent as new message');
    } else {
      logger.error('Error saat mengirim menu admin:', error);
    }
  }
}

// ... (sisa fungsi bot.action, bot.command, bot.on('text') dan lainnya) ...

// Ini adalah baris terakhir dari bot.action (/select_channel_(\w+)/)
// Yang sudah diperbaiki dan harusnya aman:

// GANTI SELURUH BLOK bot.action(/select_channel_(\w+)/, ...) DENGAN KODE INI (L. 5275)

bot.action(/select_channel_(\w+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const channelName = ctx.match[1]; 
    const depositData = global.depositState[userId];

    if (!depositData || depositData.action !== 'await_channel_select') {
        return ctx.reply('❌ Sesi top-up kadaluarsa. Silakan mulai lagi.');
    }
    
    clearTimeout(depositData.timeout);
    
    await safeDeleteMessage(ctx); 

    try {
        const amount = parseInt(depositData.amount);
        const contact = await getUserContact(userId);
        
        let paymentCodeToSend = channelName; 

        if (channelName === 'QRIS') {
            paymentCodeToSend = 'QRIS'; 
        }

        const processingMessage = await ctx.reply('⏳ *Memproses transaksi... Mohon tunggu sebentar.*', { parse_mode: 'Markdown' });
        
        const response = await requestVioletTransaction(
            userId, 
            amount, 
            contact.email, 
            contact.phone, 
            paymentCodeToSend 
        );

        await safeDeleteMessage(ctx, ctx.chat.id, processingMessage.message_id); 

        // 🟢 Cek Status Respons Utama
        if (response.status === true || response.status === 'success') {
            
            // Perbaikan KRITIS: Akses 'data' (d kecil)
            const data = response.data; 

            // Verifikasi data transaksi harus ada sebelum lanjut
            if (!data || !data.ref_kode) {
                logger.error(`❌ VIOLET RESPONS GAGAL PARSING. Data tidak ditemukan: ${JSON.stringify(response)}`);
                throw new Error("Gagal membaca data transaksi. Cek struktur API.");
            }
            
            const refId = data.ref_kode;
            const totalBayarRaw = data.nominal; 
            const expiredAtRaw = data.expired_time;
            
            // 🛠️ FIX MARKDOWN: Menggunakan Markdown lama yang lebih toleran, tetapi tetap membungkus data sensitif
            
            // Gunakan escapeMarkdownV2 pada data dinamis, tetapi pesan dikirim dengan 'Markdown'
            const totalBayarDisplay = totalBayarRaw.toLocaleString('id-ID');
            const expiredAtDisplay = new Date(Date.parse(expiredAtRaw)).toLocaleString('id-ID');
            
            // 1. UPDATE GLOBAL STATE
            global.depositState[userId] = {
                action: 'await_payment_auto',
                type: 'auto',
                refId: refId,
                totalBayar: totalBayarRaw, // Simpan nominal mentah
                expired: Date.parse(expiredAtRaw) 
            };
            
            // 2. LOGIK PENYIAPAN PESAN

            // Perbaikan Petunjuk (Instruksi)
            const petunjukText = data.petunjuk 
                ? data.petunjuk.replace(/<[^>]*>?/gm, '') 
                : 'Silakan scan QRIS di atas atau klik tombol Lanjut ke Pembayaran.';

            // Template Invoice untuk Caption (Menggunakan Markdown TOLERAN)
            const invoiceText = `
🧾 *INVOICE TOP-UP SAGI STORE*
--------------------------------------
🌐 *Metode:* \`${data.code_payment}\`
💵 *Total Bayar:* \`Rp ${totalBayarDisplay}\` 
🕒 *Batas Bayar:* \`${expiredAtDisplay}\` 
🔖 *Ref ID:* \`${refId}\`
--------------------------------------
*Instruksi Pembayaran:* ${petunjukText}
`.trim(); // Menggunakan tanda hubung (-) yang seharusnya aman di Plain Text/Markdown

            
            const keyboard = [];
            
            // Tombol ke halaman pembayaran
            const checkoutLink = data.checkout_url || data.target; 
            keyboard.push([{ text: '🔗 Lanjut ke Pembayaran / Cek Status', url: checkoutLink }]);

            let qrMessage = null;

            // **3. KIRIM SATU PESAN (GAMBAR + INVOICE)**
            if (data.target) {
                const qrLink = data.target; 
                try {
                    qrMessage = await ctx.replyWithPhoto(
                        { url: qrLink },
                        { 
                            caption: invoiceText, // Pindahkan seluruh invoice ke caption
                            parse_mode: 'Markdown', // <-- UBAH KE MARKDOWN LAMA YANG LEBIH TOLERAN
                            reply_markup: { inline_keyboard: keyboard },
                            disable_web_page_preview: true
                        }
                    );
                    logger.info(`✅ Gambar QRIS dan Invoice berhasil dikirim dalam satu pesan ke user ${userId}`);

                } catch (e) {
                    logger.error(`❌ Gagal mengirim Gambar QRIS ke user ${userId}. Error: ${e.message}`);
                    
                    // Fallback: Kirim pesan teks jika pengiriman foto gagal
                    // Menggunakan parse_mode: 'Markdown' untuk fallback
                    qrMessage = await ctx.reply(`❌ Gambar QRIS gagal ditampilkan.\n\n${invoiceText}`, { 
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: keyboard },
                        disable_web_page_preview: true
                    });
                }
            } else {
                 // Fallback jika tidak ada link target (untuk tipe pembayaran lain)
                 qrMessage = await ctx.reply(invoiceText, {
                     parse_mode: 'Markdown',
                     reply_markup: { inline_keyboard: keyboard },
                     disable_web_page_preview: true
                 });
            }

            // 4. LOGIK PENGHAPUSAN OTOMATIS DAN DB LOG
            if (qrMessage) {
                 const expiredTimestamp = Date.parse(expiredAtRaw);
                 const timeoutDuration = expiredTimestamp - Date.now();

                 // Set Timeout untuk menghapus pesan setelah expired (dengan buffer 1 menit)
                 global.depositState[userId].timeout = setTimeout(async () => {
                    // Coba hapus pesan
                    await bot.telegram.deleteMessage(userId, qrMessage.message_id).catch(e => {
                        logger.warn(`Gagal menghapus pesan ${qrMessage.message_id} (mungkin sudah dihapus): ${e.message}`);
                    });
                    
                    logger.info(`🗑️ Pesan QRIS ${qrMessage.message_id} untuk ${userId} telah dihapus karena expired.`);

                 }, Math.max(30000, timeoutDuration + 60000)); // Minimal 30 detik

                 global.depositState[userId].qrMessageId = qrMessage.message_id; // Simpan ID pesan ke state
            }
            
        } else {
            // Tangani kegagalan transaksi API
            const errorMessage = response.message || response.data?.status || 'Terjadi kesalahan tidak diketahui.';
            await ctx.reply(`❌ *Gagal membuat transaksi:*\n${errorMessage}`, { parse_mode: 'Markdown' });
        }

    } catch (e) {
        logger.error(`❌ Gagal proses transaksi otomatis (Fatal): ${e.message}`); 
        // Menggunakan Markdown mode lama yang toleran
        const safeErrorMsg = '❌ Terjadi kesalahan fatal saat memproses transaksi.';
        await ctx.reply(safeErrorMsg, { parse_mode: 'Markdown' });
        // Hapus deposit state agar user bisa mencoba lagi
        delete global.depositState[userId];
    }
});

bot.action(/edit_harga_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit harga server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_harga', serverId: serverId };

  await ctx.reply('💰 *Silakan masukkan harga server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/add_saldo_(\d+)/, async (ctx) => {
  const userId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk menambahkan saldo user dengan ID: ${userId}`);
  userState[ctx.chat.id] = { step: 'add_saldo', userId: userId };

  await ctx.reply('📊 *Silakan masukkan jumlah saldo yang ingin ditambahkan:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_batas_create_akun_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit batas create akun server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_batas_create_akun', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan batas create akun server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_total_create_akun_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit total create akun server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_total_create_akun', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan total create akun server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_limit_ip_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit limit IP server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_limit_ip', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan limit IP server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_quota_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit quota server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_quota', serverId: serverId };

  await ctx.reply('📊 *Silakan masukkan quota server baru:*', {
    reply_markup: { inline_keyboard: keyboard_nomor() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_auth_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit auth server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_auth', serverId: serverId };

  await ctx.reply('?? *Silakan masukkan auth server baru:*', {
    reply_markup: { inline_keyboard: keyboard_full() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_domain_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit domain server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_domain', serverId: serverId };

  await ctx.reply('🌐 *Silakan masukkan domain server baru:*', {
    reply_markup: { inline_keyboard: keyboard_full() },
    parse_mode: 'Markdown'
  });
});
bot.action(/edit_nama_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  logger.info(`User ${ctx.from.id} memilih untuk mengedit nama server dengan ID: ${serverId}`);
  userState[ctx.chat.id] = { step: 'edit_nama', serverId: serverId };

  await ctx.reply('🏷️ *Silakan masukkan nama server baru:*', {
    reply_markup: { inline_keyboard: keyboard_abc() },
    parse_mode: 'Markdown'
  });
});
bot.action(/confirm_delete_server_(\d+)/, async (ctx) => {
  try {
    db.run('DELETE FROM Server WHERE id = ?', [ctx.match[1]], function(err) {
      if (err) {
        logger.error('Error deleting server:', err.message);
        return ctx.reply('⚠️ *PERHATIAN! Terjadi kesalahan saat menghapus server.*', { parse_mode: 'Markdown' });
      }

      if (this.changes === 0) {
        logger.info('Server tidak ditemukan');
        return ctx.reply('⚠️ *PERHATIAN! Server tidak ditemukan.*', { parse_mode: 'Markdown' });
      }

      logger.info(`Server dengan ID ${ctx.match[1]} berhasil dihapus`);
      ctx.reply('✅ *Server berhasil dihapus.*', { parse_mode: 'Markdown' });
    });
  } catch (error) {
    logger.error('Kesalahan saat menghapus server:', error);
    await ctx.reply('❌ *GAGAL! Terjadi kesalahan saat memproses permintaan Anda. Silakan coba lagi nanti.*', { parse_mode: 'Markdown' });
  }
});
bot.action(/server_detail_(\d+)/, async (ctx) => {
  const serverId = ctx.match[1];
  try {
    const server = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, server) => {
        if (err) {
          logger.error('⚠️ Kesalahan saat mengambil detail server:', err.message);
          return reject('⚠️ *PERHATIAN! Terjadi kesalahan saat mengambil detail server.*');
        }
        resolve(server);
      });
    });

    if (!server) {
      logger.info('⚠️ Server tidak ditemukan');
      return ctx.reply('⚠️ *PERHATIAN! Server tidak ditemukan.*', { parse_mode: 'Markdown' });
    }

    const serverDetails = `📋 *Detail Server* 📋\n\n` +
      `🌐 *Domain:* \`${server.domain}\`\n` +
      `🔑 *Auth:* \`${server.auth}\`\n` +
      `🏷️ *Nama Server:* \`${server.nama_server}\`\n` +
      `📊 *Quota:* \`${server.quota}\`\n` +
      `📶 *Limit IP:* \`${server.iplimit}\`\n` +
      `🔢 *Batas Create Akun:* \`${server.batas_create_akun}\`\n` +
      `📋 *Total Create Akun:* \`${server.total_create_akun}\`\n` +
      `💵 *Harga:* \`Rp ${server.harga}\`\n\n`;

    await ctx.reply(serverDetails, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('⚠️ Kesalahan saat mengambil detail server:', error);
    await ctx.reply('⚠️ *Terjadi kesalahan saat mengambil detail server.*', { parse_mode: 'Markdown' });
  }
});

bot.on('callback_query', async (ctx) => {
  const userId = String(ctx.from.id);
  const data = ctx.callbackQuery.data;
  const userStateData = userState[ctx.chat?.id];
  const isAdmin = adminIds.includes(userId);

  await ctx.answerCbQuery(); // selalu akhiri loading tombol

// === HANDLE MANUAL TOPUP ADMIN CALLBACKS ===
if (isAdmin && (data.startsWith('verif_') || data.startsWith('tolak_') || data.startsWith('keyboard_'))) {
    // Panggil fungsi penanganan callback admin
    const handled = await handleAdminCallback(ctx); 
    if (handled) return; // Jika sudah ditangani, hentikan eksekusi callback yang lain
}

  // === HANDLE AUTO TOPUP INPUT AMOUNT ===
  if (global.depositState?.[userId]?.action === 'await_auto_amount') {
    // PENTING: Panggil fungsi yang sudah dipindahkan keluar!
    return await handleAutoDepositInput(ctx, userId, data); 
  }
  
  // === HANDLE AUTO TOPUP CHANNEL SELECT (Tambahkan di sini) ===
  if (global.depositState?.[userId]?.action === 'await_channel_select') {
    // Logika sudah ditangani di bot.action(/select_channel_(\w+)/)
    return;
  }

  // 2️⃣ HANDLE USER STATE (EDIT, ADD SALDO, DLL)
  if (userStateData) {
    switch (userStateData.step) {
      case 'add_saldo': return await handleAddSaldo(ctx, userStateData, data);
      case 'edit_batas_create_akun': return await handleEditBatasCreateAkun(ctx, userStateData, data);
      case 'edit_limit_ip': return await handleEditiplimit(ctx, userStateData, data);
      case 'edit_quota': return await handleEditQuota(ctx, userStateData, data);
      case 'edit_auth': return await handleEditAuth(ctx, userStateData, data);
      case 'edit_domain': return await handleEditDomain(ctx, userStateData, data);
      case 'edit_harga': return await handleEditHarga(ctx, userStateData, data);
      case 'edit_nama': return await handleEditNama(ctx, userStateData, data);
      case 'edit_total_create_akun': return await handleEditTotalCreateAkun(ctx, userStateData, data);
    }
  }

  // 3️⃣ HANDLE INLINE ADMIN TOOLS
  if (!adminIds.includes(userId)) return ctx.reply('🚫 *Akses ditolak.*', { parse_mode: 'Markdown' });

  // === Backup DB
  if (data === 'admin_backup_db') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(BACKUP_DIR, `sellvpn_${timestamp}.db`);

    try {
      fs.copyFileSync(DB_PATH, backupFile);
      await ctx.reply('✅ *Backup berhasil dibuat dan dikirim.*', { parse_mode: 'Markdown' });
      await ctx.telegram.sendDocument(userId, { source: backupFile });
    } catch (err) {
      logger.error('❌ Backup gagal:', err.message);
      return ctx.reply('❌ *Gagal membuat backup.*', { parse_mode: 'Markdown' });
    }
    return;
  }

  // === Restore DB: tampilkan list file
  if (data === 'admin_restore_db') {
  const today = new Date().toISOString().slice(0, 10); // format: 2025-06-11

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.db') && f.includes(today))
    .sort((a, b) => fs.statSync(path.join(BACKUP_DIR, b)).mtimeMs - fs.statSync(path.join(BACKUP_DIR, a)).mtimeMs)
    .slice(0, 10);

  if (!files.length) {
    return ctx.reply(`❌ *Tidak ada backup hari ini ditemukan (${today}).*`, { parse_mode: 'Markdown' });
  }

  const buttons = files.map(f => [
    { text: `🗂 ${f}`, callback_data: `restore_file::${f}` },
    { text: '?? Hapus', callback_data: `delete_file::${f}` }
  ]);

  return ctx.reply(`📂 *Backup Hari Ini (${today})*:\nPilih restore atau hapus:`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}
  
 if (data.startsWith('restore_uploaded_file::')) {
  const fileName = data.split('::')[1];
  const filePath = path.join('/root/BotVPN2/uploaded_restore', fileName);

  if (!fs.existsSync(filePath)) {
    return ctx.reply(`❌ File tidak ditemukan: ${fileName}`);
  }

  try {
    fs.copyFileSync(filePath, DB_PATH);
    await ctx.editMessageText(`✅ Restore berhasil dari upload: ${fileName}`);
    logRestoreAction('restore_upload', fileName, ctx.from.username, ctx.from.id);
  } catch (err) {
    logger.error('Restore upload gagal:', err.message);
    await ctx.reply('❌ Gagal restore file.');
  }

  // 🧼 PENTING: bersihkan state untuk cegah double-respon
  delete userState[ctx.chat.id];
}
  
  if (data.startsWith('delete_uploaded_file::')) {
  const fileName = data.split('::')[1];
  const filePath = path.join('/root/BotVPN2/uploaded_restore', fileName);

  if (!fs.existsSync(filePath)) {
    return ctx.reply(`❌ *File tidak ditemukan:* \`${fileName}\``, { parse_mode: 'Markdown' });
  }

  try {
    fs.unlinkSync(filePath);
    await ctx.editMessageText(`🗑 *File upload dihapus:* \`${fileName}\``, {
      parse_mode: 'Markdown'
    });
    logRestoreAction('delete_upload', fileName, ctx.from.username, ctx.from.id);
  } catch (err) {
    logger.error('❌ Gagal hapus file upload:', err.message);
    ctx.reply('❌ *Gagal menghapus file restore upload.*', { parse_mode: 'Markdown' });
  }
}
  
   if (data === 'admin_restore_all') {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.db'))
    .sort((a, b) => fs.statSync(path.join(BACKUP_DIR, b)).mtimeMs - fs.statSync(path.join(BACKUP_DIR, a)).mtimeMs)
    .slice(0, 15);

  if (!files.length) {
    return ctx.reply('❌ *Tidak ada file backup ditemukan.*', { parse_mode: 'Markdown' });
  }

  const buttons = files.map(f => [
    { text: `🗂 ${f}`, callback_data: `restore_file::${f}` },
    { text: '🗑 Hapus', callback_data: `delete_file::${f}` }
  ]);

  return ctx.reply('📂 *Daftar Semua Backup:*\nPilih restore atau hapus:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
}

  //delete
  if (data.startsWith('delete_file::')) {
  const fileName = data.split('::')[1];

  return ctx.reply(
    `⚠️ *Yakin ingin menghapus backup berikut?*\n🗂 \`${fileName}\``,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Ya, Hapus', callback_data: `confirm_delete::${fileName}` },
            { text: '❌ Batal', callback_data: 'cancel_delete' }
          ]
        ]
      }
    }
  );
}
   
   if (data.startsWith('confirm_delete::')) {
  const fileName = data.split('::')[1];
  const filePath = path.join(BACKUP_DIR, fileName);

  try {
    if (!fs.existsSync(filePath)) {
      return ctx.reply(`❌ *File tidak ditemukan:* \`${fileName}\``, { parse_mode: 'Markdown' });
    }

    fs.unlinkSync(filePath);
    await ctx.editMessageText(`🗑 *Backup dihapus:* \`${fileName}\``, {
      parse_mode: 'Markdown'
    });
    logger.info(`[CONFIRM_DELETE] ${ctx.from.username} deleted ${fileName}`);
  } catch (err) {
    logger.error('❌ Hapus gagal:', err.message);
    ctx.reply('❌ *Gagal hapus file backup.*', { parse_mode: 'Markdown' });
  }
}

if (data === 'cancel_delete') {
  await ctx.editMessageText('❎ *Penghapusan dibatalkan.*', { parse_mode: 'Markdown' });
}

  // === Restore dari file spesifik
  if (data.startsWith('restore_file::')) {
    const fileName = data.split('::')[1];
    const filePath = path.join(BACKUP_DIR, fileName);

    try {
      if (!fs.existsSync(filePath)) {
        return ctx.reply(`❌ *File tidak ditemukan:* \`${fileName}\``, { parse_mode: 'Markdown' });
      }

      fs.copyFileSync(filePath, DB_PATH);
      await ctx.editMessageText(`✅ *Restore berhasil dari:* \`${fileName}\``, { parse_mode: 'Markdown' });
      logger.info(`[RESTORE] ${ctx.from.username} restored ${fileName}`);
    } catch (err) {
      logger.error('❌ Restore file gagal:', err.message);
      return ctx.reply('❌ *Gagal restore file.*', { parse_mode: 'Markdown' });
    }
  }
});

// ===== HANDLE TOP-UP OTOMATIS INPUT NOMINAL (PINDAHKAN DARI BAWAH) =====
// Lokasi: Letakkan di sekitar Baris 2350-an, di luar bot.on('callback_query', ...)
async function handleAutoDepositInput(ctx, userId, data) {
    let currentAmount = global.depositState[userId].amount;
    const MIN_AMOUNT = 100; // Minimal 10.000

    if (data === 'delete') {
        currentAmount = currentAmount.slice(0, -1);
    } else if (data === 'topup_saldo') { // Tombol back
        clearTimeout(global.depositState[userId].timeout);
        // Hapus pesan input nominal
        await safeDeleteMessage(ctx, ctx.chat.id, global.depositState[userId].messageId); 
        delete global.depositState[userId];
        // Kirim kembali menu utama (daripada pesan batal)
        return await sendMainMenu(ctx); 
    } else if (data === 'confirm') {
        if (currentAmount.length === 0 || parseInt(currentAmount) < MIN_AMOUNT) {
            return await ctx.answerCbQuery(`⚠️ Jumlah minimal top-up adalah Rp ${MIN_AMOUNT.toLocaleString('id-ID')}!`, { show_alert: true });
        }
        
        clearTimeout(global.depositState[userId].timeout);
        global.depositState[userId].action = 'await_channel_select';
        global.depositState[userId].amount = currentAmount;
        
        await safeDeleteMessage(ctx, ctx.chat.id, global.depositState[userId].messageId); // Hapus pesan input nominal

        // GANTI BLOK FILTER INI di dalam handleAutoDepositInput()

        // 1. Fetch Channel Pembayaran dari VioletMedia
        const channelList = await getVioletPaymentChannels();
        
        // --- FILTER KODE BARU DIMULAI DI SINI ---
        const TARGET_CODE = 'QRIS'; // Kode yang kita tahu benar dari dokumentasi
        
        // Cari channel yang sesuai dengan Kode TARGET dan statusnya AKTIF
        const filteredChannels = channelList.data
            .filter(c => c.status === 'Aktif' && c.Kode === TARGET_CODE); // <--- Asumsi field kode di API bernama 'Kode'

        // Karena kita tidak tahu persis nama field kode di API, kita filter berdasarkan NAMA dan KODE:
        const finalChannel = channelList.data
            .find(c => c.status === 'Aktif' && c.nama === TARGET_CODE); 

        // Jika tidak ditemukan channel QRIS yang Aktif, tampilkan error.
        if (!channelList.status || !finalChannel) { 
            delete global.depositState[userId];
            return await ctx.reply('❌ Maaf, metode pembayaran QRIS sedang tidak aktif di akun Anda.', { parse_mode: 'Markdown' });
        }

        // Karena flow bot Anda membutuhkan tombol: Kita buat tombol dengan nama 'QRIS'
        const keyboard = [[
            { text: `💳 QRIS - Biaya: ${finalChannel.biaya}%`, callback_data: `select_channel_${finalChannel.nama}` } 
        ]];
        keyboard.push([{ text: '⬅️ Kembali', callback_data: 'topup_auto_start' }]);

        // ... (lanjutkan mengirim pesan keyboard) ...
        const channelMessage = await ctx.reply(`💳 *Pilih Metode Pembayaran untuk Rp ${parseInt(currentAmount).toLocaleString('id-ID')}:*`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
        
        // Simpan messageId baru agar bisa dihapus saat expired
        global.depositState[userId].messageId = channelMessage.message_id; 

        // Atur timeout baru untuk pemilihan channel
         global.depositState[userId].timeout = setTimeout(() => {
            // ... (Timeout logic) ...
        }, 5 * 60 * 1000); 

        return;

    } else {
        if (currentAmount.length < 10 && /^\d+$/.test(data)) {
            currentAmount += data;
        } else {
            return await ctx.answerCbQuery('⚠️ Jumlah maksimal adalah 10 digit!', { show_alert: true });
        }
    }

    global.depositState[userId].amount = currentAmount;
    const displayAmount = parseInt(currentAmount || 0).toLocaleString('id-ID');
    const newMessage = `💰 *Masukkan nominal top-up (minimal Rp ${MIN_AMOUNT.toLocaleString('id-ID')}):*\n\nJumlah saat ini: *Rp ${displayAmount}*`;
    
    try {
        await ctx.editMessageText(newMessage, {
            reply_markup: { inline_keyboard: keyboard_nomor() },
            parse_mode: 'Markdown'
        });
    } catch (error) {
        if (error.description && error.description.includes('message is not modified')) return;
        logger.error('Error updating amount message:', error);
    }
}

// GANTI FUNGSI GET CHANNEL LIST DENGAN VERSI URLSearchParams

async function getVioletPaymentChannels() {
    try {
        const url = `${VIOLET_API_PRODUCTION}channel-payment`;
        
        // --- 1. GUNAKAN URLSearchParams ---
        const formData = new URLSearchParams();
        formData.append('api_key', VIOLET_API_KEY.trim());
        formData.append('secret_key', VIOLET_SECRET_KEY.trim());
        formData.append('channel_payment', 'list');
        // ----------------------------------
        
        // --- DEBUG LOGGING ---
        logger.info(`[VIOLET DEBUG] Meminta channel dari URL: ${url}`);
        logger.warn(`[VIOLET DEBUG] Payload (Key): ${VIOLET_API_KEY.substring(0, 5)}...`);
        // ---------------------

        // --- 2. KONFIGURASI AXIOS: Form URL Encoded ---
        const config = {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded' // Wajib diubah!
            },
            timeout: 30000 // Tambahkan timeout yang disarankan
        };
        
        const response = await axios.post(url, formData, config); // Kirim formData, bukan JSON biasa
        
        logger.info(`[VIOLET RESPON] Status Code: ${response.status}`);
        logger.info(`[VIOLET RESPON] Respon JSON: ${JSON.stringify(response.data)}`);
        
        return response.data;
        
    } catch (error) {
        // ... (Logika error sama) ...
        logger.error('❌ VIOLET API Fetch Channels Gagal total.');
        if (error.response) {
            logger.error(`❌ VIOLET RESPON ERROR (HTTP ${error.response.status}): ${JSON.stringify(error.response.data)}`);
        } else {
            logger.error(`❌ VIOLET Error Jaringan/Koneksi: ${error.message}`);
        }
        return { status: false, data: [] };
    }
}


  const res = await dbGetAsync('SELECT SUM(komisi) AS total_komisi FROM reseller_sales WHERE reseller_id = ?', [ctx.from.id]);
  const total = res?.total_komisi || 0;
  const level = total >= 80000 ? 'platinum' : total >= 30000 ? 'gold' : 'silver';

  await dbRunAsync('UPDATE users SET reseller_level = ? WHERE user_id = ?', [level, ctx.from.id]);

  if (GROUP_ID) {
    const mention = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;
    const notif = `📢 *Transaksi Reseller!*\n\n👤 ${mention}\n📦 ${type.toUpperCase()} - ${username}\n💰 Komisi: Rp${komisi.toLocaleString('id-ID')}`;
    await bot.telegram.sendMessage(GROUP_ID, notif, { parse_mode: 'Markdown' });
  }
}
function renderResellerPanel(ctx) {
  const menu = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💰 Komisi Saya', callback_data: 'komisi' }],
        [{ text: '📄 Riwayat Komisi', callback_data: 'riwayatreseller' }],
        [{ text: '🏆 Top Reseller', callback_data: 'topreseller' }],
        [{ text: '📤 Export Komisi (CSV)', callback_data: 'export_komisi' }],
        [{ text: '🔁 Transfer Saldo', callback_data: 'transfer' }],
        [{ text: '📃 Log Transfer', callback_data: 'logtransfer' }]
      ]
    }
  };
  return ctx.reply('🤖 *Panel Reseller Aktif*', { parse_mode: 'Markdown', ...menu });
}

// 💡 Fungsi validasi user harus reseller
async function onlyReseller(ctx) {
  const userId = ctx.from.id;
  return new Promise((resolve) => {
    db.get('SELECT role FROM users WHERE user_id = ?', [userId], (err, row) => {
      if (err || !row || row.role !== 'reseller') {
        ctx.reply('⛔ *Panel ini hanya tersedia untuk reseller.*', { parse_mode: 'Markdown' });
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

// Validasi DB: coba buka file sebagai SQLite
function isValidSQLiteDB(path) {
  return new Promise((resolve) => {
    const db = new sqlite3.Database(path, sqlite3.OPEN_READONLY, (err) => {
      if (err) return resolve(false);
      db.get("SELECT name FROM sqlite_master WHERE type='table'", (err2) => {
        db.close();
        resolve(!err2);
      });
    });
  });
}

function isValidSQLDump(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (err, sql) => {
      if (err) return resolve(false);
      const isSQL = sql.includes('CREATE TABLE') || sql.includes('INSERT INTO');
      resolve(isSQL);
    });
  });
}


async function handleAddSaldo(ctx, userStateData, data) {
  let currentSaldo = userStateData.saldo || '';

  if (data === 'delete') {
    currentSaldo = currentSaldo.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentSaldo.length === 0) {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo tidak boleh kosong!*', { show_alert: true });
    }

    try {
      await updateUserSaldo(userStateData.userId, currentSaldo);
      ctx.reply(`✅ *Saldo user berhasil ditambahkan.*\n\n📄 *Detail Saldo:*\n- Jumlah Saldo: *Rp ${currentSaldo}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply('❌ *Terjadi kesalahan saat menambahkan saldo user.*', { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^[0-9]+$/.test(data)) {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo tidak valid!*', { show_alert: true });
    }
    if (currentSaldo.length < 10) {
      currentSaldo += data;
    } else {
      return await ctx.answerCbQuery('⚠️ *Jumlah saldo maksimal adalah 10 karakter!*', { show_alert: true });
    }
  }

  userStateData.saldo = currentSaldo;
  const newMessage = `📊 *Silakan masukkan jumlah saldo yang ingin ditambahkan:*\n\nJumlah saldo saat ini: *${currentSaldo}*`;
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }
}

async function handleEditBatasCreateAkun(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'batasCreateAkun', 'batas create akun', 'UPDATE Server SET batas_create_akun = ? WHERE id = ?');
}

async function handleEditTotalCreateAkun(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'totalCreateAkun', 'total create akun', 'UPDATE Server SET total_create_akun = ? WHERE id = ?');
}

async function handleEditiplimit(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'iplimit', 'limit IP', 'UPDATE Server SET iplimit = ? WHERE id = ?');
}

async function handleEditQuota(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'quota', 'quota', 'UPDATE Server SET quota = ? WHERE id = ?');
}

async function handleEditAuth(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'auth', 'auth', 'UPDATE Server SET auth = ? WHERE id = ?');
}

async function handleEditDomain(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'domain', 'domain', 'UPDATE Server SET domain = ? WHERE id = ?');
}

async function handleEditHarga(ctx, userStateData, data) {
  let currentAmount = userStateData.amount || '';

  if (data === 'delete') {
    currentAmount = currentAmount.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentAmount.length === 0) {
      return await ctx.answerCbQuery('⚠️ *Jumlah tidak boleh kosong!*', { show_alert: true });
    }
    const hargaBaru = parseFloat(currentAmount);
    if (isNaN(hargaBaru) || hargaBaru <= 0) {
      return ctx.reply('❌ *Harga tidak valid. Masukkan angka yang valid.*', { parse_mode: 'Markdown' });
    }
    try {
      await updateServerField(userStateData.serverId, hargaBaru, 'UPDATE Server SET harga = ? WHERE id = ?');
      ctx.reply(`✅ *Harga server berhasil diupdate.*\n\n📄 *Detail Server:*\n- Harga Baru: *Rp ${hargaBaru}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply('❌ *Terjadi kesalahan saat mengupdate harga server.*', { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^\d+$/.test(data)) {
      return await ctx.answerCbQuery('⚠️ *Hanya angka yang diperbolehkan!*', { show_alert: true });
    }
    if (currentAmount.length < 12) {
      currentAmount += data;
    } else {
      return await ctx.answerCbQuery('⚠️ *Jumlah maksimal adalah 12 digit!*', { show_alert: true });
    }
  }

  userStateData.amount = currentAmount;
  const newMessage = `💰 *Silakan masukkan harga server baru:*\n\nJumlah saat ini: *Rp ${currentAmount}*`;
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }
}

async function handleEditNama(ctx, userStateData, data) {
  await handleEditField(ctx, userStateData, data, 'name', 'nama server', 'UPDATE Server SET nama_server = ? WHERE id = ?');
}

async function handleEditField(ctx, userStateData, data, field, fieldName, query) {
  let currentValue = userStateData[field] || '';

  if (data === 'delete') {
    currentValue = currentValue.slice(0, -1);
  } else if (data === 'confirm') {
    if (currentValue.length === 0) {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} tidak boleh kosong!*`, { show_alert: true });
    }
    try {
      await updateServerField(userStateData.serverId, currentValue, query);
      ctx.reply(`✅ *${fieldName} server berhasil diupdate.*\n\n📄 *Detail Server:*\n- ${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)}: *${currentValue}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply(`❌ *Terjadi kesalahan saat mengupdate ${fieldName} server.*`, { parse_mode: 'Markdown' });
    }
    delete userState[ctx.chat.id];
    return;
  } else {
    if (!/^[a-zA-Z0-9.-]+$/.test(data)) {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} tidak valid!*`, { show_alert: true });
    }
    if (currentValue.length < 253) {
      currentValue += data;
    } else {
      return await ctx.answerCbQuery(`⚠️ *${fieldName} maksimal adalah 253 karakter!*`, { show_alert: true });
    }
  }

  userStateData[field] = currentValue;
  const newMessage = `📊 *Silakan masukkan ${fieldName} server baru:*\n\n${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} saat ini: *${currentValue}*`;
  if (newMessage !== ctx.callbackQuery.message.text) {
    await ctx.editMessageText(newMessage, {
      reply_markup: { inline_keyboard: keyboard_nomor() },
      parse_mode: 'Markdown'
    });
  }
}
async function updateUserSaldo(userId, saldo) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE Users SET saldo = saldo + ? WHERE id = ?', [saldo, userId], function (err) {
      if (err) {
        logger.error('⚠️ Kesalahan saat menambahkan saldo user:', err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function updateServerField(serverId, value, query) {
  return new Promise((resolve, reject) => {
    db.run(query, [value, serverId], function (err) {
      if (err) {
        logger.error(`⚠️ Kesalahan saat mengupdate ${fieldName} server:`, err.message);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// GANTI SELURUH BLOK DARI BARIS 5427 HINGGA BARIS 5635 DENGAN KODE BERSIH INI

function keyboard_abc() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

function keyboard_nomor() {
  const alphabet = '1234567890';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

function keyboard_full() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buttons = [];
  for (let i = 0; i < alphabet.length; i += 3) {
    const row = alphabet.slice(i, i + 3).split('').map(char => ({
      text: char,
      callback_data: char
    }));
    buttons.push(row);
  }
  buttons.push([{ text: '🔙 Hapus', callback_data: 'delete' }, { text: '✅ Konfirmasi', callback_data: 'confirm' }]);
  buttons.push([{ text: '🔙 Kembali ke Menu Utama', callback_data: 'send_main_menu' }]);
  return buttons;
}

async function updateUserBalance(userId, amount) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE users SET saldo = saldo + ? WHERE user_id = ?", 
      [amount, userId],
      function(err) {
        if (err) {
          reject(err);
          return;
        }
        resolve(this.changes);
      }
    );
  });
}

async function getUserBalance(userId) {
  return new Promise((resolve, reject) => {
    db.get("SELECT saldo FROM users WHERE user_id = ?", [userId],
      (err, row) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(row);
      }
    );
  });
}

// ===== NOTIFIKASI PLAIN TEXT (Sesuai Permintaan) =====
async function sendTopupNotification(userId, amount, isSuccess, status = 'success') {
    const user = await dbGetAsync('SELECT username, saldo, first_name FROM users WHERE user_id = ?', [userId]);
    const username = user?.username || user?.first_name || `ID User ${userId}`;
    const currentSaldo = user?.saldo || 'N/A';
    
    let userMessage, groupMessage;

    if (isSuccess) {
        userMessage = `
✅ TOPUP SALDO BERHASIL
--------------------------------------
Terima kasih, saldo Anda telah bertambah.
Nominal: Rp ${amount.toLocaleString('id-ID')}
Saldo Sekarang: Rp ${currentSaldo.toLocaleString('id-ID')}
--------------------------------------
`.trim();
        groupMessage = `
✅ TOPUP OTOMATIS BERHASIL
--------------------------------------
User: ${username} (ID: ${userId})
Nominal: Rp ${amount.toLocaleString('id-ID')}
Waktu: ${new Date().toLocaleString('id-ID')}
--------------------------------------
`.trim();
    } else if (status === 'kadaluarsa') {
         userMessage = `
❌ TRANSAKSI KADALUARSA
--------------------------------------
Top-up otomatis untuk nominal Rp ${amount.toLocaleString('id-ID')} telah kadaluarsa.
Silakan mulai transaksi baru.
--------------------------------------
`.trim();
        groupMessage = `
⚠️ TOPUP OTOMATIS KADALUARSA
--------------------------------------
User: ${username} (ID: ${userId})
Nominal: Rp ${amount.toLocaleString('id-ID')}
Waktu: ${new Date().toLocaleString('id-ID')}
--------------------------------------
`.trim();
    } else {
        return; // Jangan kirim notifikasi jika status tidak dikenal
    }

    // Kirim ke User (Plain Text)
    await safeSend(bot, userId, userMessage); 

    // Kirim ke Grup (Plain Text)
    if (typeof GROUP_ID !== 'undefined' && GROUP_ID) {
        await safeSend(bot, GROUP_ID, groupMessage); 
    }
}

//info server
async function resolveDomainToIP(domain) {
  try {
    const res = await dns.lookup(domain);
    return res.address;
  } catch (err) {
    logger.warn('⚠️ Gagal resolve domain:', err.message);
    return null;
  }
}

async function getISPAndLocation(ip) {
  try {
    const res = await fetch(`https://ipinfo.io/${ip}/json`);
    const data = await res.json();
    const isp = data.org || 'Tidak diketahui';
    const lokasi = data.city && data.country ? `${data.city}, ${data.country}` : 'Tidak diketahui';
    return { isp, lokasi };
  } catch (err) {
    logger.warn('⚠️ Gagal ambil ISP/Lokasi:', err.message);
    return { isp: 'Tidak diketahui', lokasi: 'Tidak diketahui' };
  }
}

app.listen(PORT, () => {
  logger.info(`🚀 Server berjalan di port ${PORT}`);

  const startBot = async (retry = 0) => {
    try {
      await bot.launch();
      logger.info('🤖 Bot Telegram aktif!');
    } catch (err) {
      const MAX_RETRY = 5;
      const delay = Math.min(10000 * (retry + 1), 60000); // max 1 menit

      logger.error(`❌ Error saat memulai bot: ${err.message}`);

      if (
        ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(err.code) ||
        (err.response && err.response.status >= 500)
      ) {
        if (retry < MAX_RETRY) {
          logger.warn(`🔁 Coba reconnect (${retry + 1}/${MAX_RETRY}) dalam ${delay / 1000}s...`);
          setTimeout(() => startBot(retry + 1), delay);
        } else {
          logger.error('🚫 Gagal konek ke Telegram setelah beberapa percobaan. Periksa koneksi VPS.');
        }
      } else {
        logger.error('🚨 Error lain saat start bot. Tidak dilakukan retry.');
      }
    }
  };

  // 🚀 Mulai bot dengan reconnect logic
  startBot();
});
