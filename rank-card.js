'use strict';

const { fetchAvatar } = require('./bot-profile');
const { GlobalFonts } = require('@napi-rs/canvas');
const path = require('node:path');

const WIDTH = 1000;
const HEIGHT = 320;
const UNICODE_FONT_FAMILY = 'Noto Sans Symbols';
const UNICODE_FONT_PATH = path.join(__dirname, 'assets', 'fonts', 'NotoSansSymbols-Regular.ttf');
const unicodeFontKey = GlobalFonts.registerFromPath(UNICODE_FONT_PATH, UNICODE_FONT_FAMILY);
if (!unicodeFontKey) {
  throw new Error(`Rank card Unicode font could not be registered: ${UNICODE_FONT_PATH}`);
}
const USERNAME_FONT_FAMILY = `Roboto, "${UNICODE_FONT_FAMILY}", sans-serif`;

function fitText(ctx, text, maxWidth, startSize, weight = 600) {
  let size = startSize;
  while (size > 16) {
    ctx.font = `${weight} ${size}px ${USERNAME_FONT_FAMILY}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

function drawCard(data, dependencies) {
  const { createCanvas } = dependencies.canvas;
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  const background = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  background.addColorStop(0, '#10091d');
  background.addColorStop(0.55, '#21103a');
  background.addColorStop(1, '#080711');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Original angular sigil, thin runic rails, and violet highlights.
  ctx.save();
  ctx.globalAlpha = 0.32;
  ctx.strokeStyle = '#a855f7';
  ctx.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(680 + i * 58, 0);
    ctx.lineTo(520 + i * 58, HEIGHT);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(850, 160, 120, 0, Math.PI * 2);
  ctx.arc(850, 160, 105, 0, Math.PI * 2);
  ctx.moveTo(850, 26); ctx.lineTo(850, 294);
  ctx.moveTo(716, 160); ctx.lineTo(984, 160);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = 'rgba(5, 4, 12, 0.55)';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = '#8b5cf6';
  ctx.lineWidth = 2;
  ctx.strokeRect(12, 12, WIDTH - 24, HEIGHT - 24);
  ctx.strokeStyle = 'rgba(216, 180, 254, 0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(292, 40); ctx.lineTo(292, 280);
  ctx.moveTo(316, 58); ctx.lineTo(960, 58);
  ctx.stroke();

  const centerX = 160;
  const centerY = 160;
  const radius = 88;
  ctx.save();
  ctx.shadowColor = '#a855f7';
  ctx.shadowBlur = 25;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius + 8, 0, Math.PI * 2);
  ctx.fillStyle = '#8b5cf6';
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.clip();
  if (data.avatar) {
    ctx.drawImage(data.avatar, centerX - radius, centerY - radius, radius * 2, radius * 2);
  } else {
    ctx.fillStyle = '#2e1748';
    ctx.fillRect(centerX - radius, centerY - radius, radius * 2, radius * 2);
    const initials = String(data.username || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || '?';
    ctx.fillStyle = '#f3e8ff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 54px ${USERNAME_FONT_FAMILY}`;
    ctx.fillText(initials, centerX, centerY);
  }
  ctx.restore();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#c4b5fd';
  ctx.font = '700 17px Roboto, sans-serif';
  ctx.fillText('N I G H T M A R E   /   MEMBER ARCHIVE', 326, 43);

  const username = Array.from(String(data.username || 'Member')).slice(0, 80).join('');
  const usernameSize = fitText(ctx, username, 600, 40, 700);
  ctx.font = `700 ${usernameSize}px ${USERNAME_FONT_FAMILY}`;
  ctx.fillStyle = '#faf5ff';
  ctx.fillText(username, 326, 105);

  ctx.fillStyle = '#a78bfa';
  ctx.font = '600 17px Roboto, sans-serif';
  ctx.fillText(`LEVEL ${data.stats.level}`, 326, 150);
  ctx.fillStyle = '#e9d5ff';
  ctx.font = '700 25px Roboto, sans-serif';
  ctx.fillText(`${data.stats.totalXp.toLocaleString('en-US')} XP`, 326, 184);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#c4b5fd';
  ctx.font = '700 15px Roboto, sans-serif';
  ctx.fillText('SERVER RANK', 948, 91);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 34px Roboto, sans-serif';
  ctx.fillText(data.rank ? `#${data.rank}` : '—', 948, 130);

  const barX = 326;
  const barY = 222;
  const barWidth = 622;
  const barHeight = 20;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#d8b4fe';
  ctx.font = '600 15px Roboto, sans-serif';
  const progressLabel = data.stats.level >= 9999
    ? 'MAX LEVEL · XP WILL KEEP ACCUMULATING'
    : `${data.stats.currentLevelXp.toLocaleString('en-US')} / ${data.stats.xpToNextLevel.toLocaleString('en-US')} XP TO NEXT LEVEL`;
  ctx.fillText(progressLabel, barX, 211);
  ctx.fillStyle = '#302044';
  ctx.fillRect(barX, barY, barWidth, barHeight);
  const progress = Math.max(0, Math.min(1, data.stats.progress));
  if (progress > 0) {
    const fill = ctx.createLinearGradient(barX, 0, barX + barWidth, 0);
    fill.addColorStop(0, '#7c3aed');
    fill.addColorStop(1, '#d8b4fe');
    ctx.fillStyle = fill;
    ctx.fillRect(barX, barY, Math.max(3, barWidth * progress), barHeight);
  }
  ctx.strokeStyle = 'rgba(233, 213, 255, 0.8)';
  ctx.lineWidth = 1;
  ctx.strokeRect(barX, barY, barWidth, barHeight);

  ctx.fillStyle = '#8b5cf6';
  ctx.beginPath();
  ctx.moveTo(326, 270); ctx.lineTo(338, 258); ctx.lineTo(350, 270); ctx.lineTo(338, 282); ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#c4b5fd';
  ctx.font = '600 14px Roboto, sans-serif';
  ctx.fillText('RISE THROUGH THE VEIL', 362, 275);
  return canvas.toBuffer('image/png');
}

function drawLevelUpCard(data, dependencies) {
  const { createCanvas } = dependencies.canvas;
  const canvas = createCanvas(1200, 675);
  const ctx = canvas.getContext('2d');
  const paper = ctx.createLinearGradient(0, 0, 1200, 675);
  paper.addColorStop(0, '#f7edcf');
  paper.addColorStop(0.52, '#ead8aa');
  paper.addColorStop(1, '#d9c18d');
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, 1200, 675);

  // Restrained parchment grain and double frame, matching the Guild's violet/gold identity.
  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = '#6d4d2d';
  ctx.lineWidth = 1;
  for (let y = 28; y < 675; y += 24) {
    ctx.beginPath();
    ctx.moveTo(24, y);
    ctx.lineTo(1176, y + 5);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = '#b68b35';
  ctx.lineWidth = 4;
  ctx.strokeRect(18, 18, 1164, 639);
  ctx.strokeStyle = '#39204f';
  ctx.lineWidth = 2;
  ctx.strokeRect(29, 29, 1142, 617);
  ctx.fillStyle = '#39204f';
  ctx.fillRect(438, 48, 3, 579);

  const avatarX = 226;
  const avatarY = 278;
  const radius = 132;
  ctx.save();
  ctx.shadowColor = 'rgba(57, 32, 79, 0.35)';
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, radius + 9, 0, Math.PI * 2);
  ctx.fillStyle = '#b68b35';
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, radius, 0, Math.PI * 2);
  ctx.clip();
  if (data.avatar) {
    ctx.drawImage(data.avatar, avatarX - radius, avatarY - radius, radius * 2, radius * 2);
  } else {
    ctx.fillStyle = '#39204f';
    ctx.fillRect(avatarX - radius, avatarY - radius, radius * 2, radius * 2);
    const initials = String(data.username || '?').trim().split(/\s+/).slice(0, 2)
      .map(part => part[0] || '').join('').toUpperCase() || '?';
    ctx.fillStyle = '#f7edcf';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 72px ${USERNAME_FONT_FAMILY}`;
    ctx.fillText(initials, avatarX, avatarY);
  }
  ctx.restore();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#39204f';
  ctx.font = `700 ${fitText(ctx, String(data.username || 'Petualang'), 350, 31, 700)}px ${USERNAME_FONT_FAMILY}`;
  ctx.fillText(String(data.username || 'Petualang').slice(0, 48), avatarX, 465);
  ctx.fillStyle = '#795a25';
  ctx.font = '600 17px Roboto, sans-serif';
  ctx.fillText('NIGHTMARE ADVENTURERS GUILD', avatarX, 505);
  ctx.fillStyle = '#39204f';
  ctx.font = '600 14px Roboto, sans-serif';
  ctx.fillText('PETUALANG TERDAFTAR', avatarX, 535);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#39204f';
  ctx.font = `700 34px ${USERNAME_FONT_FAMILY}`;
  ctx.fillText('🔔 SISTEM 🔔', 810, 108);
  ctx.strokeStyle = '#b68b35';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(500, 132);
  ctx.lineTo(1120, 132);
  ctx.stroke();

  ctx.fillStyle = '#72521e';
  ctx.font = '700 18px Roboto, sans-serif';
  ctx.fillText('LEVEL TERBARU', 810, 180);
  ctx.fillStyle = '#39204f';
  ctx.font = '700 72px Roboto, sans-serif';
  ctx.fillText(String(data.level), 810, 257);

  const emblemX = 1005;
  const emblemY = 370;
  ctx.beginPath();
  ctx.arc(emblemX, emblemY, 68, 0, Math.PI * 2);
  ctx.fillStyle = '#39204f';
  ctx.fill();
  ctx.strokeStyle = '#b68b35';
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.fillStyle = '#f7edcf';
  ctx.textAlign = 'center';
  ctx.font = `700 ${fitText(ctx, String(data.adventurerRank || '—'), 112, 42, 700)}px ${USERNAME_FONT_FAMILY}`;
  ctx.fillText(String(data.adventurerRank || '—'), emblemX, emblemY + 12);
  ctx.fillStyle = '#72521e';
  ctx.font = '600 13px Roboto, sans-serif';
  ctx.fillText('RANK PETUALANG', emblemX, emblemY + 94);
  ctx.fillStyle = '#39204f';
  ctx.font = `600 ${fitText(ctx, `LEADERBOARD ${data.serverRankLabel || '—'}`, 180, 13, 600)}px Roboto, sans-serif`;
  ctx.fillText(`LEADERBOARD ${data.serverRankLabel || '—'}`, emblemX, emblemY + 119);

  const message = String(data.message || 'Selamat atas level barumu!');
  const words = message.split(/\s+/);
  const lines = [];
  let line = '';
  ctx.font = `600 25px ${USERNAME_FONT_FAMILY}`;
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > 440) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#39204f';
  ctx.font = `600 25px ${USERNAME_FONT_FAMILY}`;
  lines.slice(0, 6).forEach((text, index) => ctx.fillText(text, 500, 337 + index * 39));

  ctx.fillStyle = '#795a25';
  ctx.font = '600 15px Roboto, sans-serif';
  ctx.fillText('NIGHTMARE • ADVENTURER RECORD', 500, 594);
  return canvas.toBuffer('image/png');
}

async function renderRankCard(data, options = {}) {
  const canvas = options.canvas || require('@napi-rs/canvas');
  const imageLoader = options.loadImage || canvas.loadImage;
  const avatarFetcher = options.fetchAvatar || fetchAvatar;
  let avatar = null;
  if (data.avatarUrl) {
    try {
      const bytes = await avatarFetcher(data.avatarUrl);
      avatar = await imageLoader(bytes);
    } catch {
      // Avatar failure should not prevent a rank card from rendering.
    }
  }
  const prepared = { ...data, avatar };
  return data.variant === 'level-up'
    ? drawLevelUpCard(prepared, { canvas })
    : drawCard(prepared, { canvas });
}

async function renderRankCardSafely(data, options = {}) {
  try {
    return { buffer: await renderRankCard(data, options), error: null };
  } catch (error) {
    return { buffer: null, error };
  }
}

module.exports = { renderRankCard, renderRankCardSafely, WIDTH, HEIGHT, UNICODE_FONT_FAMILY };
