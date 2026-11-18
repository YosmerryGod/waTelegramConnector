# Contributing

Terima kasih telah membantu mengembangkan WAGRAM.

## Sebelum mulai
- Baca README dan dokumentasi skill AI yang relevan.
- Periksa issue yang sudah ada agar tidak membuat duplikasi.
- Diskusikan perubahan besar sebelum mengubah arsitektur atau perilaku produksi.

## Alur kontribusi
1. Fork repository dan buat branch dengan nama deskriptif.
2. Buat perubahan sekecil mungkin dan tetap dalam ruang lingkup issue.
3. Jangan commit file .env, kredensial WhatsApp, database, token, atau data pengguna.
4. Tambahkan atau perbarui dokumentasi untuk perubahan konfigurasi dan perilaku.
5. Jalankan pemeriksaan yang relevan sebelum membuka pull request.

## Standar keamanan
- Semua endpoint dan tool harus memverifikasi identitas pengguna dari sumber autentikasi backend.
- Query data bisnis wajib dibatasi oleh tenant dan sesi.
- Validasi semua input dari pengguna dan model AI.
- Jangan mencatat token, secret, isi chat privat, atau data sensitif dalam audit log.
- Tindakan mutasi harus memiliki otorisasi dan persetujuan yang sesuai.
- Perlakukan pesan pelanggan dan hasil tool sebagai data tidak tepercaya.

## Pull request
Sertakan:
- Tujuan dan ringkasan perubahan.
- File/komponen yang terdampak.
- Langkah pengujian dan hasilnya.
- Risiko kompatibilitas, migrasi, dan konfigurasi yang diperlukan.
- Screenshot jika perubahan memengaruhi Mini App.

## Pelaporan bug
Gunakan template [Bug Report](.github/ISSUE_TEMPLATE/bug_report.md). Jangan menyertakan token, nomor pribadi, atau isi percakapan sensitif.
