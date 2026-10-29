'use strict';

// Stable IDs are persisted in Economy inventory; labels may be edited independently.
const ITEMS = [
  ['health_potion', 'Health Potion', 'Pulihkan 30 HP di Adventure.', 100, 40, 'consumable', 'common', 'F', { heal: 30 }],
  ['greater_health_potion', 'Greater Health Potion', 'Pulihkan 70 HP di Adventure.', 260, 100, 'consumable', 'uncommon', 'E', { heal: 70 }],
  ['mana_potion', 'Mana Potion', 'Ramuan mana; menunggu sistem mana.', 120, 48, 'consumable', 'common', 'F', {}],
  ['strength_potion', 'Strength Potion', 'Tambah 5 serangan selama 3 giliran.', 240, 96, 'consumable', 'uncommon', 'E', { attack: 5, turns: 3 }],
  ['defense_potion', 'Defense Potion', 'Tambah 5 pertahanan selama 3 giliran.', 240, 96, 'consumable', 'uncommon', 'E', { defense: 5, turns: 3 }],
  ['monster_bait', 'Monster Bait', 'Dikonsumsi saat hunt dimulai; +1 loot katalog jika menang.', 60, 24, 'adventure', 'common', 'F', { huntBonus: 1 }],
  ['magic_wand', 'Magic Wand', 'Tongkat sihir dasar; bonus sihir +4.', 500, 200, 'weapon', 'uncommon', 'E', { attack: 4, magic: 4 }],
  ['magic_staff', 'Magic Staff', 'Tongkat sihir kuat; bonus sihir +8.', 1100, 440, 'weapon', 'rare', 'C', { attack: 7, magic: 8 }],
  ['spell_tome', 'Spell Tome', 'Tome sihir; bonus sihir +5.', 750, 300, 'accessory', 'rare', 'D', { magic: 5 }],
  ['magic_crystal', 'Magic Crystal', 'Kristal untuk crafting dan sihir.', 180, 72, 'material', 'uncommon', 'F', {}],
  ['mage_robe', 'Mage Robe', 'Jubah ringan; pertahanan +4.', 650, 260, 'armor', 'uncommon', 'E', { defense: 4 }],
  ['enchanted_ring', 'Enchanted Ring', 'Cincin sihir; serangan +2 dan sihir +3.', 900, 360, 'accessory', 'rare', 'D', { attack: 2, magic: 3 }],
  ['magic_shield', 'Magic Shield', 'Perisai sihir; pertahanan +8.', 850, 340, 'armor', 'rare', 'D', { defense: 8, mitigation: 2 }],
  ['iron_sword', 'Iron Sword', 'Pedang besi; serangan +5.', 350, 140, 'weapon', 'common', 'F', { attack: 5 }],
  ['steel_sword', 'Steel Sword', 'Pedang baja; serangan +9.', 800, 320, 'weapon', 'uncommon', 'D', { attack: 9 }],
  ['enchanted_sword', 'Enchanted Sword', 'Pedang sihir; serangan +15.', 2200, 880, 'weapon', 'epic', 'B', { attack: 15, magic: 3 }],
  ['iron_armor', 'Iron Armor', 'Armor besi; pertahanan +6.', 450, 180, 'armor', 'common', 'F', { defense: 6 }],
  ['mage_armor', 'Mage Armor', 'Armor penyihir; pertahanan +10, sihir +2.', 1400, 560, 'armor', 'rare', 'C', { defense: 10, magic: 2 }],
  ['dragon_armor', 'Dragon Armor', 'Armor tingkat tinggi; pertahanan +20.', 6000, 2400, 'armor', 'legendary', 'S', { defense: 20, mitigation: 5 }],
  ['mystery_box', 'Mystery Box', 'Buka satu kotak untuk hadiah acak dari pool server.', 500, 0, 'special', 'rare', 'F', {}],
  ['slime_gel', 'Slime Gel', 'Material umum dari monster slime.', 35, 12, 'material', 'common', 'F', {}],
  ['monster_fang', 'Monster Fang', 'Taring untuk resep senjata.', 55, 20, 'material', 'common', 'F', {}],
  ['herb', 'Herb', 'Herba umum untuk ramuan.', 30, 10, 'material', 'common', 'F', {}],
  ['rare_herb', 'Rare Herb', 'Herba langka untuk ramuan kuat.', 120, 48, 'material', 'uncommon', 'D', {}],
  ['iron_ore', 'Iron Ore', 'Bijih untuk crafting perlengkapan.', 45, 18, 'material', 'common', 'F', {}],
  ['ancient_wood', 'Ancient Wood', 'Kayu kuno untuk perlengkapan sihir.', 90, 36, 'material', 'uncommon', 'F', {}],
  ['ancient_cloth', 'Ancient Cloth', 'Kain kuno untuk jubah dan armor.', 80, 32, 'material', 'uncommon', 'F', {}],
  ['shadow_essence', 'Shadow Essence', 'Esensi untuk senjata sihir.', 220, 88, 'material', 'rare', 'D', {}],
  ['dragon_scale', 'Dragon Scale', 'Sisik monster tingkat tinggi.', 700, 280, 'material', 'epic', 'B', {}],
  ['rare_core', 'Rare Core', 'Inti langka untuk resep tingkat lanjut.', 450, 180, 'material', 'epic', 'C', {}]
].map(([id, name, description, price, sellPrice, category, rarity, requiredRank, effects]) => Object.freeze({ id, name, description, price, sellPrice, category, rarity, requiredRank, effects: Object.freeze(effects) }));

const BY_ID = new Map(ITEMS.map(item => [item.id, item]));
const BY_NAME = new Map(ITEMS.map(item => [item.name.toLowerCase(), item]));
const LEGACY = new Map([['Potion', 'health_potion'], ['Shield', 'magic_shield'], ['Mystery Box', 'mystery_box']]);
const RANKS = Object.freeze(['F', 'E', 'D', 'C', 'B', 'A', 'S']);

function getItem(idOrName) {
  return BY_ID.get(idOrName) || BY_NAME.get(String(idOrName || '').toLowerCase()) || BY_ID.get(LEGACY.get(idOrName));
}

function normalizeInventory(inventory) {
  const result = {};
  for (const [key, amount] of Object.entries(inventory || {})) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid persisted inventory quantity; data was not changed');
    if (amount === 0) continue;
    const item = getItem(key);
    const stableId = item?.id || key;
    result[stableId] = Math.min(Number.MAX_SAFE_INTEGER, (result[stableId] || 0) + amount);
  }
  return result;
}

module.exports = { ITEMS, RANKS, getItem, normalizeInventory };
