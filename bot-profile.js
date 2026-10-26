'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff') ||
      normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.') ||
      normalized.startsWith('::ffff:192.168.');
  }
  return true;
}

async function fetchAvatar(urlInput, fetchImpl = globalThis.fetch) {
  let url;
  try { url = new URL(urlInput); } catch { throw new Error('URL avatar tidak valid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    throw new Error('Avatar harus menggunakan URL HTTPS publik yang valid.');
  }
  if (net.isIP(url.hostname) && isPrivateAddress(url.hostname)) throw new Error('Alamat IP privat tidak diizinkan.');
  let addresses;
  try { addresses = await dns.lookup(url.hostname, { all: true, verbatim: true }); }
  catch { throw new Error('Host URL avatar tidak dapat ditemukan.'); }
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error('URL avatar mengarah ke alamat internal yang tidak diizinkan.');
  }
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch (error) {
    throw new Error('Gagal mengambil URL avatar: ' + error.message);
  }
  if (!response.ok) throw new Error('Server avatar membalas HTTP ' + response.status + '.');
  const declaredType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(declaredType)) {
    throw new Error('Avatar harus berupa PNG, JPEG, GIF, atau WebP.');
  }
  const declaredSize = Number(response.headers.get('content-length'));
  const maxBytes = 8 * 1024 * 1024;
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) throw new Error('Ukuran avatar melebihi batas 8 MB.');
  const chunks = [];
  let length = 0;
  if (!response.body) throw new Error('Respons avatar tidak memiliki data gambar.');
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Ukuran avatar melebihi batas 8 MB.');
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const valid =
    (declaredType === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
    (declaredType === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    (declaredType === 'image/gif' && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString())) ||
    (declaredType === 'image/webp' && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP');
  if (!valid) throw new Error('Isi file tidak cocok dengan tipe gambar yang dinyatakan.');
  return buffer;
}

module.exports = { fetchAvatar, isPrivateAddress };
