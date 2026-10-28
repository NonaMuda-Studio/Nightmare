'use strict';

// Material quantities are per crafted result; all inputs and outputs share Economy inventory.
const RECIPES = Object.freeze({
  health_potion: Object.freeze({ amount: 1, materials: Object.freeze({ slime_gel: 2, herb: 1 }) }),
  greater_health_potion: Object.freeze({ amount: 1, materials: Object.freeze({ health_potion: 2, rare_herb: 1, magic_crystal: 1 }) }),
  magic_wand: Object.freeze({ amount: 1, materials: Object.freeze({ ancient_wood: 2, magic_crystal: 1 }) }),
  magic_staff: Object.freeze({ amount: 1, materials: Object.freeze({ ancient_wood: 3, magic_crystal: 2, rare_core: 1 }) }),
  iron_sword: Object.freeze({ amount: 1, materials: Object.freeze({ iron_ore: 3, monster_fang: 1 }) }),
  enchanted_sword: Object.freeze({ amount: 1, materials: Object.freeze({ iron_sword: 1, magic_crystal: 2, shadow_essence: 1 }) }),
  magic_shield: Object.freeze({ amount: 1, materials: Object.freeze({ iron_ore: 2, magic_crystal: 1, monster_fang: 2 }) }),
  mage_robe: Object.freeze({ amount: 1, materials: Object.freeze({ ancient_cloth: 3, magic_crystal: 1 }) }),
  monster_bait: Object.freeze({ amount: 2, materials: Object.freeze({ slime_gel: 1, herb: 1 }) })
});

module.exports = { RECIPES };
