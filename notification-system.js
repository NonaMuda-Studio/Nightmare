'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_DELIVERIES = 500;
const ANNOUNCEMENT_COOLDOWN_MS = 30_000;

function createNotificationStore(filePath, { now = Date.now } = {}) {
  function read() {
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, guilds: {} }; throw error; }
    try {
      const data = JSON.parse(raw);
      if (!data || data.version !== 1 || !data.guilds || typeof data.guilds !== 'object' || Array.isArray(data.guilds)) throw new Error('root/guilds/version tidak valid');
      return data;
    } catch (error) { throw new Error(`Data notification rusak; file tidak ditimpa: ${error.message}`); }
  }
  function write(data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try { fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, filePath); }
    finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  function validateGuildId(guildId) { if (!SNOWFLAKE.test(guildId || '')) throw new Error('Guild ID tidak valid.'); }
  function ensureConfig(guildId) {
    const data = read(); const config = data.guilds[guildId];
    if (!config) throw new Error('Notification belum dikonfigurasi. Jalankan /notify configure.');
    return { data, config };
  }
  return {
    configure(guildId, { channelId, roleId = null, joins = false, leaves = false }) {
      validateGuildId(guildId);
      if (!SNOWFLAKE.test(channelId || '') || (roleId !== null && !SNOWFLAKE.test(roleId)) || typeof joins !== 'boolean' || typeof leaves !== 'boolean') throw new Error('Konfigurasi notification tidak valid.');
      const data = read();
      const prior = data.guilds[guildId] || { deliveries: [], lastAnnouncementAt: 0 };
      data.guilds[guildId] = { channelId, roleId, joins, leaves, deliveries: Array.isArray(prior.deliveries) ? prior.deliveries.slice(-MAX_DELIVERIES) : [], lastAnnouncementAt: Number.isSafeInteger(prior.lastAnnouncementAt) ? prior.lastAnnouncementAt : 0 };
      write(data); return { ...data.guilds[guildId] };
    },
    get(guildId) { validateGuildId(guildId); const config = read().guilds[guildId]; return config ? { ...config, deliveries: undefined } : null; },
    claim(guildId, eventKey, { cooldownMs = 0, content = '' } = {}) {
      validateGuildId(guildId);
      if (typeof eventKey !== 'string' || eventKey.length < 1 || eventKey.length > 200) throw new Error('Kunci event notification tidak valid.');
      const { data, config } = ensureConfig(guildId);
      const deliveries = Array.isArray(config.deliveries) ? config.deliveries : [];
      if (deliveries.some(item => (typeof item === 'string' ? item : item?.key) === eventKey)) return { ok: false, reason: 'duplicate' };
      const current = now();
      if (cooldownMs > 0 && current - config.lastAnnouncementAt < cooldownMs) return { ok: false, reason: 'cooldown', retryAt: config.lastAnnouncementAt + cooldownMs };
      config.deliveries = [...deliveries, { key: eventKey, content: String(content), status: 'pending', attempts: 0, createdAt: current, nextRetryAt: current }].slice(-MAX_DELIVERIES);
      if (cooldownMs > 0) config.lastAnnouncementAt = current;
      write(data);
      return { ok: true, guildId, eventKey, channelId: config.channelId, roleId: config.roleId, joins: config.joins, leaves: config.leaves };
    },
    markDelivered(guildId, eventKey) {
      const { data, config } = ensureConfig(guildId);
      const delivery = config.deliveries?.find(item => item && typeof item === 'object' && item.key === eventKey);
      if (!delivery) return false;
      delivery.status = 'sent'; delivery.content = ''; delivery.deliveredAt = now(); delivery.nextRetryAt = null; write(data); return true;
    },
    markFailure(guildId, eventKey) {
      const { data, config } = ensureConfig(guildId);
      const delivery = config.deliveries?.find(item => item && typeof item === 'object' && item.key === eventKey);
      if (!delivery) return false;
      delivery.attempts = (delivery.attempts || 0) + 1;
      delivery.nextRetryAt = now() + Math.min(300_000, 5_000 * (2 ** Math.min(delivery.attempts - 1, 6)));
      write(data); return true;
    },
    pending() {
      const current = now(); const data = read(); const result = [];
      for (const [guildId, config] of Object.entries(data.guilds)) for (const delivery of config.deliveries || []) {
        if (delivery && typeof delivery === 'object' && delivery.status === 'pending' && (delivery.nextRetryAt ?? 0) <= current) result.push({ guildId, eventKey: delivery.key, content: delivery.content, channelId: config.channelId, roleId: config.roleId });
      }
      return result;
    }
  };
}

async function deliverNotification(guild, store, eventKey, content, { cooldownMs = 0, embeds = [] } = {}) {
  const claim = store.claim(guild.id, eventKey, { cooldownMs, content });
  if (!claim.ok) return claim;
  try {
    const channel = guild.channels.cache.get(claim.channelId) || await guild.channels.fetch(claim.channelId).catch(() => null);
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') throw new Error(`Configured notification channel ${claim.channelId} tidak tersedia atau bukan channel teks.`);
    const roleIds = claim.roleId ? [claim.roleId] : [];
    await channel.send({ content, embeds, allowedMentions: { parse: [], users: [], roles: roleIds } });
    store.markDelivered(guild.id, eventKey);
    return { ok: true, channelId: claim.channelId };
  } catch (error) { store.markFailure(guild.id, eventKey); throw error; }
}

async function retryPendingNotifications(client, store) {
  const inFlight = retryPendingNotifications.inFlight ||= new Set();
  for (const pending of store.pending()) {
    const key = `${pending.guildId}:${pending.eventKey}`;
    if (inFlight.has(key)) continue;
    inFlight.add(key);
    try {
      const guild = client.guilds.cache.get(pending.guildId) || await client.guilds.fetch(pending.guildId);
      const channel = guild.channels.cache.get(pending.channelId) || await guild.channels.fetch(pending.channelId).catch(() => null);
      if (!channel?.isTextBased?.() || typeof channel.send !== 'function') throw new Error(`Configured channel ${pending.channelId} tidak tersedia.`);
      await channel.send({ content: pending.content, allowedMentions: { parse: [], users: [], roles: pending.roleId ? [pending.roleId] : [] } });
      store.markDelivered(pending.guildId, pending.eventKey);
    } catch (error) {
      store.markFailure(pending.guildId, pending.eventKey);
      console.error(`[NOTIFY] Retry ${pending.guildId}/${pending.eventKey} gagal: ${error.message}`);
    } finally { inFlight.delete(key); }
  }
}

async function handleNotifyCommand(interaction, store) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!interaction.inGuild() || !interaction.guildId) throw new Error('Notification hanya dapat dikonfigurasi di server.');
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new Error('Perlu izin Manage Server untuk mengelola notification.');
    const action = interaction.options.getSubcommand();
    if (action === 'configure') {
      const channel = interaction.options.getChannel('channel', true);
      if (!channel.isTextBased?.() || ![0, 5].includes(channel.type)) throw new Error('Pilih channel teks atau announcement server.');
      const role = interaction.options.getRole('role');
      const joins = interaction.options.getBoolean('joins', true);
      const leaves = interaction.options.getBoolean('leaves', true);
      store.configure(interaction.guildId, { channelId: channel.id, roleId: role?.id || null, joins, leaves });
      return interaction.editReply(`✅ Notification disetel ke <#${channel.id}>${role ? ` dengan role <@&${role.id}>` : ''}. Join: ${joins ? 'aktif' : 'mati'}; leave: ${leaves ? 'aktif' : 'mati'}.`);
    }
    if (action === 'send') {
      const message = interaction.options.getString('message', true).trim();
      if (!message || message.length > 1800) throw new Error('Pesan harus berisi 1–1800 karakter.');
      const result = await deliverNotification(interaction.guild, store, `manual:${interaction.id}`, message, { cooldownMs: ANNOUNCEMENT_COOLDOWN_MS });
      if (!result.ok && result.reason === 'duplicate') return interaction.editReply('Pesan ini sudah diproses.');
      if (!result.ok && result.reason === 'cooldown') return interaction.editReply(`⏳ Tunggu <t:${Math.ceil(result.retryAt / 1000)}:R> sebelum mengirim pengumuman berikutnya.`);
      return interaction.editReply(`✅ Pengumuman terkirim ke <#${result.channelId}>.`);
    }
    throw new Error('Subcommand notification tidak dikenal.');
  } catch (error) {
    console.warn(`[NOTIFY] ${interaction.guildId || 'DM'} ${interaction.user?.id || 'unknown'}: ${error.message}`);
    return interaction.editReply(`❌ ${error.message}`);
  }
}

async function handleMemberNotification(member, eventType, store) {
  if (!member?.guild?.id || !member.user?.id || member.user.bot) return { ok: false, reason: 'ineligible' };
  const config = store.get(member.guild.id);
  if (!config || (eventType === 'join' && !config.joins) || (eventType === 'leave' && !config.leaves)) return { ok: false, reason: 'disabled' };
  const joinedAt = Number.isFinite(member.joinedTimestamp) ? member.joinedTimestamp : 0;
  const eventKey = `${eventType}:${member.id}:${joinedAt}`;
  const phrase = eventType === 'join' ? `👋 Selamat datang <@${member.id}> di **${member.guild.name}**!` : `👋 <@${member.id}> telah meninggalkan **${member.guild.name}**.`;
  const content = `${config.roleId ? `<@&${config.roleId}> ` : ''}${phrase}`;
  return deliverNotification(member.guild, store, eventKey, content);
}

module.exports = { createNotificationStore, deliverNotification, retryPendingNotifications, handleNotifyCommand, handleMemberNotification, ANNOUNCEMENT_COOLDOWN_MS };
