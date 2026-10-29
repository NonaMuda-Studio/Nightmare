
require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  Events,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { AttachmentBuilder } = require('discord.js');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createMusicManager, formatDuration } = require('./music-system');
const { createPlaylistStore } = require('./playlist-store');
const { searchLyrics } = require('./lyrics');
const { fetchAvatar } = require('./bot-profile');
const { createXpStore } = require('./xp-store');
const { renderRankCardSafely } = require('./rank-card');
const { grantMilestoneRoles } = require('./level-rewards');
const { buildLevelRolePanel, buildLevelRoleList, buildProgressBar } = require('./leveling-ui');
const { resetGuildAfterConfirmation, activeResetMessages } = require('./level-admin');
const { createResetConfirmationGuard } = require('./reset-confirmation');
const { createVoiceXpTracker } = require('./voice-xp');
const { createEconomyStore, createGiveawayStore, createTicketStore } = require('./nightmare-services');
const { handleEconomy, handleEconomyAdmin, handleItemAdmin, handleAdventure, handleEconomyAutocomplete, handleGiveawayCreate, handleGiveawayButton, finishDueGiveaways, handleTicketCommand, handleTicketButton } = require('./nightmare-interactions');
const { createNotificationStore, handleNotifyCommand, handleMemberNotification, retryPendingNotifications } = require('./notification-system');
const { createPlaygroundService, handlePlaygroundCommand } = require('./playground-system');
const { createTicketDeletionScheduler } = require('./ticket-deletion');
const { RANKS } = require('./economy-catalog');
const { MONSTERS } = require('./adventure-monsters');
const { SKILLS } = require('./adventure-skills');
const { TEMPLATE_KEYS, createAnnouncementDraftStore, handleAnnouncementCreate, handleAnnouncementComponent, handleAnnouncementModal } = require('./announcement-studio');
const { createInteractionDiagnostics, errorResponseAction } = require('./interaction-diagnostics');
const { RADIO_STATIONS, RADIO_STATION_BY_ID, createRadioStore, hasRadioAdminPermission } = require('./radio-system');
const { SETUP_MANIFESTS, buildSetupPreview, applySetupManifest, createSetupConfirmationStore, renderSetupPreview, validateSetupStaffRole } = require('./server-setup');
const { createServerStatusUpdater } = require('./server-status');
const { registerCommandsUnlessSkipped } = require('./command-registration');
const { createTemporaryVoiceService } = require('./temporary-voice');
const { retryIdempotentRead, sendLevelUpOnce, classifyLevelUpDeliveryError } = require('./level-up-delivery');
const { buildSetupCommand } = require('./setup-command-schema');
let voiceXpTracker;
const radioStore = createRadioStore(path.join(__dirname, 'data', 'radio.json'));
const musicManager = createMusicManager({
  radioStore,
  onVoiceActivity: (guildId, userId, channelId) => {
    const member = client.guilds.cache.get(guildId)?.members.cache.get(userId);
    if (!member || member.user.bot || member.voice.channelId !== channelId) return;
    voiceXpTracker?.markActive(guildId, userId, channelId, 'voice');
  },
  onVoiceMonitorEnd: (guildId, channelId) => voiceXpTracker?.clearChannel(guildId, channelId)
});
const playlistStore = createPlaylistStore(path.join(__dirname, 'data', 'playlists.json'));
const xpStore = createXpStore(path.join(__dirname, 'data', 'xp.json'));
const economyStore = createEconomyStore(path.join(__dirname, 'data', 'economy.json'));
const giveawayStore = createGiveawayStore(path.join(__dirname, 'data', 'giveaways.json'));
const ticketStore = createTicketStore(path.join(__dirname, 'data', 'tickets.json'));
const notificationStore = createNotificationStore(path.join(__dirname, 'data', 'notifications.json'));
const playgroundService = createPlaygroundService(economyStore);
const announcementDraftStore = createAnnouncementDraftStore();
const setupConfirmationStore = createSetupConfirmationStore();
voiceXpTracker = createVoiceXpTracker({
  award: async (guildId, userId) => {
    const result = xpStore.awardVoice(guildId, userId);
    if (!result.awarded) return;
    if (result.level > result.previousLevel) {
      const guild = client.guilds.cache.get(guildId);
      const member = await guild?.members.fetch(userId).catch(() => null);
      if (guild && member) {
        await applyLevelRewards(guild, member, result.previousLevel, result.level);
        await announceLevelUp(guild, member, result.level);
      }
    }
  },
  disconnect: async (guildId, userId, channelId) => {
    const guild = client.guilds.cache.get(guildId);
    const member = await guild?.members.fetch(userId).catch(() => null);
    if (!member || member.voice.channelId !== channelId) return;
    const botMember = guild.members.me;
    const channel = member.voice.channel;
    if (!channel?.permissionsFor(botMember)?.has(PermissionFlagsBits.MoveMembers)) throw new Error('Bot tidak memiliki izin Move Members.');
    await member.voice.disconnect('AFK 5 menit pada timer XP voice Nightmare');
  }
});
GlobalFonts.registerFromPath(
  path.join(__dirname, 'assets', 'fonts', 'Roboto-Regular.ttf'),
  'Roboto'
);



const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.Reaction,
    Partials.User
  ]
});
const ticketDeletionScheduler = createTicketDeletionScheduler({ store: ticketStore, client });
const interactionDispatchStartedAt = new WeakMap();
const interactionDiagnostics = createInteractionDiagnostics();
const activeLeaderboardMessages = new Set();
const resetConfirmationGuard = createResetConfirmationGuard();

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Cek apakah Nightmare aktif'),

  buildSetupCommand(),

  new SlashCommandBuilder()
    .setName('resetserver')
    .setDescription('Hapus channel, kategori, dan role yang dapat dikelola bot setelah konfirmasi')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    ),

  new SlashCommandBuilder()
    .setName('resetpreview')
    .setDescription('Pratinjau channel dan role tanpa menghapusnya')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    ),

  new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('Atur reaction role untuk member')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub
        .setName('create')
        .setDescription('Buat pesan reaction role')
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('Channel untuk pesan reaction role')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('title')
            .setDescription('Judul embed')
            .setMaxLength(256)
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('description')
            .setDescription('Instruksi yang ditampilkan pada embed')
            .setMaxLength(3500)
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('emoji')
            .setDescription('Satu emoji Unicode atau emoji custom dari server ini')
            .setMaxLength(100)
            .setRequired(true)
        )
        .addRoleOption(opt =>
          opt.setName('role')
            .setDescription('Role yang diberikan dan dicabut oleh reaction')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Tambahkan pasangan emoji dan role ke panel')
        .addStringOption(opt =>
          opt.setName('message_id')
            .setDescription('ID panel dari /reactionrole list')
            .setMinLength(17)
            .setMaxLength(20)
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('emoji')
            .setDescription('Satu emoji Unicode atau emoji custom dari server ini')
            .setMaxLength(100)
            .setRequired(true)
        )
        .addRoleOption(opt =>
          opt.setName('role')
            .setDescription('Role yang diberikan oleh emoji ini')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Hapus satu pasangan emoji-role dari panel')
        .addStringOption(opt =>
          opt.setName('message_id')
            .setDescription('ID panel dari /reactionrole list')
            .setMinLength(17)
            .setMaxLength(20)
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('emoji')
            .setDescription('Emoji mapping yang dihapus')
            .setMaxLength(100)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('Lihat konfigurasi reaction role server ini')
    )
    .addSubcommand(sub =>
      sub
        .setName('delete')
        .setDescription('Hapus konfigurasi berdasarkan ID pesan')
        .addStringOption(opt =>
          opt.setName('message_id')
            .setDescription('ID pesan, ditampilkan oleh /reactionrole list')
            .setMinLength(17)
            .setMaxLength(20)
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Putar atau antrekan lagu dari YouTube, Spotify, atau judul')
    .addStringOption(opt => opt.setName('query').setDescription('Judul lagu atau URL YouTube/Spotify').setMaxLength(200).setRequired(true)),
  new SlashCommandBuilder().setName('pause').setDescription('Jeda lagu yang sedang diputar'),
  new SlashCommandBuilder().setName('resume').setDescription('Lanjutkan lagu yang dijeda'),
  new SlashCommandBuilder().setName('skip').setDescription('Lewati lagu yang sedang diputar'),
  new SlashCommandBuilder().setName('stop').setDescription('Hentikan lagu dan kosongkan antrean'),
  new SlashCommandBuilder().setName('queue').setDescription('Lihat lagu yang diputar dan antrean'),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Lihat lagu yang sedang diputar'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Atur volume player server (0–200%)')
    .addIntegerOption(opt => opt.setName('percent').setDescription('Volume 0 sampai 200 persen').setMinValue(0).setMaxValue(200).setRequired(true)),
  new SlashCommandBuilder().setName('dc').setDescription('Putuskan koneksi musik dari voice channel'),

  new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Kelola mode radio Lofi server')
    .addSubcommand(sub => sub.setName('move').setDescription('Pindah dari Radio Mode ke Music Mode').addStringOption(opt => opt.setName('mode').setDescription('Mode tujuan').addChoices({ name: 'Music Mode', value: 'music' }).setRequired(true)))
    .addSubcommand(sub => sub.setName('station').setDescription('Simpan stasiun radio terakhir').addStringOption(opt => opt.setName('name').setDescription('Stasiun radio (sumber belum aktif)')
      .addChoices(...RADIO_STATIONS.map(station => ({ name: `${station.name} (belum tersedia)`, value: station.id }))).setRequired(true)))
    .addSubcommand(sub => sub.setName('status').setDescription('Lihat mode dan status radio')),

  new SlashCommandBuilder()
    .setName('music')
    .setDescription('Kelola mode Music server')
    .addSubcommand(sub => sub.setName('move').setDescription('Pindah dari Music Mode ke Radio Mode').addStringOption(opt => opt.setName('mode').setDescription('Mode tujuan').addChoices({ name: 'Radio Mode', value: 'radio' }).setRequired(true))),

  new SlashCommandBuilder()
    .setName('playlist')
    .setDescription('Kelola playlist bersama server')
    .addSubcommand(sub => sub.setName('create').setDescription('Buat playlist server').addStringOption(opt => opt.setName('name').setDescription('Nama playlist (2–40 karakter)').setMaxLength(40).setRequired(true)))
    .addSubcommand(sub => sub.setName('rename').setDescription('Ubah nama playlist').addStringOption(opt => opt.setName('name').setDescription('Nama sekarang').setMaxLength(40).setRequired(true)).addStringOption(opt => opt.setName('new_name').setDescription('Nama baru').setMaxLength(40).setRequired(true)))
    .addSubcommand(sub => sub.setName('list').setDescription('Lihat playlist server'))
    .addSubcommand(sub => sub.setName('add').setDescription('Tambahkan lagu ke playlist').addStringOption(opt => opt.setName('name').setDescription('Nama playlist').setMaxLength(40).setRequired(true)).addStringOption(opt => opt.setName('query').setDescription('Judul atau URL YouTube/Spotify').setMaxLength(200).setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Hapus lagu berdasarkan nomor atau ID').addStringOption(opt => opt.setName('name').setDescription('Nama playlist').setMaxLength(40).setRequired(true)).addStringOption(opt => opt.setName('item').setDescription('Nomor lagu (1-based) atau ID item').setMaxLength(12).setRequired(true)))
    .addSubcommand(sub => sub.setName('play').setDescription('Masukkan playlist ke antrean').addStringOption(opt => opt.setName('name').setDescription('Nama playlist').setMaxLength(40).setRequired(true))),

  new SlashCommandBuilder()
    .setName('lyrics')
    .setDescription('Cari cuplikan lirik singkat dan tautan sumber')
    .addStringOption(opt => opt.setName('song').setDescription('Judul lagu').setMaxLength(150).setRequired(true))
    .addStringOption(opt => opt.setName('artist').setDescription('Nama artis (opsional)').setMaxLength(100).setRequired(false)),

  new SlashCommandBuilder()
    .setName('botprofile')
    .setDescription('Ubah profil Nightmare')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('name').setDescription('Ubah nama bot').addStringOption(opt => opt.setName('name').setDescription('Nama baru (2–32 karakter)').setMinLength(2).setMaxLength(32).setRequired(true)))
    .addSubcommand(sub => sub.setName('avatar').setDescription('Ubah avatar bot dari gambar HTTPS').addStringOption(opt => opt.setName('url').setDescription('URL PNG, JPEG, GIF, atau WebP (maks. 8 MB)').setMaxLength(500).setRequired(true)))
    .addSubcommand(sub => sub.setName('reset').setDescription('Kembalikan nama ke nama aplikasi dan avatar ke ikon aplikasi')),

  new SlashCommandBuilder()
    .setName('bg')
    .setDescription('Atur background kartu member')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub
        .setName('welcome')
        .setDescription('Atur background kartu welcome')
        .addStringOption(opt =>
          opt.setName('url')
            .setDescription('URL gambar langsung dari GitHub')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('goodbye')
        .setDescription('Atur background kartu goodbye')
        .addStringOption(opt =>
          opt.setName('url')
            .setDescription('URL gambar langsung dari GitHub')
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Lihat kartu rank Nightmare')
    .addUserOption(opt => opt.setName('member').setDescription('Member yang ingin dilihat').setRequired(false)),
  new SlashCommandBuilder()
    .setName('level')
    .setDescription('Lihat statistik level dan progres XP member')
    .addUserOption(opt => opt.setName('member').setDescription('Member yang ingin dilihat').setRequired(false)),
  new SlashCommandBuilder()
    .setName('card')
    .setDescription('Lihat kartu rank Nightmare')
    .addUserOption(opt => opt.setName('member').setDescription('Member yang ingin dilihat').setRequired(false)),
  new SlashCommandBuilder()
    .setName('rewards')
    .setDescription('Lihat milestone role level server'),
  new SlashCommandBuilder()
    .setName('boosters')
    .setDescription('Lihat konfigurasi multiplier XP server'),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Lihat peringkat XP server'),
  new SlashCommandBuilder()
    .setName('xpboost')
    .setDescription('Atur XP akhir untuk setiap aktivitas valid')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addIntegerOption(opt => opt.setName('amount').setDescription('XP per aktivitas (1–500)').setMinValue(1).setMaxValue(500).setRequired(true)),
  new SlashCommandBuilder()
    .setName('level-config')
    .setDescription('Atur leveling server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('show').setDescription('Lihat konfigurasi leveling'))
    .addSubcommand(sub => sub.setName('enabled').setDescription('Aktifkan atau nonaktifkan XP').addBooleanOption(opt => opt.setName('value').setDescription('Status leveling').setRequired(true)))
    .addSubcommand(sub => sub.setName('announce').setDescription('Atur channel pengumuman level-up; kosongkan untuk mematikan').addChannelOption(opt => opt.setName('channel').setDescription('Channel teks untuk level-up').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false)))
    .addSubcommand(sub => sub.setName('exclude').setDescription('Kelola channel yang tidak memberi XP').addStringOption(opt => opt.setName('action').setDescription('Tindakan').addChoices({ name: 'Tambah', value: 'add' }, { name: 'Hapus', value: 'remove' }, { name: 'Bersihkan semua', value: 'clear' }).setRequired(true)).addChannelOption(opt => opt.setName('channel').setDescription('Channel teks').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false)))
    .addSubcommand(sub => sub.setName('booster-add').setDescription('Tambah booster role atau channel').addStringOption(opt => opt.setName('type').setDescription('Target booster').addChoices({ name: 'Role', value: 'role' }, { name: 'Channel', value: 'channel' }).setRequired(true)).addNumberOption(opt => opt.setName('multiplier').setDescription('Pengali XP 1–5, maksimal 2 desimal').setMinValue(1).setMaxValue(5).setRequired(true)).addRoleOption(opt => opt.setName('role').setDescription('Role target (untuk jenis role)').setRequired(false)).addChannelOption(opt => opt.setName('channel').setDescription('Channel target (untuk jenis channel)').setRequired(false)))
    .addSubcommand(sub => sub.setName('booster-remove').setDescription('Hapus booster role atau channel').addStringOption(opt => opt.setName('type').setDescription('Target booster').addChoices({ name: 'Role', value: 'role' }, { name: 'Channel', value: 'channel' }).setRequired(true)).addRoleOption(opt => opt.setName('role').setDescription('Role target').setRequired(false)).addChannelOption(opt => opt.setName('channel').setDescription('Channel target').setRequired(false))),
  new SlashCommandBuilder()
    .setName('level-rewards')
    .setDescription('Kelola role reward berdasarkan level')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('list').setDescription('Lihat semua role reward'))
    .addSubcommand(sub => sub.setName('add').setDescription('Tambahkan role reward').addIntegerOption(opt => opt.setName('level').setDescription('Level yang dicapai (0–500)').setMinValue(0).setMaxValue(500).setRequired(true)).addRoleOption(opt => opt.setName('role').setDescription('Role reward').setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Hapus mapping reward berdasarkan level').addIntegerOption(opt => opt.setName('level').setDescription('Level reward').setMinValue(0).setMaxValue(500).setRequired(true)))
    .addSubcommand(sub => sub.setName('panel').setDescription('Buat atau perbarui panel level roles').addChannelOption(opt => opt.setName('channel').setDescription('Channel teks tujuan').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))),
  ...[
    ['give-xp', 'Tambahkan XP member (maks. 1.000.000)', 1_000_000],
    ['give-level', 'Tambahkan level member (maks. 500)', 500],
    ['remove-xp', 'Kurangi XP member (maks. 1.000.000)', 1_000_000],
    ['remove-level', 'Kurangi level member (maks. 500)', 500]
  ].map(([name, description, maximum]) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(description)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addUserOption(opt => opt.setName('member').setDescription('Member target').setRequired(true))
      .addIntegerOption(opt => opt.setName('jumlah').setDescription('Jumlah perubahan').setMinValue(1).setMaxValue(maximum).setRequired(true))
  ),
  new SlashCommandBuilder()
    .setName('xp')
    .setDescription('Administrasi XP dan level server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub => sub.setName('add').setDescription('Tambahkan XP').addUserOption(opt => opt.setName('member').setDescription('Member target').setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('XP yang ditambahkan').setMinValue(1).setMaxValue(1_000_000).setRequired(true)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Kurangi XP, minimum nol').addUserOption(opt => opt.setName('member').setDescription('Member target').setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('XP yang dikurangi').setMinValue(1).setMaxValue(1_000_000).setRequired(true)))
    .addSubcommandGroup(group => group.setName('set').setDescription('Tetapkan XP atau level').addSubcommand(sub => sub.setName('xp').setDescription('Tetapkan total XP').addUserOption(opt => opt.setName('member').setDescription('Member target').setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Total XP (0–625.375.000)').setMinValue(0).setMaxValue(625_375_000).setRequired(true))).addSubcommand(sub => sub.setName('level').setDescription('Tetapkan level tepat').addUserOption(opt => opt.setName('member').setDescription('Member target').setRequired(true)).addIntegerOption(opt => opt.setName('level').setDescription('Level tujuan (0–5.000)').setMinValue(0).setMaxValue(5_000).setRequired(true))))
    .addSubcommandGroup(group => group.setName('reset').setDescription('Reset statistik leveling').addSubcommand(sub => sub.setName('member').setDescription('Reset XP seorang member').addUserOption(opt => opt.setName('member').setDescription('Member target').setRequired(true))).addSubcommand(sub => sub.setName('server').setDescription('Reset XP seluruh member; konfirmasi wajib'))),
  new SlashCommandBuilder().setName('giveaway').setDescription('Kelola giveaway server').addSubcommand(sub => sub.setName('create').setDescription('Buat giveaway baru').addStringOption(opt => opt.setName('prize').setDescription('Hadiah giveaway').setMaxLength(200).setRequired(true)).addIntegerOption(opt => opt.setName('minutes').setDescription('Durasi dalam menit').setMinValue(1).setMaxValue(10080).setRequired(true)).addIntegerOption(opt => opt.setName('winners').setDescription('Jumlah pemenang').setMinValue(1).setMaxValue(20).setRequired(true))),
  new SlashCommandBuilder().setName('economy').setDescription('Kelola saldo dan item Nightmare').addSubcommand(sub => sub.setName('balance').setDescription('Lihat saldo')).addSubcommand(sub => sub.setName('daily').setDescription('Klaim hadiah harian')).addSubcommand(sub => sub.setName('transfer').setDescription('Kirim koin ke member').addUserOption(opt => opt.setName('member').setDescription('Penerima').setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Jumlah koin').setMinValue(1).setMaxValue(1000000).setRequired(true))).addSubcommand(sub => sub.setName('shop').setDescription('Lihat katalog shop server')).addSubcommand(sub => sub.setName('buy').setDescription('Beli item katalog').addStringOption(opt => opt.setName('item').setDescription('Item katalog').setAutocomplete(true).setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Jumlah 1–1000').setMinValue(1).setMaxValue(1000).setRequired(false))).addSubcommand(sub => sub.setName('sell').setDescription('Jual item dari inventory').addStringOption(opt => opt.setName('item').setDescription('Item yang dimiliki').setAutocomplete(true).setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Jumlah 1–1000').setMinValue(1).setMaxValue(1000).setRequired(false))).addSubcommand(sub => sub.setName('inventory').setDescription('Lihat inventory')).addSubcommand(sub => sub.setName('leaderboard').setDescription('Lihat 10 saldo tertinggi')),
  new SlashCommandBuilder().setName('economy-admin').setDescription('Administrasi saldo dan harga toko').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addSubcommand(sub => sub.setName('add').setDescription('Tambah saldo member').addUserOption(opt => opt.setName('member').setDescription('Target').setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Jumlah').setMinValue(1).setMaxValue(1000000).setRequired(true))).addSubcommand(sub => sub.setName('remove').setDescription('Kurangi saldo member').addUserOption(opt => opt.setName('member').setDescription('Target').setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Jumlah').setMinValue(1).setMaxValue(1000000).setRequired(true))).addSubcommand(sub => sub.setName('reset').setDescription('Reset saldo member').addUserOption(opt => opt.setName('member').setDescription('Target').setRequired(true)).addBooleanOption(opt => opt.setName('confirm').setDescription('Konfirmasi reset saldo').setRequired(true))).addSubcommand(sub => sub.setName('price').setDescription('Ubah harga item server').addStringOption(opt => opt.setName('item').setDescription('Item').setAutocomplete(true).setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Harga 1–1.000.000').setMinValue(1).setMaxValue(1000000).setRequired(true))),
  new SlashCommandBuilder().setName('item').setDescription('Administrasi inventory Economy').setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addSubcommand(sub => sub.setName('give').setDescription('Berikan item').addUserOption(opt => opt.setName('member').setDescription('Target').setRequired(true)).addStringOption(opt => opt.setName('item').setDescription('Item').setAutocomplete(true).setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Jumlah').setMinValue(1).setMaxValue(1000).setRequired(true))).addSubcommand(sub => sub.setName('remove').setDescription('Ambil item').addUserOption(opt => opt.setName('member').setDescription('Target').setRequired(true)).addStringOption(opt => opt.setName('item').setDescription('Item').setAutocomplete(true).setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Jumlah').setMinValue(1).setMaxValue(1000).setRequired(true))),
  new SlashCommandBuilder().setName('ticket').setDescription('Kelola tiket bantuan').addSubcommand(sub => sub.setName('setup').setDescription('Konfigurasikan role staf tiket').addRoleOption(opt => opt.setName('staff_role').setDescription('Role yang dapat melihat dan menangani tiket').setRequired(true)).addChannelOption(opt => opt.setName('category').setDescription('Kategori channel tiket').addChannelTypes(ChannelType.GuildCategory).setRequired(false))).addSubcommand(sub => sub.setName('panel').setDescription('Kirim panel pembukaan tiket')).addSubcommand(sub => sub.setName('close').setDescription('Tutup tiket di channel ini')).addSubcommand(sub => sub.setName('reopen').setDescription('Buka kembali tiket di channel ini'))
  ,new SlashCommandBuilder().setName('notify').setDescription('Konfigurasikan notifikasi server').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addSubcommand(sub => sub.setName('configure').setDescription('Atur channel, role, dan event member').addChannelOption(opt => opt.setName('channel').setDescription('Channel tujuan notification').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)).addBooleanOption(opt => opt.setName('joins').setDescription('Kirim notifikasi member bergabung').setRequired(true)).addBooleanOption(opt => opt.setName('leaves').setDescription('Kirim notifikasi member keluar').setRequired(true)).addRoleOption(opt => opt.setName('role').setDescription('Role opsional untuk mention').setRequired(false))).addSubcommand(sub => sub.setName('send').setDescription('Kirim pengumuman ke channel terkonfigurasi').addStringOption(opt => opt.setName('message').setDescription('Isi pengumuman').setMaxLength(1800).setRequired(true))),
  new SlashCommandBuilder().setName('playground').setDescription('Mainkan game sederhana dan menangkan coin').addSubcommand(sub => sub.setName('guess-start').setDescription('Mulai tebak angka (3 kesempatan)').addIntegerOption(opt => opt.setName('stake').setDescription('Entry fee opsional (0–100)').setMinValue(0).setMaxValue(100).setRequired(false))).addSubcommand(sub => sub.setName('guess').setDescription('Kirim tebakan untuk game milikmu').addStringOption(opt => opt.setName('game_id').setDescription('ID dari guess-start').setMinLength(17).setMaxLength(20).setRequired(true)).addIntegerOption(opt => opt.setName('number').setDescription('Tebakan 1–10').setMinValue(1).setMaxValue(10).setRequired(true))).addSubcommand(sub => sub.setName('trivia-start').setDescription('Mulai trivia satu pertanyaan').addIntegerOption(opt => opt.setName('stake').setDescription('Entry fee opsional (0–100)').setMinValue(0).setMaxValue(100).setRequired(false))).addSubcommand(sub => sub.setName('answer').setDescription('Jawab trivia milikmu').addStringOption(opt => opt.setName('game_id').setDescription('ID dari trivia-start').setMinLength(17).setMaxLength(20).setRequired(true)).addIntegerOption(opt => opt.setName('choice').setDescription('Nomor jawaban 1–4').setMinValue(1).setMaxValue(4).setRequired(true))).addSubcommand(sub => sub.setName('flip').setDescription('Coin flip dengan taruhan 1–100 coin').addStringOption(opt => opt.setName('choice').setDescription('Tebak sisi koin').addChoices({ name: 'Heads', value: 'heads' }, { name: 'Tails', value: 'tails' }).setRequired(true)).addIntegerOption(opt => opt.setName('stake').setDescription('Taruhan 1–100 coin').setMinValue(1).setMaxValue(100).setRequired(true)))
].map(command => command.toJSON());

commands.push(new SlashCommandBuilder().setName('adventure').setDescription('Petualangan Guild Nightmare')
  .addSubcommand(sub => sub.setName('register').setDescription('Daftar sebagai petualang').addStringOption(opt => opt.setName('name').setDescription('Nama petualang').setMinLength(1).setMaxLength(32).setRequired(true)))
  .addSubcommand(sub => sub.setName('profile').setDescription('Lihat profil petualang'))
  .addSubcommand(sub => sub.setName('inventory').setDescription('Lihat inventory Economy'))
  .addSubcommand(sub => sub.setName('materials').setDescription('Lihat material crafting'))
  .addSubcommand(sub => sub.setName('recipes').setDescription('Lihat resep crafting'))
  .addSubcommand(sub => sub.setName('craft').setDescription('Buat item dengan material').addStringOption(opt => opt.setName('item').setDescription('Item resep').setAutocomplete(true).setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Jumlah 1–100').setMinValue(1).setMaxValue(100).setRequired(false)))
  .addSubcommand(sub => sub.setName('hunt').setDescription('Mulai sesi berburu turn-based'))
  .addSubcommand(sub => sub.setName('fight').setDescription('Ambil aksi pada sesi hunting').addStringOption(opt => opt.setName('session').setDescription('ID sesi dari /adventure hunt').setRequired(true)).addStringOption(opt => opt.setName('action').setDescription('Aksi turn ini').addChoices({name:'Serang',value:'attack'},{name:'Bertahan',value:'defend'},{name:'Gunakan potion',value:'potion'},{name:'Kabur',value:'run'}).setRequired(true)).addStringOption(opt => opt.setName('item').setDescription('Potion yang digunakan').setAutocomplete(true).setRequired(false)))
  .addSubcommand(sub => sub.setName('quest').setDescription('Lihat atau klaim quest guild harian'))
  .addSubcommand(sub => sub.setName('equip').setDescription('Pasang equipment yang dimiliki').addStringOption(opt => opt.setName('slot').setDescription('Slot equipment').addChoices({name:'Weapon',value:'weapon'},{name:'Armor',value:'armor'},{name:'Accessory',value:'accessory'}).setRequired(true)).addStringOption(opt => opt.setName('item').setDescription('Item equipment').setAutocomplete(true).setRequired(true)))
  .addSubcommand(sub => sub.setName('unequip').setDescription('Lepas equipment').addStringOption(opt => opt.setName('slot').setDescription('Slot equipment').addChoices({name:'Weapon',value:'weapon'},{name:'Armor',value:'armor'},{name:'Accessory',value:'accessory'}).setRequired(true)))
  .addSubcommand(sub => sub.setName('use').setDescription('Gunakan potion pemulihan').addStringOption(opt => opt.setName('item').setDescription('Potion milikmu').setAutocomplete(true).setRequired(true)))
  .addSubcommand(sub => sub.setName('open-box').setDescription('Buka satu Mystery Box milikmu'))
  .addSubcommand(sub => sub.setName('skills').setDescription('Lihat daftar, efek, biaya, dan status skill').addStringOption(opt => opt.setName('skill').setDescription('Detail skill tertentu').addChoices(...SKILLS.map(skill=>({name:skill.name,value:skill.id}))).setRequired(false)))
  .addSubcommand(sub => sub.setName('learn').setDescription('Pelajari skill menggunakan Skill Point').addStringOption(opt => opt.setName('skill').setDescription('Skill yang akan dipelajari').addChoices(...SKILLS.map(skill=>({name:skill.name,value:skill.id}))).setRequired(true)))
  .addSubcommand(sub => sub.setName('upgrade').setDescription('Tingkatkan skill yang sudah dipelajari').addStringOption(opt => opt.setName('skill').setDescription('Skill yang akan ditingkatkan').addChoices(...SKILLS.map(skill=>({name:skill.name,value:skill.id}))).setRequired(true)))
  .addSubcommand(sub => sub.setName('cast').setDescription('Gunakan skill aktif pada giliran pertarungan').addStringOption(opt => opt.setName('session').setDescription('ID sesi hunt aktif milikmu').setRequired(true)).addStringOption(opt => opt.setName('skill').setDescription('Skill aktif yang dipelajari').addChoices(...SKILLS.filter(skill=>skill.type!=='passive').map(skill=>({name:skill.name,value:skill.id}))).setRequired(true)))
  .addSubcommandGroup(group => group.setName('admin').setDescription('Bypass Adventure untuk administrator').addSubcommand(sub => sub.setName('rank').setDescription('Tetapkan rank manual (melewati syarat normal)').addUserOption(opt => opt.setName('target').setDescription('Pemain terdaftar').setRequired(true)).addStringOption(opt => opt.setName('rank').setDescription('Rank F sampai S').addChoices(...RANKS.map(rank=>({name:rank,value:rank}))).setRequired(true))).addSubcommand(sub => sub.setName('stats').setDescription('Tetapkan ATK, DEF, max HP, dan HP saat ini').addUserOption(opt => opt.setName('target').setDescription('Pemain terdaftar').setRequired(true)).addIntegerOption(opt => opt.setName('attack').setDescription('ATK dasar (0–100.000)').setMinValue(0).setMaxValue(100000).setRequired(true)).addIntegerOption(opt => opt.setName('defense').setDescription('DEF dasar (0–100.000)').setMinValue(0).setMaxValue(100000).setRequired(true)).addIntegerOption(opt => opt.setName('max_hp').setDescription('HP maksimum (1–100.000)').setMinValue(1).setMaxValue(100000).setRequired(true)).addIntegerOption(opt => opt.setName('current_hp').setDescription('HP saat ini (0–100.000)').setMinValue(0).setMaxValue(100000).setRequired(true))).addSubcommand(sub => sub.setName('skillpoints').setDescription('Tambah atau tetapkan saldo skill point').addUserOption(opt => opt.setName('target').setDescription('Pemain terdaftar').setRequired(true)).addStringOption(opt => opt.setName('operation').setDescription('Operasi saldo').addChoices({name:'Tambah',value:'add'},{name:'Tetapkan',value:'set'}).setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Jumlah (0–1.000.000)').setMinValue(0).setMaxValue(1000000).setRequired(true))).addSubcommand(sub => sub.setName('enemy').setDescription('Pilih musuh untuk hunt berikutnya pemain').addUserOption(opt => opt.setName('target').setDescription('Pemain terdaftar').setRequired(true)).addStringOption(opt => opt.setName('monster').setDescription('Musuh dari katalog Adventure').setAutocomplete(true).setRequired(true))).addSubcommand(sub => sub.setName('skill').setDescription('Tetapkan level skill tanpa biaya (0 menutup skill)').addUserOption(opt => opt.setName('target').setDescription('Pemain terdaftar').setRequired(true)).addStringOption(opt => opt.setName('skill').setDescription('Skill katalog').addChoices(...SKILLS.map(skill=>({name:skill.name,value:skill.id}))).setRequired(true)).addIntegerOption(opt => opt.setName('level').setDescription('Level skill').setMinValue(0).setMaxValue(3).setRequired(true))))
  .toJSON());

commands.push(new SlashCommandBuilder().setName('announcement').setDescription('Buat pengumuman server dengan editor privat').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).addSubcommand(sub=>sub.setName('create').setDescription('Buat draft dari template').addStringOption(opt=>opt.setName('template').setDescription('Template pengumuman').addChoices(...TEMPLATE_KEYS.map(key=>({name:key,value:key}))).setRequired(true)).addChannelOption(opt=>opt.setName('channel').setDescription('Channel teks tujuan').addChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setRequired(true)).addRoleOption(opt=>opt.setName('role').setDescription('Role yang secara eksplisit akan diping').setRequired(false))).toJSON());


// NIGHTMARE_REALTIME_SERVER_STATUS
const serverStatusUpdater = createServerStatusUpdater({ client });
client.once('clientReady', () => serverStatusUpdater.start());
// END NIGHTMARE_REALTIME_SERVER_STATUS

client.once('clientReady', async () => {
  console.log(`Bot online: ${client.user.tag}`);

  try {
    await registerCommandsUnlessSkipped({
      env: process.env,
      logger: console,
      register: async () => {
        const rest = new REST({ version: '10' })
          .setToken(process.env.DISCORD_TOKEN);
        await rest.put(
          Routes.applicationCommands(client.application.id),
          { body: commands }
        );
        console.log('Slash commands dikirim ke Discord:', commands.map(c => '/' + c.name).join(', '));
      }
    });
  } catch (error) {
    console.error('Gagal mendaftarkan perintah:', error.message);
  }
});

client.once('clientReady', () => {
  const recoverGiveaways = () => finishDueGiveaways(client, giveawayStore);
  void recoverGiveaways();
  setInterval(recoverGiveaways, 15_000);
});

client.once('clientReady', () => {
  const retryNotifications = () => retryPendingNotifications(client, notificationStore);
  void retryNotifications();
  setInterval(retryNotifications, 5_000);
});

client.once('clientReady', () => {
  const recovered = ticketDeletionScheduler.recover();
  console.log(`[TICKET] Jadwal penghapusan dipulihkan: ${recovered} tiket.`);
});

client.once('clientReady', async () => {
  let entries;
  try { entries = radioStore.list(); }
  catch (error) {
    console.error(`[RADIO] Konfigurasi gagal dibaca; tidak diubah: ${safeErrorDiagnostic(error)}`);
    return;
  }
  for (const config of entries) {
    if (config.mode !== 'radio' || !config.autoReconnect || !config.stationId || !config.voiceChannelId) continue;
    const station = RADIO_STATION_BY_ID.get(config.stationId);
    if (!station?.available) {
      console.warn(`[RADIO] guild=${config.guildId} pemulihan ditahan: ${station?.name || config.stationId} belum memiliki sumber audio/izin yang terverifikasi; konfigurasi dipertahankan.`);
      continue;
    }
    let guild;
    let channel;
    let lookupError;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        guild = client.guilds.cache.get(config.guildId) || await client.guilds.fetch(config.guildId);
        channel = guild.channels.cache.get(config.voiceChannelId) || await guild.channels.fetch(config.voiceChannelId);
        break;
      } catch (error) {
        lookupError = error;
        if ([10003, 10004, 50001, 50013].includes(Number(error.code))) break;
        if (attempt < 5) await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1_000 * (2 ** (attempt - 1)))));
      }
    }
    if (!guild || !channel) {
      console.warn(`[RADIO] guild=${config.guildId} pemulihan dilewati: guild/channel tidak dapat divalidasi; konfigurasi dipertahankan: ${safeErrorDiagnostic(lookupError || new Error('guild/channel unavailable'))}`);
      continue;
    }
    const botMember = guild.members.me || await guild.members.fetchMe().catch(error => { lookupError = error; return null; });
    if (!botMember || !channel?.isVoiceBased?.() || !channel.permissionsFor(botMember)?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      console.warn(`[RADIO] guild=${config.guildId} pemulihan dilewati: channel atau izin Connect/Speak tidak valid; konfigurasi dipertahankan${lookupError ? `: ${safeErrorDiagnostic(lookupError)}` : ''}.`);
      continue;
    }
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const restored = await musicManager.restoreRadio(guild, channel);
        if (!restored.restored) {
          console.warn(`[RADIO] guild=${config.guildId} pemulihan dilewati: ${restored.reason}; konfigurasi dipertahankan.`);
        }
        break;
      } catch (error) {
        console.warn(`[RADIO] guild=${config.guildId} pemulihan percobaan=${attempt}/5 gagal; konfigurasi tetap tersimpan: ${safeErrorDiagnostic(error)}`);
        if (attempt < 5) await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1_000 * (2 ** (attempt - 1)))));
      }
    }
  }
});


function safeDiscordText(value) {
  return String(value).replace(/@/g, '@\u200b').replace(/([\\`*_{}\[\]()#+\-.!|>~])/g, '\\$1');
}

function safeErrorDiagnostic(error) {
  const name = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error?.name || '') ? error.name : 'Error';
  const code = Number.isInteger(error?.code) ? error.code : 'none';
  const message = String(error?.message || 'tidak ada pesan')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL disembunyikan]')
    .replace(/(authorization|cookie|token|signature|sig|key)=([^\s&]+)/gi, '$1=[disembunyikan]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [disembunyikan]')
    .slice(0, 500);
  return `type=${name} code=${code} message=${message}`;
}

function requireGuild(interaction) {
  if (!interaction.inGuild() || !interaction.guild) throw new Error('Perintah ini hanya bisa digunakan di server.');
  return interaction.guild;
}

function hasManageGuildPermission(interaction) {
  return hasRadioAdminPermission(interaction.memberPermissions, PermissionFlagsBits);
}

async function handleRadioCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guild = requireGuild(interaction);
    const action = interaction.options.getSubcommand();
    if (action === 'status') {
      const snapshot = musicManager.getSnapshot(guild.id);
      const config = radioStore.get(guild.id);
      const stationId = snapshot.radioStationId || config.stationId;
      const station = RADIO_STATION_BY_ID.get(stationId);
      const mode = snapshot.mode === 'radio' ? 'Radio Mode aktif' : config.mode === 'radio' && config.autoReconnect ? 'Radio Mode dikehendaki (sedang tidak tersambung)' : `${snapshot.mode === 'off' || config.mode === 'off' ? 'Off' : 'Music Mode'}`;
      const availability = station ? (station.available ? 'siap' : 'belum tersedia: sumber/izin belum diverifikasi') : 'belum dipilih';
      return await interaction.editReply([
        `Mode: **${mode}**`,
        `Stasiun terakhir: **${station?.name || 'belum dipilih'}** (${availability})`,
        `Voice channel: ${snapshot.voiceChannelId || config.voiceChannelId || 'tidak terhubung'}`,
        `Status sumber: **${snapshot.sourceStatus}**${snapshot.sourceStatus === 'source_not_configured' ? ' (sumber audio belum dikonfigurasi)' : ''}`,
        `Koneksi: ${snapshot.connectionStatus}; player: ${snapshot.playerStatus}; pemulihan otomatis: ${config.autoReconnect ? 'aktif' : 'nonaktif'}`,
        `Antrean musik tersimpan di memory: ${snapshot.queue.length} lagu.`
      ].join('\n'));
    }
    if (!hasManageGuildPermission(interaction)) throw new Error('Perintah pengaturan radio memerlukan izin Manage Server atau Administrator.');
    if (action === 'station') {
      const stationId = interaction.options.getString('name', true);
      const station = RADIO_STATION_BY_ID.get(stationId);
      if (!station) throw new Error('Stasiun tidak dikenal.');
      const snapshot = musicManager.getSnapshot(guild.id);
      radioStore.setStation(guild.id, stationId);
      if (snapshot.mode === 'radio') {
        const sourceStatus = musicManager.getRadioSourceStatus(stationId);
        if (sourceStatus !== 'source_configured') {
          await musicManager.moveToMusic(guild.id);
          return await interaction.editReply(`Pilihan **${station.name}** disimpan. Radio dihentikan karena sumber audio belum siap (${sourceStatus}); gunakan Radio Mode lagi setelah sumber dikonfigurasi dan diverifikasi.`);
        }
        const channel = guild.channels.cache.get(snapshot.voiceChannelId);
        if (!channel) {
          await musicManager.moveToMusic(guild.id);
          return await interaction.editReply(`Pilihan **${station.name}** disimpan. Radio dihentikan karena voice channel tidak ditemukan.`);
        }
        try {
          await musicManager.moveToRadio(guild, channel, stationId);
          return await interaction.editReply(`Stasiun **${station.name}** disimpan dan Radio Mode aktif.`);
        } catch (error) {
          return await interaction.editReply(`Pilihan **${station.name}** disimpan, tetapi sumber gagal dimulai: ${String(error.message || 'error').slice(0, 1000)}`);
        }
      }
      return await interaction.editReply(station.available
        ? `Stasiun **${station.name}** disimpan. Gunakan /music move mode:radio untuk memulai.`
        : `Pilihan **${station.name}** disimpan untuk server ini. Playback belum tersedia karena sumber dan izin Discord voice belum diverifikasi.`);
    }
    if (action === 'move') {
      const target = interaction.options.getString('mode', true);
      if (target !== 'music') throw new Error('Mode tujuan tidak valid.');
      const result = await musicManager.moveToMusic(guild.id);
      return await interaction.editReply(result.alreadyActive
        ? 'Music Mode sudah aktif.'
        : `Radio dihentikan; Music Mode aktif.${result.state?.queue.length ? ` Antrean musik dilanjutkan dari awal lagu aktif (${result.state.queue.length} lagu menunggu).` : ' Antrean musik dipertahankan.'}`);
    }
    throw new Error('Subcommand radio tidak dikenal.');
  } catch (error) {
    return await interaction.editReply('❌ ' + String(error.message || 'Radio gagal diproses.').slice(0, 1800));
  }
}

async function handleMusicModeCommand(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guild = requireGuild(interaction);
    if (!hasManageGuildPermission(interaction)) throw new Error('Perpindahan mode memerlukan izin Manage Server atau Administrator.');
    if (interaction.options.getString('mode', true) !== 'radio') throw new Error('Mode tujuan tidak valid.');
    const current = musicManager.getSnapshot(guild.id);
    if (current.mode === 'radio') return await interaction.editReply('Radio Mode sudah aktif.');
    const config = radioStore.get(guild.id);
    if (!config.stationId) throw new Error('Pilih stasiun terlebih dahulu melalui /radio station.');
    const { channel } = await requireMusicVoice(interaction);
    const station = RADIO_STATION_BY_ID.get(config.stationId);
    if (!station?.available) throw new Error(`Stasiun ${station?.name || config.stationId} belum tersedia. Sumber stream dan izin rebroadcast Discord voice belum diverifikasi.`);
    const result = await musicManager.moveToRadio(guild, channel, config.stationId);
    return await interaction.editReply(result.alreadyActive ? 'Radio Mode sudah aktif.' : `Radio Mode aktif: **${station.name}**. Antrean musik tetap tersimpan.`);
  } catch (error) {
    return await interaction.editReply('❌ ' + String(error.message || 'Radio gagal diproses.').slice(0, 1800));
  }
}

async function requireMusicVoice(interaction) {
  const guild = requireGuild(interaction);
  const member = guild.members.cache.get(interaction.user.id) || await guild.members.fetch(interaction.user.id);
  const channel = member.voice?.channel;
  if (!channel) throw new Error('Masuk ke voice channel terlebih dahulu.');
  const botMember = guild.members.me || await guild.members.fetchMe();
  const permissions = channel.permissionsFor(botMember);
  if (!permissions?.has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    throw new Error('Nightmare memerlukan izin Connect dan Speak di voice channel tersebut.');
  }
  const snapshot = musicManager.getSnapshot(guild.id);
  if (snapshot.voiceChannelId && snapshot.voiceChannelId !== channel.id) {
    throw new Error('Gunakan voice channel yang sama dengan bot.');
  }
  return { guild, channel };
}

async function handleLevelCommand(interaction) {
  let deferred = false;
  let acknowledgmentAttempted = false;
  let stage = 'pre-ack';
  const handlerStartedAt = performance.now();
  const dispatchStartedAt = interactionDispatchStartedAt.get(interaction) ?? handlerStartedAt;
  const interactionCreatedAt = Number.isFinite(interaction.createdTimestamp)
    ? interaction.createdTimestamp
    : handlerStartedAt;
  let deferLatencyMs = 'pending';
  const logInteractionFailure = (failedStage, error) => {
    const errorName = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error?.name || '') ? error.name : 'Error';
    const errorCode = Number.isInteger(error?.code)
      ? error.code
      : (typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'none');
    const replied = typeof interaction.replied === 'boolean' ? interaction.replied : 'unknown';
    const isDeferred = typeof interaction.deferred === 'boolean' ? interaction.deferred : 'unknown';
    console.error(
      `[XP] handleLevelCommand stage=${failedStage} command=${interaction.commandName} ` +
      `elapsedMs=${Math.max(0, Date.now() - interactionCreatedAt)} ` +
      `handlerEntryDelayMs=${Math.max(0, handlerStartedAt - dispatchStartedAt).toFixed(1)} ` +
      `interactionAgeAtHandlerEntryMs=${Math.max(0, Date.now() - interactionCreatedAt)} deferLatencyMs=${deferLatencyMs} ` +
      `deferred=${deferred || isDeferred === true ? true : isDeferred} replied=${replied} ` +
      `errorType=${errorName} discordCode=${errorCode}`
    );
  };

  try {
    // Acknowledge immediately: Discord's interaction token expires quickly, and
    // no guild lookup, option parsing, member fetch, or rendering may precede it.
    const command = interaction.commandName;
    const adminCommands = ['level-config', 'level-rewards', 'give-xp', 'give-level', 'remove-xp', 'remove-level', 'xp', 'xpboost'];
    stage = 'deferReply';
    acknowledgmentAttempted = true;
    const deferStartedAt = performance.now();
    try {
      if (adminCommands.includes(command)) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      else await interaction.deferReply();
      deferred = true;
    } finally {
      deferLatencyMs = Math.max(0, performance.now() - deferStartedAt).toFixed(1);
    }

    const guild = requireGuild(interaction);
    if (adminCommands.includes(command) &&
        !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      throw new Error('Hanya administrator yang dapat mengatur fitur leveling atau XP member.');
    }
    stage = 'command';

    if (command === 'xpboost') {
      const amount = interaction.options.getInteger('amount', true);
      xpStore.setActivityXp(guild.id, amount);
      return await interaction.editReply(`✅ Boost XP server diatur ke **${amount} XP** per aktivitas valid.`);
    }

    if (['give-xp', 'give-level', 'remove-xp', 'remove-level'].includes(command)) {
      const selectedUser = interaction.options.getUser('member', true);
      if (selectedUser.bot) throw new Error('XP dan level hanya dapat diubah untuk member manusia.');
      const member = await guild.members.fetch(selectedUser.id).catch(() => null);
      if (!member) throw new Error('Member tersebut tidak ditemukan di server ini.');
      const amount = interaction.options.getInteger('jumlah', true);
      const operations = {
        'give-xp': { action: 'member XP ditambahkan', apply: () => xpStore.giveXp(guild.id, member.id, amount) },
        'give-level': { action: 'level member ditambahkan', apply: () => xpStore.giveLevels(guild.id, member.id, amount) },
        'remove-xp': { action: 'member XP dikurangi', apply: () => xpStore.removeXp(guild.id, member.id, amount) },
        'remove-level': { action: 'level member dikurangi', apply: () => xpStore.removeLevels(guild.id, member.id, amount) }
      };
      const result = operations[command].apply();
      if (result.stats.level > result.previousStats.level || (result.rewardFromLevel < 0 && result.stats.level === 0)) {
        result.rewardOutcome = await applyLevelRewards(guild, member, result.rewardFromLevel, result.stats.level);
      }
      const appliedText = result.applied === amount ? '' : ` (yang dapat diterapkan: ${result.applied})`;
      const skippedRewards = result.rewardOutcome?.skipped?.length || 0;
      return await interaction.editReply(
        `✅ ${operations[command].action} untuk <@${member.id}>${appliedText}. Level sekarang **${result.stats.level}**, total **${result.stats.totalXp.toLocaleString('en-US')} XP**.\n` +
        'Perubahan admin tidak memicu pengumuman. Milestone baru diproses; role lama tidak dicabut.' +
        (skippedRewards ? ` ${skippedRewards} role reward tidak dapat diberikan; periksa log bot.` : '')
      );
    }

    if (command === 'xp') {
      const group = interaction.options.getSubcommandGroup(false);
      const subcommand = interaction.options.getSubcommand();
      if (group === 'reset' && subcommand === 'server') {
        const result = await resetGuildAfterConfirmation(interaction, xpStore);
        if (!result.confirmed) return;
        return await interaction.editReply({
          content: `✅ Statistik XP ${result.members} member direset. Konfigurasi, booster, milestone, dan role member tetap dipertahankan.`,
          components: []
        });
      }

      const userOption = interaction.options.getUser('member', true);
      if (userOption.bot) throw new Error('XP dan level hanya dapat diubah untuk member manusia.');
      const member = await guild.members.fetch(userOption.id).catch(() => null);
      if (!member) throw new Error('Member tersebut tidak ditemukan di server ini.');
      let result;
      if (group === 'reset' && subcommand === 'member') {
        result = xpStore.resetMember(guild.id, member.id);
        return await interaction.editReply(
          `✅ XP <@${member.id}> direset dari ${result.previousStats.totalXp.toLocaleString('en-US')} ke **0**. Role milestone yang sudah dimiliki tidak dicabut.`
        );
      }
      if (group === 'set' && subcommand === 'xp') {
        result = xpStore.setXp(guild.id, member.id, interaction.options.getInteger('amount', true));
      } else if (group === 'set' && subcommand === 'level') {
        result = xpStore.setLevel(guild.id, member.id, interaction.options.getInteger('level', true));
      } else {
        const amount = interaction.options.getInteger('amount', true);
        result = subcommand === 'add'
          ? xpStore.giveXp(guild.id, member.id, amount)
          : xpStore.removeXp(guild.id, member.id, amount);
      }
      const isAdminIncrease = (group === null && subcommand === 'add') ||
        (group === 'set' && (subcommand === 'xp' ? interaction.options.getInteger('amount', true) > 0 : interaction.options.getInteger('level', true) > 0));
      if (isAdminIncrease && (result.stats.level > result.previousStats.level || (result.rewardFromLevel < 0 && result.stats.level === 0))) {
        result.rewardOutcome = await applyLevelRewards(guild, member, result.rewardFromLevel, result.stats.level);
      }
      const skippedRewards = result.rewardOutcome?.skipped?.length || 0;
      return await interaction.editReply(
        `✅ XP <@${member.id}> diperbarui. Level **${result.stats.level}**, total **${result.stats.totalXp.toLocaleString('en-US')} XP**. Perubahan admin tidak mengirim pengumuman level-up; role milestone baru diproses dan role lama tidak dicabut.` +
        (skippedRewards ? ` ${skippedRewards} role reward tidak dapat diberikan; periksa log bot.` : '')
      );
    }

    if (command === 'level' || command === 'rank' || command === 'card') {
      const selectedUser = interaction.options.getUser('member');
      const member = await guild.members.fetch(selectedUser?.id || interaction.user.id);
      if (member.user.bot) throw new Error('Rank XP hanya tersedia untuk member manusia.');
      const stats = xpStore.getStats(guild.id, member.id);
      const rank = xpStore.getRank(guild.id, member.id);
      if (command === 'level') {
        const embed = new EmbedBuilder()
          .setColor(0x7c3aed)
          .setTitle(`🌒 Level · ${member.displayName || member.user.username}`)
          .setDescription(stats.level >= 9999
            ? `${buildProgressBar(stats.progress)} **Level maksimum tercapai. XP tetap bertambah dan tidak direset.**`
            : `${buildProgressBar(stats.progress)} **${(stats.progress * 100).toFixed(1)}%** menuju level berikutnya`)
          .addFields(
            { name: 'Level', value: String(stats.level), inline: true },
            { name: 'Total XP', value: stats.totalXp.toLocaleString('en-US'), inline: true },
            { name: 'Progres XP', value: stats.level >= 9999 ? 'Level maksimum' : `${stats.currentLevelXp.toLocaleString('en-US')} / ${stats.xpToNextLevel.toLocaleString('en-US')}`, inline: true },
            { name: 'Rank Server', value: rank ? `#${rank}` : 'Belum memiliki rank', inline: true }
          );
        return await interaction.editReply({ embeds: [embed] });
      }
      stage = 'card-render';
    const rendered = await renderRankCardSafely({
        username: member.displayName || member.user.username,
        avatarUrl: member.displayAvatarURL({ extension: 'png', size: 256 }),
        stats,
        rank
      });
      if (rendered.error || !rendered.buffer) {
        console.error(`[XP] Rank card gagal dirender guild=${guild.id} user=${member.id}: ${rendered.error?.message || 'buffer kosong'}`);
        throw new Error('Kartu rank gagal dibuat saat ini. Coba lagi sebentar.');
      }
      const attachment = new AttachmentBuilder(rendered.buffer, { name: 'nightmare-rank.png' });
      const embed = new EmbedBuilder().setColor(0x7c3aed).setImage('attachment://nightmare-rank.png');
      return await interaction.editReply({ embeds: [embed], files: [attachment] });
    }

    if (command === 'rewards') {
      const rewards = xpStore.getRewards(guild.id);
      const roles = await guild.roles.fetch();
      const lines = buildLevelRoleList(rewards, roleId => roles.get(roleId));
      const description = lines.length ? lines.join('\n') : 'Belum ada milestone role yang dikonfigurasi.';
      return await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x4c1d95).setTitle('Nightmare • Level Rewards').setDescription(description.slice(0, 4000))],
        allowedMentions: { parse: [] }
      });
    }

    if (command === 'boosters') {
      const boosters = xpStore.getConfig(guild.id).boosters;
      if (!boosters.length) return await interaction.editReply('Belum ada konfigurasi multiplier XP di server ini.');
      const [roles, channels] = await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
      const lines = boosters.map(item => {
        const target = item.type === 'role' ? roles.get(item.targetId) : channels.get(item.targetId);
        const label = target ? (item.type === 'role' ? `<@&${item.targetId}>` : `<#${item.targetId}>`) : `target dihapus (${item.targetId})`;
        return `**${item.type === 'role' ? 'Role' : 'Channel'}** ${label} — **${item.multiplier}×**${target ? '' : ' · nonaktif'} `;
      });
      return await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x4c1d95).setTitle(`Nightmare • XP Boosters · ${guild.name}`).setDescription(lines.join('\n').slice(0, 4000)).setFooter({ text: 'Multiplier ini tersimpan sebagai konfigurasi; XP per aktivitas saat ini mengikuti nilai /xpboost.' })],
        allowedMentions: { parse: [] }
      });
    }

    if (command === 'leaderboard') {
      let page = 1;
      const getPagePayload = async currentPage => {
      const full = xpStore.getLeaderboard(guild.id, currentPage, 10);
      const totalPages = Math.min(10, Math.ceil(full.total / 10));
      const result = { ...full, entries: full.entries.slice(0, 100), totalPages };
      if (!result.total) return { content: 'Belum ada XP di server ini. Kirim pesan yang memenuhi syarat untuk memulai.' };
      if (currentPage > result.totalPages) throw new Error(`Halaman maksimal saat ini ${result.totalPages}.`);
      const entries = await Promise.all(result.entries.map(async item => ({
        ...item,
        member: await guild.members.fetch(item.userId).catch(() => null)
      })));
      const visibleEntries = entries.filter(item => !item.member?.user?.bot);
      if (!visibleEntries.length) return { content: 'Belum ada member manusia di leaderboard server ini.', components: [] };
      const description = visibleEntries.map(item =>
        `**#${item.rank}** ${item.member ? `<@${item.userId}>` : `Member keluar (${item.userId})`} — Level **${item.level}** · **${item.totalXp.toLocaleString('en-US')} XP**`
      ).join('\n');
      const embed = new EmbedBuilder()
        .setColor(0x7c3aed)
        .setTitle(`🌒 Nightmare Leaderboard · ${guild.name}`)
        .setDescription(description)
        .setFooter({ text: `Halaman ${result.page}/${result.totalPages} · ${result.total} member` });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('lb_previous').setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(currentPage <= 1),
        new ButtonBuilder().setCustomId('lb_next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= totalPages)
      );
      return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
      };
      const firstPayload = await getPagePayload(page);
      const reply = await interaction.editReply(firstPayload);
      if (!reply.components?.length) return;
      activeLeaderboardMessages.add(reply.id);
      const collector = reply.createMessageComponentCollector({ time: 120_000 });
      collector.on('collect', async button => {
        if (button.user.id !== interaction.user.id) {
          try {
            await button.reply({ content: 'Hanya pemanggil command yang dapat memakai tombol ini.', flags: MessageFlags.Ephemeral });
          } catch (error) {
            console.warn(`[XP] Leaderboard unauthorized button response failed ${safeErrorDiagnostic(error)}`);
          }
          return;
        }
        try {
          await button.deferUpdate();
          page = Math.max(1, Math.min(10, page + (button.customId === 'lb_next' ? 1 : -1)));
          await interaction.editReply(await getPagePayload(page));
        } catch (error) {
          console.error(`[XP] Leaderboard pagination gagal guild=${guild.id}: ${error.message}`);
        }
      });
      collector.on('end', async () => {
        activeLeaderboardMessages.delete(reply.id);
        try { await interaction.editReply({ components: [] }); } catch (error) { console.warn(`[XP] Gagal menutup tombol leaderboard guild=${guild.id}: ${error.message}`); }
      });
      return;
    }

    if (command === 'level-config') {
      const action = interaction.options.getSubcommand();
      if (action === 'show') {
        const config = xpStore.getConfig(guild.id);
        const announcement = !config.announcement.enabled ? 'Nonaktif' :
          config.announcement.channelId ? `<#${config.announcement.channelId}>` : 'Channel #📈・leveling (default)';
        const excluded = config.excludedChannelIds.length ? config.excludedChannelIds.map(id => `<#${id}>`).join(', ') : 'Tidak ada';
        return await interaction.editReply(
          `**Leveling:** ${config.enabled ? 'Aktif' : 'Nonaktif'}\n` +
          `**Pengumuman level-up:** ${announcement}\n` +
          `**Channel dikecualikan:** ${excluded}\n` +
          `**Role reward:** ${config.rewards.length}\n` +
          `**Konfigurasi multiplier legacy:** ${config.boosters.length} (XP aktivitas mengikuti /xpboost)`
        );
      }
      if (action === 'enabled') {
        const enabled = interaction.options.getBoolean('value', true);
        xpStore.setEnabled(guild.id, enabled);
        return await interaction.editReply(`✅ XP server ${enabled ? 'diaktifkan' : 'dinonaktifkan'}.`);
      }
      if (action === 'announce') {
        const channel = interaction.options.getChannel('channel');
        if (!channel) {
          xpStore.setAnnouncement(guild.id, null);
          return await interaction.editReply('✅ Pengumuman level-up dinonaktifkan.');
        }
        if (channel.guildId !== guild.id || !channel.isTextBased() || typeof channel.send !== 'function') {
          throw new Error('Pilih channel teks dari server ini.');
        }
        const botMember = guild.members.me || await guild.members.fetchMe();
        const permissions = channel.permissionsFor(botMember);
        if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
          throw new Error('Bot memerlukan izin View Channel dan Send Messages di channel pengumuman.');
        }
        xpStore.setAnnouncement(guild.id, channel.id);
        return await interaction.editReply(`✅ Pengumuman level-up diarahkan ke <#${channel.id}>.`);
      }
      if (action === 'exclude') {
        const operation = interaction.options.getString('action', true);
        const channel = interaction.options.getChannel('channel');
        if (operation === 'clear') {
          xpStore.updateExcludedChannel(guild.id, 'clear');
          return await interaction.editReply('✅ Daftar channel pengecualian dibersihkan.');
        }
        if (!channel || channel.guildId !== guild.id || !channel.isTextBased()) {
          throw new Error('Untuk tambah/hapus, pilih channel teks dari server ini.');
        }
        const excluded = xpStore.updateExcludedChannel(guild.id, operation, channel.id);
        return await interaction.editReply(`✅ Channel pengecualian diperbarui (${excluded.length} channel).`);
      }
      if (action === 'booster-add' || action === 'booster-remove') {
        const type = interaction.options.getString('type', true);
        const role = interaction.options.getRole('role');
        const channel = interaction.options.getChannel('channel');
        const target = type === 'role' ? role : channel;
        if (!target || (type === 'role' && channel) || (type === 'channel' && role)) {
          throw new Error('Pilih tepat satu target yang sesuai dengan jenis booster.');
        }
        if (type === 'role') {
          if (target.guild.id !== guild.id || target.id === guild.id) throw new Error('Pilih role dari server ini; @everyone tidak dapat menjadi target.');
        } else if (target.guildId !== guild.id || !target.isTextBased()) {
          throw new Error('Pilih channel pesan dari server ini.');
        }
        if (action === 'booster-add') {
          const multiplier = interaction.options.getNumber('multiplier', true);
          const booster = xpStore.addBooster(guild.id, type, target.id, multiplier);
          return await interaction.editReply(`✅ Booster ${type} ${type === 'role' ? `<@&${target.id}>` : `<#${target.id}>`} diatur ke **${booster.multiplier}×**.`);
        }
        const removed = xpStore.removeBooster(guild.id, type, target.id);
        return await interaction.editReply(`✅ Booster ${removed.type} untuk ${type === 'role' ? `<@&${removed.targetId}>` : `<#${removed.targetId}>`} dihapus.`);
      }
    }

    if (command === 'level-rewards') {
      const action = interaction.options.getSubcommand();
      if (action === 'list') {
        const rewards = xpStore.getRewards(guild.id);
        if (!rewards.length) return await interaction.editReply('Belum ada role reward yang dikonfigurasi.');
        const roles = await guild.roles.fetch();
        const lines = rewards.map(item => `Level **${item.level}** → ${roles.get(item.roleId) ? `<@&${item.roleId}>` : 'role terhapus (ID: ' + item.roleId + ')'}`);
        return await interaction.editReply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
      }
      if (action === 'add') {
        const level = interaction.options.getInteger('level', true);
        const role = interaction.options.getRole('role', true);
        const botMember = guild.members.me || await guild.members.fetchMe();
        if (role.guild.id !== guild.id || role.id === guild.id || role.managed || !role.editable ||
            role.position >= botMember.roles.highest.position || !botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
          throw new Error('Bot harus memiliki Manage Roles dan role bot harus lebih tinggi daripada role reward yang dapat dikelola.');
        }
        xpStore.addReward(guild.id, level, role.id);
        return await interaction.editReply({ content: `✅ Role <@&${role.id}> ditetapkan sebagai reward level ${level}.`, allowedMentions: { parse: [] } });
      }
      if (action === 'remove') {
        const level = interaction.options.getInteger('level', true);
        const removed = xpStore.removeReward(guild.id, level);
        return await interaction.editReply(`✅ Mapping reward level ${removed.level} dihapus. Role member yang sudah diperoleh tidak dicabut.`);
      }
      if (action === 'panel') {
        const channel = interaction.options.getChannel('channel', true);
        if (channel.guildId !== guild.id || !channel.isTextBased() || typeof channel.send !== 'function') {
          throw new Error('Pilih channel teks dari server ini.');
        }
        const botMember = guild.members.me || await guild.members.fetchMe();
        const permissions = channel.permissionsFor(botMember);
        const savedPanel = xpStore.getConfig(guild.id).levelPanel;
        const requiredPanelPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];
        if (savedPanel?.channelId === channel.id) requiredPanelPermissions.push(PermissionFlagsBits.ReadMessageHistory);
        if (!permissions?.has(requiredPanelPermissions)) {
          throw new Error('Bot memerlukan View Channel, Send Messages, dan Embed Links; Read Message History juga diperlukan untuk memperbarui panel yang sudah tersimpan.');
        }
        const rewards = xpStore.getRewards(guild.id);
        const roles = await guild.roles.fetch();
        const embedData = buildLevelRolePanel(rewards, roleId => roles.get(roleId));
        if (rewards.some(item => item.level === 0)) {
          embedData.description += '\n\nMilestone Level 0 diberikan pada pesan eligible berikutnya saat member berada di Level 0; ini tidak melakukan pemberian massal.';
        }
        let panelMessage = null;
        if (savedPanel?.channelId === channel.id) panelMessage = await channel.messages.fetch(savedPanel.messageId).catch(() => null);
        if (panelMessage) {
          await panelMessage.edit({ embeds: [embedData], allowedMentions: { parse: [] } });
          return await interaction.editReply(`✅ Panel milestone yang ada diperbarui di <#${channel.id}>.`);
        }
        panelMessage = await channel.send({ embeds: [embedData], allowedMentions: { parse: [] } });
        try {
          xpStore.setLevelPanel(guild.id, channel.id, panelMessage.id);
        } catch (error) {
          await panelMessage.delete().catch(() => {});
          throw error;
        }
        const note = savedPanel ? ' Panel baru dibuat; panel lama di channel lain tidak dihapus.' : '';
        return await interaction.editReply(`✅ Panel milestone dibuat di <#${channel.id}>.${note}`);
      }
    }
  } catch (error) {
    logInteractionFailure(stage, error);
    const content = ('❌ ' + (error?.message || 'Terjadi kesalahan.')).slice(0, 1900);

    if (interaction.replied) return;
    if (error?.code === 10062 || error?.code === 40060) return;
    if (deferred || interaction.deferred) {
      try {
        return await interaction.editReply(content);
      } catch (editError) {
        logInteractionFailure('editReply-after-' + stage, editError);
        return;
      }
    }

    // A failed deferReply may mean Discord has already invalidated this interaction.
    // Do not send a second initial response after that acknowledgment attempt.
    if (acknowledgmentAttempted && !interaction.deferred && !interaction.replied) return;

    try {
      return await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch (replyError) {
      logInteractionFailure('reply-fallback', replyError);
    }
  }
}

async function applyLevelRewards(guild, member, previousLevel, level) {
  try {
    return await grantMilestoneRoles(guild, member, xpStore.getRewards(guild.id), previousLevel, level, {
      manageRolesPermission: PermissionFlagsBits.ManageRoles,
      logger: console
    });
  } catch (error) {
    console.warn(`[XP] Gagal memproses milestone guild=${guild.id} user=${member.id}: ${error.message}`);
    return { granted: [], skipped: [] };
  }
}

function adventurerRankForLevel(level) {
  if (!Number.isInteger(level) || level < 1 || level > 9999) return null;
  if (level <= 40) return 'F';
  if (level <= 85) return 'E';
  if (level <= 150) return 'D';
  if (level <= 300) return 'C';
  if (level <= 600) return 'B';
  if (level <= 3000) return 'A';
  return 'S';
}

async function announceLevelUp(guild, member, level) {
  let stage = 'configuration';
  try {
    const config = xpStore.getConfig(guild.id);
    if (!config.announcement.enabled) return;
    let channel = null;
    stage = 'channel-lookup';
    const retryOptions = {
      attempts: 2,
      onRetry: ({ attempt, error }) => console.warn(`[XP] Retry aman pembacaan channel level-up guild=${guild.id} attempt=${attempt} class=${classifyLevelUpDeliveryError(error)}`)
    };
    if (config.announcement.channelId) {
      channel = guild.channels.cache.get(config.announcement.channelId) ||
        await retryIdempotentRead(() => guild.channels.fetch(config.announcement.channelId), retryOptions);
    } else {
      const isLevelingChannel = item => item?.name === '📈・leveling' && item.isTextBased() && typeof item.send === 'function';
      channel = guild.channels.cache.find(isLevelingChannel);
      if (!channel) {
        const channels = await retryIdempotentRead(() => guild.channels.fetch(), retryOptions);
        channel = channels.find(isLevelingChannel);
      }
    }
    if (!channel || channel.guildId !== guild.id || !channel.isTextBased() || typeof channel.send !== 'function') {
      console.warn(`[XP] Channel pengumuman tidak tersedia guild=${guild.id}`);
      return;
    }

    const adventurerRank = adventurerRankForLevel(level);
    if (!adventurerRank) throw new Error(`Level untuk rank petualang tidak valid: ${level}`);
    const serverRank = xpStore.getRank(guild.id, member.id);
    const serverRankLabel = serverRank ? `#${serverRank}` : '—';
    const username = member.displayName || member.user.username;
    const rankMessage = adventurerRank === 'S'
      ? 'Anda telah sampai Rank S! Selamat, kamu sudah mendapatkan tingkat tertinggi. Silakan lanjutkan sampai max level.'
      : `Anda telah mencapai Rank ${adventurerRank}. Terus level up untuk mencapai Rank S dan mendapatkan Rewards lebih banyak.`;
    const content = `Selamat <@${member.id}> kamu sudah mencapai Level ${level}!\n${rankMessage}\nPeringkat leaderboard server terbaru: **${serverRankLabel}**.`;
    stage = 'card-render';
    const rendered = await renderRankCardSafely({
      variant: 'level-up',
      username,
      avatarUrl: member.displayAvatarURL({ extension: 'png', size: 256 }),
      level,
      adventurerRank,
      serverRankLabel,
      message: rankMessage
    });
    if (rendered.error || !rendered.buffer) {
      console.error(`[XP] Kartu level-up gagal dirender guild=${guild.id} user=${member.id}: ${rendered.error?.message || 'buffer kosong'}`);
      stage = 'message-send';
      await sendLevelUpOnce(channel, { content, allowedMentions: { users: [member.id] } });
      return;
    }
    stage = 'message-send';
    await sendLevelUpOnce(channel, {
      content,
      files: [new AttachmentBuilder(rendered.buffer, { name: 'nightmare-level-up.png' })],
      allowedMentions: { users: [member.id] }
    });
  } catch (error) {
    const delivery = stage === 'message-send' ? (error.deliveryClass || classifyLevelUpDeliveryError(error)) : 'not-sent';
    console.warn(`[XP] Notifikasi level-up gagal guild=${guild?.id || 'unknown'} user=${member?.id || 'unknown'} stage=${stage} delivery=${delivery} ${safeErrorDiagnostic(error)}`);
  }
}

async function processXpMessage(message) {
  try {
    if (message.member?.voice?.channelId) voiceXpTracker.markActive(message.guild.id, message.author.id, message.member.voice.channelId, 'chat');
    const result = xpStore.awardMessage(message);
    if (!result.awarded) return;
    const member = message.member || await message.guild.members.fetch(message.author.id);
    if (result.level > result.previousLevel || (result.rewardFromLevel < 0 && result.level === 0)) {
      await applyLevelRewards(message.guild, member, result.rewardFromLevel, result.level);
    }
    if (result.level > result.previousLevel) await announceLevelUp(message.guild, member, result.level);
  } catch (error) {
    console.error(`[XP] Gagal memproses pesan guild=${message.guild?.id || 'unknown'} user=${message.author?.id || 'unknown'}: ${error.message}`);
  }
}


async function handleMusicCommand(interaction) {
  let deferred = false;
  let acknowledgmentAttempted = false;
  try {
    const name = interaction.commandName;
    acknowledgmentAttempted = true;
    await interaction.deferReply(name === 'play' ? {} : { flags: MessageFlags.Ephemeral });
    deferred = true;
    const guild = requireGuild(interaction);
    if (name === 'play') {
      if (musicManager.getSnapshot(guild.id).mode === 'radio') throw new Error('Radio Mode aktif. Jalankan /radio move mode:music terlebih dahulu.');
      const { channel } = await requireMusicVoice(interaction);
      const query = interaction.options.getString('query', true);
      const result = await musicManager.enqueue(guild, channel, query, interaction.user, {
        onError: async error => {
          try { await interaction.followUp({ content: '❌ ' + error.message.slice(0, 1800), flags: MessageFlags.Ephemeral }); }
          catch (followUpError) { console.warn('[MUSIC] Gagal mengirim error follow-up:', safeErrorDiagnostic(followUpError)); }
        }
      });
      const position = Math.max(1, result.position);
      return await interaction.editReply('🎶 Diantrekan **' + safeDiscordText(result.track.title) + '**' +
        (result.track.artist ? ' — ' + safeDiscordText(result.track.artist) : '') +
        ' · posisi antrean **' + position + '**. Sumber audio: YouTube' +
        (result.track.spotifyUrl ? ' (metadata dari Spotify)' : '') + '.');
    }
    if (name === 'pause' || name === 'resume' || name === 'skip' || name === 'stop' || name === 'dc' || name === 'volume') {
      await requireMusicVoice(interaction);
      if (name === 'pause') { musicManager.pause(guild.id); return await interaction.editReply('⏸️ Pemutaran dijeda.'); }
      if (name === 'resume') { musicManager.resume(guild.id); return await interaction.editReply('▶️ Pemutaran dilanjutkan.'); }
      if (name === 'skip') { musicManager.skip(guild.id); return await interaction.editReply('⏭️ Lagu dilewati.'); }
      if (name === 'stop') {
        if (!musicManager.stop(guild.id)) throw new Error('Player belum aktif.');
        return await interaction.editReply('⏹️ Pemutaran dihentikan dan antrean dikosongkan. Bot tetap di voice channel.');
      }
      if (name === 'dc') {
        if (!musicManager.disconnect(guild.id)) throw new Error('Bot tidak sedang terhubung ke voice channel.');
        return await interaction.editReply('🔌 Bot keluar dari voice channel dan state server dibersihkan.');
      }
      const volume = musicManager.setVolume(guild.id, interaction.options.getInteger('percent', true));
      return await interaction.editReply('🔊 Volume server sekarang **' + volume + '%**.');
    }
    if (name === 'queue' || name === 'nowplaying') {
      const snapshot = musicManager.getSnapshot(guild.id);
      if (name === 'nowplaying' && snapshot.mode === 'radio') {
        const station = RADIO_STATION_BY_ID.get(snapshot.radioStationId || radioStore.get(guild.id).stationId);
        if (!station) throw new Error('Stasiun radio belum dipilih.');
        return await interaction.editReply(`📻 **${safeDiscordText(station.name)}**\nMode: Radio${station.available ? '' : ' · sumber belum tersedia'}\nPlayer: ${snapshot.playerStatus} · Voice: ${snapshot.connectionStatus}`);
      }
      if (!snapshot.current && !snapshot.queue.length) throw new Error('Tidak ada lagu yang sedang diputar atau diantrekan.');
      if (name === 'nowplaying') {
        const entry = snapshot.current;
        if (entry.kind === 'radio') {
          const station = RADIO_STATION_BY_ID.get(entry.stationId);
          return await interaction.editReply(`📻 **${safeDiscordText(station?.name || entry.stationId)}**\nRadio Mode · player ${snapshot.playerStatus}`);
        }
        const track = entry.track;
        if (!track) throw new Error('Lagu sedang disiapkan; coba lagi sebentar.');
        const requester = entry.requester || 'Tidak diketahui';
        const duration = track.duration ? formatDuration(track.duration) : 'Tidak diketahui';
        return await interaction.editReply({ content: '🎵 **[' + safeDiscordText(track.title) + '](' + track.webpageUrl + ')**' +
          (track.artist ? '\nArtis: ' + safeDiscordText(track.artist) : '') + '\nPeminta: ' + safeDiscordText(requester) +
          '\nDurasi: ' + duration + '\nSumber: ' + (track.spotifyUrl ? '[YouTube audio](<' + track.webpageUrl + '>) · [Spotify metadata](<' + track.spotifyUrl + '>)' : '[YouTube](<' + track.webpageUrl + '>)'),
          });
      }
      const lines = [];
      if (snapshot.current) {
        const track = snapshot.current.track;
        if (snapshot.current.kind === 'radio') lines.push(`📻 **Radio:** ${safeDiscordText(RADIO_STATION_BY_ID.get(snapshot.current.stationId)?.name || snapshot.current.stationId)}`);
        else lines.push('▶️ **Sedang diputar:** ' + (track ? safeDiscordText(track.title) : 'Menyiapkan lagu…') +
          (track?.duration ? ' (`' + formatDuration(track.duration) + '`)' : ''));
      }
      for (const [index, entry] of snapshot.queue.slice(0, 15).entries()) {
        lines.push('**' + (index + 1) + '.** ' + safeDiscordText(entry.track?.title || entry.query) +
          (entry.requester ? ' — diminta ' + safeDiscordText(entry.requester) : ''));
      }
      if (snapshot.queue.length > 15) lines.push('… dan ' + (snapshot.queue.length - 15) + ' lagu lain.');
      return await interaction.editReply({ content: lines.join('\n').slice(0, 1900) });
    }
  } catch (error) {
    if (error?.code === 10062 || error?.code === 40060) return;
    const message = '❌ ' + error.message;
    if (deferred) return await interaction.editReply(message.slice(0, 1900));
    if (acknowledgmentAttempted || error?.code === 10062 || error?.code === 40060) return;
    return await interaction.reply({ content: message.slice(0, 1900), flags: MessageFlags.Ephemeral });
  }
}

async function handlePlaylistCommand(interaction) {
  let deferred = false;
  let acknowledgmentAttempted = false;
  try {
    acknowledgmentAttempted = true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    deferred = true;
    const guild = requireGuild(interaction);
    const action = interaction.options.getSubcommand();
    if (action === 'play') {
      if (musicManager.getSnapshot(guild.id).mode === 'radio') throw new Error('Radio Mode aktif. Jalankan /radio move mode:music terlebih dahulu.');
      await requireMusicVoice(interaction);
    }
    if (action === 'create') {
      const playlist = playlistStore.create(guild.id, interaction.options.getString('name', true));
      return await interaction.editReply('✅ Playlist server **' + playlist.name + '** dibuat.');
    }
    if (action === 'rename') {
      const playlist = playlistStore.rename(guild.id, interaction.options.getString('name', true), interaction.options.getString('new_name', true));
      return await interaction.editReply('✅ Playlist diubah menjadi **' + playlist.name + '**.');
    }
    if (action === 'list') {
      const lists = playlistStore.list(guild.id);
      if (!lists.length) return await interaction.editReply('Belum ada playlist di server ini.');
      const pages = [];
      let page = '';
      for (const item of lists) {
        const line = '• **' + safeDiscordText(item.name) + '** — ' + item.items.length + ' lagu';
        if (page && (page + '\n' + line).length > 1700) { pages.push(page); page = ''; }
        page += (page ? '\n' : '') + line;
      }
      if (page) pages.push(page);
      await interaction.editReply(pages[0]);
      for (const nextPage of pages.slice(1)) await interaction.followUp({ content: nextPage, flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'add') {
      const playlistName = interaction.options.getString('name', true);
      const query = interaction.options.getString('query', true);
      const track = await musicManager.resolveTrack(query);
      const item = playlistStore.add(guild.id, playlistName, track, interaction.user.id);
      return await interaction.editReply('✅ **' + safeDiscordText(item.title) + '** ditambahkan ke playlist. ID item: `' + item.id + '`.');
    }
    if (action === 'remove') {
      const item = playlistStore.remove(guild.id, interaction.options.getString('name', true), interaction.options.getString('item', true));
      return await interaction.editReply('✅ **' + safeDiscordText(item.title) + '** dihapus dari playlist.');
    }
    if (action === 'play') {
      const playlist = playlistStore.get(guild.id, interaction.options.getString('name', true));
      if (!playlist.items.length) throw new Error('Playlist ini kosong.');
      const { channel } = await requireMusicVoice(interaction);
      await musicManager.enqueueSavedMany(guild, channel, playlist.items, interaction.user);
      return await interaction.editReply('🎶 **' + playlist.name + '** (' + playlist.items.length + ' lagu) ditambahkan ke antrean sesuai urutan.');
    }
  } catch (error) {
    if (error?.code === 10062 || error?.code === 40060) return;
    if (deferred) return await interaction.editReply(('❌ ' + error.message).slice(0, 1900));
    if (acknowledgmentAttempted || error?.code === 10062 || error?.code === 40060) return;
    return await interaction.reply({ content: ('❌ ' + error.message).slice(0, 1900), flags: MessageFlags.Ephemeral });
  }
}

async function handleLyricsCommand(interaction) {
  let deferred = false;
  let acknowledgmentAttempted = false;
  try {
    acknowledgmentAttempted = true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    deferred = true;
    const result = await searchLyrics(
      interaction.options.getString('song', true),
      interaction.options.getString('artist') || ''
    );
    if (!result) return await interaction.editReply('Lirik untuk lagu tersebut tidak ditemukan di LRCLIB.');
    return await interaction.editReply('🎼 **' + safeDiscordText(result.title) + '** — ' + safeDiscordText(result.artist) +
      '\nLihat lirik di sumber resmi: [' + result.source + '](<' + result.url + '>). Bot hanya menampilkan metadata dan tautan, bukan menyalin lirik.');
  } catch (error) {
    if (error?.code === 10062 || error?.code === 40060) return;
    if (deferred) return await interaction.editReply(('❌ ' + error.message).slice(0, 1900));
    if (acknowledgmentAttempted || error?.code === 10062 || error?.code === 40060) return;
    return await interaction.reply({ content: ('❌ ' + error.message).slice(0, 1900), flags: MessageFlags.Ephemeral });
  }
}

async function handleBotProfileCommand(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return await interaction.reply({ content: '❌ Hanya administrator yang dapat mengubah profil bot.', flags: MessageFlags.Ephemeral });
  }
  let deferred = false;
  let acknowledgmentAttempted = false;
  try {
    acknowledgmentAttempted = true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    deferred = true;
    const action = interaction.options.getSubcommand();
    if (action === 'name') {
      const name = interaction.options.getString('name', true).trim();
      if (name.length < 2 || name.length > 32) throw new Error('Nama bot harus 2–32 karakter.');
      await client.user.setUsername(name);
      return await interaction.editReply('✅ Nama profil bot diubah menjadi **' + name + '**. Perubahan berlaku global dan tunduk pada rate limit Discord.');
    }
    if (action === 'avatar') {
      const image = await fetchAvatar(interaction.options.getString('url', true));
      await client.user.setAvatar(image);
      return await interaction.editReply('✅ Avatar bot berhasil diperbarui. Perubahan berlaku global.');
    }
    const application = await client.application.fetch();
    const originalName = application.name;
    const iconUrl = application.iconURL({ extension: 'png', size: 1024 });
    const icon = iconUrl ? await fetchAvatar(iconUrl) : null;
    await client.user.setUsername(originalName);
    if (!icon) {
      return await interaction.editReply('✅ Nama dikembalikan ke nama aplikasi (**' + originalName + '**). Aplikasi tidak memiliki ikon tersimpan, jadi avatar saat ini tetap dipakai.');
    }
    try {
      await client.user.setAvatar(icon);
    } catch (error) {
      return await interaction.editReply(('⚠️ Nama kembali ke **' + originalName + '**, tetapi avatar gagal direset: ' + error.message).slice(0, 1900));
    }
    return await interaction.editReply('✅ Nama dan avatar dikembalikan ke nama serta ikon aplikasi. Perubahan tunduk pada rate limit Discord.');
  } catch (error) {
    if (error?.code === 10062 || error?.code === 40060) return;
    if (deferred) return await interaction.editReply(('❌ Gagal memperbarui profil: ' + error.message).slice(0, 1900));
    if (acknowledgmentAttempted || error?.code === 10062 || error?.code === 40060) return;
    return await interaction.reply({ content: ('❌ Gagal memperbarui profil: ' + error.message).slice(0, 1900), flags: MessageFlags.Ephemeral });
  }
}

async function handleSetupComponent(interaction) {
  const match = /^nightmare_setup:(confirm|cancel):([\da-f-]{36})$/i.exec(interaction.customId || '');
  if (!match) return false;
  const [, action, id] = match;
  try {
    if (!interaction.inGuild?.() || !interaction.guildId) throw new Error('Setup hanya tersedia di server.');
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) throw new Error('Perlu izin Manage Channels untuk mengonfirmasi setup.');
    const entry = setupConfirmationStore.get(id, interaction.guildId, interaction.user.id);
    if (!entry) throw new Error('Preview setup kedaluwarsa atau bukan milikmu. Jalankan /setup kembali.');
    if (action === 'cancel') {
      const cancellation = setupConfirmationStore.cancel(id, interaction.guildId, interaction.user.id);
      if (cancellation === 'claimed') {
        return await interaction.reply({ content: 'Setup sedang diproses dan tidak dapat dibatalkan lewat tombol ini. Pembatalan tidak menghentikan operasi yang sudah dimulai.', flags: MessageFlags.Ephemeral });
      }
      if (cancellation === 'unavailable') throw new Error('Preview setup kedaluwarsa atau bukan milikmu. Jalankan /setup kembali.');
      if (cancellation === 'already-cancelled') {
        return await interaction.reply({ content: 'Preview setup ini sudah dibatalkan atau tidak lagi aktif.', flags: MessageFlags.Ephemeral });
      }
      return await interaction.update({ content: 'Setup dibatalkan. Tidak ada channel yang diubah.', embeds: [], components: [] });
    }
    const claimed = setupConfirmationStore.claim(id, interaction.guildId, interaction.user.id);
    if (!claimed) throw new Error('Konfirmasi setup sudah digunakan.');
    await interaction.deferUpdate();
    const guild = interaction.guild;
    const me = guild.members.me || await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) throw new Error('Nightmare tidak memiliki izin Manage Channels.');
    const staffRoleId = claimed.staffRoleId || null;
    if (staffRoleId) await validateSetupStaffRole(guild, staffRoleId);
    const result = await applySetupManifest(guild, SETUP_MANIFESTS[claimed.templateId], { staffRoleId, botId: me.id, expectedPreview: claimed.preview });
    setupConfirmationStore.finish(id);
    const actual = result.actualCount === null ? 'tidak dapat dipastikan' : `${result.actualCount}/${SETUP_MANIFESTS[claimed.templateId].permanentChannelCount}`;
    let text = `**Setup ${SETUP_MANIFESTS[claimed.templateId].name} diproses**
Kategori dibuat: ${result.madeCategories}
Channel dibuat dan terverifikasi: ${result.madeChannels}
Sudah ada/dilewati: ${result.skipped}
Gagal atau konflik: ${result.failed.length}
Channel manifest terverifikasi saat pemeriksaan akhir: ${actual}.`;
    if (!staffRoleId) text += '\nTidak ada role staf tiket terkonfigurasi; kategori privat dapat diakses administrator dan bot saja.';
    if (result.failed.length) text += `\n\n**Detail (maksimal 8):**\n${result.failed.slice(0, 8).map(item => `• ${item}`).join('\n')}${result.failed.length > 8 ? `\n…dan ${result.failed.length - 8} kendala lain.` : ''}`;
    return await interaction.editReply({ content: text.slice(0, 1900), embeds: [], components: [] });
  } catch (error) {
    if ([10062, 40060].includes(error?.code)) return;
    if (interaction.deferred || interaction.replied) return await interaction.editReply({ content: `❌ Setup gagal: ${error.message}`.slice(0, 1900), embeds: [], components: [] });
    return await interaction.reply({ content: `❌ Setup gagal: ${error.message}`.slice(0, 1900), flags: MessageFlags.Ephemeral });
  }
}

client.on('interactionCreate', async interaction => {
  interactionDiagnostics.instrument(interaction, 'component-listener');
  try {
  if (interaction.isModalSubmit?.() && interaction.customId?.startsWith('nightmare_announce_modal:')) {
    return await handleAnnouncementModal(interaction, announcementDraftStore);
  }
  if (!interaction.isButton()) return;

  if (interaction.customId?.startsWith('nightmare_announce:')) {
    return await handleAnnouncementComponent(interaction, announcementDraftStore);
  }
  if (interaction.customId?.startsWith('nightmare_setup:')) return await handleSetupComponent(interaction);
  if (interaction.customId === 'nightmare_giveaway_enter') {
    return await handleGiveawayButton(interaction, giveawayStore);
  }
  if (interaction.customId.startsWith('nightmare_ticket:')) {
    return await handleTicketButton(interaction, ticketStore, {
      onClosed: (guildId, channelId) => ticketDeletionScheduler.schedule(guildId, channelId),
      onReopened: (guildId, channelId) => ticketDeletionScheduler.cancel(guildId, channelId)
    });
  }

  if (['lb_previous', 'lb_next'].includes(interaction.customId) &&
      !activeLeaderboardMessages.has(interaction.message?.id)) {
    try {
      await interaction.reply({ content: 'Tombol leaderboard ini sudah kedaluwarsa. Jalankan kembali /leaderboard.', flags: MessageFlags.Ephemeral });
    } catch (error) {
      console.warn('[XP] Tombol leaderboard kedaluwarsa tidak dapat ditanggapi:', safeErrorDiagnostic(error));
    }
    return;
  }

  const xpResetAction = interaction.customId.match(/^xp-reset:(confirm|cancel):(\d{17,20}):(\d{17,20})$/);
  if (xpResetAction && !activeResetMessages.has(interaction.message?.id)) {
    try {
      await interaction.reply({ content: 'Konfirmasi reset XP ini sudah kedaluwarsa. Jalankan kembali /xp reset server jika masih diperlukan.', flags: MessageFlags.Ephemeral });
    } catch (error) {
      console.warn('[XP] Konfirmasi reset kedaluwarsa tidak dapat ditanggapi:', safeErrorDiagnostic(error));
    }
    return;
  }
  if (xpResetAction && (interaction.user.id !== xpResetAction[3] ||
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))) {
    try {
      await interaction.reply({ content: 'Hanya administrator yang memulai reset ini yang dapat mengonfirmasinya.', flags: MessageFlags.Ephemeral });
    } catch (error) {
      console.warn('[XP] Tombol reset server ditolak tetapi tidak dapat ditanggapi:', safeErrorDiagnostic(error));
    }
    return;
  }

  const resetAction = interaction.customId.match(/^nightmare_reset_(confirm|cancel):([\da-f-]{36})$/i);
  if (!resetAction) {
    if (interaction.customId?.startsWith('nightmare_reset_')) {
      try {
        await interaction.reply({ content: 'Tombol reset ini sudah kedaluwarsa. Jalankan kembali /resetserver jika memang diperlukan.', flags: MessageFlags.Ephemeral });
      } catch (error) {
        console.error('[RESET SERVER] Tombol lama tidak dapat ditanggapi:', safeErrorDiagnostic(error));
      }
    }
    return;
  }

  try {
    const [, action, confirmationId] = resetAction;
    if (!interaction.inGuild() || !interaction.guildId) {
      return await interaction.reply({ content: 'Perintah ini hanya bisa digunakan di server.', flags: MessageFlags.Ephemeral });
    }

    const confirmation = resetConfirmationGuard.get(confirmationId);
    if (!confirmation || confirmation.guildId !== interaction.guildId) {
      return await interaction.reply({ content: 'Konfirmasi reset ini sudah kedaluwarsa atau sudah digunakan. Jalankan /resetserver untuk membuat konfirmasi baru.', flags: MessageFlags.Ephemeral });
    }
    if (interaction.user.id !== confirmation.ownerId) {
      return await interaction.reply({ content: 'Hanya administrator yang memulai reset ini yang dapat mengonfirmasi atau membatalkannya.', flags: MessageFlags.Ephemeral });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return await interaction.reply({ content: 'Hanya administrator yang bisa melakukan tindakan ini.', flags: MessageFlags.Ephemeral });
    }

    if (action === 'cancel') {
      if (!resetConfirmationGuard.cancel(confirmationId, interaction.user.id, interaction.guildId)) {
        return await interaction.reply({ content: 'Konfirmasi reset ini sudah diproses atau tidak lagi aktif.', flags: MessageFlags.Ephemeral });
      }
      return await interaction.update({ content: 'Reset dibatalkan. Tidak ada perubahan.', components: [] });
    }

    const claim = resetConfirmationGuard.claim(confirmationId, interaction.user.id, interaction.guildId);
    if (!claim.claimed) {
      const message = claim.status === 'running'
        ? 'Reset ini sedang diproses. Klik ulang tidak akan memulai operasi kedua.'
        : claim.status === 'completed'
          ? 'Konfirmasi reset ini sudah selesai digunakan. Jalankan /resetserver jika perlu membuat reset baru.'
          : 'Konfirmasi reset ini sudah tidak aktif. Jalankan /resetserver untuk membuat konfirmasi baru.';
      return await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }

    try {
      await interaction.deferUpdate();
    } catch (error) {
      // No destructive request has started; permit a fresh click if Discord
      // rejected this component acknowledgment.
      resetConfirmationGuard.release(confirmationId);
      throw error;
    }


  try {
    const guild = interaction.guild;
    const me = await guild.members.fetchMe();

    if (
      !me.permissions.has(PermissionFlagsBits.ManageChannels) ||
      !me.permissions.has(PermissionFlagsBits.ManageRoles)
    ) {
      resetConfirmationGuard.finish(confirmationId, 'failed');
      return await interaction.editReply({
        content: 'Reset dibatalkan. Nightmare memerlukan izin Manage Channels dan Manage Roles.',
        components: []
      });
    }

    const reason = 'Reset server dikonfirmasi oleh administrator';
    let failures = [];
    let deletedChannels = 0;
    let deletedCategories = 0;
    let deletedRoles = 0;
    let skippedRoles = 0;

    let channels = await guild.channels.fetch();

    let setup = [...channels.values()].find(
      ch => ch &&
        ch.type === ChannelType.GuildText &&
        ch.name === 'setup'
    );

    if (setup) {
      if (setup.parentId) {
        await setup.setParent(null, {
          lockPermissions: false,
          reason
        });
      }

      await setup.permissionOverwrites.set([{
        id: guild.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory
        ]
      }], reason);
    } else {
      setup = await guild.channels.create({
        name: 'setup',
        type: ChannelType.GuildText,
        permissionOverwrites: [{
          id: guild.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory
          ]
        }],
        reason
      });
    }

    channels = await guild.channels.fetch();

    const ordinaryChannels = [...channels.values()].filter(
      ch => ch &&
        ch.id !== setup.id &&
        ch.type !== ChannelType.GuildCategory
    );

    for (const channel of ordinaryChannels) {
      try {
        await channel.delete(reason);
        deletedChannels++;
      } catch (error) {
        failures.push(`Channel ${channel.name}: ${error.message}`);
      }
    }

    channels = await guild.channels.fetch();

    const categories = [...channels.values()].filter(
      ch => ch && ch.type === ChannelType.GuildCategory
    );

    for (const category of categories) {
      try {
        await category.delete(reason);
        deletedCategories++;
      } catch (error) {
        failures.push(`Kategori ${category.name}: ${error.message}`);
      }
    }

    if (failures.length === 0) {
      const roles = await guild.roles.fetch();

      for (const role of roles.values()) {
        if (
          role.id === guild.id ||
          role.managed ||
          !role.editable
        ) {
          skippedRoles++;
          continue;
        }

        try {
          await role.delete(reason);
          deletedRoles++;
        } catch (error) {
          failures.push(`Role ${role.name}: ${error.message}`);
        }
      }
    }

    const summary =
      'Reset selesai diproses di server **' + guild.name + '**.\n' +
      'Channel dihapus: **' + deletedChannels + '**\n' +
      'Kategori dihapus: **' + deletedCategories + '**\n' +
      'Role dihapus: **' + deletedRoles + '**\n' +
      'Role dilindungi/tidak dapat dikelola: **' + skippedRoles + '**\n' +
      'Channel yang dipertahankan: <#' + setup.id + '> (`#setup`)\n' +
      (failures.length
        ? '\n⚠️ Ada ' + failures.length +
          ' kegagalan. Role tidak akan dihapus jika penghapusan channel/kategori gagal.'
        : '\nOperasi channel dan kategori berhasil.');

    resetConfirmationGuard.finish(confirmationId, 'completed');
    return await interaction.editReply({
      content: summary.slice(0, 1900),
      components: []
    });
  } catch (error) {
    resetConfirmationGuard.finish(confirmationId, 'failed');
    const code = Number.isInteger(error?.code) ? error.code : 'none';
    console.error(`[RESET SERVER] Komponen gagal acknowledged=${interaction.deferred || interaction.replied} ${safeErrorDiagnostic(error)}`);
    if (code === 10062 || code === 40060) return;
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: '❌ Reset gagal atau terhenti. Konfirmasi ini telah ditutup; periksa kondisi server, lalu jalankan /resetserver untuk membuat konfirmasi baru.',
          components: []
        });
      } else {
        await interaction.reply({ content: '❌ Reset gagal atau terhenti.', flags: MessageFlags.Ephemeral });
      }
    } catch (responseError) {
      console.error(`[RESET SERVER] Respons error code=${Number.isInteger(responseError?.code) ? responseError.code : 'none'}`);
    }
  }
  } catch (error) {
    const code = Number.isInteger(error?.code) ? error.code : 'none';
    console.error(`[RESET SERVER] Acknowledgment komponen gagal ${safeErrorDiagnostic(error)}`);
  }
  } catch (error) {
    const diagnostic = interactionDiagnostics.reportFailure(interaction, 'component-listener', error);
    if (diagnostic.attempts === 0 && !interaction.replied && !interaction.deferred && interaction.isRepliable?.()) {
      try { await interaction.reply({ content: '❌ Komponen gagal diproses. Coba ulangi tindakan dari command.', flags: MessageFlags.Ephemeral }); }
      catch (replyError) { interactionDiagnostics.reportFailure(interaction, 'component-error-reply', replyError); }
    }
  }
});

client.on('interactionCreate', async interaction => {
  const diagnostic = interactionDiagnostics.instrument(interaction, 'command-dispatcher');
  interactionDispatchStartedAt.set(interaction, performance.now());
  if (interaction.isAutocomplete()) {
    try { return await handleEconomyAutocomplete(interaction); }
    catch (error) {
      interactionDiagnostics.reportFailure(interaction, 'autocomplete', error);
      // Only provide an empty result when the handler failed before attempting
      // its one allowed autocomplete response. A rejected respond() is not retried.
      if (!interaction.responded && diagnostic.attempts === 0) {
        try { return await interaction.respond([]); }
        catch (responseError) { interactionDiagnostics.reportFailure(interaction, 'autocomplete-fallback', responseError); }
      }
      return;
    }
  }
  if (!interaction.isChatInputCommand()) return;

  let acknowledgmentAttempted = false;
  let setupStage = 'dispatcher';
  try {
    if (['rank', 'level', 'card', 'rewards', 'boosters', 'leaderboard', 'level-config', 'level-rewards', 'give-xp', 'give-level', 'remove-xp', 'remove-level', 'xp', 'xpboost'].includes(interaction.commandName)) {
      return await handleLevelCommand(interaction);
    }
    if (['play', 'pause', 'resume', 'skip', 'stop', 'queue', 'nowplaying', 'volume', 'dc'].includes(interaction.commandName)) {
      return await handleMusicCommand(interaction);
    }
    if (interaction.commandName === 'playlist') return await handlePlaylistCommand(interaction);
    if (interaction.commandName === 'lyrics') return await handleLyricsCommand(interaction);
    if (interaction.commandName === 'botprofile') return await handleBotProfileCommand(interaction);
    if (interaction.commandName === 'reactionrole') {
      return await handleReactionRoleCommand(interaction);
    }
    if (interaction.commandName === 'giveaway') return await handleGiveawayCreate(interaction, giveawayStore);
    if (interaction.commandName === 'economy') return await handleEconomy(interaction, economyStore);
    if (interaction.commandName === 'economy-admin') return await handleEconomyAdmin(interaction, economyStore);
    if (interaction.commandName === 'item') return await handleItemAdmin(interaction, economyStore);
    if (interaction.commandName === 'adventure') return await handleAdventure(interaction, economyStore);
    if (interaction.commandName === 'announcement') return await handleAnnouncementCreate(interaction, announcementDraftStore);
    if (interaction.commandName === 'radio') return await handleRadioCommand(interaction);
    if (interaction.commandName === 'music') return await handleMusicModeCommand(interaction);
    if (interaction.commandName === 'ticket') return await handleTicketCommand(interaction, ticketStore, {
      onClosed: (guildId, channelId) => ticketDeletionScheduler.schedule(guildId, channelId),
      onReopened: (guildId, channelId) => ticketDeletionScheduler.cancel(guildId, channelId)
    });
    if (interaction.commandName === 'notify') return await handleNotifyCommand(interaction, notificationStore);
    if (interaction.commandName === 'playground') return await handlePlaygroundCommand(interaction, playgroundService);

    if (interaction.commandName === 'ping') {
      acknowledgmentAttempted = true;
      return await interaction.reply({
        content: '🏓 Pong! Nightmare aktif!',
        flags: MessageFlags.Ephemeral
      });
    }


    if (interaction.commandName === 'resetserver') {
      if (!interaction.inGuild()) {
        acknowledgmentAttempted = true;
        return await interaction.reply({
          content: 'Perintah ini hanya bisa digunakan di server.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (!interaction.memberPermissions.has(
        PermissionFlagsBits.Administrator
      )) {
        acknowledgmentAttempted = true;
        return await interaction.reply({
          content: '❌ Hanya administrator server yang bisa melakukan reset.',
          flags: MessageFlags.Ephemeral
        });
      }

      acknowledgmentAttempted = true;
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
      const confirmationId = resetConfirmationGuard.issue({ guildId: interaction.guildId, ownerId: interaction.user.id });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('nightmare_reset_confirm:' + confirmationId)
          .setLabel('Konfirmasi reset')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('nightmare_reset_cancel:' + confirmationId)
          .setLabel('Batal')
          .setStyle(ButtonStyle.Secondary)
      );

      return await interaction.editReply({
        content: '⚠️ **Reset server bersifat destruktif dan tidak dapat dibatalkan.** Jika dikonfirmasi, bot menghapus semua channel selain `#setup`, semua kategori, dan semua role yang dapat dikelolanya. Pastikan cadangan tersedia sebelum melanjutkan.',
        components: [row]
      });
    }

    if (interaction.commandName === 'resetpreview') {
      if (!interaction.inGuild()) {
        acknowledgmentAttempted = true;
        return await interaction.reply({
          content: 'Perintah ini hanya bisa digunakan di server.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (!interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator
      )) {
        acknowledgmentAttempted = true;
        return await interaction.reply({
          content: 'Hanya administrator yang bisa menggunakan perintah ini.',
          flags: MessageFlags.Ephemeral
        });
      }

      acknowledgmentAttempted = true;
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral
      });

      const guild = interaction.guild;
      const me = await guild.members.fetchMe();

      if (
        !me.permissions.has(PermissionFlagsBits.ManageChannels) ||
        !me.permissions.has(PermissionFlagsBits.ManageRoles)
      ) {
        return await interaction.editReply(
          'Nightmare memerlukan izin Manage Channels dan Manage Roles untuk pratinjau lengkap.'
        );
      }

      const channels = await guild.channels.fetch();
      const allChannels = [...channels.values()].filter(Boolean);
      const categories = allChannels.filter(
        ch => ch.type === ChannelType.GuildCategory
      );
      const setupChannels = allChannels.filter(
        ch => ch.type === ChannelType.GuildText && ch.name === 'setup'
      );
      const roles = await guild.roles.fetch();

      const deletableRoles = [...roles.values()].filter(
        role =>
          role.id !== guild.id &&
          !role.managed &&
          role.editable
      );

      const protectedRoles = [...roles.values()].filter(
        role =>
          role.id === guild.id ||
          role.managed ||
          !role.editable
      );

      return await interaction.editReply({
        content:
          '🛡️ **PRATINJAU RESET, TIDAK ADA YANG DIHAPUS**\\n' +
          'Server: **' + guild.name + '**\\n' +
          'Channel ditemukan: **' + allChannels.filter(ch => ch.type !== ChannelType.GuildCategory).length + '**\\n' +
          'Kategori ditemukan: **' + categories.length + '**\\n' +
          'Channel teks bernama #setup: **' + setupChannels.length + '**\\n' +
          'Role yang dapat dikelola bot: **' + deletableRoles.length + '**\\n' +
          'Role yang dilindungi/tidak dapat dikelola: **' + protectedRoles.length + '**\\n\\n' +
          'Ini hanya pemeriksaan. Belum ada data yang diubah.'
      });
    }


    if (interaction.commandName === 'bg') {
      if (!interaction.inGuild()) {
        acknowledgmentAttempted = true;
        return await interaction.reply({
          content: 'Perintah ini hanya bisa digunakan di server.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (!interaction.memberPermissions?.has(
        PermissionFlagsBits.Administrator
      )) {
        acknowledgmentAttempted = true;
        return await interaction.reply({
          content: '❌ Hanya administrator yang bisa mengatur background.',
          flags: MessageFlags.Ephemeral
        });
      }

      const subcommand = interaction.options.getSubcommand();
      const url = interaction.options.getString('url', true).trim();

      let imageUrl;
      try {
        imageUrl = normalizeMemberCardImageUrl(url);
      } catch (error) {
        acknowledgmentAttempted = true;
        return await interaction.reply({
          content: '❌ ' + error.message,
          flags: MessageFlags.Ephemeral
        });
      }

      acknowledgmentAttempted = true;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        await fetchMemberCardImage(imageUrl);

        const settings = readMemberCardSettings();
        const guildId = interaction.guildId;
        settings[guildId] = settings[guildId] || {};
        settings[guildId][subcommand] = imageUrl;
        saveMemberCardSettings(settings);

        return await interaction.editReply(
          '✅ Background **' + subcommand +
          '** berhasil disimpan untuk server ini. Server lain tidak berubah.'
        );
      } catch (error) {
        console.error('[BG] Gagal mengatur background:', error.message);
        return await interaction.editReply(
          '❌ Pengaturan background gagal: ' + error.message
        );
      }
    }

    if (interaction.commandName !== 'setup') return;
    setupStage = 'guild-preflight';

    if (!interaction.inGuild?.() || !interaction.guildId) {
      acknowledgmentAttempted = true;
      return await interaction.reply({ content: 'Perintah ini hanya bisa digunakan di server.', flags: MessageFlags.Ephemeral });
    }
    setupStage = 'user-permission-preflight';
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      acknowledgmentAttempted = true;
      return await interaction.reply({ content: 'Kamu perlu izin Manage Channels untuk menyiapkan server.', flags: MessageFlags.Ephemeral });
    }
    setupStage = 'acknowledgment';
    acknowledgmentAttempted = true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    setupStage = 'template-option';
    const templateId = interaction.options.getString('template', false);
    if (!templateId) throw new Error('Schema /setup yang terdaftar belum memiliki opsi template. Minta administrator menyinkronkan slash command sebelum menjalankan setup.');
    const manifest = SETUP_MANIFESTS[templateId];
    if (!manifest) throw new Error('Template setup tidak dikenal.');
    setupStage = 'bot-permission-preflight';
    const guild = interaction.guild;
    const me = guild.members.me || await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) return await interaction.editReply('❌ Nightmare perlu izin Manage Channels sebelum setup dapat dimulai.');
    setupStage = 'preview-resource-fetch';
    const channels = await guild.channels.fetch();
    const selectedStaffRole = interaction.options.getRole('staff_role');
    if (selectedStaffRole && (selectedStaffRole.guild?.id !== guild.id || selectedStaffRole.id === guild.id || selectedStaffRole.managed)) {
      return await interaction.editReply('❌ Pilih role staf biasa dari server ini; role terkelola dan @everyone tidak dapat digunakan.');
    }
    const configuredStaffRoleId = selectedStaffRole?.id || ticketStore.configuration(guild.id)?.staffRoleId || null;
    setupStage = 'preview-build';
    const preview = buildSetupPreview(manifest, channels, { guildId: guild.id, staffRoleId: configuredStaffRoleId, botId: me.id });
    const confirmationId = setupConfirmationStore.create({ guildId: guild.id, ownerId: interaction.user.id, templateId: manifest.id, preview, staffRoleId: configuredStaffRoleId });
    setupStage = 'preview-response';
    const fields = renderSetupPreview(preview);
    const embed = new EmbedBuilder()
      .setTitle(`Preview setup · ${manifest.name}`)
      .setDescription(`Manifest berisi **${preview.permanentChannelCount} channel permanen** dari 8 kategori. Kategori lama dengan permission tidak aman/berbeda dilewati tanpa perubahan. Baru: **${preview.newChannels}** · sudah sesuai: **${preview.existingChannels}** · konflik/dilewati: **${preview.conflicts}**. Kategori baru: **${preview.newCategories}** · konflik kategori: **${preview.categoryConflicts}**. Channel Temporary Voice yang dibuat dinamis tidak dihitung.`)
      .setColor(0x5865f2)
      .addFields(fields);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nightmare_setup:confirm:${confirmationId}`).setLabel('Konfirmasi setup').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`nightmare_setup:cancel:${confirmationId}`).setLabel('Batal').setStyle(ButtonStyle.Secondary)
    );
    return await interaction.editReply({ content: 'Periksa daftar channel berikut. Tidak ada channel lama yang akan dihapus atau dipindahkan.', embeds: [embed], components: [row] });
  } catch (error) {
    const diagnostic = interactionDiagnostics.reportFailure(interaction, 'command-dispatcher', error);
    if (interaction.commandName === 'setup') console.error(`[SETUP] Command gagal stage=${setupStage} guild=${interaction.guildId || 'none'} interaction=${interaction.id || 'unknown'} ${safeErrorDiagnostic(error)}`);

    // Jangan membuat crash jika Discord sudah menganggap
    // interaksi kedaluwarsa atau responsnya tidak bisa dikirim.
    // Never retry an expired/ambiguous initial acknowledgment. If a defer was
    // confirmed, replace its loading response with a safe error instead.
    const responseAction = errorResponseAction(interaction, diagnostic, error);
    if (responseAction === 'none') return;

    try {
      if (responseAction === 'edit') {
        await interaction.editReply(
          '❌ Terjadi kesalahan. Periksa log Termux.'
        );
      } else if (interaction.replied) {
        return;
      } else if (acknowledgmentAttempted) {
        return;
      } else if (interaction.isRepliable()) {
        await interaction.reply({
          content: '❌ Terjadi kesalahan. Coba lagi.',
          flags: MessageFlags.Ephemeral
        });
      }
    } catch (replyError) {
      console.error('Gagal mengirim respons:', safeErrorDiagnostic(replyError));
    }
  }
});


// NIGHTMARE_TEMPVOICE
const TEMPVOICE_TRIGGER = '➕・create-voice';
const TEMPVOICE_PREFIX = '🔊・';
const temporaryVoiceService = createTemporaryVoiceService({ logger: console });

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    if (oldState.channelId !== newState.channelId) {
      if (oldState.channelId) voiceXpTracker.clear(newState.guild.id, newState.id);
      if (newState.channelId && !newState.member?.user?.bot) {
        voiceXpTracker.start(newState.guild.id, newState.id, newState.channelId);
      }
    }
    console.log('[TEMPVOICE] event:', oldState.channel?.name, '->', newState.channel?.name);
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    // Member masuk channel pemicu: buat room sementara.
    if (
      newState.channel &&
      newState.channel.name === TEMPVOICE_TRIGGER &&
      oldState.channelId !== newState.channelId
    ) {
      const member = newState.member;
      if (!member) {
        console.error('[TEMPVOICE] Member tidak tersedia pada event voice state.');
        return;
      }

      const channels = await guild.channels.fetch();
      const tempCategory = channels.find(
        channel =>
          channel.type === ChannelType.GuildCategory &&
          channel.name === '– – ~ 🔊 • | VOICE LOUNGE |'
      );

      if (!tempCategory) {
        console.error('Kategori VOICE LOUNGE | ✓ tidak ditemukan.');
        return;
      }

      await temporaryVoiceService.createRoom({
        guild,
        member,
        category: tempCategory,
        name: `${TEMPVOICE_PREFIX}${member.displayName}`.slice(0, 100),
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
          }
        ]
      });
    }

    // Hapus room buatan bot setelah kosong.
    const leftChannel = oldState.channel;
    if (leftChannel) await temporaryVoiceService.cleanupEmptyRoom(leftChannel);
  } catch (error) {
    console.error('Temporary Voice error:', error.message);
  }
});
// END NIGHTMARE_TEMPVOICE

client.on('error', error => {
  console.error('Discord client error:', safeErrorDiagnostic(error));
});



// NIGHTMARE WELCOME / GOODBYE CARDS

const fs = require('node:fs');

const MEMBER_CARD_SETTINGS_FILE = path.join(
  __dirname, 'data', 'member-card-backgrounds.json'
);
const MEMBER_CARD_IMAGE_CACHE = new Map();
const MEMBER_CARD_IMAGE_IN_FLIGHT = new Map();
const MEMBER_CARD_IMAGE_HOST = 'raw.githubusercontent.com';
const MEMBER_CARD_MAX_REDIRECTS = 5;
const MEMBER_CARD_IMAGE_CACHE_LIMIT = 100;

function readMemberCardSettings() {
  let contents;
  try {
    contents = fs.readFileSync(MEMBER_CARD_SETTINGS_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    console.error('[BG] Gagal membaca konfigurasi member card:', error.message);
    throw error;
  }

  try {
    const settings = JSON.parse(contents);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('struktur JSON harus berupa objek server.');
    }
    for (const [guildId, guildSettings] of Object.entries(settings)) {
      if (!guildSettings || typeof guildSettings !== 'object' || Array.isArray(guildSettings)) {
        throw new Error('pengaturan server ' + guildId + ' harus berupa objek.');
      }
      for (const key of ['welcome', 'goodbye']) {
        if (guildSettings[key] !== undefined && typeof guildSettings[key] !== 'string') {
          throw new Error('background ' + key + ' server ' + guildId + ' harus berupa URL teks.');
        }
      }
    }
    return settings;
  } catch (error) {
    const configError = new Error(
      'Konfigurasi member card rusak di ' + MEMBER_CARD_SETTINGS_FILE +
      ': ' + error.message
    );
    console.error('[BG] ' + configError.message);
    throw configError;
  }
}

function saveMemberCardSettings(settings) {
  try {
    fs.mkdirSync(path.dirname(MEMBER_CARD_SETTINGS_FILE), { recursive: true });
    const tempFile = MEMBER_CARD_SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tempFile, MEMBER_CARD_SETTINGS_FILE);
  } catch (error) {
    console.error('[BG] Gagal menyimpan konfigurasi member card:', error.message);
    throw error;
  }
}

async function fetchMemberCardImage(url) {
  if (MEMBER_CARD_IMAGE_IN_FLIGHT.has(url)) {
    return MEMBER_CARD_IMAGE_IN_FLIGHT.get(url);
  }

  const request = fetchMemberCardImageFromUrl(url, 0);
  MEMBER_CARD_IMAGE_IN_FLIGHT.set(url, request);
  try {
    return await request;
  } finally {
    MEMBER_CARD_IMAGE_IN_FLIGHT.delete(url);
  }
}

function normalizeMemberCardImageUrl(value) {
  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error('URL tidak valid. Masukkan link gambar GitHub yang benar.');
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error('URL gambar harus menggunakan HTTPS.');
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.port) {
    throw new Error('URL gambar tidak boleh memakai kredensial atau port khusus.');
  }

  if (parsedUrl.hostname === MEMBER_CARD_IMAGE_HOST) {
    return parsedUrl.href;
  }

  if (parsedUrl.hostname !== 'github.com') {
    throw new Error(
      'Host tidak didukung. Gunakan github.com dengan format /blob/ atau ' +
      'raw.githubusercontent.com.'
    );
  }

  const segments = parsedUrl.pathname.split('/');
  if (
    segments.length < 6 ||
    !segments[1] ||
    !segments[2] ||
    segments[3] !== 'blob' ||
    !segments[4] ||
    !segments.slice(5).some(segment => segment)
  ) {
    throw new Error(
      'Format GitHub tidak didukung. Gunakan URL file dengan pola ' +
      'https://github.com/<owner>/<repo>/blob/<branch>/<path-file>.'
    );
  }

  parsedUrl.hostname = MEMBER_CARD_IMAGE_HOST;
  parsedUrl.pathname = '/' + [segments[1], segments[2], ...segments.slice(4)].join('/');
  parsedUrl.hash = '';
  return parsedUrl.href;
}

function assertAllowedMemberCardUrl(value) {
  const parsedUrl = new URL(value);
  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== MEMBER_CARD_IMAGE_HOST ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error(
      'URL gambar dan setiap pengalihan harus tetap memakai HTTPS di ' +
      MEMBER_CARD_IMAGE_HOST + '.'
    );
  }
  return parsedUrl;
}

async function fetchMemberCardImageFromUrl(url, redirectCount) {
  const parsedUrl = assertAllowedMemberCardUrl(url);
  const cached = MEMBER_CARD_IMAGE_CACHE.get(parsedUrl.href);
  const headers = {};
  if (cached?.etag) headers['If-None-Match'] = cached.etag;
  if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

  const response = await fetch(parsedUrl.href, {
    redirect: 'manual',
    headers,
    signal: AbortSignal.timeout(12000)
  });

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Pengalihan gambar tidak memiliki URL tujuan.');
    if (redirectCount >= MEMBER_CARD_MAX_REDIRECTS) {
      throw new Error('Gambar melewati batas jumlah pengalihan.');
    }
    const redirectUrl = new URL(location, parsedUrl);
    assertAllowedMemberCardUrl(redirectUrl.href);
    if (response.body) await response.body.cancel();
    return await fetchMemberCardImageFromUrl(redirectUrl.href, redirectCount + 1);
  }

  if (response.status === 304) {
    if (!cached) throw new Error('Server mengirim 304 tanpa gambar cache yang valid.');
    return cached.image;
  }

  if (!response.ok) {
    throw new Error('Gagal mengunduh gambar (HTTP ' + response.status + ').');
  }

  const contentType = (response.headers.get('content-type') || '')
    .split(';')[0].trim().toLowerCase();

  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(contentType)) {
    throw new Error('URL harus mengarah ke gambar PNG, JPEG, WebP, atau GIF.');
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 8 * 1024 * 1024) {
    throw new Error('Ukuran gambar melebihi 8 MB.');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) {
    throw new Error('Gambar kosong atau ukurannya melebihi 8 MB.');
  }

  const image = await loadImage(bytes);
  if (!MEMBER_CARD_IMAGE_CACHE.has(parsedUrl.href) &&
      MEMBER_CARD_IMAGE_CACHE.size >= MEMBER_CARD_IMAGE_CACHE_LIMIT) {
    MEMBER_CARD_IMAGE_CACHE.delete(MEMBER_CARD_IMAGE_CACHE.keys().next().value);
  }
  MEMBER_CARD_IMAGE_CACHE.set(parsedUrl.href, {
    image,
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified')
  });
  return image;
}

async function loadMemberCardBackground(guildId, type) {
  const settings = readMemberCardSettings();
  const url = settings[guildId]?.[type];

  if (!url) return await loadImage(MEMBER_CARD_BG);
  return await fetchMemberCardImage(url);
}

const MEMBER_CARD_CHANNEL = '👋・welcome-goodbye';
const MEMBER_CARD_BG = path.join(__dirname, 'assets', 'kurumi.png');

async function sendMemberCard(channel, member, type) {
  const isWelcome = type === 'WELCOME';
  const width = 1200;
  const height = 675;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const background = await loadMemberCardBackground(
    member.guild.id, isWelcome ? 'welcome' : 'goodbye'
  );
  const scale = Math.max(width / background.width, height / background.height);
  const bgWidth = background.width * scale;
  const bgHeight = background.height * scale;

  ctx.drawImage(
    background,
    (width - bgWidth) / 2,
    (height - bgHeight) / 2,
    bgWidth,
    bgHeight
  );

  ctx.fillStyle = 'rgba(10, 8, 24, 0.62)';
  ctx.fillRect(0, 0, width, height);


  // Layout horizontal ala kartu Koya
  const avatarResponse = await fetch(
    member.displayAvatarURL({ extension: 'png', size: 256 })
  );
  if (!avatarResponse.ok) throw new Error('Gagal mengambil avatar.');
  const avatar = await loadImage(
    Buffer.from(await avatarResponse.arrayBuffer())
  );

  // Avatar besar di sebelah kiri
  const avatarX = 235;
  const avatarY = 337;
  const avatarR = 125;

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, avatarR, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(
    avatar,
    avatarX - avatarR,
    avatarY - avatarR,
    avatarR * 2,
    avatarR * 2
  );
  ctx.restore();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, avatarR + 3, 0, Math.PI * 2);
  ctx.stroke();

  // Tulisan rata kiri di sisi kanan avatar
  const textX = 410;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 78px Roboto';
  ctx.fillText(type, textX, 300);

  const rawUsername = member.user.username || 'Member';
  const username = rawUsername
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '?')
    .slice(0, 32);

  ctx.font = 'bold 42px Roboto';
  ctx.fillStyle = '#f3c5ff';
  ctx.fillText(username, textX, 365);

  ctx.font = '28px Roboto';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(member.guild.name.slice(0, 30), textX, 420);

  ctx.font = '24px Roboto';
  ctx.fillStyle = '#e6d9ff';
  ctx.fillText(
    isWelcome ? `Member #${member.guild.memberCount}` : 'Thanks for being here',
    textX,
    470
  );

  const attachment = new AttachmentBuilder(
    await canvas.encode('png'),
    { name: `${type.toLowerCase()}-card.png` }
  );

  await channel.send({
    content: isWelcome
      ? `🎉 Selamat datang, ${member}!`
      : `👋 Sampai jumpa, **${username}**.`,
    files: [attachment]
  });
}

async function findMemberCardChannel(guild) {
  const channels = await guild.channels.fetch();
  return channels.find(
    ch => ch &&
      ch.name.trim().toLowerCase() === MEMBER_CARD_CHANNEL &&
      ch.isTextBased() &&
      typeof ch.send === 'function'
  );
}

client.on(Events.GuildMemberAdd, async member => {
  try {
    const channel = await findMemberCardChannel(member.guild);
    if (!channel) {
      console.error('[WELCOME] Channel tidak ditemukan.');
      return;
    }
    await sendMemberCard(channel, member, 'WELCOME');
    console.log('[WELCOME] Kartu terkirim:', member.user.tag);
  } catch (error) {
    console.error('[WELCOME] Gagal:', error.message);
  }
});

client.on(Events.GuildMemberAdd, member => {
  void handleMemberNotification(member, 'join', notificationStore).catch(error =>
    console.error(`[NOTIFY] Join event guild=${member.guild?.id || 'unknown'} user=${member.id}: ${error.message}`)
  );
});

client.on(Events.GuildMemberRemove, async member => {
  try {
    const channel = await findMemberCardChannel(member.guild);
    if (!channel) {
      console.error('[GOODBYE] Channel tidak ditemukan.');
      return;
    }
    await sendMemberCard(channel, member, 'GOODBYE');
    console.log('[GOODBYE] Kartu terkirim:', member.user.tag);
  } catch (error) {
    console.error('[GOODBYE] Gagal:', error.message);
  }
});

client.on(Events.GuildMemberRemove, member => {
  void handleMemberNotification(member, 'leave', notificationStore).catch(error =>
    console.error(`[NOTIFY] Leave event guild=${member.guild?.id || 'unknown'} user=${member.id}: ${error.message}`)
  );
});

client.on(Events.MessageCreate, async message => {
  if (!xpStore.isEligibleMessage(message)) return;
  // XP persistence uses synchronous JSON work. Yield once so queued gateway
  // interactions can be dispatched and acknowledged before that work begins.
  setImmediate(() => { void processXpMessage(message); });

  const command = message.content.trim().toLowerCase();
  if (command !== '^^welcome' && command !== '^^goodbye') return;
  if (!message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

  try {
    const member = await message.guild.members.fetch(message.author.id);
    await sendMemberCard(
      message.channel,
      member,
      command === '^^welcome' ? 'WELCOME' : 'GOODBYE'
    );
  } catch (error) {
    console.error('[CARD TEST] Gagal:', error.message);
    await message.reply('❌ Kartu gagal dibuat. Periksa log Termux.');
  }
});

// END NIGHTMARE WELCOME / GOODBYE CARDS


// NIGHTMARE REACTION ROLES
const REACTION_ROLE_FILE = path.join(__dirname, 'data', 'reaction-roles.json');
const REACTION_ROLE_PERMISSION_SET = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions
];
const REACTION_ROLE_OPERATION_LOCKS = new Map();

function readReactionRoleData() {
  let contents;
  try {
    contents = fs.readFileSync(REACTION_ROLE_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 2, reactionRoles: [], grants: [] };
    console.error('[REACTION ROLE] Gagal membaca konfigurasi:', error.message);
    throw error;
  }

  try {
    const stored = JSON.parse(contents);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) ||
        !Array.isArray(stored.reactionRoles) || !Array.isArray(stored.grants)) {
      throw new Error('struktur harus memiliki array reactionRoles dan grants.');
    }

    // Legacy records represented one emoji-role mapping per row. Group those
    // rows into a single panel while preserving the existing grant records.
    const panels = [];
    for (const record of stored.reactionRoles) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('ada record reaction role yang bukan objek.');
      }
      let panel = panels.find(item =>
        item.guildId === record.guildId && item.messageId === record.messageId
      );
      if (Array.isArray(record.mappings)) {
        if (!panel) {
          panel = {
            guildId: record.guildId,
            channelId: record.channelId,
            messageId: record.messageId,
            title: record.title || 'Reaction Roles',
            description: record.description ?? null,
            mappings: []
          };
          panels.push(panel);
        }
        for (const mapping of record.mappings) {
          if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) ||
              typeof mapping.emojiKey !== 'string' || typeof mapping.roleId !== 'string') {
            throw new Error('ada mapping panel yang tidak valid.');
          }
          panel.mappings.push({
            emoji: String(mapping.emoji || mapping.emojiKey),
            emojiKey: mapping.emojiKey,
            roleId: mapping.roleId
          });
        }
        continue;
      }

      if (typeof record.guildId !== 'string' || typeof record.channelId !== 'string' ||
          typeof record.messageId !== 'string' || typeof record.emojiKey !== 'string' ||
          typeof record.roleId !== 'string') {
        throw new Error('ada record reaction role lama yang tidak lengkap.');
      }
      if (!panel) {
        panel = {
          guildId: record.guildId,
          channelId: record.channelId,
          messageId: record.messageId,
          title: record.title || 'Reaction Roles',
          description: record.description ?? null,
          mappings: []
        };
        panels.push(panel);
      }
      if (panel.channelId !== record.channelId) {
        throw new Error('Message ID panel tercatat pada channel yang berbeda.');
      }
      panel.mappings.push({
        emoji: String(record.emoji || record.emojiKey),
        emojiKey: record.emojiKey,
        roleId: record.roleId
      });
    }

    return { version: 2, reactionRoles: panels, grants: stored.grants };
  } catch (error) {
    const configError = new Error(
      'Konfigurasi reaction role rusak di ' + REACTION_ROLE_FILE + ': ' + error.message
    );
    console.error('[REACTION ROLE] ' + configError.message);
    throw configError;
  }
}

function saveReactionRoleData(data) {
  try {
    fs.mkdirSync(path.dirname(REACTION_ROLE_FILE), { recursive: true });
    const tempFile = REACTION_ROLE_FILE + '.tmp';
    const payload = {
      version: 2,
      reactionRoles: data.reactionRoles,
      grants: data.grants
    };
    fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2) + '\n');
    fs.renameSync(tempFile, REACTION_ROLE_FILE);
  } catch (error) {
    console.error('[REACTION ROLE] Gagal menyimpan konfigurasi:', error.message);
    throw error;
  }
}
function reactionEmojiKey(emoji) {
  return emoji.id ? 'custom:' + emoji.id : 'unicode:' + emoji.name;
}

async function resolveReactionRoleEmoji(guild, input, allowDeletedCustom = false) {
  const value = input.trim();
  const customMatch = value.match(/^<(a?):([A-Za-z0-9_]{2,32}):(\d+)>$/);
  if (customMatch) {
    let emoji;
    try {
      emoji = await guild.emojis.fetch(customMatch[3]);
    } catch {
      if (allowDeletedCustom) {
        return { identifier: value, key: 'custom:' + customMatch[3], display: value };
      }
      throw new Error('Emoji custom tidak ditemukan atau tidak tersedia di server ini.');
    }
    if (!emoji || emoji.available === false) {
      if (allowDeletedCustom) {
        return { identifier: value, key: 'custom:' + customMatch[3], display: value };
      }
      throw new Error('Emoji custom tidak tersedia untuk digunakan di server ini.');
    }
    return { identifier: emoji.toString(), key: 'custom:' + emoji.id, display: emoji.toString() };
  }

  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
  if (
    segments.length !== 1 ||
    !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value)
  ) {
    throw new Error('Emoji harus berupa satu emoji Unicode atau emoji custom dari server ini.');
  }
  return { identifier: value, key: 'unicode:' + value, display: value };
}

function validateReactionRoleTarget(guild, channel, role, botMember) {
  if (!channel || channel.guildId !== guild.id ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    throw new Error('Pilih channel teks atau announcement dari server ini.');
  }
  if (!role || role.guild.id !== guild.id || role.id === guild.id || role.managed) {
    throw new Error('Pilih role biasa yang dapat dikelola dari server ini.');
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('Nightmare memerlukan permission Manage Roles.');
  }
  if (role.position >= botMember.roles.highest.position) {
    throw new Error('Role bot Nightmare harus berada lebih tinggi daripada role target.');
  }
  const channelPermissions = channel.permissionsFor(botMember);
  if (!channelPermissions || !channelPermissions.has(REACTION_ROLE_PERMISSION_SET)) {
    throw new Error('Nightmare memerlukan View Channel, Send Messages, Embed Links, dan Add Reactions di channel tujuan.');
  }
}

function buildReactionRolePanelEmbed(panel) {
  const mappingText = panel.mappings.length
    ? panel.mappings.map(mapping => mapping.emoji + ' → <@&' + mapping.roleId + '>').join('\n')
    : 'Belum ada role yang tersedia. Administrator dapat menambahkan mapping baru.';
  const description = (panel.description || '') +
    (panel.description ? '\n\n' : '') + '**React untuk mendapatkan role:**\n' + mappingText;
  if (description.length > 4096) {
    throw new Error('Daftar mapping akan melewati batas panjang deskripsi embed Discord.');
  }
  return new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle(panel.title || 'Reaction Roles')
    .setDescription(description);
}

async function withOneReactionRoleLock(key, callback) {
  const previous = REACTION_ROLE_OPERATION_LOCKS.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(callback);
  REACTION_ROLE_OPERATION_LOCKS.set(key, operation);
  try {
    return await operation;
  } finally {
    if (REACTION_ROLE_OPERATION_LOCKS.get(key) === operation) {
      REACTION_ROLE_OPERATION_LOCKS.delete(key);
    }
  }
}

function withReactionRoleLocks(keys, callback) {
  const orderedKeys = [...new Set(keys)].sort();
  const acquire = index => index >= orderedKeys.length
    ? callback()
    : withOneReactionRoleLock(orderedKeys[index], () => acquire(index + 1));
  return acquire(0);
}

async function fetchRegisteredReactionRoleMessage(guild, panel) {
  let channel;
  try {
    channel = await guild.channels.fetch(panel.channelId);
  } catch {
    throw new Error('Channel panel tidak ditemukan atau tidak dapat diakses bot.');
  }
  if (!channel || channel.guildId !== guild.id ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    throw new Error('Panel tidak berasal dari server ini atau channel-nya sudah tidak tersedia.');
  }
  let message;
  try {
    message = await channel.messages.fetch(panel.messageId);
  } catch {
    throw new Error('Pesan panel tidak ditemukan di channel yang terdaftar.');
  }
  if (message.guildId !== guild.id || message.author.id !== client.user.id) {
    throw new Error('Pesan terdaftar bukan pesan panel yang dibuat oleh bot di server ini.');
  }
  return { channel, message };
}

function validatePanelEditPermissions(channel, botMember, needsAddReactions = false) {
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks
  ];
  if (needsAddReactions) required.push(PermissionFlagsBits.AddReactions);
  const permissions = channel.permissionsFor(botMember);
  if (!permissions || !permissions.has(required)) {
    throw new Error('Nightmare perlu View Channel, Send Messages, dan Embed Links' +
      (needsAddReactions ? ', serta Add Reactions' : '') + ' di channel panel.');
  }
}

async function removeBotPanelReaction(message, emojiKey) {
  const reaction = message.reactions.cache.find(item => reactionEmojiKey(item.emoji) === emojiKey);
  if (!reaction) return false;
  await reaction.users.remove(client.user.id);
  return true;
}

async function removeSoleSourceRoleGrants(guild, removedGrants) {
  let removed = 0;
  let shared = 0;
  let failed = 0;
  const handled = new Set();
  for (const grant of removedGrants) {
    const identity = [grant.guildId, grant.userId, grant.roleId].join(':');
    if (handled.has(identity)) continue;
    handled.add(identity);
    await withReactionRoleLocks(['user:' + guild.id + ':' + grant.userId], async () => {
      try {
        // Event handlers share this per-user lock. Read grants after acquiring
        // it so concurrent mappings from another panel cannot be missed.
        const currentData = readReactionRoleData();
        if (currentData.grants.some(other =>
          other.guildId === grant.guildId && other.userId === grant.userId &&
          other.roleId === grant.roleId
        )) {
          shared++;
          return;
        }
        const role = await guild.roles.fetch(grant.roleId);
        if (!role) return;
        const member = await guild.members.fetch(grant.userId);
        if (!member.roles.cache.has(role.id)) return;
        const botMember = await guild.members.fetchMe();
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
            role.position >= botMember.roles.highest.position) {
          failed++;
          return;
        }
        await member.roles.remove(role, 'Reaction role mapping dihapus oleh administrator');
        removed++;
      } catch (error) {
        failed++;
        console.warn('[REACTION ROLE] Role grant tidak dapat dibersihkan:', error.message);
      }
    });
  }
  return { removed, shared, failed };
}

async function handleReactionRoleCommand(interaction) {
  if (!interaction.inGuild()) {
    return await interaction.reply({
      content: 'Perintah ini hanya bisa digunakan di server.',
      flags: MessageFlags.Ephemeral
    });
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return await interaction.reply({
      content: '❌ Hanya administrator yang bisa mengatur reaction role.',
      flags: MessageFlags.Ephemeral
    });
  }

  let deferred = false;
  let acknowledgmentAttempted = false;
  try {
    acknowledgmentAttempted = true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    deferred = true;
    const guild = interaction.guild;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'create') {
      const channel = interaction.options.getChannel('channel', true);
      const title = interaction.options.getString('title', true).trim();
      const description = interaction.options.getString('description', true).trim();
      const emojiInput = interaction.options.getString('emoji', true);
      const selectedRole = interaction.options.getRole('role', true);
      if (!title || !description) throw new Error('Judul dan deskripsi tidak boleh kosong.');

      const botMember = await guild.members.fetchMe();
      const role = await guild.roles.fetch(selectedRole.id);
      if (!role) throw new Error('Role yang dipilih sudah tidak tersedia.');
      validateReactionRoleTarget(guild, channel, role, botMember);
      const emoji = await resolveReactionRoleEmoji(guild, emojiInput);
      const panel = {
        guildId: guild.id,
        channelId: channel.id,
        messageId: null,
        title,
        description,
        mappings: [{ emoji: emoji.display, emojiKey: emoji.key, roleId: role.id }]
      };
      const message = await channel.send({ embeds: [buildReactionRolePanelEmbed(panel)] });
      panel.messageId = message.id;
      let reaction;
      try {
        reaction = await message.react(emoji.identifier);
        panel.mappings[0].emoji = reaction.emoji.toString();
        const data = readReactionRoleData();
        data.reactionRoles.push(panel);
        saveReactionRoleData(data);
      } catch (error) {
        if (reaction) {
          try { await reaction.users.remove(client.user.id); }
          catch (cleanupError) { console.warn('[REACTION ROLE] Gagal membersihkan reaction panel:', safeErrorDiagnostic(cleanupError)); }
        }
        try { await message.delete(); }
        catch (cleanupError) { console.warn('[REACTION ROLE] Gagal menghapus panel yang tidak tersimpan:', safeErrorDiagnostic(cleanupError)); }
        throw new Error('Gagal memasang reaction atau menyimpan konfigurasi: ' + error.message);
      }
      return await interaction.editReply(
        '✅ Panel Reaction Roles dibuat di <#' + channel.id + '>. ID pesan: `' + message.id + '`.'
      );
    }

    if (subcommand === 'list') {
      const data = readReactionRoleData();
      const panels = data.reactionRoles.filter(panel => panel.guildId === guild.id);
      if (!panels.length) {
        return await interaction.editReply('Belum ada panel reaction role di server ini.');
      }
      const lines = [];
      for (const panel of panels) {
        lines.push('**' + panel.title + '** di <#' + panel.channelId + '> — Message ID: `' + panel.messageId + '`');
        if (!panel.mappings.length) lines.push('  Belum ada mapping.');
        for (const mapping of panel.mappings) {
          lines.push('  ' + mapping.emoji + ' → <@&' + mapping.roleId + '>');
        }
      }
      const pages = [];
      let page = '';
      for (const line of lines) {
        if (page && (page + '\n' + line).length > 1800) {
          pages.push(page);
          page = '';
        }
        page += (page ? '\n' : '') + line;
      }
      if (page) pages.push(page);
      await interaction.editReply('**Panel Reaction Roles server ini**\n' + pages[0]);
      for (const nextPage of pages.slice(1)) {
        await interaction.followUp({ content: nextPage, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (subcommand === 'add') {
      const messageId = interaction.options.getString('message_id', true).trim();
      const emojiInput = interaction.options.getString('emoji', true);
      const selectedRole = interaction.options.getRole('role', true);
      const result = await withReactionRoleLocks(['panel:' + guild.id + ':' + messageId], async () => {
        const data = readReactionRoleData();
        const panelIndex = data.reactionRoles.findIndex(item =>
          item.guildId === guild.id && item.messageId === messageId
        );
        if (panelIndex === -1) throw new Error('Message ID tersebut bukan panel terdaftar di server ini.');
        const panel = data.reactionRoles[panelIndex];
        const emoji = await resolveReactionRoleEmoji(guild, emojiInput);
        if (panel.mappings.length >= 20) {
          throw new Error('Panel sudah mencapai batas 20 reaction Discord.');
        }
        const conflict = panel.mappings.find(mapping => mapping.emojiKey === emoji.key);
        if (conflict) {
          if (conflict.roleId === selectedRole.id) throw new Error('Pasangan emoji-role ini sudah ada pada panel.');
          throw new Error('Emoji tersebut sudah dipetakan ke role lain pada panel ini.');
        }
        const botMember = await guild.members.fetchMe();
        const role = await guild.roles.fetch(selectedRole.id);
        if (!role) throw new Error('Role yang dipilih sudah tidak tersedia.');
        const { channel, message } = await fetchRegisteredReactionRoleMessage(guild, panel);
        validateReactionRoleTarget(guild, channel, role, botMember);
        if (panel.description === null || panel.description === undefined) {
          panel.description = message.embeds[0]?.description || '';
        }
        const oldEmbed = buildReactionRolePanelEmbed(panel);
        const reaction = await message.react(emoji.identifier);
        const updatedPanel = {
          ...panel,
          mappings: [...panel.mappings, {
            emoji: reaction.emoji.toString(),
            emojiKey: reactionEmojiKey(reaction.emoji),
            roleId: role.id
          }]
        };
        try {
          await message.edit({ embeds: [buildReactionRolePanelEmbed(updatedPanel)] });
          const latestData = readReactionRoleData();
          const latestIndex = latestData.reactionRoles.findIndex(item =>
            item.guildId === guild.id && item.messageId === messageId
          );
          if (latestIndex === -1) throw new Error('Panel dihapus sebelum perubahan dapat disimpan.');
          latestData.reactionRoles[latestIndex] = updatedPanel;
          saveReactionRoleData(latestData);
        } catch (error) {
          try { await message.edit({ embeds: [oldEmbed] }); }
          catch (cleanupError) { console.warn('[REACTION ROLE] Gagal mengembalikan embed setelah add gagal:', safeErrorDiagnostic(cleanupError)); }
          try { await reaction.users.remove(client.user.id); }
          catch (cleanupError) { console.warn('[REACTION ROLE] Gagal membersihkan reaction setelah add gagal:', safeErrorDiagnostic(cleanupError)); }
          throw new Error('Mapping tidak jadi ditambahkan: ' + error.message);
        }
        return '✅ Ditambahkan ke panel: ' + reaction.emoji.toString() + ' → <@&' + role.id + '>.';
      });
      return await interaction.editReply(result);
    }

    if (subcommand === 'remove') {
      const messageId = interaction.options.getString('message_id', true).trim();
      const emojiInput = interaction.options.getString('emoji', true);
      const result = await withReactionRoleLocks(['panel:' + guild.id + ':' + messageId], async () => {
        const data = readReactionRoleData();
        const panelIndex = data.reactionRoles.findIndex(item =>
          item.guildId === guild.id && item.messageId === messageId
        );
        if (panelIndex === -1) throw new Error('Message ID tersebut bukan panel terdaftar di server ini.');
        const panel = data.reactionRoles[panelIndex];
        const emoji = await resolveReactionRoleEmoji(guild, emojiInput, true);
        const mappingIndex = panel.mappings.findIndex(mapping => mapping.emojiKey === emoji.key);
        if (mappingIndex === -1) throw new Error('Emoji tersebut tidak memiliki mapping pada panel ini.');
        const oldMappings = [...panel.mappings];
        const [removedMapping] = panel.mappings.splice(mappingIndex, 1);
        const { channel, message } = await fetchRegisteredReactionRoleMessage(guild, panel);
        const botMember = await guild.members.fetchMe();
        validatePanelEditPermissions(channel, botMember);
        if (panel.description === null || panel.description === undefined) {
          panel.description = message.embeds[0]?.description || '';
        }
        const oldEmbed = buildReactionRolePanelEmbed({ ...panel, mappings: oldMappings });
        const updatedPanel = { ...panel, mappings: [...panel.mappings] };
        let latestData;
        let removedGrants;
        try {
          await message.edit({ embeds: [buildReactionRolePanelEmbed(updatedPanel)] });
          latestData = readReactionRoleData();
          const latestIndex = latestData.reactionRoles.findIndex(item =>
            item.guildId === guild.id && item.messageId === messageId
          );
          if (latestIndex === -1) throw new Error('Panel dihapus sebelum perubahan dapat disimpan.');
          removedGrants = latestData.grants.filter(grant =>
            grant.guildId === guild.id && grant.messageId === messageId &&
            grant.emojiKey === removedMapping.emojiKey && grant.roleId === removedMapping.roleId
          );
          latestData.reactionRoles[latestIndex] = updatedPanel;
          latestData.grants = latestData.grants.filter(grant =>
            !(grant.guildId === guild.id && grant.messageId === messageId &&
              grant.emojiKey === removedMapping.emojiKey && grant.roleId === removedMapping.roleId)
          );
          saveReactionRoleData(latestData);
        } catch (error) {
          try { await message.edit({ embeds: [oldEmbed] }); }
          catch (cleanupError) { console.warn('[REACTION ROLE] Gagal mengembalikan embed setelah remove gagal:', safeErrorDiagnostic(cleanupError)); }
          throw new Error('Mapping tidak jadi dihapus: ' + error.message);
        }

        let botReactionRemoved = false;
        try { botReactionRemoved = await removeBotPanelReaction(message, removedMapping.emojiKey); }
        catch (error) {
          console.warn('[REACTION ROLE] Tidak dapat menghapus reaction bot:', error.message);
        }
        const cleanup = await removeSoleSourceRoleGrants(guild, removedGrants);
        const summary = cleanup.removed
          ? ' Role dari mapping ini dicabut dari ' + cleanup.removed + ' anggota yang tidak memiliki sumber mapping lain.'
          : '';
        const sharedSummary = cleanup.shared
          ? ' Role dipertahankan untuk ' + cleanup.shared + ' anggota karena masih diberikan mapping lain.'
          : '';
        const failureSummary = cleanup.failed
          ? ' Pencabutan role gagal untuk ' + cleanup.failed + ' anggota; periksa log bot.'
          : '';
        const emptySummary = updatedPanel.mappings.length
          ? ''
          : ' Panel tetap ada dengan daftar kosong dan dapat diisi lagi memakai /reactionrole add.';
        const reactionSummary = botReactionRemoved ? '' : ' Reaction bot tidak ditemukan atau tidak dapat dihapus.';
        return '✅ Mapping ' + removedMapping.emoji + ' dihapus.' + summary + sharedSummary +
          failureSummary + emptySummary + reactionSummary;
      });
      return await interaction.editReply(result);
    }

    if (subcommand === 'delete') {
      const messageId = interaction.options.getString('message_id', true).trim();
      const result = await withReactionRoleLocks(['panel:' + guild.id + ':' + messageId], async () => {
        const data = readReactionRoleData();
        const index = data.reactionRoles.findIndex(panel =>
          panel.guildId === guild.id && panel.messageId === messageId
        );
        if (index === -1) throw new Error('Panel dengan Message ID tersebut tidak ditemukan di server ini.');
        const [panel] = data.reactionRoles.splice(index, 1);
        data.grants = data.grants.filter(grant =>
          !(grant.guildId === guild.id && grant.messageId === panel.messageId)
        );
        saveReactionRoleData(data);
        let messageDeleted = false;
        try {
          const { message } = await fetchRegisteredReactionRoleMessage(guild, panel);
          await message.delete();
          messageDeleted = true;
        } catch (error) {
          console.warn('[REACTION ROLE] Konfigurasi dihapus, tetapi pesan tidak dapat dihapus:', error.message);
        }
        return '✅ Panel dan semua mapping dihapus.' +
          (messageDeleted ? ' Pesan bot juga dihapus.' : ' Pesan sudah tidak tersedia atau tidak dapat dihapus.') +
          ' Role yang sudah diberikan tidak dicabut oleh perintah delete.';
      });
      return await interaction.editReply(result);
    }
  } catch (error) {
    if (error?.code === 10062 || error?.code === 40060) {
      console.error('[REACTION ROLE] Acknowledgment/response Discord gagal:', safeErrorDiagnostic(error));
      return;
    }
    console.error('[REACTION ROLE] Perintah gagal:', safeErrorDiagnostic(error));
    if (deferred || interaction.deferred) return await interaction.editReply('❌ ' + error.message);
    if (acknowledgmentAttempted || interaction.replied) return;
    return await interaction.reply({ content: '❌ ' + error.message, flags: MessageFlags.Ephemeral });
  }
}

async function processReactionRoleEvent(reactionInput, userInput, adding) {
  let reaction = reactionInput;
  let user = userInput;
  if (user.partial) user = await user.fetch();
  if (!user || user.bot) return;
  if (reaction.partial) reaction = await reaction.fetch();
  if (reaction.message.partial) await reaction.message.fetch();
  const guild = reaction.message.guild;
  if (!guild) return;

  const eventEmojiKey = reactionEmojiKey(reaction.emoji);
  const panelKey = 'panel:' + guild.id + ':' + reaction.message.id;
  const userKey = 'user:' + guild.id + ':' + user.id;
  return await withReactionRoleLocks([panelKey, userKey], async () => {
    const data = readReactionRoleData();
    const panel = data.reactionRoles.find(item =>
      item.guildId === guild.id && item.messageId === reaction.message.id
    );
    const mapping = panel?.mappings.find(item => item.emojiKey === eventEmojiKey);
    if (!mapping) return;

    const member = await guild.members.fetch(user.id);
    if (member.user.bot) return;
    const role = await guild.roles.fetch(mapping.roleId);
    if (!role) {
      console.warn('[REACTION ROLE] Role sudah dihapus:', mapping.roleId);
      return;
    }
    const botMember = await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles) ||
        role.position >= botMember.roles.highest.position) {
      console.error('[REACTION ROLE] Bot tidak dapat mengelola role target:', role.id);
      return;
    }

    const matchesGrant = grant =>
      grant.guildId === guild.id && grant.userId === user.id &&
      grant.messageId === panel.messageId && grant.emojiKey === mapping.emojiKey &&
      grant.roleId === mapping.roleId;
    const grantIndex = data.grants.findIndex(matchesGrant);

    if (adding) {
      if (grantIndex !== -1) return;
      const hasRole = member.roles.cache.has(role.id);
      if (hasRole) {
        const roleIsManagedByReactionRole = data.grants.some(grant =>
          grant.guildId === guild.id && grant.userId === user.id && grant.roleId === role.id
        );
        if (roleIsManagedByReactionRole) {
          data.grants.push({
            guildId: guild.id,
            userId: user.id,
            messageId: panel.messageId,
            emojiKey: mapping.emojiKey,
            roleId: mapping.roleId
          });
          saveReactionRoleData(data);
        }
        return;
      }

      await member.roles.add(role, 'Reaction role Nightmare');
      const latestData = readReactionRoleData();
      const stillMapped = latestData.reactionRoles.some(item =>
        item.guildId === guild.id && item.messageId === panel.messageId &&
        item.mappings.some(candidate => candidate.emojiKey === mapping.emojiKey && candidate.roleId === role.id)
      );
      if (!stillMapped) {
        try { await member.roles.remove(role, 'Reaction role mapping was removed'); }
        catch (cleanupError) { console.error('[REACTION ROLE] Gagal mencabut role setelah mapping dihapus:', safeErrorDiagnostic(cleanupError)); }
        return;
      }
      if (!latestData.grants.some(matchesGrant)) {
        latestData.grants.push({
          guildId: guild.id,
          userId: user.id,
          messageId: panel.messageId,
          emojiKey: mapping.emojiKey,
          roleId: mapping.roleId
        });
        try {
          saveReactionRoleData(latestData);
        } catch (error) {
          try { await member.roles.remove(role, 'Reaction role grant could not be saved'); }
          catch (cleanupError) { console.error('[REACTION ROLE] Grant tidak tersimpan dan role gagal dipulihkan:', safeErrorDiagnostic(cleanupError)); }
          throw error;
        }
      }
      return;
    }

    if (grantIndex === -1) return;
    const hasOtherSource = data.grants.some((grant, index) =>
      index !== grantIndex && grant.guildId === guild.id &&
      grant.userId === user.id && grant.roleId === role.id
    );
    if (!hasOtherSource && member.roles.cache.has(role.id)) {
      await member.roles.remove(role, 'Reaction role dilepas di Nightmare');
    }
    const latestData = readReactionRoleData();
    latestData.grants = latestData.grants.filter(grant => !matchesGrant(grant));
    saveReactionRoleData(latestData);
  });
}
async function handleReactionRoleEvent(reaction, user, adding) {
  try {
    await processReactionRoleEvent(reaction, user, adding);
  } catch (error) {
    console.error('[REACTION ROLE] Gagal memproses reaction ' +
      (adding ? 'add' : 'remove') + ':', error.message);
  }
}

client.on(Events.MessageReactionAdd, (reaction, user) =>
  handleReactionRoleEvent(reaction, user, true)
);
client.on(Events.MessageReactionRemove, (reaction, user) =>
  handleReactionRoleEvent(reaction, user, false)
);
// END NIGHTMARE REACTION ROLES

client.login(process.env.DISCORD_TOKEN);

