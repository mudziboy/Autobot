// modules/createVMESS.js (Kode Diperbaiki)

const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./sellvpn.db');

// Promisify dbGetAsync (diperlukan karena modul tidak bisa mengimport promisify dari app.js dengan mudah)
const dbGetAsync = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

// ✅ CREATE VMESS
async function createvmess(username, exp, quota, limitip, serverId) {
  console.log(`⚙️ Creating VMESS for ${username} | Exp: ${exp} | Quota: ${quota} GB | IP Limit: ${limitip}`);

  if (/\s/.test(username) || /[^a-zA-Z0-9]/.test(username)) {
    return '❌ Username tidak valid. Gunakan hanya huruf dan angka tanpa spasi.';
  }

  // Karena dbGetAsync sudah di-promisify, kita tidak perlu membungkusnya lagi dengan new Promise
  try {
    const server = await dbGetAsync('SELECT domain, auth FROM Server WHERE id = ?', [serverId]);
    
    if (!server || !server.auth) {
      console.error('❌ DB Error: Server atau AUTH tidak ditemukan.');
      return '❌ Server tidak ditemukan atau kunci otentikasi hilang.';
    }

    // Server API Anda tampaknya menggunakan port 5888 dan query parameter
    // Kita akan tetap menggunakan query parameter untuk data akun, TAPI memindahkan auth ke header
    const API_ENDPOINT = `http://${server.domain}:5888/createvmess`;
    const API_KEY = server.auth.trim();

    // Data yang akan dikirim (menggunakan query parameter sesuai struktur API Anda sebelumnya)
    const params = {
      user: username,
      exp: exp,
      quota: quota,
      iplimit: limitip
    };

    const response = await axios.get(
      API_ENDPOINT,
      {
        params: params, // Mengirim data sebagai query string
        headers: {
          // 🚨 PERBAIKAN KRUSIAL: Mengirim AUTH melalui Header
          // Asumsi Server API Anda menggunakan header X-API-Key atau serupa
          // Jika server Anda memerlukan 'Authorization: Bearer [KEY]', ubah di sini.
          'X-API-Key': API_KEY, // COBA DENGAN X-API-Key DULU
          // 'Authorization': `Bearer ${API_KEY}`, // Jika Server menggunakan Bearer Token
        },
        timeout: 15000
      }
    );

    const { data } = response;
    
    if (data.status !== 'success') {
      console.error('❌ Gagal dari API:', data.message);
      return `❌ Gagal membuat akun: ${data.message}`;
    }

    const d = data.data;

    // ... (Logika pembuatan pesan invoice) ...
    const msg = `
         🔥 *VMESS PREMIUM ACCOUNT*
         
🔹 *Informasi Akun*
┌─────────────────────
│👤 *Username:* \`${d.username}\`
│🌐 *Domain:* \`${d.domain}\`
└─────────────────────
┌─────────────────────
│🔐 *Port TLS:* \`443\`
│📡 *Port HTTP:* \`80\`
│🔁 *Network:* WebSocket
│📦 *Quota:* ${d.quota === '0 GB' ? 'Unlimited' : d.quota}
│🌍 *IP Limit:* ${d.ip_limit === '0' ? 'Unlimited' : d.ip_limit}
└─────────────────────

🔗 *VMESS TLS:*
\`\`\`
${d.vmess_tls_link}
\`\`\`
🔗 *VMESS NON-TLS:*
\`\`\`
${d.vmess_nontls_link}
\`\`\`
🔗 *VMESS GRPC:*
\`\`\`
${d.vmess_grpc_link}
\`\`\`

🧾 *UUID:* \`${d.uuid}\`
🔏 *PUBKEY:* \`${d.pubkey}\`
┌─────────────────────
│🕒 *Expired:* \`${d.expired}\`
│
│📥 [Save Account](https://${d.domain}:81/vmess-${d.username}.txt)
└─────────────────────
✨ By : *SAGI TUNNEL*! ✨
`.trim();

    console.log('✅ VMESS created for', username);
    return msg; // Resolve dengan pesan sukses

  } catch (e) {
    // Penanganan error 401/403
    if (e.response) {
      if (e.response.status === 401 || e.response.status === 403) {
        console.error(`❌ Error saat request ke API: Unauthorized/Forbidden (401/403). Cek API Key: ${e.response.data?.message || e.response.status}`);
        return '❌ Gagal membuat akun: Kunci API salah atau tidak sah (401).';
      }
      console.error(`❌ Error saat request ke API: HTTP ${e.response.status} - ${e.response.data?.message || 'Unknown Error'}`);
      return `❌ Gagal membuat akun: API Server Error (${e.response.status}).`;
    }

    console.error('❌ Error saat request ke API:', e.message);
    return '❌ Tidak bisa menghubungi server. Coba lagi nanti.';
  }
}

module.exports = { createvmess };
module.exports = { createvmess };
