# Music, lyrics, and bot profile setup

## Music runtime

- Node.js 22.12 or newer for `@discordjs/voice` 0.19.2. The verified Termux runtime is Node v24.22.1.
- `yt-dlp` **2026.08.19 or newer** for YouTube metadata/search and audio streaming. Set `YTDLP_PATH` in the process environment or `.env` to override the default Termux executable `/data/data/com.termux/files/usr/bin/yt-dlp`. The bot rejects older versions before joining voice because they can return metadata while their YouTube audio download fails with HTTP 403.
- Bot voice permissions: Connect and Speak in the target voice channel. The user invoking playback must be in that same channel.
- `prism-media` demuxes WebM/Opus; `opusscript` provides the JavaScript Opus decoder/encoder and avoids a Termux native build.
- This pipeline does **not** need FFmpeg. It requests YouTube's WebM/Opus audio format specifically, decodes it in JavaScript, applies per-guild volume, then encodes Opus for Discord. A video without that format fails with a clear source error. The pure JavaScript codec uses more CPU than a native Opus module, so monitor load on low-powered Termux devices.

The currently verified Termux executable is `/data/data/com.termux/files/usr/bin/yt-dlp`, version `2026.10.26`; the code minimum is `2026.08.19`, so this installed version exceeds it. An earlier public-video diagnostic was run with the then-installed `2026.06.09`: it found Opus/WebM (249/251) and AAC/M4A (139/140) formats, but each tested audio download returned HTTP 403 with 0 bytes. That result is historical and does not establish the download status of the current version. The matching upstream `android_vr` 403 issue was marked fixed in `2026.08.19`. FFmpeg was not found in the executable PATH during the radio audit; an earlier runtime note reported a Termux dynamic-linker failure. The selected WebM/Opus music path does not invoke FFmpeg. Direct Discord voice playback has not been verified; tests with mocks do not prove that listeners receive audio.

## Lyrics

`/lyrics` uses the official Genius search API and only returns a matched title, artist, and Genius page link; it does not copy lyrics into Discord. Create a Genius API client and add this variable to the existing `.env` without replacing other values:

```env
GENIUS_ACCESS_TOKEN=your_genius_client_access_token
```

The bot does not log or expose this token. If it is missing, `/lyrics` explains how to configure it.

## Storage and commands

Server playlists are stored in `data/playlists.json`, isolated by guild ID and written with an atomic rename. That file is created on the first playlist mutation. Music queues and player controls are per guild and are intentionally in memory; they are cleared when the bot stops. Profile edits are global Discord bot account changes and are limited by Discord API rate limits. `/botprofile reset` restores the application name and icon when an icon is configured; otherwise it resets the name only.

## Radio mode status

The local slash-command schema now includes `/radio status`, `/radio station name:<stasiun>`, `/radio move mode:music`, and `/music move mode:radio`. Mode changes and station selection require Manage Server or Administrator at execution time. They use the existing per-guild Music Engine, voice connection, and AudioPlayer. There is no second player or voice subsystem.

Radio playback is intentionally unavailable until a source adapter and its Discord voice rebroadcast permission are verified and configured. The four stable IDs (`study-lofi`, `sleep-lofi`, `anime-lofi`, `jazz-lofi`) are currently marked unavailable and contain no stream URLs. `/radio station` saves the preferred station even while its source is unavailable; `/music move mode:radio` refuses to start. `/radio status` exposes `source_not_configured` and a human-readable explanation while no adapter is installed, and no stream is presented as playing. If a station is changed during Radio Mode while its source is unavailable, the selection is retained and the old radio session is stopped. The adapter contract is `open({ guildId, voiceChannelId, signal }) -> { stream, destroy? }`, where `stream` is a Readable of raw signed 16-bit little-endian PCM at 48 kHz stereo. The shared engine applies per-guild volume and Opus encoding using its existing AudioPlayer and voice connection; adapters must not create another player or connection. The current engine's YouTube WebM/Opus pipeline is not an HLS adapter. `ffmpeg` is not a project dependency and was not found in PATH during the prior audit, so no HLS path is enabled.

Radio preferences are stored per guild in `data/radio.json` using versioned JSON and atomic temporary-file rename, separate from `data/playlists.json`. The record contains desired mode, last station, last voice channel, auto-reconnect intent, and update time. This follows the project's single-process local-store pattern; atomic rename does not make concurrent bot processes safe. Music queues remain memory-only, while playlist definitions remain persisted as before.

When a verified adapter is configured, mode transitions are serialized per guild and use a generation token plus abort signal to prevent a delayed source from starting after a mode change. Startup restoration uses the same gate: it requires saved mode `radio`, `autoReconnect`, a verified/configured adapter, and the saved voice channel. Saved `off` and music intent never start radio. Switching to radio returns the interrupted music track to the queue head; switching back stops radio and resumes the queue from the start of that track. The song's playback timestamp is not retained. `/pause` and `/resume` are music-only, `/skip` rejects radio because it is continuous, and `/stop` rejects radio so it cannot accidentally clear the saved music queue. `/volume` uses the shared PCM volume transform. `/dc` disconnects and persists mode `off`, disabling automatic reconnect until radio is explicitly started again.

Stream interruption retries use exponential backoff and stop after five retries; recoverable voice disconnects also use bounded exponential retries and preserve the in-memory music queue. On startup, saved radio intent is considered only if the station is configured as available, the guild and voice channel still exist, and the bot has Connect and Speak; startup restoration is bounded to five attempts. If a channel or permission check fails, the saved preference is retained without joining. A Node process, host, network, and Discord voice session must remain available for continuous playback. Termux/Android may suspend or kill the process, so “24/7” is best effort and restart recovery cannot provide audio while the bot is offline.

### Source and license gate

No reviewed provider is currently configured. MUGEN Radio publishes an HLS `.m3u8` URL and describes non-commercial use under CC BY-NC 4.0 with attribution, but its published license examples cover specific online platforms or physical locations; they do not explicitly confirm Discord voice bot rebroadcast. Obtain written permission for this use and verify HLS codecs/availability before enabling an adapter. SomaFM's current terms prohibit new third-party clients and restreaming without explicit prior permission; Lofi Girl's published platform list does not include Discord voice. These are not configured as sources.
