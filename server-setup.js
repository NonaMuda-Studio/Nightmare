'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { randomUUID } = require('node:crypto');

const CATEGORY_NAMES = Object.freeze([
  '– – ~ 📊 • | SERVER STATS |', '– – ~ 📢 • | ANNOUNCEMENT |',
  '– – ~ 💬 • | GENERAL |', '– – ~ 📝 • | LOGS |',
  '– – ~ 🎮 • | GAME |', '– – ~ 🛡️ • | MOD & STAFF |',
  '– – ~ 🎵 • | MUSIC |', '– – ~ 🔊 • | VOICE LOUNGE |'
]);
const STATS_CHANNELS = Object.freeze(['👥・all-members','👤・members','🤖・bots','💬・channels','🎭・roles']);
const TYPE_MAP = Object.freeze({ text: ChannelType.GuildText, announcement: ChannelType.GuildAnnouncement, forum: ChannelType.GuildForum, voice: ChannelType.GuildVoice, stage: ChannelType.GuildStageVoice });
const rawTemplates = {
  large: [
    [CATEGORY_NAMES[0], 'stats-readonly', [['👥・all-members','text'],['👤・members','text'],['🤖・bots','text'],['💬・channels','text'],['🎭・roles','text']]],
    [CATEGORY_NAMES[1], 'public', [['📢・announcements','announcement'],['📰・server-updates','announcement'],['📅・event-calendar','text'],['🎉・event-announcements','announcement'],['🚨・important-notices','announcement'],['📡・community-news','announcement'],['📜・changelog','announcement'],['🎁・giveaways','text']]],
    [CATEGORY_NAMES[2], 'public', [['💬・global-chat','text'],['🌏・international-chat','text'],['👋・introductions','text'],['🤝・meet-the-community','text'],['🤔・questions','text'],['☕・off-topic','text'],['💭・random-chat','text'],['😂・memes','text'],['📸・media-share','text'],['🤖・bot-commands','text'],['📈・leveling','text'],['🌙・daily-chat','text'],['💡・suggestions','forum'],['📮・feedback','forum'],['🗳️・community-polls','text'],['🧑‍💻・help-desk','text'],['🔗・resources','text'],['🎭・getroles','text'],['📌・server-guide','text'],['🗞️・member-stories','forum']]],
    [CATEGORY_NAMES[3], 'private-staff', [['🔨・mod-logs','text'],['🚫・ban-logs','text'],['👢・kick-logs','text'],['🔓・unban-logs','text'],['💬・message-logs','text'],['👥・member-logs','text'],['🔊・voice-logs','text'],['🎫・ticket-logs','text'],['🤖・bot-logs','text'],['📋・audit-notes','text']]],
    [CATEGORY_NAMES[4], 'public', [['🕹️・game-chat','text'],['📰・game-updates','announcement'],['🔎・find-teammates','text'],['🎯・looking-for-group','text'],['🎬・game-clips','text'],['🧠・game-guides','forum'],['🏅・ranked-talk','text'],['🎲・other-games','text'],['📷・game-screenshots','text'],['🏆・tournament-talk','text'],['🧭・co-op-games','text'],['🧱・minecraft','text'],['🎯・valorant','text'],['📱・mobile-games','text'],['🧩・strategy-games','forum'],['🗓️・game-events','text'],['📣・team-recruitment','forum'],['🎮・game-feedback','text']]],
    [CATEGORY_NAMES[5], 'private-staff', [['🛡️・staff-chat','text'],['📣・staff-announcements','announcement'],['🧭・moderator-room','text'],['👑・admin-room','text'],['📚・staff-resources','text'],['📥・moderation-queue','forum'],['⚖️・appeal-review','forum'],['🎫・ticket-staff','text'],['🔊・staff-voice','voice'],['🎙️・mod-meetings','voice'],['🗓️・staff-planning','text'],['📋・staff-handbook','text']]],
    [CATEGORY_NAMES[6], 'public', [['🎧・request-music','text'],['🎵・music-commands','text'],['📻・radio-status','text'],['📜・music-guide','text'],['💬・music-chat','text'],['🎶・listening-room','voice'],['🎼・chill-room','voice'],['🎹・instrumental-room','voice'],['🎤・karaoke-room','voice'],['💡・music-suggestions','forum']]],
    [CATEGORY_NAMES[7], 'public', [['🔊・general-vc','voice'],['🎮・gaming-vc','voice'],['🎙️・creator-channel','voice'],['👥・community-vc','voice'],['🛋️・chill-lounge','voice'],['➕・create-voice','voice'],['📚・study-room','voice'],['🎉・event-stage','stage'],['🎲・gaming-room-2','voice'],['☕・casual-chat','voice'],['🎬・watch-party','voice'],['🎵・community-listening','voice']]]
  ],
  medium: [
    [CATEGORY_NAMES[0], 'stats-readonly', [['👥・all-members','text'],['👤・members','text'],['🤖・bots','text'],['💬・channels','text'],['🎭・roles','text']]],
    [CATEGORY_NAMES[1], 'public', [['📢・announcements','announcement'],['📰・server-updates','announcement'],['📅・events','text'],['🎁・giveaways','text'],['📌・server-guide','text']]],
    [CATEGORY_NAMES[2], 'public', [['💬・global-chat','text'],['👋・introductions','text'],['😂・memes','text'],['🤖・bot-commands','text'],['📸・media-share','text'],['🤔・questions','text'],['💡・suggestions','forum'],['☕・off-topic','text'],['🎭・getroles','text'],['📈・leveling','text']]],
    [CATEGORY_NAMES[3], 'private-staff', [['🔨・mod-logs','text'],['🚫・ban-logs','text'],['👥・member-logs','text'],['🎫・ticket-logs','text'],['🤖・bot-logs','text']]],
    [CATEGORY_NAMES[4], 'public', [['🕹️・game-chat','text'],['🔎・find-teammates','text'],['🎬・game-clips','text'],['🧠・game-guides','forum'],['🎲・other-games','text'],['🏅・ranked-talk','text'],['🎮・game-updates','announcement'],['🏆・game-events','text']]],
    [CATEGORY_NAMES[5], 'private-staff', [['🛡️・staff-chat','text'],['📣・staff-announcements','announcement'],['📋・staff-notes','text'],['🎫・ticket-staff','text'],['🔊・staff-voice','voice'],['📚・staff-resources','text'],['⚖️・appeal-review','forum']]],
    [CATEGORY_NAMES[6], 'public', [['🎧・request-music','text'],['🎵・music-commands','text'],['📻・radio-status','text'],['🎶・listening-room','voice'],['🎼・chill-room','voice']]],
    [CATEGORY_NAMES[7], 'public', [['🔊・general-vc','voice'],['🎮・gaming-vc','voice'],['👥・community-vc','voice'],['➕・create-voice','voice'],['🎉・event-stage','stage']]]
  ],
  small: [
    [CATEGORY_NAMES[0], 'stats-readonly', [['👥・all-members','text'],['👤・members','text'],['🤖・bots','text'],['💬・channels','text'],['🎭・roles','text']]],
    [CATEGORY_NAMES[1], 'public', [['📢・announcements','announcement'],['📅・events','text'],['📌・server-guide','text']]],
    [CATEGORY_NAMES[2], 'public', [['💬・global-chat','text'],['👋・introductions','text'],['😂・memes','text'],['🤖・bot-commands','text'],['📸・media-share','text'],['💡・suggestions','forum'],['🎭・getroles','text']]],
    [CATEGORY_NAMES[3], 'private-staff', [['🔨・mod-logs','text'],['🚫・ban-logs','text'],['🎫・ticket-logs','text'],['🤖・bot-logs','text']]],
    [CATEGORY_NAMES[4], 'public', [['🕹️・game-chat','text'],['🔎・find-teammates','text'],['🎬・game-clips','text'],['🎲・other-games','text'],['🎮・game-updates','announcement']]],
    [CATEGORY_NAMES[5], 'private-staff', [['🛡️・staff-chat','text'],['📋・staff-notes','text'],['🔊・staff-voice','voice']]],
    [CATEGORY_NAMES[6], 'public', [['🎧・request-music','text'],['🎵・music-commands','text'],['🎶・listening-room','voice']]],
    [CATEGORY_NAMES[7], 'public', [['🔊・general-vc','voice'],['🎮・gaming-vc','voice'],['👥・community-vc','voice'],['➕・create-voice','voice'],['🎉・event-stage','stage']]]
  ]
};

function permissionConfig(profile) {
  if (profile === 'private-staff') return { profile, everyone: 'deny-view', configuredStaffRole: 'allow-view-and-use', bot: 'allow-view-and-manage' };
  if (profile === 'stats-readonly') return { profile, everyone: 'view-only', bot: 'view-and-update' };
  return { profile: 'public', everyone: 'guild-default', bot: 'guild-default' };
}
function makeManifest(id, rows) {
  const names = { large: 'Large Community', medium: 'Medium Community', small: 'Small Community' };
  return Object.freeze({ id, name: names[id], categories: Object.freeze(rows.map(([name, permissionProfile, channelRows], index) => Object.freeze({ name, order: index + 1, type: ChannelType.GuildCategory, permissionProfile, permissions: Object.freeze(permissionConfig(permissionProfile)), channels: Object.freeze(channelRows.map(([channelName, type], channelIndex) => Object.freeze({ name: channelName, order: channelIndex + 1, type: TYPE_MAP[type], typeName: type, permissionProfile: 'inherit-category', permissions: Object.freeze({ profile: 'inherit-category' }) }))) }))), permanentChannelCount: rows.reduce((sum, row) => sum + row[2].length, 0) });
}
const SETUP_MANIFESTS = Object.freeze(Object.fromEntries(Object.entries(rawTemplates).map(([id, rows]) => [id, makeManifest(id, rows)])));
const STATS_CATEGORY = CATEGORY_NAMES[0];
const SETUP_CONFIRM_TTL_MS = 10 * 60_000;

function valuesOf(collection) { return collection ? Array.from(typeof collection.values === 'function' ? collection.values() : collection) : []; }
function matchesManifestName(actual, expected) {
  if (actual === expected) return true;
  if (!STATS_CHANNELS.includes(expected) || !actual.startsWith(expected + '・')) return false;
  const suffix = actual.slice(expected.length + 1);
  return /^\d+$/.test(suffix) || suffix === 'unavailable';
}
function findManifestChannel(channels, spec) {
  return channels.find(channel => matchesManifestName(channel?.name || '', spec.name));
}
function buildSetupPreview(manifest, channels, { guildId, staffRoleId = null, botId } = {}) {
  const existingChannels = valuesOf(channels);
  const categories = manifest.categories.map(category => {
    const sameName = existingChannels.find(channel => channel?.name === category.name);
    const categoryMatches = sameName?.type === ChannelType.GuildCategory;
    const categoryStatus = sameName ? (categoryMatches ? 'existing' : 'conflict') : 'new';
    const categoryPermissionSafe = !sameName || !guildId || !categoryMatches || categoryPermissionIsSafe(sameName, category.permissionProfile, guildId, staffRoleId, botId);
    const channelPlans = category.channels.map(spec => {
      const existing = findManifestChannel(existingChannels, spec);
      const structuralMatch = Boolean(categoryMatches && existing?.type === spec.type && existing.parentId === sameName.id);
      const childPermission = structuralMatch && category.permissionProfile === 'private-staff'
        ? inspectPrivateChannelPermissions(existing, { guildId, staffRoleId, botId })
        : { status: 'safe', reason: null };
      const matches = Boolean(structuralMatch && categoryPermissionSafe && childPermission.status === 'safe');
      let statusReason = null;
      if (categoryStatus === 'conflict') statusReason = 'Nama kategori dipakai objek bertipe lain.';
      else if (!categoryPermissionSafe) statusReason = 'Permission kategori tidak aman atau tidak dapat diverifikasi.';
      else if (structuralMatch && childPermission.status !== 'safe') statusReason = `Overwrite channel ${childPermission.status}: ${childPermission.reason}`;
      else if (existing && !structuralMatch) statusReason = 'Nama sudah digunakan di lokasi lain atau tipenya berbeda.';
      return Object.freeze({ ...spec, status: categoryStatus === 'conflict' || !categoryPermissionSafe ? 'conflict' : matches ? 'existing' : existing ? 'conflict' : 'new', existingId: matches ? existing.id : null, permissionStatus: childPermission.status, statusReason });
    });
    return Object.freeze({ ...category, categoryStatus, categoryPermissionSafe, channelPlans: Object.freeze(channelPlans) });
  });
  const plans = categories.flatMap(category => category.channelPlans);
  return Object.freeze({ manifest, categories: Object.freeze(categories), permanentChannelCount: plans.length, newChannels: plans.filter(item => item.status === 'new').length, existingChannels: plans.filter(item => item.status === 'existing').length, conflicts: plans.filter(item => item.status === 'conflict').length, newCategories: categories.filter(item => item.categoryStatus === 'new').length, categoryConflicts: categories.filter(item => item.categoryStatus === 'conflict').length });
}
function setupPreviewMatches(expected, current) {
  if (!expected?.categories || !current?.categories || expected.categories.length !== current.categories.length) return false;
  return expected.categories.every((category, categoryIndex) => {
    const actual = current.categories[categoryIndex];
    if (!actual || category.name !== actual.name || category.categoryStatus !== actual.categoryStatus || category.categoryPermissionSafe !== actual.categoryPermissionSafe || category.channelPlans.length !== actual.channelPlans.length) return false;
    return category.channelPlans.every((plan, channelIndex) => {
      const currentPlan = actual.channelPlans[channelIndex];
      return currentPlan && plan.name === currentPlan.name && plan.status === currentPlan.status && plan.permissionStatus === currentPlan.permissionStatus;
    });
  });
}

function permissionOverwrites(profile, { everyoneId, botId, staffRoleId } = {}) {
  const p = PermissionFlagsBits;
  if (profile === 'public') return undefined;
  if (profile === 'stats-readonly') return [{ id: everyoneId, allow: [p.ViewChannel, p.ReadMessageHistory], deny: [p.SendMessages] }, ...(botId ? [{ id: botId, allow: [p.ViewChannel, p.SendMessages, p.ReadMessageHistory, p.ManageChannels] }] : [])];
  if (profile === 'private-staff') return [{ id: everyoneId, deny: [p.ViewChannel] }, ...(staffRoleId ? [{ id: staffRoleId, allow: [p.ViewChannel, p.SendMessages, p.ReadMessageHistory, p.Connect, p.Speak] }] : []), ...(botId ? [{ id: botId, allow: [p.ViewChannel, p.SendMessages, p.ReadMessageHistory, p.ManageChannels, p.Connect, p.Speak] }] : [])];
  throw new Error(`Permission profile tidak dikenal: ${profile}`);
}

function permissionHas(overwrite, field, permission) {
  const value = overwrite?.[field];
  if (Array.isArray(value)) return value.includes(permission);
  if (typeof value?.has === 'function') return value.has(permission);
  if (typeof value === 'bigint') return (value & permission) === permission;
  if (typeof value?.bitfield === 'bigint') return (value.bitfield & permission) === permission;
  return false;
}
function categoryPermissionIsSafe(category, profile, guildId, staffRoleId, botId) {
  const source = category.permissionOverwrites?.cache || category.permissionOverwrites;
  const records = Array.isArray(source) ? source : source && typeof source.values === 'function' ? Array.from(source.values()) : [];
  if (source == null || (!Array.isArray(source) && typeof source.values !== 'function')) return false;
  const everyone = records.find(item => item.id === guildId);
  if (profile === 'public' && permissionHas(everyone, 'deny', PermissionFlagsBits.ViewChannel)) return false;
  if (profile === 'private-staff' && !permissionHas(everyone, 'deny', PermissionFlagsBits.ViewChannel)) return false;
  if (profile === 'stats-readonly' && !permissionHas(everyone, 'deny', PermissionFlagsBits.SendMessages)) return false;
  if (staffRoleId && profile === 'private-staff') {
    const staff = records.find(item => item.id === staffRoleId);
    if (!permissionHas(staff, 'allow', PermissionFlagsBits.ViewChannel)) return false;
  }
  if (botId && profile !== 'public') {
    const bot = records.find(item => item.id === botId);
    if (!permissionHas(bot, 'allow', PermissionFlagsBits.ViewChannel)) return false;
  }
  if (profile === 'private-staff') {
    const permittedIds = [guildId, botId, staffRoleId].filter(Boolean);
    if (records.some(item => permissionHas(item, 'allow', PermissionFlagsBits.ViewChannel) && !permittedIds.includes(item.id))) return false;
  }
  return true;
}

function inspectPrivateChannelPermissions(channel, { guildId, staffRoleId = null, botId } = {}) {
  const source = channel?.permissionOverwrites?.cache ?? channel?.permissionOverwrites;
  if (source == null) return { status: 'unverifiable', reason: 'overwrite channel tidak tersedia' };
  let records;
  if (Array.isArray(source)) records = source;
  else if (typeof source.values === 'function') records = Array.from(source.values());
  else return { status: 'unverifiable', reason: 'format overwrite channel tidak dikenal' };
  if (typeof channel.permissionsLocked !== 'boolean') return { status: 'unverifiable', reason: 'status sinkronisasi permission dengan kategori tidak tersedia' };

  const everyone = records.find(overwrite => overwrite?.id === guildId);
  if (channel.permissionsLocked) {
    // The parent category has already passed the private permission check.
    // A channel-specific public allow still overrides that protection.
    if (permissionHas(everyone, 'allow', PermissionFlagsBits.ViewChannel)) return { status: 'unsafe', reason: '@everyone diberi View Channel pada channel ini' };
  } else {
    // For an unsynced channel, category restrictions cannot be assumed to apply.
    if (permissionHas(everyone, 'allow', PermissionFlagsBits.ViewChannel)) return { status: 'unsafe', reason: '@everyone diberi View Channel pada channel ini' };
    if (!permissionHas(everyone, 'deny', PermissionFlagsBits.ViewChannel)) return { status: 'unverifiable', reason: 'channel tidak tersinkron dan tidak memiliki deny View Channel untuk @everyone' };
    if (staffRoleId && !permissionHas(records.find(overwrite => overwrite?.id === staffRoleId), 'allow', PermissionFlagsBits.ViewChannel)) return { status: 'unverifiable', reason: 'channel tidak tersinkron dan akses View Channel role staf tidak dapat dibuktikan' };
    if (botId && !permissionHas(records.find(overwrite => overwrite?.id === botId), 'allow', PermissionFlagsBits.ViewChannel)) return { status: 'unverifiable', reason: 'channel tidak tersinkron dan akses View Channel bot tidak dapat dibuktikan' };
  }

  for (const overwrite of records) {
    if (!overwrite || typeof overwrite.id !== 'string') return { status: 'unverifiable', reason: 'entri overwrite tidak lengkap' };
    const allowsView = permissionHas(overwrite, 'allow', PermissionFlagsBits.ViewChannel);
    const deniesView = permissionHas(overwrite, 'deny', PermissionFlagsBits.ViewChannel);
    if (overwrite.id === botId && deniesView) return { status: 'unverifiable', reason: 'overwrite channel menolak View Channel untuk bot' };
    if (staffRoleId && overwrite.id === staffRoleId && deniesView) return { status: 'unverifiable', reason: 'overwrite channel menolak View Channel untuk role staf' };
    if (allowsView && ![guildId, botId, staffRoleId].filter(Boolean).includes(overwrite.id)) {
      return { status: 'unverifiable', reason: `akses View Channel diberikan kepada overwrite tak dikenal (${overwrite.id})` };
    }
  }
  return { status: 'safe', reason: null };
}

async function validateSetupStaffRole(guild, roleId) {
  if (!roleId) return null;
  let role = null;
  try { role = await guild.roles.fetch(roleId); } catch {}
  if (!role || role.id !== roleId || role.id === guild.id || role.managed || role.guild?.id !== guild.id) {
    throw new Error('Role staf dari preview sudah tidak tersedia atau tidak valid di server ini. Jalankan /setup kembali dan periksa role staf.');
  }
  return role;
}

const applyingGuilds = new Set();
async function applySetupManifest(guild, manifest, { staffRoleId = null, botId, logger = console, expectedPreview = null } = {}) {
  if (applyingGuilds.has(guild.id)) throw new Error('Setup lain sedang berjalan untuk server ini.');
  applyingGuilds.add(guild.id);
  const result = { madeCategories: 0, madeChannels: 0, skipped: 0, failed: [], verified: 0, actualCount: null };
  try {
    let channels = valuesOf(await guild.channels.fetch());
    if (expectedPreview) {
      const currentPreview = buildSetupPreview(manifest, channels, { guildId: guild.id, staffRoleId, botId });
      if (!setupPreviewMatches(expectedPreview, currentPreview)) throw new Error('Struktur atau permission server berubah sejak preview. Jalankan /setup kembali untuk meninjau perubahan sebelum konfirmasi.');
    }
    for (const categorySpec of manifest.categories) {
      let category = channels.find(channel => channel?.name === categorySpec.name);
      if (category && category.type !== ChannelType.GuildCategory) { result.failed.push(`Kategori ${categorySpec.name}: nama dipakai objek bertipe lain.`); continue; }
      if (!category) {
        try {
          const overwrites = permissionOverwrites(categorySpec.permissionProfile, { everyoneId: guild.id, botId, staffRoleId });
          const created = await guild.channels.create({ name: categorySpec.name, type: ChannelType.GuildCategory, ...(overwrites ? { permissionOverwrites: overwrites } : {}), reason: 'Nightmare server setup template' });
          const verified = await guild.channels.fetch(created.id);
          if (!verified || verified.type !== ChannelType.GuildCategory || verified.name !== categorySpec.name) throw new Error('kategori tidak terverifikasi setelah dibuat');
          category = verified; channels.push(category); result.madeCategories++;
        } catch (error) { result.failed.push(`Kategori ${categorySpec.name}: ${error.message}`); continue; }
      }
      if (!categoryPermissionIsSafe(category, categorySpec.permissionProfile, guild.id, staffRoleId, botId)) {
        result.failed.push('Kategori ' + categorySpec.name + ': permission yang ada tidak sesuai atau tidak dapat diverifikasi; kategori dan channel di dalamnya dibiarkan tanpa perubahan.');
        continue;
      }
      for (const spec of categorySpec.channels) {
        const existing = findManifestChannel(channels, spec);
        if (existing) {
          if (existing.type === spec.type && existing.parentId === category.id) {
            if (categorySpec.permissionProfile === 'private-staff') {
              const permission = inspectPrivateChannelPermissions(existing, { guildId: guild.id, staffRoleId, botId });
              if (permission.status !== 'safe') {
                result.failed.push(`${spec.name}: overwrite channel ${permission.status} (${permission.reason}); channel lama dibiarkan tanpa perubahan.`);
                continue;
              }
            }
            result.skipped++;
          } else result.failed.push(`${spec.name}: nama sudah digunakan di lokasi lain atau tipenya berbeda; dilewati tanpa perubahan.`);
          continue;
        }
        try {
          const overwrites = spec.permissionProfile === 'inherit-category' ? undefined : permissionOverwrites(spec.permissionProfile, { everyoneId: guild.id, botId, staffRoleId });
          const created = await guild.channels.create({ name: spec.name, type: spec.type, parent: category.id, ...(overwrites ? { permissionOverwrites: overwrites } : {}), reason: 'Nightmare server setup template' });
          const verified = await guild.channels.fetch(created.id);
          if (!verified || verified.type !== spec.type || verified.parentId !== category.id || verified.name !== spec.name) throw new Error('channel tidak terverifikasi setelah dibuat');
          if (categorySpec.permissionProfile === 'private-staff') {
            const permission = inspectPrivateChannelPermissions(verified, { guildId: guild.id, staffRoleId, botId });
            if (permission.status !== 'safe') {
              channels.push(verified); result.madeChannels++; result.verified++;
              throw new Error(`channel sudah dibuat tetapi overwrite ${permission.status} (${permission.reason}); tidak diubah otomatis`);
            }
          }
          channels.push(verified); result.madeChannels++; result.verified++;
        } catch (error) { result.failed.push(`${spec.name} (${spec.typeName}): ${error.message}`); }
      }
    }
    try {
      const finalChannels = valuesOf(await guild.channels.fetch());
      result.actualCount = manifest.categories.reduce((sum, cat) => {
        const category = finalChannels.find(channel => channel?.name === cat.name && channel.type === ChannelType.GuildCategory);
        return sum + (category ? cat.channels.filter(spec => finalChannels.some(channel => matchesManifestName(channel?.name || '', spec.name) && channel.type === spec.type && channel.parentId === category.id)).length : 0);
      }, 0);
    } catch (error) { result.failed.push(`Verifikasi akhir channel gagal: ${error.message}`); }
    logger.info?.(`[SETUP] guild=${guild.id} template=${manifest.id} dibuat=${result.madeChannels} kategori=${result.madeCategories} dilewati=${result.skipped} gagal=${result.failed.length} aktual=${result.actualCount ?? 'tidak diketahui'}`);
    return result;
  } finally { applyingGuilds.delete(guild.id); }
}

function createSetupConfirmationStore({ now = Date.now, createId = randomUUID, ttlMs = SETUP_CONFIRM_TTL_MS } = {}) {
  const entries = new Map();
  function prune() { for (const [id, entry] of entries) if (entry.expiresAt <= now()) entries.delete(id); }
  return {
    create({ guildId, ownerId, templateId, preview, staffRoleId = null }) { prune(); const id = createId(); if (entries.size >= 500 || typeof id !== 'string' || entries.has(id)) throw new Error('Konfirmasi setup tidak dapat dibuat.'); entries.set(id, { guildId, ownerId, templateId, preview, staffRoleId, expiresAt: now() + ttlMs, status: 'pending' }); return id; },
    get(id, guildId, ownerId) { prune(); const item = entries.get(id); return item && item.guildId === guildId && item.ownerId === ownerId ? item : null; },
    claim(id, guildId, ownerId) { const item = this.get(id, guildId, ownerId); if (!item || item.status !== 'pending') return null; item.status = 'claimed'; return item; },
    cancel(id, guildId, ownerId) { const item = this.get(id, guildId, ownerId); if (!item) return 'unavailable'; if (item.status === 'pending') { item.status = 'cancelled'; return 'cancelled-now'; } if (item.status === 'claimed') return 'claimed'; return 'already-cancelled'; },
    finish(id) { const item = entries.get(id); if (!item || item.status !== 'claimed') return false; return entries.delete(id); }
  };
}
function renderSetupPreview(preview) {
  return preview.categories.map(category => ({ name: `${category.order}. ${category.name} · ${category.categoryStatus}${category.categoryPermissionSafe ? '' : ' · permission unsafe, skipped'} · permission ${category.permissionProfile}`, value: category.channelPlans.map(plan => `${plan.status === 'new' ? '＋' : plan.status === 'existing' ? '＝' : '⚠️'} ${plan.name}${plan.statusReason ? ` — ${plan.statusReason}` : ''}`).join('\n').slice(0, 1024) || 'Tidak ada channel.' }));
}

module.exports = { CATEGORY_NAMES, STATS_CHANNELS, SETUP_MANIFESTS, SETUP_CONFIRM_TTL_MS, buildSetupPreview, permissionOverwrites, applySetupManifest, createSetupConfirmationStore, renderSetupPreview, inspectPrivateChannelPermissions, validateSetupStaffRole, setupPreviewMatches, TYPE_MAP, STATS_CATEGORY };
