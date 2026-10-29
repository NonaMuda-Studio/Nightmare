'use strict';

const { ChannelType } = require('discord.js');
const { STATS_CATEGORY, STATS_CHANNELS } = require('./server-setup');

const STAT_INTERVAL_MS = 5 * 60 * 1000;
const STAT_RENAME_DELAY_MS = 1500;

function sizeOf(collection) {
  return typeof collection?.size === 'number' ? collection.size : Array.from(collection?.values?.() || []).length;
}
function entriesOf(collection) {
  if (!collection) return [];
  return Array.from(typeof collection.values === 'function' ? collection.values() : collection);
}
function calculateServerStats({ members, channels, roles }) {
  const users = entriesOf(members);
  if (users.some(member => typeof member.user?.bot !== 'boolean')) throw new Error('Data member tidak lengkap.');
  const humans = users.filter(member => !member.user.bot).length;
  const bots = users.filter(member => Boolean(member.user?.bot)).length;
  return {
    '👥・all-members': humans + bots,
    '👤・members': humans,
    '🤖・bots': bots,
    '💬・channels': entriesOf(channels).filter(channel => channel.type !== ChannelType.GuildCategory).length,
    '🎭・roles': sizeOf(roles)
  };
}

function createServerStatusUpdater({
  client,
  logger = console,
  intervalMs = STAT_INTERVAL_MS,
  renameDelayMs = STAT_RENAME_DELAY_MS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  let timer = null;
  let updating = false;

  async function update() {
    if (updating) {
      logger.warn?.('[STATUS] Update dilewati: pembaruan sebelumnya masih berjalan.');
      return { skipped: true };
    }
    updating = true;
    try {
      logger.log?.('[STATUS] Mulai update...');
      for (const guild of client.guilds.cache.values()) {
        logger.log?.(`[STATUS] Guild diproses: ${guild.name} (${guild.id})`);
        let channels;
        let channelsFresh = true;
        try {
          channels = await guild.channels.fetch();
          logger.log?.('[STATUS] Channel didapat guild=' + guild.name + ' (' + guild.id + '): ' + sizeOf(channels));
        } catch (error) {
          channelsFresh = false;
          channels = guild.channels.cache;
          logger.error?.('[STATUS] Gagal mengambil channel guild=' + guild.name + ' (' + guild.id + '); jumlah channel tidak diubah: ' + error.message);
        }
        const category = entriesOf(channels).find(channel => channel.type === ChannelType.GuildCategory && channel.name === STATS_CATEGORY);
        if (!category) logger.warn?.(`[STATUS] Kategori tidak ditemukan: ${guild.name} (${guild.id}) · ${STATS_CATEGORY}`);

        let memberStats = null;
        try {
          logger.log?.(`[STATUS] Mengambil member guild=${guild.name} (${guild.id})...`);
          const members = await guild.members.fetch();
          const users = entriesOf(members);
          if (users.some(member => typeof member.user?.bot !== 'boolean')) throw new Error('Data member tidak lengkap.');
          const humans = users.filter(member => !member.user.bot).length;
          const bots = users.filter(member => Boolean(member.user?.bot)).length;
          memberStats = { '👥・all-members': humans + bots, '👤・members': humans, '🤖・bots': bots };
          logger.log?.(`[STATUS] Member didapat guild=${guild.name} (${guild.id}): ${users.length}`);
        } catch (error) {
          logger.error?.(`[STATUS] Gagal mengambil seluruh member guild=${guild.name} (${guild.id}); statistik member tidak diubah: ${error.message}`);
        }

        let roleCount = null;
        try {
          const roles = await guild.roles.fetch();
          if (!roles) throw new Error('Data role tidak tersedia.');
          roleCount = sizeOf(roles);
        } catch (error) {
          logger.error?.(`[STATUS] Gagal mengambil role guild=${guild.name} (${guild.id}); statistik role tidak diubah: ${error.message}`);
        }

        const stats = {
          ...(memberStats || {}),
          ...(channelsFresh ? { '💬・channels': entriesOf(channels).filter(channel => channel.type !== ChannelType.GuildCategory).length } : {}),
          ...(roleCount === null ? {} : { '🎭・roles': roleCount })
        };
        for (const name of STATS_CHANNELS) {
          const channel = entriesOf(channels).find(item => {
            if (item.parentId !== category?.id || item.type !== ChannelType.GuildText) return false;
            if (item.name === name) return true;
            const prefix = name + '・';
            if (!item.name.startsWith(prefix)) return false;
            const suffix = item.name.slice(prefix.length);
            return /^\d+$/.test(suffix) || suffix === 'unavailable';
          });
          if (!channel) {
            logger.warn?.('[STATUS] Channel tidak ditemukan: ' + name + ' · guild=' + guild.name + ' (' + guild.id + ')');
            continue;
          }
          const newName = Object.hasOwn(stats, name) ? name + '・' + stats[name] : name + '・unavailable';
          if (!Object.hasOwn(stats, name)) logger.warn?.('[STATUS] Nilai tidak tersedia: ' + name + ' · guild=' + guild.name + ' (' + guild.id + '); ditandai unavailable.');
          if (channel.name === newName) continue;
          try {
            await channel.setName(newName, 'Nightmare server status');
            if (renameDelayMs > 0) await sleep(renameDelayMs);
          } catch (error) {
            logger.error?.(`[STATUS] Gagal memperbarui channel: ${name} · guild=${guild.name} (${guild.id}) · code=${Number.isInteger(error?.code) ? error.code : 'none'} · ${error.message}`);
            if (Object.hasOwn(stats, name)) {
              if (renameDelayMs > 0) await sleep(renameDelayMs);
              try {
                await channel.setName(name + '・unavailable', 'Nightmare server status value could not be refreshed');
                logger.warn?.('[STATUS] Angka lama dihapus dari nama counter: ' + name + ' · guild=' + guild.name + ' (' + guild.id + ')');
              } catch (invalidateError) {
                logger.error?.('[STATUS] Counter mungkin masih menampilkan angka lama; gagal menandai unavailable: ' + name + ' · guild=' + guild.name + ' (' + guild.id + ') · code=' + (Number.isInteger(invalidateError?.code) ? invalidateError.code : 'none') + ' · ' + invalidateError.message);
              }
            }
          }
        }
        logger.log?.(`[STATUS] Selesai guild=${guild.name} (${guild.id})`);
      }
      return { skipped: false };
    } finally {
      updating = false;
    }
  }

  function start() {
    if (timer) return false;
    timer = setIntervalFn(() => { void update().catch(error => logger.error?.(`[STATUS] Update gagal: ${error.message}`)); }, intervalMs);
    timer.unref?.();
    void update().catch(error => logger.error?.(`[STATUS] Update gagal: ${error.message}`));
    logger.log?.('[STATUS] Sistem status aktif.');
    return true;
  }
  function stop() {
    if (!timer) return false;
    clearIntervalFn(timer);
    timer = null;
    return true;
  }
  return { update, start, stop, get isUpdating() { return updating; } };
}

module.exports = { STAT_INTERVAL_MS, STAT_RENAME_DELAY_MS, calculateServerStats, createServerStatusUpdater };
