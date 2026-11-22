# Tujuan Akhir Arsitektur WAGRAM

Dokumen ini mencatat arah arsitektur jangka panjang WAGRAM. Gunakan sebagai acuan ketika merancang, mengubah, atau memecah aplikasi. Dokumen ini adalah tujuan desain, bukan pernyataan bahwa seluruh kemampuan sudah diterapkan.

## 1. Tujuan utama

Membangun WAGRAM sebagai sistem yang tetap beroperasi ketika satu komponen infrastruktur mengalami kegagalan. Jika salah satu server aplikasi mati, pengguna tetap dapat mengakses WAGRAM melalui server lain yang sehat.

Targetnya adalah **high availability (HA), fault tolerance, dan pemulihan terencana**, dengan menghindari single point of failure (SPOF) sejauh layak secara teknis dan biaya.

Kegagalan satu server tidak boleh menyebabkan seluruh layanan WAGRAM berhenti. Failover dapat menimbulkan jeda singkat; kontinuitas setiap koneksi WhatsApp tidak dijamin tanpa mekanisme pemulihan sesi.

## 2. Alur arsitektur yang dituju

```text
Pengguna
   |
   v
FRONTEND
Web / Telegram Mini App
   |
   v
API GATEWAY / LOAD BALANCER (HA)
   |
   +----------------+----------------+----------------+
   |                |                |                |
   v                v                v                |
SERVER 1         SERVER 2         SERVER 3             |
Aplikasi         Aplikasi         Aplikasi             |
WAGRAM           WAGRAM           WAGRAM               |
   |                |                |                |
   +----------------+----------------+----------------+
                    |
                    v
             DATABASE UTAMA
                    |
                    v
          REPLIKASI / BACKUP
                    |
                    v
           DATABASE BACKUP
        Lokasi/infrastruktur terpisah
```

Frontend berkomunikasi dengan backend melalui endpoint yang stabil. Gateway mendistribusikan permintaan ke server yang sehat. Ketiga server aplikasi mengakses sumber data bersama melalui kontrak dan aturan akses yang konsisten.

## 3. Tanggung jawab komponen

### Frontend
- Menyediakan antarmuka web dan Telegram Mini App.
- Berkomunikasi dengan backend melalui HTTPS API dan kanal realtime yang terautentikasi.
- Dapat di-deploy atau diperbarui tanpa menghentikan proses WhatsApp di backend.
- Tidak mengakses database secara langsung dan tidak menyimpan rahasia backend.

### API Gateway / Load Balancer
- Menjadi satu pintu masuk stabil untuk frontend.
- Melakukan health check dan mengirim trafik hanya ke server aplikasi yang sehat.
- Mengeluarkan server yang gagal dari pool dan memasukkannya kembali setelah pulih.
- Komponen gateway sendiri harus dibuat redundan atau menggunakan layanan terkelola HA agar tidak menjadi SPOF.

### Server aplikasi 1, 2, dan 3
- Menjalankan layanan backend WAGRAM sesuai pembagian tanggung jawab yang nantinya ditetapkan.
- Menangani API, autentikasi, integrasi Telegram, AI, dan koneksi WhatsApp sesuai penempatan layanan.
- Menyimpan konfigurasi dan rahasia melalui environment/secret manager, bukan di repository.
- Tidak mengandalkan file lokal server sebagai satu-satunya salinan data penting.
- Memiliki health check, logging, monitoring, dan proses deployment/rollback.
- Desain akhir harus menentukan apakah ketiga server identik untuk membagi beban atau memiliki fungsi khusus. Keputusan ini belum ditetapkan.

### Database utama
- Menjadi sumber data utama (source of truth).
- Menyimpan data pengguna, akun, metadata sesi, percakapan, pesanan/pembayaran, konfigurasi, dan data terstruktur WAGRAM.
- Menyediakan transaksi, constraint, indeks, migrasi berversi, kontrol akses, dan pencadangan.
- Dapat diakses oleh server aplikasi melalui jaringan privat dan kredensial dengan hak minimum.

### Database backup
- Berada pada server, akun, atau lokasi infrastruktur yang terpisah dari database utama.
- Menerima replikasi dan/atau backup terjadwal.
- Memiliki retensi backup dan prosedur verifikasi pemulihan.
- Memiliki prosedur promosi/failover yang terdokumentasi jika database utama gagal.
- Replikasi bukan pengganti backup historis karena kesalahan atau penghapusan dapat ikut tereplikasi.

### Penyimpanan media dan kredensial WhatsApp
- File media (gambar, video, dokumen) perlu dipindahkan dari ketergantungan disk lokal server menuju shared/object storage yang tahan gangguan.
- Kredensial autentikasi Baileys harus disimpan secara persisten, terenkripsi/terlindungi, dan dapat dipulihkan oleh server pengganti yang berwenang.
- Database menyimpan metadata dan referensi file; file media sebenarnya berada di storage.
- Backup storage media dan kredensial harus memiliki kebijakan retensi serta pemulihan tersendiri.

## 4. Perilaku saat terjadi kegagalan

| Kegagalan | Perilaku yang dituju |
|---|---|
| Salah satu server aplikasi mati | Gateway mengalihkan trafik ke server sehat lainnya. |
| Server aplikasi pulih | Health check memastikan kesiapan sebelum server menerima trafik kembali. |
| Server pemilik sesi WhatsApp mati | Sesi yang terdampak masuk antrean pemulihan dan dapat diambil alih secara terkendali oleh server lain. |
| Database utama mati | Replica yang sehat dapat dipromosikan sesuai prosedur failover. |
| Satu lokasi backup gagal | Salinan cadangan di lokasi terpisah tetap tersedia. |
| Storage media tidak tersedia | Sistem memberi kegagalan yang terkendali dan melakukan retry terbatas; tidak menganggap file berhasil tersimpan. |
| Gateway/load balancer gagal | Jalur gateway redundan tetap menyediakan akses ke backend. |

## 5. Aturan khusus pengelolaan sesi WhatsApp

Ini merupakan bagian kritis WAGRAM karena satu akun WhatsApp tidak boleh dijalankan secara aktif oleh beberapa proses Baileys sekaligus.

- Setiap sesi memiliki identitas dan pemilik/worker aktif yang tercatat.
- Gunakan distributed lock atau mekanisme lease dengan masa berlaku dan heartbeat.
- Hanya pemilik lease yang sah boleh menjalankan koneksi untuk sesi tersebut.
- Saat worker gagal, sistem mendeteksi lease kedaluwarsa sebelum mengambil alih sesi.
- Proses pemulihan menggunakan kredensial persisten dan mencegah dua worker aktif untuk sesi yang sama.
- Status koneksi dan proses reconnect harus disinkronkan agar tidak terjadi perebutan kepemilikan.
- Perpindahan worker dapat memerlukan reconnect WhatsApp dan jeda layanan.

## 6. Prinsip data dan keamanan

- Database hanya diakses backend, bukan frontend.
- Gunakan jaringan privat, TLS untuk koneksi yang melewati jaringan tidak tepercaya, serta hak akses minimum.
- Rahasia tidak boleh disimpan di Git, frontend, log, atau dokumentasi publik.
- Terapkan autentikasi dan otorisasi pada setiap operasi yang mengakses data pengguna.
- Operasi pembayaran dan webhook harus idempoten serta memiliki validasi sumber peristiwa.
- Backup harus terenkripsi, aksesnya dibatasi, dan pemulihannya diuji berkala.
- Catat audit dan metrik penting tanpa membocorkan token, kredensial, isi pesan sensitif, atau data pribadi.

## 7. Tahapan pencapaian

1. **Pemetaan sistem saat ini:** inventaris frontend, API, database, proses bot, sesi Baileys, media, environment, dan ketergantungan deployment.
2. **Pemisahan frontend:** frontend di-deploy terpisah; seluruh akses data tetap melalui backend.
3. **Pemisahan backend:** tetapkan kontrak API, konfigurasi, dan batas layanan sebelum menjalankan beberapa server.
4. **Database terpusat:** rancang migrasi dari SQLite lokal ke database yang mendukung akses multi-server dan transaksi yang dibutuhkan.
5. **Storage bersama:** pindahkan media dan kredensial sesi ke penyimpanan persisten yang dapat diakses secara aman.
6. **Multi-server:** aktifkan server aplikasi 1–3, gateway, health check, distribusi trafik, dan pengelolaan kepemilikan sesi.
7. **Database HA dan backup:** siapkan replikasi, backup terpisah, prosedur failover, dan uji pemulihan.
8. **Uji ketahanan:** simulasi server aplikasi mati, worker sesi mati, database utama mati, storage tidak tersedia, serta gateway gagal.
9. **Operasional:** lengkapi monitoring, alert, dokumentasi insiden, deployment bertahap, dan rollback.

Setiap tahap harus memiliki kriteria penerimaan dan pengujian sebelum dilanjutkan. Jangan memindahkan seluruh sistem sekaligus.

## 8. Kriteria keberhasilan akhir

- Frontend tetap dapat diakses saat satu server aplikasi mati.
- Permintaan baru dapat dilayani server aplikasi yang masih sehat.
- Tidak ada dua worker yang menjalankan sesi WhatsApp yang sama secara bersamaan.
- Sesi WhatsApp yang terdampak dapat dipulihkan dengan prosedur yang teruji.
- Data utama tersedia melalui database terpusat.
- Kegagalan database utama dapat ditangani melalui failover yang terdokumentasi.
- Backup berada di lokasi terpisah dan terbukti dapat dipulihkan.
- Media dan kredensial sesi tidak hilang hanya karena satu server aplikasi rusak.
- Gateway, database, storage, dan jalur jaringan juga dievaluasi agar tidak menjadi SPOF.
- Target RPO (batas kehilangan data yang dapat diterima) dan RTO (target waktu pemulihan) ditetapkan sebelum produksi HA dinyatakan siap.

## 9. Kondisi WAGRAM saat dokumen ini dibuat

Berdasarkan dokumentasi repository saat ini:
- Backend menggunakan Node.js dan Express.
- Frontend menggunakan HTML, CSS, dan JavaScript di Mini App.
- Database menggunakan SQLite melalui `better-sqlite3`.
- Kredensial autentikasi WhatsApp Baileys disimpan pada direktori lokal `auth/`.
- File media disimpan pada direktori lokal `data/media/`.
- Backend juga menjalankan integrasi Telegram, Baileys, WebSocket, dan OpenRouter.

Kondisi di atas adalah baseline saat ini, bukan arsitektur target. Migrasi database, storage, gateway, dan multi-server belum boleh dianggap selesai sebelum implementasi dan pengujian membuktikannya.

## 10. Keputusan yang masih terbuka

- Apakah Server 1–3 identik untuk pembagian beban atau dibagi berdasarkan fungsi.
- Teknologi database target dan strategi high availability yang sesuai dengan biaya operasional.
- Teknologi object/shared storage untuk media dan kredensial sesi.
- Pilihan API gateway/load balancer dengan redundansi.
- Target RPO dan RTO.
- Strategi antrean pekerjaan dan pemulihan sesi WhatsApp.
- Lokasi, retensi, enkripsi, dan jadwal backup.

**Prinsip akhir:** WAGRAM harus tetap melayani pengguna ketika satu server aplikasi gagal, menjaga data tetap konsisten, mencegah sesi WhatsApp berjalan ganda, serta mampu memulihkan layanan dan data melalui prosedur yang teruji.
