'use strict';

const EMBED_DESCRIPTION_LIMIT = 4_000;
const MAX_PANEL_REWARDS = 25;

function buildRewardLines(rewards, resolveRole) {
  return [...rewards]
    .sort((a, b) => a.level - b.level)
    .slice(0, MAX_PANEL_REWARDS)
    .map(item => {
      const role = resolveRole(item.roleId);
      return role
        ? `**Level ${item.level}** → <@&${item.roleId}>`
        : `**Level ${item.level}** → role sudah dihapus (ID: ${item.roleId})`;
    });
}

function buildLevelRolePanel(rewards, resolveRole) {
  const lines = buildRewardLines(rewards, resolveRole);
  const description = lines.length
    ? lines.join('\n').slice(0, EMBED_DESCRIPTION_LIMIT)
    : 'Belum ada milestone role yang dikonfigurasi oleh administrator.';
  return {
    color: 0x4c1d95,
    title: 'Nightmare • Level Roles',
    description: `${description}\n\nRole diberikan otomatis saat kamu mencapai milestone. Tidak perlu menekan reaction.`,
    footer: { text: 'Nightmare · Leveling Milestones' }
  };
}

function buildLevelRoleList(rewards, resolveRole) {
  return buildRewardLines(rewards, resolveRole);
}

function buildProgressBar(progress, width = 10) {
  const safeProgress = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const filled = Math.round(safeProgress * width);
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)}`;
}

module.exports = {
  buildRewardLines,
  buildLevelRolePanel,
  buildLevelRoleList,
  buildProgressBar,
  EMBED_DESCRIPTION_LIMIT,
  MAX_PANEL_REWARDS
};
