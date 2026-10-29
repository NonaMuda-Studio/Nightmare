'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Deliberately has no URLs: none of the researched providers currently has
// verified permission for rebroadcast through a Discord voice bot.
const RADIO_STATIONS = Object.freeze([
  Object.freeze({ id: 'study-lofi', name: 'Study Lofi', available: false, reason: 'Sumber dan izin Discord voice belum diverifikasi.' }),
  Object.freeze({ id: 'sleep-lofi', name: 'Sleep Lofi', available: false, reason: 'Sumber dan izin Discord voice belum diverifikasi.' }),
  Object.freeze({ id: 'anime-lofi', name: 'Anime Lofi', available: false, reason: 'Sumber dan izin Discord voice belum diverifikasi.' }),
  Object.freeze({ id: 'jazz-lofi', name: 'Jazz Lofi', available: false, reason: 'Sumber dan izin Discord voice belum diverifikasi.' })
]);
const RADIO_STATION_BY_ID = new Map(RADIO_STATIONS.map(station => [station.id, station]));

function hasRadioAdminPermission(memberPermissions, permissionFlags) {
  return Boolean(memberPermissions?.has(permissionFlags.Administrator) || memberPermissions?.has(permissionFlags.ManageGuild));
}

function createRadioStore(filePath, options = {}) {
  const fsImpl = options.fs || fs;

  function read() {
    let raw;
    try { raw = fsImpl.readFileSync(filePath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, guilds: {} };
      throw error;
    }
    let value;
    try { value = JSON.parse(raw); }
    catch (error) { throw new Error('File radio JSON rusak: ' + error.message); }
    if (!value || value.version !== 1 || !value.guilds || typeof value.guilds !== 'object' || Array.isArray(value.guilds)) {
      throw new Error('Struktur file radio tidak valid.');
    }
    for (const [guildId, row] of Object.entries(value.guilds)) {
      if (!/^\d{1,22}$/.test(guildId) || !row || typeof row !== 'object' || Array.isArray(row) ||
          !['music', 'radio', 'off'].includes(row.mode) ||
          (row.stationId !== null && !RADIO_STATION_BY_ID.has(row.stationId)) ||
          (row.voiceChannelId !== null && (typeof row.voiceChannelId !== 'string' || !/^\d{1,22}$/.test(row.voiceChannelId))) ||
          typeof row.autoReconnect !== 'boolean') {
        throw new Error('Konfigurasi radio tidak valid untuk guild ' + guildId + '.');
      }
    }
    return value;
  }

  function write(data) {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = filePath + '.tmp-' + process.pid + '-' + randomUUID();
    try {
      fsImpl.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fsImpl.renameSync(temporary, filePath);
    } catch (error) {
      try { fsImpl.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  function get(guildId) {
    const row = read().guilds[String(guildId)];
    return row ? { ...row } : { mode: 'music', stationId: null, voiceChannelId: null, autoReconnect: false, updatedAt: null };
  }

  function update(guildId, patch) {
    const id = String(guildId);
    if (!/^\d{1,22}$/.test(id)) throw new Error('ID guild tidak valid.');
    const data = read();
    const previous = data.guilds[id] || { mode: 'music', stationId: null, voiceChannelId: null, autoReconnect: false };
    const next = { ...previous, ...patch, updatedAt: new Date().toISOString() };
    if (!['music', 'radio', 'off'].includes(next.mode) ||
        (next.stationId !== null && !RADIO_STATION_BY_ID.has(next.stationId)) ||
        (next.voiceChannelId !== null && (typeof next.voiceChannelId !== 'string' || !/^\d{1,22}$/.test(next.voiceChannelId))) ||
        typeof next.autoReconnect !== 'boolean' || (next.autoReconnect && (next.mode !== 'radio' || !next.stationId || !next.voiceChannelId))) {
      throw new Error('Konfigurasi radio yang diminta tidak valid.');
    }
    data.guilds[id] = next;
    write(data);
    return { ...next };
  }

  function setStation(guildId, stationId) {
    if (!RADIO_STATION_BY_ID.has(stationId)) throw new Error('Stasiun tidak dikenal.');
    return update(guildId, { stationId });
  }

  function setMode(guildId, mode, voiceChannelId = null, autoReconnect = false, stationId) {
    const patch = { mode, voiceChannelId, autoReconnect };
    if (arguments.length >= 5) patch.stationId = stationId;
    return update(guildId, patch);
  }

  function list() { return Object.entries(read().guilds).map(([guildId, config]) => ({ guildId, ...config })); }
  return { get, setStation, setMode, list, read };
}

module.exports = { RADIO_STATIONS, RADIO_STATION_BY_ID, createRadioStore, hasRadioAdminPermission };
