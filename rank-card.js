'use strict';

const { fetchAvatar } = require('./bot-profile');

const WIDTH = 1000;
const HEIGHT = 320;

function fitText(ctx, text, maxWidth, startSize, weight = 600) {
  let size = startSize;
  while (size > 16) {
    ctx.font = `${weight} ${size}px Roboto, sans-serif`;
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
    ctx.font = '700 54px Roboto, sans-serif';
    ctx.fillText(initials, centerX, centerY);
  }
  ctx.restore();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#c4b5fd';
  ctx.font = '700 17px Roboto, sans-serif';
  ctx.fillText('N I G H T M A R E   /   MEMBER ARCHIVE', 326, 43);

  const username = String(data.username || 'Member').slice(0, 80);
  const usernameSize = fitText(ctx, username, 600, 40, 700);
  ctx.font = `700 ${usernameSize}px Roboto, sans-serif`;
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
  ctx.fillText(`${data.stats.currentLevelXp.toLocaleString('en-US')} / ${data.stats.xpToNextLevel.toLocaleString('en-US')} XP TO NEXT LEVEL`, barX, 211);
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
  return drawCard({ ...data, avatar }, { canvas });
}

async function renderRankCardSafely(data, options = {}) {
  try {
    return { buffer: await renderRankCard(data, options), error: null };
  } catch (error) {
    return { buffer: null, error };
  }
}

module.exports = { renderRankCard, renderRankCardSafely, WIDTH, HEIGHT };
