'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_PLAYLISTS_PER_GUILD = 50;
const MAX_ITEMS_PER_PLAYLIST = 100;
const MAX_NAME_LENGTH = 40;

function normalizeName(name) {
  if (typeof name !== 'string') throw new Error('Nama playlist harus berupa teks.');
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length < 2 || clean.length > MAX_NAME_LENGTH || /[<>@`]/.test(clean)) {
    throw new Error('Nama playlist harus 2–40 karakter dan tidak boleh berisi mention atau format Discord.');
  }
  return clean;
}

function createPlaylistStore(filePath) {
  function read() {
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, guilds: {} };
      throw error;
    }
    let value;
    try { value = JSON.parse(raw); }
    catch (error) { throw new Error('File playlist JSON rusak: ' + error.message); }
    if (!value || value.version !== 1 || !value.guilds || typeof value.guilds !== 'object' || Array.isArray(value.guilds)) {
      throw new Error('Struktur file playlist tidak valid.');
    }
    return value;
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
  function guildPlaylists(data, guildId) {
    if (!data.guilds[guildId]) data.guilds[guildId] = {};
    return data.guilds[guildId];
  }
  function findKey(playlists, name) {
    const normalized = normalizeName(name).toLocaleLowerCase('en');
    return Object.keys(playlists).find(key => key.toLocaleLowerCase('en') === normalized);
  }
  function create(guildId, name) {
    const clean = normalizeName(name);
    const data = read();
    const playlists = guildPlaylists(data, guildId);
    if (findKey(playlists, clean)) throw new Error('Playlist dengan nama tersebut sudah ada di server ini.');
    if (Object.keys(playlists).length >= MAX_PLAYLISTS_PER_GUILD) throw new Error('Batas playlist server (50) sudah tercapai.');
    playlists[clean] = { name: clean, items: [] };
    write(data);
    return playlists[clean];
  }
  function rename(guildId, name, newName) {
    const clean = normalizeName(newName);
    const data = read();
    const playlists = guildPlaylists(data, guildId);
    const oldKey = findKey(playlists, name);
    if (!oldKey) throw new Error('Playlist tidak ditemukan di server ini.');
    const existing = findKey(playlists, clean);
    if (existing && existing !== oldKey) throw new Error('Nama playlist baru sudah digunakan.');
    const value = playlists[oldKey];
    delete playlists[oldKey];
    value.name = clean;
    playlists[clean] = value;
    write(data);
    return value;
  }
  function list(guildId) {
    const data = read();
    return Object.values(data.guilds[guildId] || {}).map(item => ({ ...item, items: [...item.items] }));
  }
  function get(guildId, name) {
    const data = read();
    const playlists = data.guilds[guildId] || {};
    const key = findKey(playlists, name);
    if (!key) throw new Error('Playlist tidak ditemukan di server ini.');
    return { ...playlists[key], items: [...playlists[key].items] };
  }
  function add(guildId, name, track, addedBy) {
    const data = read();
    const playlists = guildPlaylists(data, guildId);
    const key = findKey(playlists, name);
    if (!key) throw new Error('Playlist tidak ditemukan di server ini.');
    const playlist = playlists[key];
    if (playlist.items.length >= MAX_ITEMS_PER_PLAYLIST) throw new Error('Batas playlist (100 lagu) sudah tercapai.');
    const item = {
      id: randomUUID().replace(/-/g, '').slice(0, 12),
      query: track.query,
      title: track.title,
      artist: track.artist || '',
      url: track.url || null,
      spotifyUrl: track.spotifyUrl || null,
      duration: track.duration || null,
      addedBy: String(addedBy)
    };
    playlist.items.push(item);
    write(data);
    return item;
  }
  function remove(guildId, name, itemSelector) {
    const selector = String(itemSelector).trim();
    if (!selector) throw new Error('Masukkan nomor lagu atau ID item.');
    const data = read();
    const playlists = data.guilds[guildId] || {};
    const key = findKey(playlists, name);
    if (!key) throw new Error('Playlist tidak ditemukan di server ini.');
    const playlist = playlists[key];
    const matchingId = playlist.items.findIndex(item => item.id === selector);
    let index = matchingId !== -1 ? matchingId : (/^\d+$/.test(selector) ? Number(selector) - 1 : -1);
    if (!Number.isInteger(index) || index < 0 || index >= playlist.items.length) throw new Error('Nomor/ID item tidak valid.');
    const [item] = playlist.items.splice(index, 1);
    write(data);
    return item;
  }
  return { create, rename, list, get, add, remove, read };
}

module.exports = { createPlaylistStore, normalizeName, MAX_PLAYLISTS_PER_GUILD, MAX_ITEMS_PER_PLAYLIST };
