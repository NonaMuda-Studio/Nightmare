# Nightmare server setup manifests

Sumber daftar kategori/channel adalah server-setup.js. /setup template:<large|medium|small> menampilkan preview berdasarkan kondisi channel aktual dan membutuhkan konfirmasi sebelum membuat struktur. Setup mempertahankan konflik serta channel lama tanpa memindahkan atau menghapusnya.

## Kategori utama dan permission

| Urutan | Kategori | Permission |
|---:|---|---|
| 1 | – – ~ 📊 • &#124; SERVER STATS &#124; | stats-readonly |
| 2 | – – ~ 📢 • &#124; ANNOUNCEMENT &#124; | public |
| 3 | – – ~ 💬 • &#124; GENERAL &#124; | public |
| 4 | – – ~ 📝 • &#124; LOGS &#124; | private-staff |
| 5 | – – ~ 🎮 • &#124; GAME &#124; | public |
| 6 | – – ~ 🛡️ • &#124; MOD & STAFF &#124; | private-staff |
| 7 | – – ~ 🎵 • &#124; MUSIC &#124; | public |
| 8 | – – ~ 🔊 • &#124; VOICE LOUNGE &#124; | public |

Kategori private-staff menolak View Channel untuk @everyone. Role staf dapat dipilih pada opsi /setup staff_role; jika kosong, role dari konfigurasi /ticket setup dipakai; administrator tetap memiliki akses melalui permission Administrator, dan bot diberi izin yang diperlukan. Tanpa role tersebut, kategori privat hanya dapat diakses administrator dan bot. Kategori/channel yang sudah ada tidak diubah permission-nya otomatis. Ruang LOGS hanya disediakan; tidak ada klaim bahwa event logging otomatis mengirim ke semua ruang tersebut. Kategori statistik membatasi Send Messages bagi @everyone.

## Large Community — 95 channel permanen

Jumlah dihitung dari channel entries di manifest; kategori dan Temporary Voice rooms dinamis tidak masuk hitungan.

### 1. – – ~ 📊 • | SERVER STATS |

Permission kategori: stats-readonly.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 👥・all-members | text | inherit-category |
| 2 | 👤・members | text | inherit-category |
| 3 | 🤖・bots | text | inherit-category |
| 4 | 💬・channels | text | inherit-category |
| 5 | 🎭・roles | text | inherit-category |

### 2. – – ~ 📢 • | ANNOUNCEMENT |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 📢・announcements | announcement | inherit-category |
| 2 | 📰・server-updates | announcement | inherit-category |
| 3 | 📅・event-calendar | text | inherit-category |
| 4 | 🎉・event-announcements | announcement | inherit-category |
| 5 | 🚨・important-notices | announcement | inherit-category |
| 6 | 📡・community-news | announcement | inherit-category |
| 7 | 📜・changelog | announcement | inherit-category |
| 8 | 🎁・giveaways | text | inherit-category |

### 3. – – ~ 💬 • | GENERAL |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 💬・global-chat | text | inherit-category |
| 2 | 🌏・international-chat | text | inherit-category |
| 3 | 👋・introductions | text | inherit-category |
| 4 | 🤝・meet-the-community | text | inherit-category |
| 5 | 🤔・questions | text | inherit-category |
| 6 | ☕・off-topic | text | inherit-category |
| 7 | 💭・random-chat | text | inherit-category |
| 8 | 😂・memes | text | inherit-category |
| 9 | 📸・media-share | text | inherit-category |
| 10 | 🤖・bot-commands | text | inherit-category |
| 11 | 📈・leveling | text | inherit-category |
| 12 | 🌙・daily-chat | text | inherit-category |
| 13 | 💡・suggestions | forum | inherit-category |
| 14 | 📮・feedback | forum | inherit-category |
| 15 | 🗳️・community-polls | text | inherit-category |
| 16 | 🧑‍💻・help-desk | text | inherit-category |
| 17 | 🔗・resources | text | inherit-category |
| 18 | 🎭・getroles | text | inherit-category |
| 19 | 📌・server-guide | text | inherit-category |
| 20 | 🗞️・member-stories | forum | inherit-category |

### 4. – – ~ 📝 • | LOGS |

Permission kategori: private-staff.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🔨・mod-logs | text | inherit-category |
| 2 | 🚫・ban-logs | text | inherit-category |
| 3 | 👢・kick-logs | text | inherit-category |
| 4 | 🔓・unban-logs | text | inherit-category |
| 5 | 💬・message-logs | text | inherit-category |
| 6 | 👥・member-logs | text | inherit-category |
| 7 | 🔊・voice-logs | text | inherit-category |
| 8 | 🎫・ticket-logs | text | inherit-category |
| 9 | 🤖・bot-logs | text | inherit-category |
| 10 | 📋・audit-notes | text | inherit-category |

### 5. – – ~ 🎮 • | GAME |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🕹️・game-chat | text | inherit-category |
| 2 | 📰・game-updates | announcement | inherit-category |
| 3 | 🔎・find-teammates | text | inherit-category |
| 4 | 🎯・looking-for-group | text | inherit-category |
| 5 | 🎬・game-clips | text | inherit-category |
| 6 | 🧠・game-guides | forum | inherit-category |
| 7 | 🏅・ranked-talk | text | inherit-category |
| 8 | 🎲・other-games | text | inherit-category |
| 9 | 📷・game-screenshots | text | inherit-category |
| 10 | 🏆・tournament-talk | text | inherit-category |
| 11 | 🧭・co-op-games | text | inherit-category |
| 12 | 🧱・minecraft | text | inherit-category |
| 13 | 🎯・valorant | text | inherit-category |
| 14 | 📱・mobile-games | text | inherit-category |
| 15 | 🧩・strategy-games | forum | inherit-category |
| 16 | 🗓️・game-events | text | inherit-category |
| 17 | 📣・team-recruitment | forum | inherit-category |
| 18 | 🎮・game-feedback | text | inherit-category |

### 6. – – ~ 🛡️ • | MOD & STAFF |

Permission kategori: private-staff.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🛡️・staff-chat | text | inherit-category |
| 2 | 📣・staff-announcements | announcement | inherit-category |
| 3 | 🧭・moderator-room | text | inherit-category |
| 4 | 👑・admin-room | text | inherit-category |
| 5 | 📚・staff-resources | text | inherit-category |
| 6 | 📥・moderation-queue | forum | inherit-category |
| 7 | ⚖️・appeal-review | forum | inherit-category |
| 8 | 🎫・ticket-staff | text | inherit-category |
| 9 | 🔊・staff-voice | voice | inherit-category |
| 10 | 🎙️・mod-meetings | voice | inherit-category |
| 11 | 🗓️・staff-planning | text | inherit-category |
| 12 | 📋・staff-handbook | text | inherit-category |

### 7. – – ~ 🎵 • | MUSIC |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🎧・request-music | text | inherit-category |
| 2 | 🎵・music-commands | text | inherit-category |
| 3 | 📻・radio-status | text | inherit-category |
| 4 | 📜・music-guide | text | inherit-category |
| 5 | 💬・music-chat | text | inherit-category |
| 6 | 🎶・listening-room | voice | inherit-category |
| 7 | 🎼・chill-room | voice | inherit-category |
| 8 | 🎹・instrumental-room | voice | inherit-category |
| 9 | 🎤・karaoke-room | voice | inherit-category |
| 10 | 💡・music-suggestions | forum | inherit-category |

### 8. – – ~ 🔊 • | VOICE LOUNGE |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🔊・general-vc | voice | inherit-category |
| 2 | 🎮・gaming-vc | voice | inherit-category |
| 3 | 🎙️・creator-channel | voice | inherit-category |
| 4 | 👥・community-vc | voice | inherit-category |
| 5 | 🛋️・chill-lounge | voice | inherit-category |
| 6 | ➕・create-voice | voice | inherit-category |
| 7 | 📚・study-room | voice | inherit-category |
| 8 | 🎉・event-stage | stage | inherit-category |
| 9 | 🎲・gaming-room-2 | voice | inherit-category |
| 10 | ☕・casual-chat | voice | inherit-category |
| 11 | 🎬・watch-party | voice | inherit-category |
| 12 | 🎵・community-listening | voice | inherit-category |

## Medium Community — 50 channel permanen

Jumlah dihitung dari channel entries di manifest; kategori dan Temporary Voice rooms dinamis tidak masuk hitungan.

### 1. – – ~ 📊 • | SERVER STATS |

Permission kategori: stats-readonly.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 👥・all-members | text | inherit-category |
| 2 | 👤・members | text | inherit-category |
| 3 | 🤖・bots | text | inherit-category |
| 4 | 💬・channels | text | inherit-category |
| 5 | 🎭・roles | text | inherit-category |

### 2. – – ~ 📢 • | ANNOUNCEMENT |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 📢・announcements | announcement | inherit-category |
| 2 | 📰・server-updates | announcement | inherit-category |
| 3 | 📅・events | text | inherit-category |
| 4 | 🎁・giveaways | text | inherit-category |
| 5 | 📌・server-guide | text | inherit-category |

### 3. – – ~ 💬 • | GENERAL |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 💬・global-chat | text | inherit-category |
| 2 | 👋・introductions | text | inherit-category |
| 3 | 😂・memes | text | inherit-category |
| 4 | 🤖・bot-commands | text | inherit-category |
| 5 | 📸・media-share | text | inherit-category |
| 6 | 🤔・questions | text | inherit-category |
| 7 | 💡・suggestions | forum | inherit-category |
| 8 | ☕・off-topic | text | inherit-category |
| 9 | 🎭・getroles | text | inherit-category |
| 10 | 📈・leveling | text | inherit-category |

### 4. – – ~ 📝 • | LOGS |

Permission kategori: private-staff.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🔨・mod-logs | text | inherit-category |
| 2 | 🚫・ban-logs | text | inherit-category |
| 3 | 👥・member-logs | text | inherit-category |
| 4 | 🎫・ticket-logs | text | inherit-category |
| 5 | 🤖・bot-logs | text | inherit-category |

### 5. – – ~ 🎮 • | GAME |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🕹️・game-chat | text | inherit-category |
| 2 | 🔎・find-teammates | text | inherit-category |
| 3 | 🎬・game-clips | text | inherit-category |
| 4 | 🧠・game-guides | forum | inherit-category |
| 5 | 🎲・other-games | text | inherit-category |
| 6 | 🏅・ranked-talk | text | inherit-category |
| 7 | 🎮・game-updates | announcement | inherit-category |
| 8 | 🏆・game-events | text | inherit-category |

### 6. – – ~ 🛡️ • | MOD & STAFF |

Permission kategori: private-staff.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🛡️・staff-chat | text | inherit-category |
| 2 | 📣・staff-announcements | announcement | inherit-category |
| 3 | 📋・staff-notes | text | inherit-category |
| 4 | 🎫・ticket-staff | text | inherit-category |
| 5 | 🔊・staff-voice | voice | inherit-category |
| 6 | 📚・staff-resources | text | inherit-category |
| 7 | ⚖️・appeal-review | forum | inherit-category |

### 7. – – ~ 🎵 • | MUSIC |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🎧・request-music | text | inherit-category |
| 2 | 🎵・music-commands | text | inherit-category |
| 3 | 📻・radio-status | text | inherit-category |
| 4 | 🎶・listening-room | voice | inherit-category |
| 5 | 🎼・chill-room | voice | inherit-category |

### 8. – – ~ 🔊 • | VOICE LOUNGE |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🔊・general-vc | voice | inherit-category |
| 2 | 🎮・gaming-vc | voice | inherit-category |
| 3 | 👥・community-vc | voice | inherit-category |
| 4 | ➕・create-voice | voice | inherit-category |
| 5 | 🎉・event-stage | stage | inherit-category |

## Small Community — 35 channel permanen

Jumlah dihitung dari channel entries di manifest; kategori dan Temporary Voice rooms dinamis tidak masuk hitungan.

### 1. – – ~ 📊 • | SERVER STATS |

Permission kategori: stats-readonly.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 👥・all-members | text | inherit-category |
| 2 | 👤・members | text | inherit-category |
| 3 | 🤖・bots | text | inherit-category |
| 4 | 💬・channels | text | inherit-category |
| 5 | 🎭・roles | text | inherit-category |

### 2. – – ~ 📢 • | ANNOUNCEMENT |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 📢・announcements | announcement | inherit-category |
| 2 | 📅・events | text | inherit-category |
| 3 | 📌・server-guide | text | inherit-category |

### 3. – – ~ 💬 • | GENERAL |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 💬・global-chat | text | inherit-category |
| 2 | 👋・introductions | text | inherit-category |
| 3 | 😂・memes | text | inherit-category |
| 4 | 🤖・bot-commands | text | inherit-category |
| 5 | 📸・media-share | text | inherit-category |
| 6 | 💡・suggestions | forum | inherit-category |
| 7 | 🎭・getroles | text | inherit-category |

### 4. – – ~ 📝 • | LOGS |

Permission kategori: private-staff.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🔨・mod-logs | text | inherit-category |
| 2 | 🚫・ban-logs | text | inherit-category |
| 3 | 🎫・ticket-logs | text | inherit-category |
| 4 | 🤖・bot-logs | text | inherit-category |

### 5. – – ~ 🎮 • | GAME |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🕹️・game-chat | text | inherit-category |
| 2 | 🔎・find-teammates | text | inherit-category |
| 3 | 🎬・game-clips | text | inherit-category |
| 4 | 🎲・other-games | text | inherit-category |
| 5 | 🎮・game-updates | announcement | inherit-category |

### 6. – – ~ 🛡️ • | MOD & STAFF |

Permission kategori: private-staff.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🛡️・staff-chat | text | inherit-category |
| 2 | 📋・staff-notes | text | inherit-category |
| 3 | 🔊・staff-voice | voice | inherit-category |

### 7. – – ~ 🎵 • | MUSIC |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🎧・request-music | text | inherit-category |
| 2 | 🎵・music-commands | text | inherit-category |
| 3 | 🎶・listening-room | voice | inherit-category |

### 8. – – ~ 🔊 • | VOICE LOUNGE |

Permission kategori: public.

| Urutan | Nama channel | Tipe | Permission |
|---:|---|---|---|
| 1 | 🔊・general-vc | voice | inherit-category |
| 2 | 🎮・gaming-vc | voice | inherit-category |
| 3 | 👥・community-vc | voice | inherit-category |
| 4 | ➕・create-voice | voice | inherit-category |
| 5 | 🎉・event-stage | stage | inherit-category |

## Real-Time Server Stats

Updater berjalan sekali saat clientReady, lalu setiap lima menit, dengan guard agar cycle tidak bertumpuk. Ia mencari kategori dan lima nama dasar secara persis: 👥・all-members, 👤・members, 🤖・bots, 💬・channels, 🎭・roles. Setelah update, nama statistik menggunakan suffix angka; suffix ini dikenali oleh setup agar rerun tidak menggandakan channel. all-members adalah manusia + bot; members mengecualikan bot; channels menghitung semua top-level guild channel hasil fetch kecuali kategori (text, announcement, forum, voice, stage); roles menghitung koleksi role hasil fetch, termasuk @everyone. Fetch gagal menandai nilai unavailable bila channel dapat dijangkau, bukan mempertahankan angka seolah aktual. Setiap rename gagal dicatat dan tidak menghentikan empat statistik lain.

## Temporary Voice dan batas verifikasi

Temporary Voice tetap memakai satu listener voiceStateUpdate, trigger ➕・create-voice, kategori – – ~ 🔊 • | VOICE LOUNGE |, pemindahan member, dan cleanup room kosong yang dibuat proses bot. Room sementara tidak dihitung manifest. Belum ada validasi live terhadap Discord, izin server nyata, atau gambar referensi; manifest memakai daftar channel terdahulu yang relevan serta tambahan bernama eksplisit di source.
