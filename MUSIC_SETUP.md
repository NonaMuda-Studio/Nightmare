# Music, lyrics, and bot profile setup

## Music runtime

- Node.js 22.12 or newer for `@discordjs/voice` 0.19.2. The current Termux runtime is Node v24.17.0.
- `yt-dlp` **2026.08.19 or newer** for YouTube metadata/search and audio streaming. Set `YTDLP_PATH` in the process environment or `.env`; the Termux default is `/data/data/com.termux/files/home/yt-dlp-venv/bin/yt-dlp`. The bot rejects older versions before joining voice because they can return metadata while their YouTube audio download fails with HTTP 403.
- Bot voice permissions: Connect and Speak in the target voice channel. The user invoking playback must be in that same channel.
- `prism-media` demuxes WebM/Opus; `opusscript` provides the JavaScript Opus decoder/encoder and avoids a Termux native build.
- This pipeline does **not** need FFmpeg. It requests YouTube's WebM/Opus audio format specifically, decodes it in JavaScript, applies per-guild volume, then encodes Opus for Discord. A video without that format fails with a clear source error. The pure JavaScript codec uses more CPU than a native Opus module, so monitor load on low-powered Termux devices.

The Termux executable in this workspace is `yt-dlp` 2026.06.09, below the required minimum. A direct public-video diagnostic found available Opus/WebM (249/251) and AAC/M4A (139/140) formats, but each tested audio download returned HTTP 403 with 0 bytes. Upstream marks the matching `android_vr` 403 issue fixed in 2026.08.19; update yt-dlp using the same installation method before testing playback. FFmpeg currently fails to load because of a Termux dynamic-linker error, but the selected WebM/Opus path does not invoke FFmpeg. Actual Discord voice playback remains unverified until a live server test succeeds.

## Lyrics

`/lyrics` uses the official Genius search API and only returns a matched title, artist, and Genius page link; it does not copy lyrics into Discord. Create a Genius API client and add this variable to the existing `.env` without replacing other values:

```env
GENIUS_ACCESS_TOKEN=your_genius_client_access_token
```

The bot does not log or expose this token. If it is missing, `/lyrics` explains how to configure it.

## Storage and commands

Server playlists are stored in `data/playlists.json`, isolated by guild ID and written with an atomic rename. That file is created on the first playlist mutation. Music queues and player controls are per guild and are intentionally in memory; they are cleared when the bot stops. Profile edits are global Discord bot account changes and are limited by Discord API rate limits. `/botprofile reset` restores the application name and icon when an icon is configured; otherwise it resets the name only.
