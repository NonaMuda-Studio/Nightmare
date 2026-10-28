'use strict';

const { spawn } = require('node:child_process');
const { Transform, pipeline } = require('node:stream');
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const SPOTIFY_HOST = 'open.spotify.com';
const MAX_QUERY_LENGTH = 200;
const MAX_QUEUE_SIZE = 100;
const YTDLP_FORMAT = 'bestaudio[acodec=opus][ext=webm]';
const MIN_YTDLP_403_FIX = '2026.08.19';
const DEFAULT_YTDLP_PATH = '/data/data/com.termux/files/home/yt-dlp-venv/bin/yt-dlp';

function sanitizeExtractorError(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s\"'<>]+/gi, '[URL disembunyikan]')
    .replace(/(authorization|cookie|token|signature|sig|key)=([^\s&]+)/gi, '$1=[disembunyikan]')
    .trim().slice(-500);
}

function parseSupportedUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) {
    if (host === SPOTIFY_HOST) return null;
    const id = host === 'youtu.be'
      ? url.pathname.split('/').filter(Boolean)[0]
      : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?]+)/)?.[1];
    if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
    return { type: 'youtube', url: 'https://www.youtube.com/watch?v=' + id };
  }
  if (host === SPOTIFY_HOST) {
    const match = url.pathname.match(/^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?track\/([A-Za-z0-9]{22})\/?$/i);
    if (!match) return { type: 'unsupported', reason: 'Hanya URL track Spotify yang didukung; playlist/album belum didukung.' };
    return { type: 'spotify', url: 'https://open.spotify.com/track/' + match[1] };
  }
  return { type: 'unsupported', reason: 'URL hanya mendukung track YouTube atau Spotify HTTPS.' };
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Tidak diketahui';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function isYouTubeWebpage(value) {
  const parsed = parseSupportedUrl(value);
  return parsed?.type === 'youtube';
}

function createPcmVolumeTransformer(getVolume, TransformClass = Transform) {
  return new TransformClass({
    writableObjectMode: true,
    readableObjectMode: true,
    transform(chunk, _encoding, callback) {
      if (!Buffer.isBuffer(chunk) || chunk.length % 2 !== 0) {
        callback(new Error('PCM Opus decoder menghasilkan frame yang tidak valid.'));
        return;
      }
      const output = Buffer.from(chunk);
      const gain = Math.max(0, Math.min(2, Number(getVolume()) / 100));
      for (let offset = 0; offset < output.length; offset += 2) {
        const sample = output.readInt16LE(offset);
        const scaled = Math.max(-32768, Math.min(32767, Math.round(sample * gain)));
        output.writeInt16LE(scaled, offset);
      }
      callback(null, output);
    }
  });
}

function createMusicManager(options = {}) {
  const voice = options.voice || require('@discordjs/voice');
  const spawnProcess = options.spawn || spawn;
  const fetchImpl = options.fetch || globalThis.fetch;
  const prism = options.prism || require('prism-media');
  const environment = options.env || process.env;
  const ytDlp = options.ytDlp || environment.YTDLP_PATH || DEFAULT_YTDLP_PATH;
  const getYtDlpVersion = options.getYtDlpVersion || (async () => (await runYtDlp(['--version'], 256)).trim());
  const players = options.players || new Map();
  const connecting = new Map();
  let ytDlpVersionPromise;

  function stateFor(guildId) { return players.get(guildId); }

  async function runYtDlp(args, maxBytes = 2_000_000) {
    return await new Promise((resolve, reject) => {
      const child = spawnProcess(ytDlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout = [];
      let length = 0;
      let stderr = '';
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Waktu tunggu ekstraksi yt-dlp habis (30 detik).'));
      }, 30000);
      timeout.unref?.();
      child.stdout.on('data', chunk => {
        length += chunk.length;
        if (length > maxBytes) {
          child.kill('SIGKILL');
          clearTimeout(timeout);
          reject(new Error('Metadata hasil audio terlalu besar.'));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', chunk => { if (stderr.length < 3000) stderr += chunk.toString(); });
      child.once('error', error => { clearTimeout(timeout); reject(new Error('yt-dlp tidak dapat dijalankan: ' + error.message)); });
      child.once('close', code => {
        clearTimeout(timeout);
        if (code !== 0) return reject(new Error('Sumber audio gagal diproses oleh yt-dlp: ' + sanitizeExtractorError(stderr)));
        resolve(Buffer.concat(stdout).toString('utf8'));
      });
    });
  }

  async function assertCompatibleAudioExtractor() {
    if (!ytDlpVersionPromise) ytDlpVersionPromise = Promise.resolve().then(getYtDlpVersion);
    const version = await ytDlpVersionPromise;
    const current = String(version).match(/(\d{4})\.(\d{2})\.(\d{2})/);
    if (current && current[0] < MIN_YTDLP_403_FIX) {
      throw new Error(`Versi yt-dlp ${current[0]} terlalu lama untuk unduhan YouTube saat ini. Perbarui yt-dlp ke ${MIN_YTDLP_403_FIX} atau lebih baru melalui metode instalasi Termux yang digunakan, lalu coba lagi. Metadata dapat terbaca, tetapi unduhan audio akan gagal HTTP 403.`);
    }
    console.log(`[MUSIC] tahap=extractor-version version=${current?.[0] || 'unknown'}`);
  }

  async function spotifyMetadata(url) {
    const response = await fetchImpl('https://open.spotify.com/oembed?url=' + encodeURIComponent(url), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
      redirect: 'error'
    });
    if (!response.ok) throw new Error('Spotify tidak menyediakan metadata untuk URL tersebut (HTTP ' + response.status + ').');
    const result = await response.json();
    if (typeof result.title !== 'string' || !result.title.trim()) throw new Error('Metadata track Spotify tidak lengkap.');
    // Spotify oEmbed is public and does not expose structured artist metadata.
    // The playable YouTube search result supplies an artist/uploader when available.
    return { title: result.title.trim(), artist: '' };
  }

  async function resolveTrack(query) {
    if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY_LENGTH) {
      throw new Error(`Query wajib diisi dan maksimal ${MAX_QUERY_LENGTH} karakter.`);
    }
    const clean = query.trim();
    const parsed = parseSupportedUrl(clean);
    if (parsed?.type === 'unsupported') throw new Error(parsed.reason);
    let search = clean;
    let spotifyUrl = null;
    if (parsed?.type === 'spotify') {
      const meta = await spotifyMetadata(parsed.url);
      spotifyUrl = parsed.url;
      search = meta.title;
    } else if (parsed?.type === 'youtube') {
      search = parsed.url;
    } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clean)) {
      throw new Error('URL tidak didukung. Gunakan URL YouTube/Spotify HTTPS atau judul lagu.');
    }
    const target = parseSupportedUrl(search)?.url || (isYouTubeWebpage(search) ? search : 'ytsearch1:' + search);
    let metadata;
    try {
      const raw = await runYtDlp(['--dump-single-json', '--no-warnings', '--no-playlist', '--skip-download', target]);
      metadata = JSON.parse(raw);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('yt-dlp memberikan metadata lagu yang tidak valid.');
      throw error;
    }
    if (Array.isArray(metadata.entries)) metadata = metadata.entries.find(Boolean);
    if (!metadata || !isYouTubeWebpage(metadata.webpage_url || metadata.original_url)) {
      throw new Error('Pencarian tidak menghasilkan audio YouTube yang didukung.');
    }
    const canonicalUrl = parseSupportedUrl(metadata.webpage_url || metadata.original_url).url;
    const title = String(metadata.title || '').slice(0, 250).replace(/@/g, '@\u200b');
    if (!title) throw new Error('Sumber audio tidak memiliki judul yang valid.');
    return {
      query: spotifyUrl || (parsed?.type === 'youtube' ? canonicalUrl : clean),
      title,
      artist: String(metadata.artist || metadata.uploader || metadata.channel || '').slice(0, 120).replace(/@/g, '@\u200b'),
      url: canonicalUrl,
      spotifyUrl,
      duration: Number.isFinite(Number(metadata.duration)) ? Number(metadata.duration) : null,
      webpageUrl: canonicalUrl
    };
  }


  async function createConnection(guild, voiceChannel) {
    let state = players.get(guild.id);
    if (state && state.connection.state.status === voice.VoiceConnectionStatus.Destroyed) {
      players.delete(guild.id);
      state = null;
    }
    if (state) {
      if (state.voiceChannelId !== voiceChannel.id) throw new Error('Bot sudah berada di voice channel lain di server ini.');
      await voice.entersState(state.connection, voice.VoiceConnectionStatus.Ready, 15000);
      return state;
    }
    const connection = voice.joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      // The receiver observes speaking-start only; no audio is recorded or retained.
      selfDeaf: typeof options.onVoiceActivity !== 'function'
    });
    if (typeof options.onVoiceActivity === 'function') {
      connection.receiver?.speaking?.on('start', userId => {
        try { options.onVoiceActivity(guild.id, userId, voiceChannel.id); }
        catch (error) { console.warn(`[MUSIC] guild=${guild.id} voice-activity handler gagal: ${error.message}`); }
      });
    }
    const player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause } });
    const created = {
      guildId: guild.id,
      voiceChannelId: voiceChannel.id,
      connection,
      player,
      queue: [],
      current: null,
      volume: 100,
      isStarting: false,
      starting: null,
      generation: 0,
      destroyed: false
    };
    players.set(guild.id, created);
    // Count packets at the public methods used by AudioPlayer's transport path.
    if (typeof connection.prepareAudioPacket === 'function') {
      const prepareAudioPacket = connection.prepareAudioPacket.bind(connection);
      connection.prepareAudioPacket = packet => {
        const diagnostics = created.current?.resource?.metadata?.diagnostics;
        try {
          const prepared = prepareAudioPacket(packet);
          if (prepared && diagnostics) diagnostics.voicePreparedPackets++;
          return prepared;
        } catch (error) {
          if (diagnostics) diagnostics.transportErrors = (diagnostics.transportErrors || 0) + 1;
          console.error(`[MUSIC] guild=${guild.id} tahap=voice-prepare-failed error=${sanitizeExtractorError(error.message)}`);
          return undefined;
        }
      };
    }
    if (typeof connection.dispatchAudio === 'function') {
      const dispatchAudio = connection.dispatchAudio.bind(connection);
      connection.dispatchAudio = () => {
        const diagnostics = created.current?.resource?.metadata?.diagnostics;
        try {
          const dispatched = dispatchAudio();
          if (diagnostics) {
            diagnostics.voiceDispatchCalls++;
            if (dispatched) diagnostics.voiceDispatchedPackets++;
            else diagnostics.voiceDispatchMisses++;
          }
          return dispatched;
        } catch (error) {
          if (diagnostics) {
            diagnostics.voiceDispatchCalls++;
            diagnostics.voiceDispatchMisses++;
            diagnostics.transportErrors = (diagnostics.transportErrors || 0) + 1;
          }
          console.error(`[MUSIC] guild=${guild.id} tahap=voice-dispatch-failed error=${sanitizeExtractorError(error.message)}`);
          return false;
        }
      };
    }
    created.connectionSubscription = connection.subscribe(player);
    connection.on('stateChange', (oldState, newState) => {
      console.log(`[MUSIC] guild=${guild.id} voice ${oldState?.status || 'unknown'} -> ${newState?.status || 'unknown'}`);
    });
    player.on('stateChange', (oldState, newState) => {
      const resource = oldState?.resource || newState?.resource;
      const diagnostics = resource?.metadata?.diagnostics;
      const networkingCode = connection.state?.networking?.state?.code ?? 'unknown';
      if (newState?.status === voice.AudioPlayerStatus.Idle && diagnostics) {
        let reason = diagnostics.stopReason || created.current?.stopReason;
        if (!reason) {
          if (diagnostics.playerReadOpusPackets === 0) reason = 'no-opus-packets-read-by-player';
          else if (diagnostics.playerReadOpusPackets < (diagnostics.opusPacketsGenerated || 0)) reason = 'player-idle-before-all-generated-packets-were-read';
          else reason = resource?.playStream?.readableEnded ? 'natural-stream-end' : 'resource-ended-or-playback-stopped';
        }
        console.log(`[MUSIC] guild=${guild.id} tahap=player-idle reason=${reason} voice=${connection.state?.status || 'unknown'} networkingCode=${networkingCode} generatedOpusPackets=${diagnostics.opusPacketsGenerated || 0} generatedOpusBytes=${diagnostics.opusBytes} playerReadOpusPackets=${diagnostics.playerReadOpusPackets} playerReadOpusBytes=${diagnostics.playerReadOpusBytes} invalidPlayerPackets=${diagnostics.invalidPlayerOpusPackets} transportErrors=${diagnostics.transportErrors} preparedPackets=${diagnostics.voicePreparedPackets} dispatchedPackets=${diagnostics.voiceDispatchedPackets} dispatchMisses=${diagnostics.voiceDispatchMisses} resourcePlaybackMs=${resource.playbackDuration ?? 'unknown'}`);
      }
      console.log(`[MUSIC] guild=${guild.id} audio-player-state=${oldState?.status || 'unknown'}->${newState?.status || 'unknown'} voice=${connection.state?.status || 'unknown'} networkingCode=${networkingCode}`);
    });
    player.on(voice.AudioPlayerStatus.Playing, () => {
      const resource = player.state.resource;
      console.log(`[MUSIC] guild=${guild.id} audio-player-state=playing resource=${resource?.playStream?.constructor?.name || 'unknown'} inputType=${resource?.encoder ? 'prism-opus-encoder' : 'unknown'} subscription=${Boolean(created.connectionSubscription)} voice=${connection.state?.status || 'unknown'}; status ini bukan bukti audio terdengar`);
    });
    player.on(voice.AudioPlayerStatus.Idle, () => {
      terminateCurrent(created);
      created.current = null;
      void playNext(created);
    });
    player.on('error', error => {
      if (created.current?.resource?.metadata?.diagnostics) created.current.resource.metadata.diagnostics.stopReason = 'player-error';
      console.error(`[MUSIC] guild=${guild.id} tahap=player error=${sanitizeExtractorError(error.message)}`);
      try {
        Promise.resolve(created.current?.onError?.(new Error('Player audio Discord mengalami error.')))
          .catch(callbackError => console.warn(`[MUSIC] guild=${guild.id} callback error gagal: ${sanitizeExtractorError(callbackError.message)}`));
      } catch (callbackError) {
        console.warn(`[MUSIC] guild=${guild.id} callback error gagal: ${sanitizeExtractorError(callbackError.message)}`);
      }
      terminateCurrent(created);
      created.current = null;
      void playNext(created);
    });
    connection.on('error', error => console.error(`[MUSIC] guild=${guild.id} tahap=voice error=${sanitizeExtractorError(error.message)}`));
    connection.on(voice.VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          voice.entersState(connection, voice.VoiceConnectionStatus.Signalling, 5000),
          voice.entersState(connection, voice.VoiceConnectionStatus.Connecting, 5000)
        ]);
      } catch {
        if (players.get(guild.id) === created) destroyState(created);
      }
    });
    try {
      await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 15000);
      console.log(`[MUSIC] guild=${guild.id} tahap=voice-ready channel=${voiceChannel.id}`);
    } catch (error) {
      destroyState(created);
      throw new Error('Gagal tersambung ke voice channel: ' + error.message);
    }
    return created;
  }


  async function connect(guild, voiceChannel) {
    const existing = connecting.get(guild.id);
    if (existing) {
      const state = await existing;
      if (state.voiceChannelId !== voiceChannel.id) throw new Error('Bot sudah berada di voice channel lain di server ini.');
      return state;
    }
    const promise = createConnection(guild, voiceChannel);
    connecting.set(guild.id, promise);
    try {
      return await promise;
    } finally {
      if (connecting.get(guild.id) === promise) connecting.delete(guild.id);
    }
  }

  function terminateCurrent(state) {
    if (state.current?.process && !state.current.process.killed) state.current.process.kill('SIGTERM');
    state.current?.resource?.playStream?.destroy?.();
  }

  function destroyState(state) {
    if (!state || state.destroyed) return;
    if (state.current?.resource?.metadata?.diagnostics) state.current.resource.metadata.diagnostics.stopReason = 'disconnect';
    state.destroyed = true;
    try { options.onVoiceMonitorEnd?.(state.guildId, state.voiceChannelId); }
    catch (error) { console.warn(`[MUSIC] guild=${state.guildId} voice-monitor cleanup gagal: ${error.message}`); }
    terminateCurrent(state);
    state.queue.length = 0;
    try { state.player.stop(true); }
    catch (error) { console.warn(`[MUSIC] guild=${state.guildId} player cleanup gagal: ${sanitizeExtractorError(error.message)}`); }
    try { state.connection.destroy(); }
    catch (error) { console.warn(`[MUSIC] guild=${state.guildId} voice cleanup gagal: ${sanitizeExtractorError(error.message)}`); }
    if (players.get(state.guildId) === state) players.delete(state.guildId);
  }

  async function playNext(state) {
    if (state.destroyed || state.isStarting || state.current || !state.queue.length) return;
    state.isStarting = true;
    while (!state.destroyed && !state.current && state.queue.length) {
      const entry = state.queue.shift();
      const generation = ++state.generation;
      let child;
      state.starting = entry;
      try {
        const track = entry.track || await resolveTrack(entry.query);
        if (state.destroyed || state.generation !== generation) return;
        entry.track = track;
        console.log(`[MUSIC] guild=${state.guildId} tahap=extractor-start format=webm-opus`);
        child = spawnProcess(ytDlp, ['--no-warnings', '--no-playlist', '--retries', '3', '--fragment-retries', '3', '--extractor-retries', '3', '--format', YTDLP_FORMAT, '--output', '-', track.url], {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        let stderr = '';
        const diagnostics = { inputBytes: 0, opusPackets: 0, pcmBytes: 0, opusBytes: 0, opusPacketsGenerated: 0, playerReadOpusPackets: 0, playerReadOpusBytes: 0, invalidPlayerOpusPackets: 0, voicePreparedPackets: 0, voiceDispatchCalls: 0, voiceDispatchedPackets: 0, voiceDispatchMisses: 0, transportErrors: 0 };
        let failureReported = false;
        const reportFailure = error => {
          const intentionallyCancelled = ['skip', 'stop', 'disconnect'].includes(diagnostics.stopReason);
          if (failureReported || intentionallyCancelled || state.destroyed || state.generation !== generation || state.current !== entry) return;
          failureReported = true;
          diagnostics.stopReason = 'stream-error';
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[MUSIC] guild=${state.guildId} tahap=stream-failed bytes=${diagnostics.inputBytes} opusPackets=${diagnostics.opusPackets} pcmBytes=${diagnostics.pcmBytes} opusBytes=${diagnostics.opusBytes} error=${sanitizeExtractorError(message)}`);
          try {
            Promise.resolve(entry.onError?.(new Error('Audio gagal diunduh atau diproses: ' + sanitizeExtractorError(message))))
              .catch(callbackError => console.warn(`[MUSIC] guild=${state.guildId} callback stream error gagal: ${sanitizeExtractorError(callbackError.message)}`));
          } catch (callbackError) {
            console.warn(`[MUSIC] guild=${state.guildId} callback stream error gagal: ${sanitizeExtractorError(callbackError.message)}`);
          }
          if (state.current === entry) state.player.stop(true);
        };
        const streamTimeout = setTimeout(() => {
          if (!child.killed) child.kill('SIGTERM');
        }, 6 * 60 * 60 * 1000);
        streamTimeout.unref?.();
        child.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk.toString(); });
        const demuxer = new prism.opus.WebmDemuxer();
        const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
        const volume = createPcmVolumeTransformer(() => state.volume);
        const encoder = new prism.opus.Encoder({ frameSize: 960, channels: 2, rate: 48000 });
        child.stdout.on('data', chunk => { diagnostics.inputBytes += chunk.length; });
        demuxer.on('data', () => { diagnostics.opusPackets++; });
        decoder.on('data', chunk => { diagnostics.pcmBytes += chunk.length; });
        // Observe output without a `data` listener: that listener switches the
        // readable encoder to flowing mode and can drain packets before voice reads.
        const encoderPush = encoder.push.bind(encoder);
        encoder.push = (packet, encoding) => {
          if (packet !== null && packet !== undefined) {
            diagnostics.opusPacketsGenerated++;
            diagnostics.opusBytes += Buffer.isBuffer(packet) ? packet.length : 0;
          }
          return encoderPush(packet, encoding);
        };
        for (const [label, stream] of [['demuxer', demuxer], ['decoder', decoder], ['volume', volume], ['encoder', encoder]]) {
          stream.on('error', error => reportFailure(new Error(`${label}: ${error.message}`)));
        }
        const opusStream = encoder;
        const resource = voice.createAudioResource(opusStream, {
          inputType: voice.StreamType.Opus,
          metadata: { ...entry, diagnostics }
        });
        if (typeof resource.read === 'function') {
          const resourceRead = resource.read.bind(resource);
          resource.read = () => {
            const previousDuration = resource.playbackDuration;
            const packet = resourceRead();
            if (resource.playbackDuration > previousDuration && packet !== null && packet !== undefined) {
              if (Buffer.isBuffer(packet) && packet.length > 0 && packet.length <= 1275) {
                diagnostics.playerReadOpusPackets++;
                diagnostics.playerReadOpusBytes += packet.length;
                if (diagnostics.playerReadOpusPackets === 1) {
                  console.log(`[MUSIC] guild=${state.guildId} tahap=player-read-opus packetBytes=${packet.length} resourceInputType=Opus`);
                }
              } else {
                diagnostics.invalidPlayerOpusPackets++;
                console.error(`[MUSIC] guild=${state.guildId} tahap=invalid-player-packet type=${packet?.constructor?.name || typeof packet} bytes=${Buffer.isBuffer(packet) ? packet.length : 'unknown'}`);
              }
            }
            return packet;
          };
        }
        entry.process = child;
        entry.resource = resource;
        entry.track = track;
        state.current = entry;
        state.starting = null;
        state.isStarting = false;
        child.once('close', code => {
          clearTimeout(streamTimeout);
          if (code !== 0 && state.current === entry) {
            reportFailure(new Error('yt-dlp keluar dengan kode ' + code + ': ' + sanitizeExtractorError(stderr)));
          }
        });
        child.once('error', error => reportFailure(new Error('yt-dlp: ' + error.message)));
        pipeline(child.stdout, demuxer, decoder, volume, encoder, error => {
          clearTimeout(streamTimeout);
          if (error) {
            reportFailure(new Error('pipeline: ' + error.message));
          } else if (state.current === entry && (diagnostics.inputBytes === 0 || diagnostics.opusPackets === 0 || diagnostics.pcmBytes === 0 || diagnostics.opusBytes === 0)) {
            reportFailure(new Error('Stream berakhir tanpa data audio Opus yang valid.'));
          } else if (state.current === entry) {
            console.log(`[MUSIC] guild=${state.guildId} tahap=stream-end inputBytes=${diagnostics.inputBytes} demuxOpusPackets=${diagnostics.opusPackets} pcmBytes=${diagnostics.pcmBytes} generatedOpusPackets=${diagnostics.opusPacketsGenerated} generatedOpusBytes=${diagnostics.opusBytes}; player/voice counters dicatat terpisah`);
          }
        });
        console.log(`[MUSIC] guild=${state.guildId} tahap=resource-created input=WebM/Opus output=Opus inlineVolume=false volume=${state.volume}%`);
        state.player.play(resource);
        console.log(`[MUSIC] guild=${state.guildId} tahap=player-play status=${state.player.state.status} subscription=${Boolean(state.connectionSubscription)}`);
        return;
      } catch (error) {
        if (child && !child.killed) child.kill('SIGTERM');
        if (state.destroyed || state.generation !== generation) return;
        state.starting = null;
        console.error(`[MUSIC] guild=${state.guildId} tahap=track-setup-failed error=${sanitizeExtractorError(error.message)}`);
        if (entry.onError) entry.onError(error);
      }
    }
    state.starting = null;
    state.isStarting = false;
  }

  async function enqueue(guild, voiceChannel, query, requester, callbacks = {}) {
    const track = await resolveTrack(query);
    await assertCompatibleAudioExtractor();
    const state = await connect(guild, voiceChannel);
    if (state.queue.length >= MAX_QUEUE_SIZE) throw new Error('Antrean server penuh (maksimal 100 lagu menunggu).');
    const entry = { track, query: track.query, requester: requester.tag || requester.username || requester.id, requesterId: requester.id, onError: callbacks.onError };
    const position = state.queue.length + (state.current || state.isStarting ? 2 : 1);
    state.queue.push(entry);
    if (!state.current && !state.isStarting) void playNext(state);
    return { track, position, state };
  }

  function makeSavedEntry(saved, requester) {
    const parsedSavedUrl = saved.url ? parseSupportedUrl(saved.url) : null;
    if (saved.url && parsedSavedUrl?.type !== 'youtube') throw new Error('URL tersimpan pada playlist bukan URL YouTube yang valid.');
    return {
      track: parsedSavedUrl ? {
        query: saved.query,
        title: saved.title,
        artist: saved.artist || '',
        url: parsedSavedUrl.url,
        webpageUrl: parsedSavedUrl.url,
        spotifyUrl: saved.spotifyUrl || null,
        duration: saved.duration || null
      } : null,
      query: saved.query || saved.title,
      requester: requester.tag || requester.username || requester.id,
      requesterId: requester.id
    };
  }

  async function enqueueSavedMany(guild, voiceChannel, savedItems, requester) {
    if (!Array.isArray(savedItems) || !savedItems.length) throw new Error('Tidak ada lagu untuk dimasukkan ke antrean.');
    const entries = savedItems.map(saved => makeSavedEntry(saved, requester));
    await assertCompatibleAudioExtractor();
    const state = await connect(guild, voiceChannel);
    if (state.queue.length + entries.length > MAX_QUEUE_SIZE) throw new Error('Antrean server penuh; maksimal ada 100 lagu menunggu.');
    state.queue.push(...entries);
    if (!state.current && !state.isStarting) void playNext(state);
    return entries;
  }

  async function enqueueSaved(guild, voiceChannel, saved, requester) {
    return (await enqueueSavedMany(guild, voiceChannel, [saved], requester))[0];
  }

  function pause(guildId) {
    const state = stateFor(guildId);
    if (!state?.current) throw new Error('Tidak ada lagu yang sedang diputar.');
    if (!state.player.pause()) throw new Error('Player tidak dapat dijeda pada status saat ini.');
  }
  function resume(guildId) {
    const state = stateFor(guildId);
    if (!state?.current) throw new Error('Tidak ada lagu yang dapat dilanjutkan.');
    if (!state.player.unpause()) throw new Error('Player tidak sedang dijeda.');
  }
  function skip(guildId) {
    const state = stateFor(guildId);
    if (!state?.current) throw new Error(state?.starting ? 'Lagu masih disiapkan; coba skip lagi setelah pemutaran mulai.' : 'Tidak ada lagu yang sedang diputar.');
    if (state.current?.resource?.metadata?.diagnostics) state.current.resource.metadata.diagnostics.stopReason = 'skip';
    state.player.stop(true);
  }
  function stop(guildId) {
    const state = stateFor(guildId);
    if (!state) return false;
    state.queue.length = 0;
    state.generation++;
    state.isStarting = false;
    state.starting = null;
    if (state.current?.resource?.metadata?.diagnostics) state.current.resource.metadata.diagnostics.stopReason = 'stop';
    terminateCurrent(state);
    state.current = null;
    state.player.stop(true);
    return true;
  }
  function disconnect(guildId) {
    const state = stateFor(guildId);
    if (!state) return false;
    destroyState(state);
    return true;
  }
  function setVolume(guildId, percent) {
    if (!Number.isInteger(percent) || percent < 0 || percent > 200) throw new Error('Volume harus bilangan bulat 0–200%.');
    const state = stateFor(guildId);
    if (!state) throw new Error('Bot belum bergabung ke voice channel. Jalankan /play terlebih dahulu.');
    state.volume = percent;
    return state.volume;
  }
  function getSnapshot(guildId) {
    const state = stateFor(guildId);
    if (!state) return { current: null, queue: [], volume: null, voiceChannelId: null, paused: false };
    return {
      current: state.current || state.starting,
      queue: [...state.queue],
      volume: state.volume,
      voiceChannelId: state.voiceChannelId,
      paused: state.player.state.status === voice.AudioPlayerStatus.Paused
    };
  }
  function cleanup() { for (const state of players.values()) destroyState(state); }

  return { players, resolveTrack, enqueue, enqueueSaved, enqueueSavedMany, pause, resume, skip, stop, disconnect, setVolume, getSnapshot, cleanup };
}

module.exports = { createMusicManager, parseSupportedUrl, formatDuration, isYouTubeWebpage, createPcmVolumeTransformer, MAX_QUERY_LENGTH, MAX_QUEUE_SIZE, MIN_YTDLP_403_FIX, DEFAULT_YTDLP_PATH };
