'use strict';

async function searchLyrics(song, artist = '', options = {}) {
  const cleanSong = typeof song === 'string' ? song.trim() : '';
  const cleanArtist = typeof artist === 'string' ? artist.trim() : '';
  if (!cleanSong || cleanSong.length > 150) throw new Error('Judul lagu wajib diisi (maksimal 150 karakter).');
  if (cleanArtist.length > 100) throw new Error('Nama artis maksimal 100 karakter.');
  const token = options.token ?? process.env.GENIUS_ACCESS_TOKEN;
  if (!token) throw new Error('Pencarian lirik memerlukan GENIUS_ACCESS_TOKEN di .env. Command hanya mengirim judul/artis dan menautkan halaman resmi; lirik tidak disalin.');
  const fetchImpl = options.fetch || globalThis.fetch;
  const query = [cleanSong, cleanArtist].filter(Boolean).join(' ');
  let response;
  try {
    response = await fetchImpl('https://api.genius.com/search?q=' + encodeURIComponent(query), {
      headers: { accept: 'application/json', authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(10000),
      redirect: 'error'
    });
  } catch (error) {
    throw new Error('Genius API tidak dapat dihubungi: ' + error.message);
  }
  if (!response.ok) throw new Error('Genius API membalas HTTP ' + response.status + '. Periksa token atau rate limit.');
  const payload = await response.json();
  const hits = payload?.response?.hits;
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const songKey = cleanSong.toLocaleLowerCase('en');
  const artistKey = cleanArtist.toLocaleLowerCase('en');
  const selected = hits.find(hit => {
    const result = hit?.result;
    return result && String(result.title || '').toLocaleLowerCase('en') === songKey &&
      (!artistKey || String(result.primary_artist?.name || '').toLocaleLowerCase('en').includes(artistKey));
  }) || hits.find(hit => hit?.result?.url);
  const result = selected?.result;
  if (!result || !/^https:\/\/genius\.com\//.test(result.url || '')) return null;
  return {
    title: String(result.title || cleanSong).slice(0, 200).replace(/@/g, '@\u200b'),
    artist: String(result.primary_artist?.name || cleanArtist || 'Tidak diketahui').slice(0, 120).replace(/@/g, '@\u200b'),
    source: 'Genius',
    url: result.url
  };
}

module.exports = { searchLyrics };
