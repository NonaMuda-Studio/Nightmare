'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomInt } = require('node:crypto');

const XP_MIN = 15;
const XP_MAX = 25;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_REWARD_LEVEL = 500;
const MAX_REWARDS_PER_GUILD = 25;
const MAX_ADMIN_XP_ADJUSTMENT = 1_000_000;
const MAX_ADMIN_LEVEL_ADJUSTMENT = 500;
const MAX_ADMIN_LEVEL_VALUE = 5_000;
const MAX_ADMIN_XP_VALUE = 25 * MAX_ADMIN_LEVEL_VALUE * MAX_ADMIN_LEVEL_VALUE + 75 * MAX_ADMIN_LEVEL_VALUE;
const MAX_BOOSTER_MULTIPLIER = 5;
const MAX_BOOSTERS_PER_GUILD = 25;
const MAX_PROCESSED_MESSAGES = 1_000;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

function validateId(value, label) {
  if (typeof value !== 'string' || !SNOWFLAKE_PATTERN.test(value)) {
    throw new Error(`${label} harus berupa ID Discord yang valid.`);
  }
  return value;
}

function xpRequiredForLevel(level) {
  if (!Number.isInteger(level) || level < 0) throw new Error('Level harus bilangan bulat nonnegatif.');
  // Total XP threshold: 100 XP for level 1, then +50 XP per level.
  return 25 * level * level + 75 * level;
}

function calculateProgress(totalXp) {
  if (!Number.isSafeInteger(totalXp) || totalXp < 0) throw new Error('Total XP tidak valid.');
  let level = Math.max(0, Math.floor((Math.sqrt(5625 + 100 * totalXp) - 75) / 50));
  while (xpRequiredForLevel(level + 1) <= totalXp) level++;
  while (xpRequiredForLevel(level) > totalXp) level--;
  const levelStartXp = xpRequiredForLevel(level);
  const nextLevelXp = xpRequiredForLevel(level + 1);
  return {
    totalXp,
    level,
    currentLevelXp: totalXp - levelStartXp,
    xpToNextLevel: nextLevelXp - levelStartXp,
    nextLevelAt: nextLevelXp,
    progress: (totalXp - levelStartXp) / (nextLevelXp - levelStartXp)
  };
}

function isEligibleMessage(message) {
  if (!message || !message.guild || !message.guild.id || !message.author || !message.author.id) return false;
  if (message.author.bot || message.webhookId || message.system) return false;
  const hasText = typeof message.content === 'string' && message.content.trim().length > 0;
  const attachmentCount = message.attachments?.size ?? message.attachments?.length ?? 0;
  return hasText || attachmentCount > 0;
}

function createXpStore(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('Lokasi file XP harus berupa path.');
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const seenMessageIds = new Set();
  const randomXp = options.randomXp || (() => randomInt(XP_MIN, XP_MAX + 1));
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) throw new Error('Cooldown XP tidak valid.');
  if (typeof randomXp !== 'function') throw new Error('Generator XP harus berupa fungsi.');

  function emptyData() { return { version: 1, guilds: {} }; }
  function emptyGuild() {
    return {
      enabled: true,
      announcement: { enabled: true, channelId: null },
      excludedChannelIds: [],
      rewards: [],
      boosters: [],
      levelPanel: null,
      processedMessageIds: [],
      members: {}
    };
  }

  function validateGuild(guildId, guild) {
    validateId(guildId, 'Guild ID');
    if (!guild || typeof guild !== 'object' || Array.isArray(guild)) throw new Error(`Data guild ${guildId} tidak valid.`);
    if (typeof guild.enabled !== 'boolean') throw new Error(`Pengaturan enabled guild ${guildId} tidak valid.`);
    if (!guild.announcement || typeof guild.announcement !== 'object' || Array.isArray(guild.announcement) ||
        typeof guild.announcement.enabled !== 'boolean' ||
        (guild.announcement.channelId !== null && guild.announcement.channelId !== undefined && !SNOWFLAKE_PATTERN.test(guild.announcement.channelId))) {
      throw new Error(`Konfigurasi announcement guild ${guildId} tidak valid.`);
    }
    if (!Array.isArray(guild.excludedChannelIds) || guild.excludedChannelIds.some(id => !SNOWFLAKE_PATTERN.test(id)) ||
        new Set(guild.excludedChannelIds).size !== guild.excludedChannelIds.length) {
      throw new Error(`Daftar channel pengecualian guild ${guildId} tidak valid.`);
    }
    if (!Array.isArray(guild.rewards)) throw new Error(`Daftar reward guild ${guildId} tidak valid.`);
    const rewardLevels = new Set();
    const rewardRoles = new Set();
    for (const reward of guild.rewards) {
      if (!reward || !Number.isInteger(reward.level) || reward.level < 0 || reward.level > MAX_REWARD_LEVEL || !SNOWFLAKE_PATTERN.test(reward.roleId || '')) {
        throw new Error(`Ada role reward yang tidak valid pada guild ${guildId}.`);
      }
      if (rewardLevels.has(reward.level) || rewardRoles.has(reward.roleId)) throw new Error(`Role reward duplikat pada guild ${guildId}.`);
      rewardLevels.add(reward.level);
      rewardRoles.add(reward.roleId);
    }
    if (!Array.isArray(guild.boosters) || guild.boosters.length > MAX_BOOSTERS_PER_GUILD) throw new Error(`Daftar XP booster guild ${guildId} tidak valid.`);
    const boosterTargets = new Set();
    for (const booster of guild.boosters) {
      if (!booster || !['role', 'channel'].includes(booster.type) || !SNOWFLAKE_PATTERN.test(booster.targetId || '') ||
          typeof booster.multiplier !== 'number' || !Number.isFinite(booster.multiplier) || booster.multiplier < 1 || booster.multiplier > MAX_BOOSTER_MULTIPLIER) {
        throw new Error(`Ada XP booster yang tidak valid pada guild ${guildId}.`);
      }
      const key = `${booster.type}:${booster.targetId}`;
      if (boosterTargets.has(key)) throw new Error(`XP booster duplikat pada guild ${guildId}.`);
      boosterTargets.add(key);
    }
    if (guild.levelPanel !== null && (!guild.levelPanel || typeof guild.levelPanel !== 'object' || Array.isArray(guild.levelPanel) ||
        !SNOWFLAKE_PATTERN.test(guild.levelPanel.channelId || '') || !SNOWFLAKE_PATTERN.test(guild.levelPanel.messageId || ''))) {
      throw new Error(`Konfigurasi panel milestone guild ${guildId} tidak valid.`);
    }
    if (!Array.isArray(guild.processedMessageIds) || guild.processedMessageIds.length > MAX_PROCESSED_MESSAGES ||
        guild.processedMessageIds.some(id => !SNOWFLAKE_PATTERN.test(id)) || new Set(guild.processedMessageIds).size !== guild.processedMessageIds.length) {
      throw new Error(`Riwayat pesan XP guild ${guildId} tidak valid.`);
    }
    if (!guild.members || typeof guild.members !== 'object' || Array.isArray(guild.members)) throw new Error(`Data member guild ${guildId} tidak valid.`);
    for (const [userId, member] of Object.entries(guild.members)) {
      validateId(userId, 'User ID');
      if (!member || typeof member !== 'object' || Array.isArray(member) || !Number.isSafeInteger(member.xp) || member.xp < 0 ||
          !(member.lastMessageAt === null || (Number.isSafeInteger(member.lastMessageAt) && member.lastMessageAt >= 0))) {
        throw new Error(`Statistik member ${userId} pada guild ${guildId} tidak valid.`);
      }
    }
  }

  function read() {
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return emptyData();
      throw error;
    }
    let data;
    try { data = JSON.parse(raw); }
    catch (error) { throw new Error('File XP JSON rusak; file tidak ditimpa: ' + error.message); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 ||
        !data.guilds || typeof data.guilds !== 'object' || Array.isArray(data.guilds)) {
      throw new Error('Struktur file XP tidak valid; file tidak ditimpa.');
    }
    for (const [guildId, guild] of Object.entries(data.guilds)) {
      if (guild && typeof guild === 'object' && !Array.isArray(guild)) {
        if (!Object.hasOwn(guild, 'boosters')) guild.boosters = [];
        if (!Object.hasOwn(guild, 'levelPanel')) guild.levelPanel = null;
        if (!Object.hasOwn(guild, 'processedMessageIds')) guild.processedMessageIds = [];
      }
      validateGuild(guildId, guild);
    }
    return data;
  }

  function write(data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = filePath + '.tmp-' + process.pid + '-' + randomUUID();
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, filePath);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  function getGuild(data, guildId, create = false) {
    validateId(guildId, 'Guild ID');
    if (!data.guilds[guildId] && create) data.guilds[guildId] = emptyGuild();
    return data.guilds[guildId] || emptyGuild();
  }

  function statsFor(xp, lastMessageAt = null) {
    return { ...calculateProgress(xp), lastMessageAt };
  }

  function mutateGuild(guildId, callback) {
    const data = read();
    const guild = getGuild(data, guildId, true);
    const result = callback(guild);
    write(data);
    return result;
  }

  function getConfig(guildId) {
    const data = read();
    const guild = getGuild(data, guildId);
    return {
      enabled: guild.enabled,
      announcement: { ...guild.announcement, channelId: guild.announcement.channelId ?? null },
      excludedChannelIds: [...guild.excludedChannelIds],
      rewards: guild.rewards.map(item => ({ ...item })),
      boosters: guild.boosters.map(item => ({ ...item })),
      levelPanel: guild.levelPanel ? { ...guild.levelPanel } : null
    };
  }

  function setEnabled(guildId, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Status leveling harus berupa true atau false.');
    return mutateGuild(guildId, guild => { guild.enabled = enabled; return enabled; });
  }

  function setAnnouncement(guildId, channelId) {
    if (channelId !== null) validateId(channelId, 'Channel ID');
    return mutateGuild(guildId, guild => {
      guild.announcement = { enabled: channelId !== null, channelId };
      return { ...guild.announcement };
    });
  }

  function updateExcludedChannel(guildId, action, channelId = null) {
    if (!['add', 'remove', 'clear'].includes(action)) throw new Error('Aksi channel pengecualian tidak valid.');
    if (action !== 'clear') validateId(channelId, 'Channel ID');
    return mutateGuild(guildId, guild => {
      if (action === 'clear') guild.excludedChannelIds = [];
      else if (action === 'add') {
        if (guild.excludedChannelIds.includes(channelId)) throw new Error('Channel sudah dikecualikan.');
        if (guild.excludedChannelIds.length >= 50) throw new Error('Maksimal 50 channel dapat dikecualikan.');
        guild.excludedChannelIds.push(channelId);
      } else {
        const index = guild.excludedChannelIds.indexOf(channelId);
        if (index === -1) throw new Error('Channel tidak ada dalam daftar pengecualian.');
        guild.excludedChannelIds.splice(index, 1);
      }
      return [...guild.excludedChannelIds];
    });
  }

  function addReward(guildId, level, roleId) {
    if (!Number.isInteger(level) || level < 0 || level > MAX_REWARD_LEVEL) throw new Error(`Level reward harus 0–${MAX_REWARD_LEVEL}.`);
    validateId(roleId, 'Role ID');
    return mutateGuild(guildId, guild => {
      if (guild.rewards.length >= MAX_REWARDS_PER_GUILD) throw new Error(`Maksimal ${MAX_REWARDS_PER_GUILD} role reward per server.`);
      if (guild.rewards.some(item => item.level === level)) throw new Error('Level tersebut sudah memiliki role reward.');
      if (guild.rewards.some(item => item.roleId === roleId)) throw new Error('Role tersebut sudah digunakan sebagai reward.');
      const reward = { level, roleId };
      guild.rewards.push(reward);
      guild.rewards.sort((a, b) => a.level - b.level);
      return { ...reward };
    });
  }

  function removeReward(guildId, level) {
    if (!Number.isInteger(level) || level < 0 || level > MAX_REWARD_LEVEL) throw new Error('Level reward tidak valid.');
    return mutateGuild(guildId, guild => {
      const index = guild.rewards.findIndex(item => item.level === level);
      if (index === -1) throw new Error('Role reward untuk level tersebut tidak ditemukan.');
      return guild.rewards.splice(index, 1)[0];
    });
  }

  function getRewards(guildId) { return getConfig(guildId).rewards; }

  function getStats(guildId, userId) {
    validateId(userId, 'User ID');
    const guild = getGuild(read(), guildId);
    const member = guild.members[userId];
    return statsFor(member?.xp || 0, member?.lastMessageAt ?? null);
  }

  function validateAdminAmount(amount, maximum, label) {
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > maximum) {
      throw new Error(`${label} harus bilangan bulat positif antara 1 dan ${maximum.toLocaleString('en-US')}.`);
    }
  }

  function adjustXp(guildId, userId, amount, direction) {
    validateId(userId, 'User ID');
    validateAdminAmount(amount, MAX_ADMIN_XP_ADJUSTMENT, 'Jumlah XP');
    if (!['add', 'remove'].includes(direction)) throw new Error('Arah perubahan XP tidak valid.');
    return mutateGuild(guildId, guild => {
      const existingMember = guild.members[userId];
      const member = existingMember || { xp: 0, lastMessageAt: null };
      const before = member.xp;
      const after = direction === 'add' ? before + amount : Math.max(0, before - amount);
      if (!Number.isSafeInteger(after)) throw new Error('Total XP melebihi batas aman.');
      member.xp = after;
      guild.members[userId] = member;
      return {
        requested: amount,
        applied: direction === 'add' ? after - before : before - after,
        isNewMember: !existingMember,
        rewardFromLevel: (!existingMember || (direction === 'add' && calculateProgress(before).level === 0 && guild.rewards.some(item => item.level === 0))) ? -1 : calculateProgress(before).level,
        previousStats: statsFor(before, member.lastMessageAt),
        stats: statsFor(after, member.lastMessageAt)
      };
    });
  }

  function adjustLevels(guildId, userId, amount, direction) {
    validateId(userId, 'User ID');
    validateAdminAmount(amount, MAX_ADMIN_LEVEL_ADJUSTMENT, 'Jumlah level');
    if (!['add', 'remove'].includes(direction)) throw new Error('Arah perubahan level tidak valid.');
    return mutateGuild(guildId, guild => {
      const existingMember = guild.members[userId];
      const member = existingMember || { xp: 0, lastMessageAt: null };
      const previousStats = statsFor(member.xp, member.lastMessageAt);
      const targetLevel = direction === 'add'
        ? previousStats.level + amount
        : Math.max(0, previousStats.level - amount);
      if (!Number.isSafeInteger(targetLevel)) throw new Error('Level tujuan melebihi batas aman.');
      const targetXp = xpRequiredForLevel(targetLevel);
      if (!Number.isSafeInteger(targetXp)) throw new Error('XP untuk level tujuan melebihi batas aman.');
      member.xp = targetXp;
      guild.members[userId] = member;
      return {
        requested: amount,
        applied: direction === 'add' ? targetLevel - previousStats.level : previousStats.level - targetLevel,
        isNewMember: !existingMember,
        rewardFromLevel: (!existingMember || (direction === 'add' && previousStats.level === 0 && guild.rewards.some(item => item.level === 0))) ? -1 : previousStats.level,
        previousStats,
        stats: statsFor(member.xp, member.lastMessageAt)
      };
    });
  }

  function giveXp(guildId, userId, amount) { return adjustXp(guildId, userId, amount, 'add'); }
  function removeXp(guildId, userId, amount) { return adjustXp(guildId, userId, amount, 'remove'); }
  function giveLevels(guildId, userId, amount) { return adjustLevels(guildId, userId, amount, 'add'); }
  function removeLevels(guildId, userId, amount) { return adjustLevels(guildId, userId, amount, 'remove'); }

  function setXp(guildId, userId, amount) {
    validateId(userId, 'User ID');
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_ADMIN_XP_VALUE) throw new Error(`Total XP harus 0–${MAX_ADMIN_XP_VALUE.toLocaleString('en-US')}.`);
    return mutateGuild(guildId, guild => {
      const prior = guild.members[userId];
      const previousStats = statsFor(prior?.xp || 0, prior?.lastMessageAt ?? null);
      guild.members[userId] = { xp: amount, lastMessageAt: prior?.lastMessageAt ?? null };
      const rewardFromLevel = (!prior || (amount > (prior?.xp || 0) && previousStats.level === 0 && guild.rewards.some(item => item.level === 0)))
        ? -1
        : previousStats.level;
      return { previousStats, isNewMember: !prior, rewardFromLevel, stats: statsFor(amount, prior?.lastMessageAt ?? null) };
    });
  }

  function setLevel(guildId, userId, level) {
    validateId(userId, 'User ID');
    if (!Number.isSafeInteger(level) || level < 0 || level > MAX_ADMIN_LEVEL_VALUE) throw new Error(`Level harus 0–${MAX_ADMIN_LEVEL_VALUE}.`);
    const xp = xpRequiredForLevel(level);
    if (!Number.isSafeInteger(xp)) throw new Error('XP untuk level tujuan melebihi batas aman.');
    const result = setXp(guildId, userId, xp);
    return { ...result, requestedLevel: level };
  }

  function resetMember(guildId, userId) {
    validateId(userId, 'User ID');
    return mutateGuild(guildId, guild => {
      const existed = Boolean(guild.members[userId]);
      const previousStats = statsFor(guild.members[userId]?.xp || 0, guild.members[userId]?.lastMessageAt ?? null);
      delete guild.members[userId];
      return { previousStats, stats: statsFor(0), removed: existed };
    });
  }

  function resetGuild(guildId) {
    return mutateGuild(guildId, guild => {
      const members = Object.keys(guild.members).length;
      guild.members = {};
      guild.processedMessageIds = [];
      return { members };
    });
  }

  function setLevelPanel(guildId, channelId, messageId) {
    validateId(channelId, 'Channel ID');
    validateId(messageId, 'Message ID');
    return mutateGuild(guildId, guild => {
      guild.levelPanel = { channelId, messageId };
      return { ...guild.levelPanel };
    });
  }

  function addBooster(guildId, type, targetId, multiplier) {
    if (!['role', 'channel'].includes(type)) throw new Error('Jenis booster harus role atau channel.');
    validateId(targetId, type === 'role' ? 'Role ID' : 'Channel ID');
    if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 1 || multiplier > MAX_BOOSTER_MULTIPLIER || Math.round(multiplier * 100) / 100 !== multiplier) {
      throw new Error(`Multiplier harus 1–${MAX_BOOSTER_MULTIPLIER} dengan maksimal 2 angka desimal.`);
    }
    return mutateGuild(guildId, guild => {
      if (guild.boosters.some(item => item.type === type && item.targetId === targetId)) throw new Error('Booster untuk target tersebut sudah ada.');
      if (guild.boosters.length >= MAX_BOOSTERS_PER_GUILD) throw new Error(`Maksimal ${MAX_BOOSTERS_PER_GUILD} booster per server.`);
      const booster = { type, targetId, multiplier };
      guild.boosters.push(booster);
      guild.boosters.sort((a, b) => a.type.localeCompare(b.type) || a.targetId.localeCompare(b.targetId));
      return { ...booster };
    });
  }

  function removeBooster(guildId, type, targetId) {
    if (!['role', 'channel'].includes(type)) throw new Error('Jenis booster harus role atau channel.');
    validateId(targetId, type === 'role' ? 'Role ID' : 'Channel ID');
    return mutateGuild(guildId, guild => {
      const index = guild.boosters.findIndex(item => item.type === type && item.targetId === targetId);
      if (index < 0) throw new Error('Booster tersebut tidak ditemukan.');
      return guild.boosters.splice(index, 1)[0];
    });
  }

  function awardMessage(message, now = Date.now()) {
    if (!isEligibleMessage(message)) return { awarded: false, reason: 'ineligible' };
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Waktu pesan tidak valid.');
    const guildId = validateId(message.guild.id, 'Guild ID');
    const userId = validateId(message.author.id, 'User ID');
    const channelId = message.channelId || message.channel?.id || null;
    if (channelId !== null) validateId(channelId, 'Channel ID');

    const data = read();
    const guild = getGuild(data, guildId, true);
    const messageId = message.id || null;
    if (messageId !== null) validateId(messageId, 'Message ID');
    const seenKey = messageId ? `${guildId}:${messageId}` : null;
    if (messageId && (guild.processedMessageIds.includes(messageId) || seenMessageIds.has(seenKey))) return { awarded: false, reason: 'duplicate' };
    if (seenKey) {
      seenMessageIds.add(seenKey);
      if (seenMessageIds.size > 5_000) seenMessageIds.delete(seenMessageIds.values().next().value);
    }
    const member = guild.members[userId] || { xp: 0, lastMessageAt: null };
    const isNewMember = !guild.members[userId];
    if (!guild.enabled) return { awarded: false, reason: 'disabled' };
    if (channelId && guild.excludedChannelIds.includes(channelId)) return { awarded: false, reason: 'excluded-channel' };
    if (member.lastMessageAt !== null && now - member.lastMessageAt < cooldownMs) return { awarded: false, reason: 'cooldown', stats: statsFor(member.xp, member.lastMessageAt) };
    const baseXp = randomXp();
    if (!Number.isInteger(baseXp) || baseXp < XP_MIN || baseXp > XP_MAX) throw new Error(`XP acak harus ${XP_MIN}–${XP_MAX}.`);
    const memberRoleIds = new Set(message.member?.roles?.cache?.keys ? message.member.roles.cache.keys() : []);
    const matchingBoosters = guild.boosters.filter(item =>
      (item.type === 'channel' && item.targetId === channelId) ||
      (item.type === 'role' && memberRoleIds.has(item.targetId))
    );
    const multiplier = matchingBoosters.reduce((max, item) => Math.max(max, item.multiplier), 1);
    const xpAdded = Math.max(1, Math.round(baseXp * multiplier));
    const previousLevel = calculateProgress(member.xp).level;
    if (messageId) {
      guild.processedMessageIds.push(messageId);
      if (guild.processedMessageIds.length > MAX_PROCESSED_MESSAGES) guild.processedMessageIds.shift();
    }
    member.xp += xpAdded;
    if (!Number.isSafeInteger(member.xp)) throw new Error('Total XP melebihi batas aman.');
    member.lastMessageAt = now;
    guild.members[userId] = member;
    write(data);
    const stats = statsFor(member.xp, member.lastMessageAt);
    const rewardFromLevel = isNewMember || (previousLevel === 0 && guild.rewards.some(item => item.level === 0)) ? -1 : previousLevel;
    return { awarded: true, baseXp, xpAdded, multiplier, isNewMember, rewardFromLevel, previousLevel, level: stats.level, stats };
  }

  function getLeaderboard(guildId, page = 1, pageSize = 10) {
    if (!Number.isInteger(page) || page < 1) throw new Error('Halaman leaderboard harus bilangan bulat positif.');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error('Ukuran halaman leaderboard harus 1–50.');
    const guild = getGuild(read(), guildId);
    const entries = Object.entries(guild.members)
      .map(([userId, member]) => ({ userId, ...statsFor(member.xp, member.lastMessageAt) }))
      .sort((a, b) => b.totalXp - a.totalXp || a.userId.localeCompare(b.userId));
    const totalPages = Math.ceil(entries.length / pageSize);
    return {
      entries: entries.slice((page - 1) * pageSize, page * pageSize).map((item, index) => ({ ...item, rank: (page - 1) * pageSize + index + 1 })),
      total: entries.length,
      page,
      pageSize,
      totalPages
    };
  }

  function getRank(guildId, userId) {
    validateId(userId, 'User ID');
    const data = read();
    const guild = getGuild(data, guildId);
    const sorted = Object.entries(guild.members).sort((a, b) => b[1].xp - a[1].xp || a[0].localeCompare(b[0]));
    const index = sorted.findIndex(([id]) => id === userId);
    return index === -1 ? null : index + 1;
  }

  return {
    filePath,
    cooldownMs,
    read,
    isEligibleMessage,
    awardMessage,
    getStats,
    giveXp,
    removeXp,
    giveLevels,
    removeLevels,
    setXp,
    setLevel,
    resetMember,
    resetGuild,
    setLevelPanel,
    addBooster,
    removeBooster,
    getRank,
    getLeaderboard,
    getConfig,
    setEnabled,
    setAnnouncement,
    updateExcludedChannel,
    addReward,
    removeReward,
    getRewards
  };
}

module.exports = {
  createXpStore,
  calculateProgress,
  xpRequiredForLevel,
  isEligibleMessage,
  XP_MIN,
  XP_MAX,
  DEFAULT_COOLDOWN_MS,
  MAX_REWARD_LEVEL,
  MAX_REWARDS_PER_GUILD,
  MAX_ADMIN_XP_ADJUSTMENT,
  MAX_ADMIN_LEVEL_ADJUSTMENT,
  MAX_ADMIN_XP_VALUE,
  MAX_ADMIN_LEVEL_VALUE,
  MAX_BOOSTER_MULTIPLIER,
  MAX_BOOSTERS_PER_GUILD,
  MAX_PROCESSED_MESSAGES
};
