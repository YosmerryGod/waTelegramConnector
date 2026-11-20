<p align="center"><img src="miniapp/assets/wagram-logo.svg" alt="WAGRAM logo" width="120"></p>

<h1 align="center">WAGRAM — WhatsApp to Telegram Connector</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/AI-OpenRouter-6b5cff.svg" alt="OpenRouter">
</p>

**Bahasa Indonesia** — WAGRAM menghubungkan akun WhatsApp ke Telegram dan menyediakan Mini App untuk mengelola percakapan, koneksi, kontak, panggilan, serta fitur AI bisnis. Backend menggunakan Node.js, Express, SQLite, Baileys, dan OpenRouter.

**English** — WAGRAM connects WhatsApp accounts to Telegram and provides a Mini App for managing conversations, connections, contacts, calls, and business AI features. The backend is built with Node.js, Express, SQLite, Baileys, and OpenRouter.

> [!WARNING]
> **Disclaimer WhatsApp / Baileys:** WAGRAM menggunakan Baileys, library tidak resmi yang berinteraksi dengan WhatsApp Web. Baileys bukan WhatsApp Business Platform/API resmi dan tidak didukung atau disponsori WhatsApp/Meta. Penggunaan otomasi pihak ketiga dapat menyebabkan logout, pembatasan, atau pemblokiran akun. Gunakan dengan memahami risiko dan ketentuan WhatsApp. Untuk kebutuhan produksi yang memerlukan jalur resmi, evaluasi WhatsApp Business Platform/Cloud API.

## Fitur utama
- Meneruskan pesan WhatsApp ke Telegram.
- Mengelola beberapa akun/sesi WhatsApp per pengguna sesuai paket.
- Menghubungkan WhatsApp menggunakan QR code atau pairing code.
- Mini App untuk pesan, panggilan, kontak, profil, dan pengaturan.
- Sinkronisasi status melalui WebSocket yang diautentikasi dengan Telegram Mini App initData.
- Penyimpanan data aplikasi menggunakan SQLite.
- Penyimpanan media lokal dengan direktori per pemilik dan sesi.
- Paket membership dan pengelolaan status sesi.
- AI Business dan AI Customer Service melalui OpenRouter (DeepSeek untuk chat dan Gemini untuk vision, sesuai konfigurasi).
- Progressive Skill Runtime untuk memilih skill marketing, psikologi, komunikasi, dan service recovery sesuai tahap keputusan pelanggan.
- Penawaran produk kontekstual dengan penjelasan alami berdasarkan fakta varian, harga, stok, dan promo dari profil bisnis.

## Tech stack
| Area | Teknologi |
|---|---|
| Runtime | Node.js >= 20 |
| Backend | Express |
| Telegram | node-telegram-bot-api |
| WhatsApp connector | Baileys (unofficial) |
| Database | SQLite melalui better-sqlite3 |
| AI | OpenRouter (DeepSeek + Gemini Vision) |
| Realtime | WebSocket (ws) |
| Logging | Pino |
| Frontend | HTML, CSS, JavaScript |
| QR code | qrcode |

## Prerequisites
- Node.js 20 atau lebih baru dan npm.
- SQLite runtime/library yang kompatibel dengan better-sqlite3.
- Akun Telegram dan bot token dari BotFather.
- OpenRouter API key untuk fitur AI.
- Akun WhatsApp yang akan ditautkan. Perhatikan disclaimer Baileys.
- AI dijalankan melalui OpenRouter.

## Installation
1. Clone repository:
   ~~~bash
   git clone https://github.com/YosmerryGod/waTelegramConnector.git
   cd waTelegramConnector
   ~~~
2. Install dependencies:
   ~~~bash
   npm install
   ~~~
3. Siapkan environment:
   ~~~bash
   cp .env.example .env
   ~~~
   Isi TELEGRAM_BOT_TOKEN. Isi OPENROUTER_API_KEY untuk mengaktifkan fitur AI. Jangan commit file .env.
4. Jalankan aplikasi:
   ~~~bash
   npm start
   ~~~
   Development mode: npm run dev.
5. Buka bot Telegram dan kirim /start. Mini App dibuka melalui tombol dashboard bot.

## Environment variables
Salin .env.example sebagai titik awal. Variabel yang tidak wajib memiliki nilai default di aplikasi atau dapat dibiarkan kosong.

| Variable | Default / contoh | Keterangan |
|---|---|---|
| TELEGRAM_BOT_TOKEN | — | Token bot Telegram (wajib). |
| MINI_APP_URL | https://chat.doodweb.tech | URL Mini App Telegram. |
| MINIAPP_API_HOST | 127.0.0.1 | Host bind API; gunakan 0.0.0.0 di container. |
| MINIAPP_API_PORT | 3000 | Port API Mini App. |
| MINIAPP_AUTH_MAX_AGE_SECONDS | 86400 | Umur maksimum Telegram initData. |
| WHATSAPP_AUTH_DIR | ./auth | Lokasi kredensial sesi WhatsApp. |
| WHATSAPP_MEDIA_DIR | ./data/media | Lokasi media WhatsApp. |
| SQLITE_PATH | ./data/bridge.db | Path database SQLite. |
| LOG_LEVEL | warn | Level log Pino. |
| OPENROUTER_API_KEY | — | API key OpenRouter. |
| OPENROUTER_MODEL | deepseek/deepseek-v4.1-flash-1017 | Model chat utama. |
| OPENROUTER_TIMEOUT_MS | 60000 | Timeout request OpenRouter. |
| OPENROUTER_SITE_URL | https://wagram.app | Referer metadata OpenRouter. |
| OPENROUTER_APP_NAME | WAGRAM | Nama aplikasi pada metadata OpenRouter. |
| WAGRAM_VISION_MODEL | google/gemini-2.5-flash | Model vision; prioritas sebelum alias fallback. |
| OPENROUTER_VISION_MODEL | google/gemini-2.5-flash | Fallback konfigurasi model vision. |
| FREE_PAUSE_HOUR | 8 | Jam pause harian paket Free, zona waktu WITA (0–23). |
| RECONNECT_DELAY_MS | 3000 | Jeda awal reconnect WhatsApp. |
| MAX_RECONNECT_DELAY_MS | 60000 | Batas jeda reconnect maksimum. |
| WA_CONNECT_TIMEOUT_MS | 30000 | Timeout koneksi WhatsApp. |
| WA_KEEPALIVE_MS | 25000 | Interval keepalive WhatsApp. |
| DISCONNECT_NOTICE_DELAY_MS | 45000 | Jeda sebelum notifikasi disconnect. |
| WAGRAM_AUTO_REPLY_SETTLE_MS | 5000 | Jeda penggabungan pesan sebelum auto-reply. |
| TELEGRAM_MESSAGE_LIMIT | 4000 | Batas panjang pesan Telegram. |
| MAX_MEDIA_MB | 45 | Batas ukuran media Telegram (MB). |
| DEFAULT_COUNTRY_CODE | — | Kode negara default untuk normalisasi nomor. |
| ADMIN_TELEGRAM_IDS | — | Daftar Telegram ID admin dipisahkan koma. |
| DANA_PAYMENT_MONITOR_API_KEY | — | API key monitor pembayaran DANA jika digunakan. |
| CALL_DEBUG | false | Flag diagnostik panggilan jika diaktifkan. |

## Usage guide

### Telegram bot commands
| Command | Fungsi |
|---|---|
| /start | Registrasi awal dan membuka dashboard WAGRAM. |
| /me | Menampilkan informasi akun Telegram terdaftar. |
| /status | Memeriksa status koneksi WhatsApp. |
| /help | Menampilkan panduan penggunaan singkat. |
| /set | Perintah administratif untuk membership dan pause; hanya untuk admin. |
| /users | Menampilkan daftar pengguna; hanya untuk admin. |
| /user TELEGRAM_ID | Melihat detail pengguna; hanya untuk admin. |

### Mini App
1. Kirim /start ke bot Telegram.
2. Tekan tombol untuk membuka WAGRAM.
3. Hubungkan akun WhatsApp melalui QR code atau pairing code.
4. Gunakan tab Pesan, Panggilan, Kontak, dan Profil.
5. Fitur AI dan pengaturan bisnis tersedia sesuai membership dan konfigurasi backend.

## Architecture overview
~~~text
Telegram User
     |
     v
Telegram Bot (node-telegram-bot-api)
     |
     +------ WhatsApp Connector (Baileys) ------ WhatsApp
     |
     +------ Mini App (HTML / CSS / JS)
                    |
                    +---- REST API (Express)
                    +---- WebSocket (ws)
                              |
                              v
                     SQLite / Local Media
                              |
                              v
                     AI Services (OpenRouter)
                       |              |
                    DeepSeek       Gemini Vision
~~~

## Contributing
Baca [CONTRIBUTING.md](CONTRIBUTING.md) sebelum membuka issue atau pull request. Sertakan langkah reproduksi, dampak, dan hasil pengujian.

## License
Didistribusikan di bawah [MIT License](LICENSE). Penggunaan Baileys tetap tunduk pada ketentuan dan risiko layanan WhatsApp.
