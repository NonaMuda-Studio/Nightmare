'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const voiceApi = require('@discordjs/voice');
const prism = require('prism-media');
const { createMusicManager, parseSupportedUrl, formatDuration, createPcmVolumeTransformer, DEFAULT_YTDLP_PATH } = require('../music-system');
const { createPlaylistStore } = require('../playlist-store');
const { searchLyrics } = require('../lyrics');
const { isPrivateAddress } = require('../bot-profile');
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { RANKS } = require('../economy-catalog');
const { MONSTERS } = require('../adventure-monsters');
const { SKILLS } = require('../adventure-skills');
const { TEMPLATE_KEYS } = require('../announcement-studio');
const { buildSetupCommand } = require('../setup-command-schema');
const { RADIO_STATIONS, createRadioStore, hasRadioAdminPermission } = require('../radio-system');
const vm = require('node:vm');

test('query validation accepts only supported HTTPS YouTube and Spotify tracks', () => {
  assert.equal(parseSupportedUrl('https://youtu.be/dQw4w9WgXcQ').url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(parseSupportedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ').type, 'youtube');
  assert.equal(parseSupportedUrl('https://open.spotify.com/track/1234567890123456789012').type, 'spotify');
  assert.equal(parseSupportedUrl('https://open.spotify.com/intl-id/track/1234567890123456789012').type, 'spotify');
  assert.equal(parseSupportedUrl('http://youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.match(parseSupportedUrl('https://open.spotify.com/playlist/1234567890123456789012').reason, /track Spotify/);
  assert.equal(parseSupportedUrl('https://127.0.0.1/internal').type, 'unsupported');
  assert.equal(formatDuration(3661), '1:01:01');
});

test('installed voice/Opus APIs create WebM demux, decoder, encoder, and Opus resource', () => {
  assert.equal(typeof voiceApi.createAudioPlayer, 'function');
  assert.equal(typeof voiceApi.joinVoiceChannel, 'function');
  assert.equal(voiceApi.StreamType.Opus, 'opus');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 22);
  const demuxer = new prism.opus.WebmDemuxer();
  const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
  const encoder = new prism.opus.Encoder({ frameSize: 960, channels: 2, rate: 48000 });
  assert.equal(encoder.readableObjectMode, true, 'encoder outputs Opus packets');
  const resource = voiceApi.createAudioResource(encoder, { inputType: voiceApi.StreamType.Opus });
  assert.ok(resource);
  demuxer.destroy(); decoder.destroy(); encoder.destroy();
});

test('installed Opus encoder and decoder carry actual PCM audio frames', async () => {
  const { Readable, pipeline } = require('node:stream');
  const pcm = Buffer.alloc(960 * 2 * 2);
  for (let frame = 0; frame < 960; frame++) {
    const sample = Math.round(Math.sin((frame / 48000) * Math.PI * 2 * 440) * 12000);
    pcm.writeInt16LE(sample, frame * 4);
    pcm.writeInt16LE(sample, frame * 4 + 2);
  }
  const encoder = new prism.opus.Encoder({ frameSize: 960, channels: 2, rate: 48000 });
  const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
  let opusPackets = 0;
  let opusBytes = 0;
  let decodedBytes = 0;
  encoder.on('data', packet => { opusPackets++; opusBytes += packet.length; });
  decoder.on('data', frame => { decodedBytes += frame.length; });
  await new Promise((resolve, reject) => pipeline(Readable.from([pcm], { objectMode: false }), encoder, decoder, error => error ? reject(error) : resolve()));
  assert.ok(opusPackets > 0);
  assert.ok(opusBytes > 0);
  assert.ok(decodedBytes > 0);
});

test('PCM volume transform applies live gain and clamps samples safely', async () => {
  let volume = 150;
  const transform = createPcmVolumeTransformer(() => volume);
  const input = Buffer.alloc(6);
  input.writeInt16LE(1000, 0);
  input.writeInt16LE(-1000, 2);
  input.writeInt16LE(20000, 4);
  const scaled = await new Promise((resolve, reject) => {
    transform.once('data', resolve);
    transform.once('error', reject);
    transform.end(input);
  });
  assert.equal(scaled.readInt16LE(0), 1500);
  assert.equal(scaled.readInt16LE(2), -1500);
  assert.equal(scaled.readInt16LE(4), 30000);
  volume = 200;
});

function makeVoiceMocks() {
  const states = { Ready: 'ready', Disconnected: 'disconnected', Signalling: 'signalling', Connecting: 'connecting', Destroyed: 'destroyed' };
  const playerStates = { Idle: 'idle', Playing: 'playing', Paused: 'paused' };
  let joins = 0;
  const voice = {
    get joins() { return joins; },
    VoiceConnectionStatus: states,
    AudioPlayerStatus: playerStates,
    StreamType: { Arbitrary: 'arbitrary' },
    NoSubscriberBehavior: { Pause: 'pause' },
    entersState: async (target, expected) => { if (target.state) target.state.status = expected; return target; },
    joinVoiceChannel: ({ channelId }) => {
      joins++;
      const connection = new EventEmitter();
      connection.state = { status: 'ready' };
      connection.subscribe = player => { connection.player = player; };
      connection.prepared = null;
      connection.prepareAudioPacket = packet => { if (connection.failPrepare) throw new Error('mock crypto failure'); connection.prepared = packet; return packet ? { packet } : undefined; };
      connection.dispatchAudio = () => { if (connection.failDispatch) throw new Error('mock transport failure'); return Boolean(connection.prepared); };
      connection.destroy = () => { connection.state.status = 'destroyed'; connection.emit('stateChange', {}); };
      connection.channelId = channelId;
      return connection;
    },
    createAudioPlayer: () => {
      const player = new EventEmitter();
      player.state = { status: playerStates.Idle };
      player.play = resource => { player.resource = resource; player.state.status = playerStates.Playing; };
      player.pause = () => { if (player.state.status !== playerStates.Playing) return false; player.state.status = playerStates.Paused; return true; };
      player.unpause = () => { if (player.state.status !== playerStates.Paused) return false; player.state.status = playerStates.Playing; return true; };
      player.stop = () => { const changed = player.state.status !== playerStates.Idle; player.state.status = playerStates.Idle; if (changed) player.emit(playerStates.Idle); return changed; };
      return player;
    },
    createAudioResource: (stream, options = {}) => ({
      playStream: stream,
      metadata: options.metadata,
      playbackDuration: 0,
      read() {
        const packet = stream.read();
        if (packet) this.playbackDuration += 20;
        return packet;
      },
      volume: { value: 1, setVolume(value) { this.value = value; } }
    })
  };
  return voice;
}

function fakeSpawn(_binary, args) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.stdout.destroy(); process.nextTick(() => child.emit('close', 0)); };
  process.nextTick(() => {
    if (args.includes('--version')) {
      child.stdout.end('2026.10.21');
      child.emit('close', 0);
    } else if (args.includes('--dump-single-json')) {
      const term = args[args.length - 1];
      const metadata = { title: term.includes('second song') ? 'Second song' : 'Test song', uploader: 'Test artist', duration: 123, webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };
      child.stdout.end(JSON.stringify(metadata));
      child.emit('close', 0);
    }
  });
  return child;
}

test('explicit yt-dlp path, YTDLP_PATH, and Termux default are prioritized for extractor invocations', async () => {
  const configuredPath = '/custom/yt-dlp/bin/yt-dlp';
  const configuredCalls = [];
  const configuredSpawn = (binary, args, options) => {
    configuredCalls.push({ binary, args });
    return fakeSpawn(binary, args, options);
  };
  const configuredManager = createMusicManager({
    voice: makeVoiceMocks(),
    spawn: configuredSpawn,
    env: { YTDLP_PATH: configuredPath },
    players: new Map()
  });
  const guild = { id: 'yt-dlp-path-guild', voiceAdapterCreator: {} };
  await configuredManager.enqueue(guild, { id: 'voice-yt-dlp-path' }, 'path test', { id: 'user', username: 'Member' });
  await new Promise(resolve => setTimeout(resolve, 30));
  configuredManager.cleanup();
  assert.ok(configuredCalls.length >= 3, 'metadata, version, and stream processes were started');
  assert.ok(configuredCalls.every(call => call.binary === configuredPath));
  assert.ok(configuredCalls.some(call => call.args.includes('--version')));
  assert.ok(configuredCalls.some(call => call.args.includes('--format')));

  const defaultCalls = [];
  const defaultManager = createMusicManager({
    spawn: (binary, args, options) => { defaultCalls.push(binary); return fakeSpawn(binary, args, options); },
    env: {},
    players: new Map()
  });
  await defaultManager.resolveTrack('default path test');
  assert.deepEqual(defaultCalls, [DEFAULT_YTDLP_PATH]);
  defaultManager.cleanup();

  const explicitCalls = [];
  const explicitManager = createMusicManager({
    ytDlp: '/explicit/yt-dlp',
    env: { YTDLP_PATH: configuredPath },
    spawn: (binary, args, options) => { explicitCalls.push(binary); return fakeSpawn(binary, args, options); },
    players: new Map()
  });
  await explicitManager.resolveTrack('explicit path test');
  assert.deepEqual(explicitCalls, ['/explicit/yt-dlp']);
  explicitManager.cleanup();
});

test('outdated yt-dlp is rejected before connecting voice after the reproduced YouTube 403', async () => {
  const voice = makeVoiceMocks();
  const manager = createMusicManager({ voice, spawn: fakeSpawn, getYtDlpVersion: async () => '2026.06.09', players: new Map() });
  await assert.rejects(
    manager.enqueue({ id: 'outdated-ytdlp-guild', voiceAdapterCreator: {} }, { id: 'voice-old' }, 'test query', { id: 'user', username: 'Member' }),
    /yt-dlp 2026\.06\.09 terlalu lama.*2026\.08\.19/
  );
  assert.equal(voice.joins, 0);
  manager.cleanup();
});

test('player controls, queue progression and player isolation are per guild', async () => {
  const manager = createMusicManager({ voice: makeVoiceMocks(), spawn: fakeSpawn, players: new Map() });
  const guildA = { id: 'guild-a', voiceAdapterCreator: {} };
  const guildB = { id: 'guild-b', voiceAdapterCreator: {} };
  const channelA = { id: 'voice-a' };
  const channelB = { id: 'voice-b' };
  const requester = { id: 'user', username: 'Member' };
  const first = await manager.enqueue(guildA, channelA, 'test query', requester);
  await manager.enqueue(guildA, channelA, 'second song', requester);
  await manager.enqueue(guildB, channelB, 'other song', requester);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(manager.players.size, 2);
  assert.equal(manager.getSnapshot('guild-a').current.track.title, 'Test song');
  assert.equal(manager.getSnapshot('guild-a').queue.length, 1);
  assert.equal(first.position, 1);
  manager.pause('guild-a');
  assert.equal(manager.getSnapshot('guild-a').paused, true);
  manager.resume('guild-a');
  assert.equal(manager.getSnapshot('guild-a').paused, false);
  assert.equal(manager.setVolume('guild-a', 150), 150);
  assert.throws(() => manager.setVolume('guild-a', 201), /0–200/);
  manager.skip('guild-a');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(manager.getSnapshot('guild-a').current.track.title, 'Second song');
  manager.stop('guild-a');
  assert.equal(manager.getSnapshot('guild-a').queue.length, 0);
  manager.disconnect('guild-b');
  assert.equal(manager.players.has('guild-b'), false);
  manager.cleanup();
});

test('intentional skip, stop, and disconnect suppress cancellation errors and stale-track callbacks', async () => {
  class PassTransform extends require('node:stream').Transform {
    constructor() { super({ writableObjectMode: true, readableObjectMode: true }); }
    _transform(chunk, _encoding, callback) { this.push(chunk); callback(); }
  }
  const testPrism = { opus: { WebmDemuxer: PassTransform, Decoder: PassTransform, Encoder: PassTransform } };
  const audioChildren = [];
  const spawn = (_binary, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.stdout.destroy(new Error('Premature close'));
      process.nextTick(() => child.emit('close', 1));
      return true;
    };
    process.nextTick(() => {
      if (args.includes('--version')) {
        child.stdout.end('2026.10.21'); child.emit('close', 0);
      } else if (args.includes('--dump-single-json')) {
        const target = args[args.length - 1];
        const title = target.includes('second') ? 'Second result' : target.includes('first') ? 'First result' : 'Track result';
        child.stdout.end(JSON.stringify({ title, uploader: 'Artist', webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }));
        child.emit('close', 0);
      } else {
        audioChildren.push(child); // Leave output open so cancellation aborts the pipeline.
      }
    });
    return child;
  };
  const manager = createMusicManager({ voice: makeVoiceMocks(), spawn, prism: testPrism, players: new Map() });
  const guild = id => ({ id, voiceAdapterCreator: {} });
  const channel = { id: 'voice-cancel-test' };
  const requester = { id: 'cancel-test-user', username: 'Member' };
  const errors = [];
  const waitForAudioChildren = async count => {
    for (let attempt = 0; attempt < 40 && audioChildren.length < count; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(audioChildren.length, count);
  };

  await manager.enqueue(guild('skip-guild'), channel, 'first song', requester, { onError: error => errors.push('skip-first:' + error.message) });
  await waitForAudioChildren(1);
  await manager.enqueue(guild('skip-guild'), channel, 'second song', requester, { onError: error => errors.push('skip-second:' + error.message) });
  manager.skip('skip-guild');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(audioChildren.length, 2, 'the next track starts before the aborted track reports its close');
  assert.equal(manager.getSnapshot('skip-guild').current.track.title, 'Second result');

  await manager.enqueue(guild('stop-guild'), channel, 'stop song', requester, { onError: error => errors.push('stop:' + error.message) });
  await waitForAudioChildren(3);
  manager.stop('stop-guild');

  await manager.enqueue(guild('disconnect-guild'), channel, 'disconnect song', requester, { onError: error => errors.push('disconnect:' + error.message) });
  await waitForAudioChildren(4);
  manager.disconnect('disconnect-guild');

  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(errors, [], 'intentional stream closure must not notify requesters as playback failure');
  assert.equal(manager.getSnapshot('skip-guild').current.track.title, 'Second result');
  manager.cleanup();
});

test('audio pipeline reports generated packets and rejects non-audio extractor output', async () => {
  class PassTransform extends require('node:stream').Transform {
    constructor() { super({ writableObjectMode: true, readableObjectMode: true }); }
    _transform(chunk, _encoding, callback) { this.push(chunk); callback(); }
  }
  class TestDemuxer extends PassTransform {}
  class TestDecoder extends PassTransform {}
  class TestEncoder extends PassTransform {}
  const testPrism = { opus: { WebmDemuxer: TestDemuxer, Decoder: TestDecoder, Encoder: TestEncoder } };
  const makeSpawn = (streamBytes, exitCode = 0) => (_binary, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = () => { child.killed = true; child.stdout.destroy(); process.nextTick(() => child.emit('close', 1)); };
    process.nextTick(() => {
      if (args.includes('--version')) {
        child.stdout.end('2026.10.21');
        child.emit('close', 0);
      } else if (args.includes('--dump-single-json')) {
        child.stdout.end(JSON.stringify({ title: 'Pipeline song', uploader: 'Artist', webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }));
        child.emit('close', 0);
      } else {
        child.stdout.end(streamBytes);
        child.stderr.end(exitCode ? 'ERROR: HTTP Error 403: Forbidden' : '');
        child.emit('close', exitCode);
      }
    });
    return child;
  };
  const guild = { id: 'audio-pipeline-guild', voiceAdapterCreator: {} };
  const channel = { id: 'voice-audio' };
  const requester = { id: 'user', username: 'Member' };
  const manager = createMusicManager({ voice: makeVoiceMocks(), spawn: makeSpawn(Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])), prism: testPrism, players: new Map() });
  await manager.enqueue(guild, channel, 'pipeline test', requester);
  await new Promise(resolve => setTimeout(resolve, 40));
  const resource = manager.players.get(guild.id).player.resource;
  assert.equal(resource.metadata.diagnostics.inputBytes, 8);
  assert.equal(resource.metadata.diagnostics.opusPackets, 1);
  assert.equal(resource.metadata.diagnostics.pcmBytes, 8);
  assert.equal(resource.metadata.diagnostics.opusBytes, 8);
  assert.equal(resource.metadata.diagnostics.opusPacketsGenerated, 1);
  assert.equal(resource.playStream.listenerCount('data'), 0, 'production pipeline must not drain the encoder through a data listener');
  const packet = resource.read();
  assert.ok(Buffer.isBuffer(packet));
  const connection = manager.players.get(guild.id).connection;
  connection.prepareAudioPacket(packet);
  assert.equal(connection.dispatchAudio(), true);
  const diagnostics = resource.metadata.diagnostics;
  assert.equal(diagnostics.playerReadOpusPackets, 1);
  assert.equal(diagnostics.playerReadOpusBytes, packet.length);
  assert.equal(diagnostics.voicePreparedPackets, 1);
  assert.equal(diagnostics.voiceDispatchedPackets, 1);
  assert.equal(diagnostics.transportErrors, 0);
  connection.failPrepare = true;
  assert.doesNotThrow(() => connection.prepareAudioPacket(packet));
  connection.failPrepare = false;
  connection.failDispatch = true;
  assert.equal(connection.dispatchAudio(), false);
  assert.equal(diagnostics.transportErrors, 2);
  assert.equal(diagnostics.voiceDispatchMisses, 1);
  assert.equal(manager.players.get(guild.id).player.state.status, 'playing');
  manager.cleanup();

  const badManager = createMusicManager({ voice: makeVoiceMocks(), spawn: makeSpawn(Buffer.from('<html>blocked</html>'), 1), prism: { opus: {
    WebmDemuxer: class extends require('node:stream').Transform {
      constructor() { super({ readableObjectMode: true }); }
      _transform(chunk, _encoding, callback) { callback(new Error('Did not find the EBML tag at the start of the stream')); }
    }, Decoder: TestDecoder, Encoder: TestEncoder
  } }, players: new Map() });
  let playbackError = '';
  await badManager.enqueue({ ...guild, id: 'bad-audio-guild' }, channel, 'bad pipeline test', requester, { onError: error => { playbackError = error.message; } });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(playbackError, /yt-dlp keluar dengan kode 1|pipeline: Did not find the EBML/);
  assert.equal(badManager.getSnapshot('bad-audio-guild').current, null);
  badManager.cleanup();
});

test('Prism WebM demuxer rejects HTML or expired-source error pages', async () => {
  const demuxer = new prism.opus.WebmDemuxer();
  const input = new PassThrough();
  const error = await new Promise(resolve => {
    require('node:stream').pipeline(input, demuxer, err => resolve(err));
    input.end(Buffer.from('<html>Forbidden</html>'));
  });
  assert.match(error.message, /EBML/);
});

test('concurrent play requests create only one voice player per guild', async () => {
  const voice = makeVoiceMocks();
  const manager = createMusicManager({ voice, spawn: fakeSpawn, players: new Map() });
  const guild = { id: 'same-guild', voiceAdapterCreator: {} };
  const channel = { id: 'same-voice' };
  const requester = { id: 'u1', username: 'Member' };
  await Promise.all([
    manager.enqueue(guild, channel, 'one', requester),
    manager.enqueue(guild, channel, 'two', requester)
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(voice.joins, 1);
  assert.equal(manager.players.size, 1);
  assert.equal(manager.getSnapshot(guild.id).queue.length, 1);
  await assert.rejects(manager.enqueueSaved(guild, channel, { query: 'bad', title: 'bad', url: 'https://127.0.0.1/private' }, requester), /bukan URL YouTube/);
  manager.cleanup();

  const batchManager = createMusicManager({ voice: makeVoiceMocks(), spawn: fakeSpawn, players: new Map() });
  const batchGuild = { id: 'batch-guild', voiceAdapterCreator: {} };
  await batchManager.enqueueSavedMany(batchGuild, channel, [
    { query: 'one', title: 'One', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    { query: 'two', title: 'Two', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    { query: 'three', title: 'Three', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }
  ], requester);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(batchManager.getSnapshot(batchGuild.id).queue.map(entry => entry.track.title), ['Two', 'Three']);
  const player = batchManager.players.get(batchGuild.id).player;
  const originalError = console.error;
  console.error = () => {};
  try { player.emit('error', new Error('mock stream failure')); }
  finally { console.error = originalError; }
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(batchManager.getSnapshot(batchGuild.id).current.track.title, 'Two');
  player.emit('idle');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(batchManager.getSnapshot(batchGuild.id).current.track.title, 'Three');
  batchManager.cleanup();
});

test('playlist persistence, guild isolation, validation, rename and item removal', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-playlist-'));
  const file = path.join(temp, 'playlists.json');
  try {
    const store = createPlaylistStore(file);
    store.create('guild-a', 'Favorites');
    store.create('guild-b', 'Favorites');
    const item = store.add('guild-a', 'favorites', { query: 'song query', title: 'Song', artist: 'Artist', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, 'user-a');
    assert.equal(store.list('guild-b')[0].items.length, 0);
    const restarted = createPlaylistStore(file);
    assert.equal(restarted.get('guild-a', 'Favorites').items[0].id, item.id);
    restarted.rename('guild-a', 'Favorites', 'Road Songs');
    assert.equal(restarted.remove('guild-a', 'Road Songs', item.id).title, 'Song');
    assert.throws(() => restarted.create('guild-a', 'x'), /2–40/);
    assert.throws(() => restarted.get('guild-b', 'Road Songs'), /tidak ditemukan/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('radio preferences persist by guild and reject unknown stations or unsafe reconnect state', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-radio-'));
  const file = path.join(temp, 'radio.json');
  try {
    const store = createRadioStore(file);
    assert.equal(store.get('123').mode, 'music');
    store.setStation('123', 'study-lofi');
    store.setMode('123', 'radio', '456', true);
    store.setMode('123', 'radio', '456', true, 'sleep-lofi');
    assert.equal(store.get('123').stationId, 'sleep-lofi');
    store.setMode('123', 'radio', '456', true, 'study-lofi');
    store.setStation('789', 'jazz-lofi');
    const restarted = createRadioStore(file);
    assert.deepEqual(restarted.get('123'), store.get('123'));
    assert.equal(restarted.get('789').stationId, 'jazz-lofi');
    assert.throws(() => store.setStation('123', 'not-a-station'), /Stasiun tidak dikenal/);
    assert.throws(() => store.setMode('321', 'radio', null, true), /tidak valid/);
    store.setMode('123', 'off', null, false);
    assert.equal(createRadioStore(file).get('123').autoReconnect, false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('music/radio transitions share one player, preserve current track and queue, and are idempotent', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-radio-engine-'));
  const store = createRadioStore(path.join(temp, 'radio.json'));
  store.setStation('12345678901234567', 'study-lofi');
  const voice = makeVoiceMocks();
  const sourceStreams = [];
  const manager = createMusicManager({
    voice, spawn: fakeSpawn, radioStore: store, radioRetryLimit: 0, players: new Map(),
    isRadioSourceVerified: stationId => stationId === 'study-lofi',
    radioSources: { 'study-lofi': async () => { const stream = new PassThrough(); sourceStreams.push(stream); return { stream }; } }
  });
  const guild = { id: '12345678901234567', voiceAdapterCreator: {} };
  const channel = { id: '12345678901234569' };
  const requester = { id: 'radio-user', username: 'RadioUser' };
  try {
    await manager.enqueue(guild, channel, 'radio interrupted track', requester);
    const state = manager.players.get(guild.id);
    state.queue.push({ kind: 'music', track: { title: 'Queued next' }, query: 'queued next' });
    const originalPlayer = state.player;
    const first = await manager.moveToRadio(guild, channel, 'study-lofi');
    assert.equal(first.alreadyActive, false);
    assert.equal(voice.joins, 1);
    assert.equal(manager.players.get(guild.id).player, originalPlayer);
    assert.equal(manager.getSnapshot(guild.id).mode, 'radio');
    assert.deepEqual(manager.getSnapshot(guild.id).queue.map(entry => entry.track.title), ['Test song', 'Queued next']);
    assert.throws(() => manager.pause(guild.id), /Gunakan \/radio move mode:music/);
    assert.throws(() => manager.resume(guild.id), /Gunakan \/radio move mode:music/);
    assert.throws(() => manager.skip(guild.id), /stream kontinu/);
    assert.throws(() => manager.stop(guild.id), /\/radio move mode:music/);
    assert.equal(manager.setVolume(guild.id, 80), 80);
    const again = await manager.moveToRadio(guild, channel, 'study-lofi');
    assert.equal(again.alreadyActive, true);
    assert.equal(voice.joins, 1);
    const back = await manager.moveToMusic(guild.id);
    assert.equal(back.alreadyActive, false);
    assert.equal(manager.players.get(guild.id).player, originalPlayer);
    assert.equal(voice.joins, 1);
    assert.equal(manager.getSnapshot(guild.id).mode, 'music');
    assert.equal(store.get(guild.id).stationId, 'study-lofi');
    assert.equal(store.get(guild.id).autoReconnect, false);
    manager.disconnect(guild.id);
    assert.equal(store.get(guild.id).mode, 'off');
    assert.equal(store.get(guild.id).autoReconnect, false);
  } finally {
    manager.cleanup();
    for (const stream of sourceStreams) stream.destroy();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a delayed radio source is cancelled by a newer move to Music Mode and cannot start late', async () => {
  const voice = makeVoiceMocks();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-radio-cancel-'));
  const store = createRadioStore(path.join(temp, 'radio.json'));
  store.setStation('12345678901234568', 'study-lofi');
  let lateSourceDestroyed = false;
  const manager = createMusicManager({
    voice, radioStore: store, players: new Map(),
    isRadioSourceVerified: stationId => stationId === 'study-lofi',
    radioSources: { 'study-lofi': () => new Promise(resolve => setTimeout(() => resolve({ stream: new PassThrough(), destroy() { lateSourceDestroyed = true; } }), 40)) }
  });
  const guild = { id: '12345678901234568', voiceAdapterCreator: {} };
  try {
    const goingRadio = manager.moveToRadio(guild, { id: '12345678901234570' }, 'study-lofi').catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 0));
    const goingMusic = manager.moveToMusic(guild.id);
    await Promise.all([goingRadio, goingMusic]);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.notEqual(manager.getSnapshot(guild.id).mode, 'radio');
    assert.equal(manager.getSnapshot(guild.id).current, null);
    assert.equal(lateSourceDestroyed, true);
    assert.equal(store.get(guild.id).autoReconnect, false);
  } finally {
    manager.cleanup();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('radio source status is explicit and startup restoration honors persisted intent and source readiness', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-radio-restore-gates-'));
  const store = createRadioStore(path.join(temp, 'radio.json'));
  const guild = { id: '12345678901234581', voiceAdapterCreator: {} };
  const channel = { id: '12345678901234582' };
  const voice = makeVoiceMocks();
  const unavailable = createMusicManager({ voice, radioStore: store, players: new Map() });
  try {
    store.setStation(guild.id, 'study-lofi');
    assert.equal(unavailable.getSnapshot(guild.id).sourceStatus, 'source_not_configured');
    store.setMode(guild.id, 'radio', channel.id, true);
    assert.deepEqual(await unavailable.restoreRadio(guild, channel), { restored: false, reason: 'source_not_configured' });
    assert.equal(voice.joins, 0);
    unavailable.disconnect(guild.id);
    assert.equal(store.get(guild.id).mode, 'off');
    assert.deepEqual(await unavailable.restoreRadio(guild, channel), { restored: false, reason: 'radio_not_requested' });
    assert.equal(voice.joins, 0);
  } finally {
    unavailable.cleanup();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('startup restoration uses configured adapter and the existing shared player/connection', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-radio-restore-success-'));
  const store = createRadioStore(path.join(temp, 'radio.json'));
  const voice = makeVoiceMocks();
  const streams = [];
  const manager = createMusicManager({
    voice, radioStore: store, players: new Map(),
    isRadioSourceVerified: stationId => stationId === 'study-lofi',
    radioSources: { 'study-lofi': () => { const stream = new PassThrough(); streams.push(stream); return { stream }; } }
  });
  const guild = { id: '12345678901234583', voiceAdapterCreator: {} };
  const channel = { id: '12345678901234584' };
  try {
    store.setMode(guild.id, 'radio', channel.id, true, 'study-lofi');
    const restored = await manager.restoreRadio(guild, channel);
    assert.deepEqual(restored, { restored: true, reason: 'restored' });
    const state = manager.players.get(guild.id);
    assert.equal(state.mode, 'radio');
    assert.equal(voice.joins, 1);
    assert.equal(state.connection.player, state.player);
    assert.equal(manager.getSnapshot(guild.id).sourceStatus, 'playing');
    assert.deepEqual(await manager.restoreRadio(guild, { id: '12345678901234585' }), { restored: false, reason: 'voice_channel_unavailable' });
  } finally {
    manager.disconnect(guild.id);
    for (const stream of streams) stream.destroy();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('radio station catalog does not expose unverified URLs as active sources', () => {
  assert.deepEqual(RADIO_STATIONS.map(station => station.id), ['study-lofi', 'sleep-lofi', 'anime-lofi', 'jazz-lofi']);
  assert.ok(RADIO_STATIONS.every(station => station.available === false && !Object.hasOwn(station, 'url')));
});

test('unconfigured radio stations cannot create a voice connection or player', async () => {
  const voice = makeVoiceMocks();
  const manager = createMusicManager({ voice, players: new Map() });
  await assert.rejects(manager.moveToRadio({ id: '12345678901234579', voiceAdapterCreator: {} }, { id: '12345678901234580' }, 'study-lofi'), /belum tersedia atau belum diverifikasi/);
  assert.equal(voice.joins, 0);
  assert.equal(manager.players.size, 0);
  assert.equal(manager.getSnapshot('12345678901234579').mode, 'music');
});

test('configured adapter without source verification cannot enter Radio Mode', async () => {
  const voice = makeVoiceMocks();
  const manager = createMusicManager({
    voice, players: new Map(),
    radioSources: { 'study-lofi': () => ({ stream: new PassThrough() }) }
  });
  try {
    assert.equal(manager.getRadioSourceStatus('study-lofi'), 'source_not_verified');
    await assert.rejects(
      manager.moveToRadio({ id: '12345678901234585', voiceAdapterCreator: {} }, { id: '12345678901234586' }, 'study-lofi'),
      /belum diverifikasi/
    );
    assert.equal(voice.joins, 0);
    assert.equal(manager.players.size, 0);
    assert.equal(manager.getRadioSourceStatus('study-lofi'), 'source_not_verified');
  } finally { manager.cleanup(); }
});

test('radio transition permissions accept only Manage Server or Administrator', () => {
  const flags = { Administrator: 8n, ManageGuild: 32n };
  const permissions = bits => ({ has: value => (bits & value) === value });
  assert.equal(hasRadioAdminPermission(permissions(32n), flags), true);
  assert.equal(hasRadioAdminPermission(permissions(8n), flags), true);
  assert.equal(hasRadioAdminPermission(permissions(1n), flags), false);
  assert.equal(hasRadioAdminPermission(null, flags), false);
});

test('simultaneous radio transitions serialize to one active source and one voice connection', async () => {
  const voice = makeVoiceMocks();
  const sources = [];
  const manager = createMusicManager({
    voice, players: new Map(), radioRetryLimit: 0,
    isRadioSourceVerified: stationId => stationId === 'study-lofi',
    radioSources: { 'study-lofi': async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      const stream = new PassThrough();
      sources.push(stream);
      return { stream };
    } }
  });
  const guild = { id: '12345678901234571', voiceAdapterCreator: {} };
  const channel = { id: '12345678901234572' };
  try {
    const results = await Promise.all([
      manager.moveToRadio(guild, channel, 'study-lofi'),
      manager.moveToRadio(guild, channel, 'study-lofi')
    ]);
    assert.equal(results.filter(result => result.alreadyActive).length, 1);
    assert.equal(voice.joins, 1);
    assert.equal(manager.players.size, 1);
    assert.equal(manager.getSnapshot(guild.id).mode, 'radio');
    assert.equal(sources.length, 1);
    await manager.moveToMusic(guild.id);
  } finally {
    manager.cleanup();
    for (const stream of sources) stream.destroy();
  }
});

test('radio source failures retain station choice and bounded retries stop cleanly', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-radio-retry-'));
  const store = createRadioStore(path.join(temp, 'radio.json'));
  store.setStation('12345678901234573', 'study-lofi');
  let opens = 0;
  const manager = createMusicManager({
    voice: makeVoiceMocks(), radioStore: store, players: new Map(), radioRetryBaseDelayMs: 1, radioRetryLimit: 2,
    isRadioSourceVerified: stationId => stationId === 'study-lofi',
    radioSources: { 'study-lofi': async () => {
      opens++;
      if (opens > 1) throw new Error('mock source failure');
      return { stream: new PassThrough() };
    } }
  });
  const guild = { id: '12345678901234573', voiceAdapterCreator: {} };
  try {
    await manager.moveToRadio(guild, { id: '12345678901234574' }, 'study-lofi');
    manager.players.get(guild.id).player.stop(true);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(opens, 3);
    assert.equal(store.get(guild.id).stationId, 'study-lofi');
    assert.equal(store.get(guild.id).mode, 'radio');
    assert.equal(manager.getSnapshot(guild.id).radioRetryAttempts, 2);
  } finally {
    manager.cleanup();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('recoverable voice disconnect reconnects radio once and preserves music queue intent', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-radio-voice-reconnect-'));
  const store = createRadioStore(path.join(temp, 'radio.json'));
  const voice = makeVoiceMocks();
  voice.entersState = async (target, expected) => {
    if (expected === voice.VoiceConnectionStatus.Signalling || expected === voice.VoiceConnectionStatus.Connecting) throw new Error('mock unrecoverable disconnect');
    if (target.state) target.state.status = expected;
    return target;
  };
  let sourceOpens = 0;
  const manager = createMusicManager({
    voice, radioStore: store, players: new Map(), radioVoiceReconnectBaseDelayMs: 1,
    isRadioSourceVerified: stationId => stationId === 'study-lofi',
    radioSources: { 'study-lofi': () => { sourceOpens++; return { stream: new PassThrough() }; } }
  });
  const guild = { id: '12345678901234575', voiceAdapterCreator: {} };
  const channel = { id: '12345678901234576' };
  store.setStation(guild.id, 'study-lofi');
  try {
    await manager.moveToRadio(guild, channel, 'study-lofi');
    const oldState = manager.players.get(guild.id);
    oldState.queue.push({ kind: 'music', track: { title: 'Preserved queue' }, query: 'preserved' });
    oldState.connection.emit(voice.VoiceConnectionStatus.Disconnected);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(voice.joins, 2);
    assert.equal(sourceOpens, 2);
    assert.equal(manager.getSnapshot(guild.id).mode, 'radio');
    assert.deepEqual(manager.getSnapshot(guild.id).queue.map(entry => entry.track.title), ['Preserved queue']);
    assert.equal(store.get(guild.id).autoReconnect, true);
  } finally {
    manager.disconnect(guild.id);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('/dc while radio reconnect is pending cancels the timer and leaves radio off', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-radio-dc-reconnect-'));
  const store = createRadioStore(path.join(temp, 'radio.json'));
  const voice = makeVoiceMocks();
  voice.entersState = async (target, expected) => {
    if (expected === voice.VoiceConnectionStatus.Signalling || expected === voice.VoiceConnectionStatus.Connecting) throw new Error('mock unrecoverable disconnect');
    if (target.state) target.state.status = expected;
    return target;
  };
  let sourceOpens = 0;
  const manager = createMusicManager({
    voice, radioStore: store, players: new Map(), radioVoiceReconnectBaseDelayMs: 2000,
    isRadioSourceVerified: stationId => stationId === 'study-lofi',
    radioSources: { 'study-lofi': () => { sourceOpens++; return { stream: new PassThrough() }; } }
  });
  const guild = { id: '12345678901234587', voiceAdapterCreator: {} };
  const channel = { id: '12345678901234588' };
  try {
    store.setStation(guild.id, 'study-lofi');
    await manager.moveToRadio(guild, channel, 'study-lofi');
    assert.equal(manager.getSnapshot(guild.id).mode, 'radio');
    manager.players.get(guild.id).connection.emit(voice.VoiceConnectionStatus.Disconnected);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(manager.players.has(guild.id), false, 'the failed voice session is removed before its reconnect timer');
    assert.equal(store.get(guild.id).mode, 'radio');
    assert.equal(manager.disconnect(guild.id), true, 'dc succeeds by cancelling the pending reconnect intent');
    assert.equal(store.get(guild.id).mode, 'off');
    assert.equal(store.get(guild.id).autoReconnect, false);
    t.mock.timers.tick(10_000);
    assert.equal(voice.joins, 1);
    assert.equal(sourceOpens, 1);
  } finally {
    manager.cleanup();
    t.mock.timers.reset();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('saved radio intent survives engine reconstruction and can be restored with the same station', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightmare-radio-restart-'));
  const file = path.join(temp, 'radio.json');
  const store = createRadioStore(file);
  const guild = { id: '12345678901234577', voiceAdapterCreator: {} };
  const channel = { id: '12345678901234578' };
  const adapter = () => ({ stream: new PassThrough() });
  const first = createMusicManager({ voice: makeVoiceMocks(), radioStore: store, players: new Map(), radioSources: { 'study-lofi': adapter }, isRadioSourceVerified: stationId => stationId === 'study-lofi' });
  try {
    store.setStation(guild.id, 'study-lofi');
    await first.moveToRadio(guild, channel, 'study-lofi');
    first.cleanup();
    const reloadedStore = createRadioStore(file);
    const second = createMusicManager({ voice: makeVoiceMocks(), radioStore: reloadedStore, players: new Map(), radioSources: { 'study-lofi': adapter }, isRadioSourceVerified: stationId => stationId === 'study-lofi' });
    try {
      const saved = reloadedStore.get(guild.id);
      assert.equal(saved.mode, 'radio');
      assert.equal(saved.stationId, 'study-lofi');
      assert.equal(saved.voiceChannelId, channel.id);
      assert.equal(saved.autoReconnect, true);
      assert.deepEqual(await second.restoreRadio(guild, channel), { restored: true, reason: 'restored' });
      assert.equal(second.getSnapshot(guild.id).mode, 'radio');
      assert.equal(second.getSnapshot(guild.id).queue.length, 0, 'music queue remains memory-only');
    } finally { second.disconnect(guild.id); }
  } finally {
    first.cleanup();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('lyrics search returns official result link without copying lyric text', async () => {
  let requested;
  const result = await searchLyrics('Song', 'Artist', {
    token: 'fake-test-token',
    fetch: async (url, options) => {
      requested = { url, options };
      return { ok: true, json: async () => ({ response: { hits: [{ result: {
        title: 'Song', primary_artist: { name: 'Artist' }, url: 'https://genius.com/artist-song-lyrics'
      } }] } }) };
    }
  });
  assert.equal(result.title, 'Song');
  assert.equal(result.artist, 'Artist');
  assert.equal(result.url, 'https://genius.com/artist-song-lyrics');
  assert.equal(result.source, 'Genius');
  assert.match(requested.options.headers.authorization, /^Bearer /);
  assert.equal(await searchLyrics('Missing', '', { token: 'test-token', fetch: async () => ({ ok: true, json: async () => ({ response: { hits: [] } }) }) }), null);
  await assert.rejects(searchLyrics('Song', '', { token: '' }), /GENIUS_ACCESS_TOKEN/);
});

test('avatar IP validation blocks internal destinations', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('10.1.2.3'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
});


test('slash command JSON schema builds globally without removing legacy commands', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const start = source.indexOf('const commands = [');
  const marker = '].map(command => command.toJSON());';
  const end = source.indexOf(marker, start);
  assert.ok(start >= 0 && end >= 0, 'global command array found');
  const snippet = source.slice(start, end + marker.length);
  const context = { SlashCommandBuilder, PermissionFlagsBits, ChannelType, buildSetupCommand, ITEMS: require('../economy-catalog').ITEMS, RANKS, MONSTERS, SKILLS, TEMPLATE_KEYS, RADIO_STATIONS };
  vm.createContext(context);
  vm.runInContext(snippet + '\nthis.result = commands;', context);
  context.commands = context.result;
  const adventureStart = source.indexOf("commands.push(new SlashCommandBuilder().setName('adventure')");
  const adventureEnd = source.indexOf('\n  .toJSON());', adventureStart) + '\n  .toJSON());'.length;
  assert.ok(adventureStart >= 0 && adventureEnd > adventureStart, 'Adventure command builder found');
  vm.runInContext(source.slice(adventureStart, adventureEnd), context);
  const announcementStart=source.indexOf("commands.push(new SlashCommandBuilder().setName('announcement')");
  const announcementEnd=source.indexOf('\n\n// NIGHTMARE_REALTIME_SERVER_STATUS',announcementStart);
  assert.ok(announcementStart>=0&&announcementEnd>announcementStart,'Announcement command builder found');
  vm.runInContext(source.slice(announcementStart,announcementEnd),context);
  const commands = context.result;
  assert.match(source, /createPlaygroundService\(economyStore\)/, 'playground uses the existing economy store');
  assert.match(source, /handlePlaygroundCommand\(interaction, playgroundService\)/, 'playground slash command is dispatched');
  const names = commands.map(command => command.name);
  for (const name of ['ping','setup','resetserver','resetpreview','bg','reactionrole','play','pause','resume','skip','stop','queue','nowplaying','volume','dc','radio','music','playlist','lyrics','botprofile','rank','level','card','rewards','boosters','leaderboard','xpboost','level-config','level-rewards','give-xp','give-level','remove-xp','remove-level','xp','giveaway','economy','economy-admin','item','adventure','announcement','ticket','notify','playground']) {
    assert.ok(names.includes(name), 'expected global /' + name);
  }
  assert.equal(new Set(names).size, names.length, 'no duplicate global command names');
  const setupCommand = commands.find(command => command.name === 'setup');
  assert.equal(setupCommand.default_member_permissions, String(PermissionFlagsBits.ManageChannels));
  assert.deepEqual(setupCommand.options[0].choices.map(choice => choice.value), ['large','medium','small']);

  for (const command of commands) for (const subcommand of command.options.filter(option => option.options)) for (const option of subcommand.options) assert.ok((option.choices || []).length <= 25, `${command.name}/${subcommand.name} choice limit`);
  const economy = commands.find(command => command.name === 'economy');
  assert.equal(economy.options.find(option => option.name === 'buy').options.find(option => option.name === 'item').autocomplete, true);
  const adventure = commands.find(command => command.name === 'adventure');
  assert.deepEqual(adventure.options.map(option => option.name), ['register','profile','inventory','materials','recipes','craft','hunt','fight','quest','equip','unequip','use','open-box','skills','learn','upgrade','cast','admin']);
  assert.deepEqual(adventure.options.find(option=>option.name==='admin').options.map(option=>option.name),['rank','stats','skillpoints','enemy','skill']);
  assert.equal(adventure.options.find(option=>option.name==='cast').options.find(option=>option.name==='skill').choices.length,3);
  assert.equal(adventure.options.find(option => option.name === 'fight').options.find(option => option.name === 'action').choices.length, 4);
  const announcement=commands.find(command=>command.name==='announcement');assert.deepEqual(announcement.options[0].options.find(option=>option.name==='template').choices.map(choice=>choice.value),['update','info','event','announcement','maintenance']);
  assert.equal(announcement.default_member_permissions,String(PermissionFlagsBits.ManageGuild));
  assert.match(source,/interaction\.commandName === 'announcement'\) return await handleAnnouncementCreate/,'announcement slash command is dispatched');
  assert.match(source,/handleAnnouncementComponent\(interaction, announcementDraftStore\)/,'announcement buttons are routed');
  assert.match(source,/handleAnnouncementModal\(interaction, announcementDraftStore\)/,'announcement modals are routed');
  assert.match(source,/Routes\.applicationCommands\(client\.application\.id\),\s*\{ body: commands \}/,'the generated command array is the Discord registration payload');
  assert.match(source,/interactionDiagnostics\.instrument\(interaction, 'component-listener'\)/,'component/modal interactions are instrumented in the first listener');
  assert.match(source,/interactionDiagnostics\.instrument\(interaction, 'command-dispatcher'\)/,'slash/autocomplete interactions are instrumented in the dispatcher');
  assert.match(source,/diagnostic\.attempts === 0/,'autocomplete fallback only responds when no response was attempted');
  assert.match(source,/errorResponseAction\(interaction, diagnostic, error\)/,'dispatcher fallback distinguishes successful defer from failed acknowledgment');
  const playlist = commands.find(command => command.name === 'playlist');
  assert.deepEqual(playlist.options.map(option => option.name), ['create','rename','list','add','remove','play']);
  const radio = commands.find(command => command.name === 'radio');
  assert.deepEqual(radio.options.map(option => option.name), ['move','station','status']);
  assert.deepEqual(radio.options.find(option => option.name === 'move').options[0].choices.map(choice => choice.value), ['music']);
  assert.deepEqual(radio.options.find(option => option.name === 'station').options[0].choices.map(choice => choice.value), RADIO_STATIONS.map(station => station.id));
  assert.equal(commands.find(command => command.name === 'music').options[0].name, 'move');
  assert.match(source, /interaction\.commandName === 'radio'\) return await handleRadioCommand/);
  assert.match(source, /interaction\.commandName === 'music'\) return await handleMusicModeCommand/);
  const profile = commands.find(command => command.name === 'botprofile');
  assert.equal(profile.default_member_permissions, String(PermissionFlagsBits.Administrator));
  const reactionrole = commands.find(command => command.name === 'reactionrole');
  assert.deepEqual(reactionrole.options.map(option => option.name), ['create','add','remove','list','delete']);
  const levelConfig = commands.find(command => command.name === 'level-config');
  const xpboost = commands.find(command => command.name === 'xpboost');
  assert.equal(xpboost.default_member_permissions, String(PermissionFlagsBits.Administrator));
  assert.equal(xpboost.options[0].name, 'amount');
  assert.equal(xpboost.options[0].min_value, 1);
  assert.equal(xpboost.options[0].max_value, 500);
  const levelRewards = commands.find(command => command.name === 'level-rewards');
  assert.equal(levelConfig.default_member_permissions, String(PermissionFlagsBits.Administrator));
  assert.equal(levelRewards.default_member_permissions, String(PermissionFlagsBits.Administrator));
  assert.deepEqual(levelConfig.options.map(option => option.name), ['show','enabled','announce','exclude','booster-add','booster-remove']);
  assert.deepEqual(levelRewards.options.map(option => option.name), ['list','add','remove','panel']);
  const assertRequiredOptionsFirst = (options, optionPath = 'command') => {
    let optionalSeen = false;
    for (const option of options || []) {
      if (Object.hasOwn(option, 'required')) {
        if (!option.required) optionalSeen = true;
        else assert.equal(optionalSeen, false, `${optionPath}.${option.name}: required option follows an optional option`);
      }
      if (option.options) assertRequiredOptionsFirst(option.options, `${optionPath}.${option.name}`);
    }
  };
  for (const command of commands) assertRequiredOptionsFirst(command.options, `/${command.name}`);
  assert.deepEqual(levelConfig.options.find(option => option.name === 'booster-add').options.map(option => option.name), ['type','multiplier','role','channel']);
  for (const name of ['give-xp', 'give-level', 'remove-xp', 'remove-level']) {
    const command = commands.find(item => item.name === name);
    assert.equal(command.default_member_permissions, String(PermissionFlagsBits.Administrator));
    assert.deepEqual(command.options.map(option => option.name), ['member', 'jumlah']);
    assert.equal(command.options[1].required, true);
    assert.equal(command.options[1].min_value, 1);
  }
  const xp = commands.find(command => command.name === 'xp');
  assert.equal(xp.default_member_permissions, String(PermissionFlagsBits.Administrator));
  assert.deepEqual(xp.options.map(option => option.name), ['add','remove','set','reset']);
  assert.deepEqual(xp.options.find(option => option.name === 'set').options.map(option => option.name), ['xp','level']);
  assert.deepEqual(xp.options.find(option => option.name === 'reset').options.map(option => option.name), ['member','server']);
});
