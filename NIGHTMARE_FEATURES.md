# Nightmare feature commands

This page documents the new persistent community commands. Slash commands are registered globally by the bot when it starts.

## Giveaway

- `/giveaway create prize minutes winners` publishes an entry button in the current text channel. The caller needs Manage Server.
- Members enter with the button. The bot ignores duplicate entries and excludes bots.
- Giveaway records are stored in `data/giveaways.json`. Expired giveaways are checked at startup and every 15 seconds; winners are selected without replacement.

## Economy

- `/economy daily` claims 100 coins once per 24 hours.
- `/economy balance|daily|transfer|shop|buy|sell|inventory|leaderboard` operates on one wallet and inventory per guild/user.
- `/economy buy` and `/economy sell` use autocomplete item IDs and accept an optional `amount` from 1 to 1000. Prices, rank gates, inventory validation and settlement are checked in the persistent service; the client cannot set a price.
- `/economy shop` displays the full catalog across two embeds (25 and 5 fields) to stay within Discord's embed field limit.
- `/economy-admin add|remove|reset|price` and `/item give|remove` require Administrator. Reset requires an explicit confirmation option. Changes include actor/target, action, before/after state and timestamp in the same Economy file.
- The store keeps its existing version-1 data format. Legacy display-name inventory keys are mapped to stable item IDs when an account is changed; the current user's file is not rewritten by module load.
- Economy data and up to 500 recent coin transactions per guild are stored in `data/economy.json`. Playground uses this same store; there is no second wallet or inventory.

### Shop catalogue

Buy and sell prices are coins. Server administrators can override buy prices with `/economy-admin price`; sale prices are fixed by the catalog. Rank gate uses the Adventure profile and defaults to F. Items with rank above F cannot be bought until that profile reaches the required rank. The Adventure effects below describe implemented behavior.

| Item | Buy / sell | Rank | Effect or use |
|---|---:|:---:|---|
| Health Potion | 100 / 40 | F | Restores up to 30 HP; can be used between hunts or in combat. |
| Greater Health Potion | 260 / 100 | E | Restores up to 70 HP; can be used between hunts or in combat. |
| Mana Potion | 120 / 48 | F | No active effect; there is no mana system. |
| Strength Potion | 240 / 96 | E | +5 attack for three combat turns. |
| Defense Potion | 240 / 96 | E | +5 defense for three combat turns. |
| Monster Bait | 60 / 24 | F | Consumed when hunt starts; +1 loot on victory. |
| Magic Wand | 500 / 200 | E | +4 attack and +4 magic when equipped. |
| Magic Staff | 1,100 / 440 | C | +7 attack and +8 magic when equipped. |
| Spell Tome | 750 / 300 | D | +5 magic when equipped. |
| Magic Crystal | 180 / 72 | F | Crafting material. |
| Mage Robe | 650 / 260 | E | +4 defense when equipped. |
| Enchanted Ring | 900 / 360 | D | +2 attack and +3 magic when equipped. |
| Magic Shield | 850 / 340 | D | +8 defense and 2 damage mitigation when equipped. |
| Iron Sword | 350 / 140 | F | +5 attack; craftable and equippable. |
| Steel Sword | 800 / 320 | D | +9 attack when equipped. |
| Enchanted Sword | 2,200 / 880 | B | +15 attack and +3 magic; craftable and equippable. |
| Iron Armor | 450 / 180 | F | +6 defense when equipped. |
| Mage Armor | 1,400 / 560 | C | +10 defense and +2 magic when equipped. |
| Dragon Armor | 6,000 / 2,400 | S | +20 defense and 5 damage mitigation when equipped. |
| Mystery Box | 500 / cannot sell | F | One owned box opens for one of five server rewards at equal odds. |
| Slime Gel | 35 / 12 | F | Crafting material. |
| Monster Fang | 55 / 20 | F | Crafting material. |
| Herb | 30 / 10 | F | Crafting material. |
| Rare Herb | 120 / 48 | D | Crafting material. |
| Iron Ore | 45 / 18 | F | Crafting material. |
| Ancient Wood | 90 / 36 | F | Crafting material. |
| Ancient Cloth | 80 / 32 | F | Crafting material. |
| Shadow Essence | 220 / 88 | D | Crafting material. |
| Dragon Scale | 700 / 280 | B | Crafting material. |
| Rare Core | 450 / 180 | C | Crafting material. |

### Adventure RPG and crafting (implemented core)

- `/adventure register name` creates one F-rank profile per user/server. `/adventure profile` displays stats and the Economy balance.
- `/adventure inventory` and `/adventure materials` read the same Economy inventory as `/economy inventory`; no RPG-only wallet/inventory exists.
- `/adventure recipes` lists recipes; `/adventure craft item [amount]` checks all required inputs and rank, then consumes materials and inserts the output in one persisted Economy write. Missing materials leave inventory unchanged. Craft quantity is 1–100.
- Current recipes (ingredients per one craft): Health Potion: 2 Slime Gel + 1 Herb; Greater Health Potion: 2 Health Potion + 1 Rare Herb + 1 Magic Crystal; Magic Wand: 2 Ancient Wood + 1 Magic Crystal; Magic Staff: 3 Ancient Wood + 2 Magic Crystal + 1 Rare Core; Iron Sword: 3 Iron Ore + 1 Monster Fang; Enchanted Sword: 1 Iron Sword + 2 Magic Crystal + 1 Shadow Essence; Magic Shield: 2 Iron Ore + 1 Magic Crystal + 2 Monster Fang; Mage Robe: 3 Ancient Cloth + 1 Magic Crystal; Monster Bait: 1 Slime Gel + 1 Herb (produces 2).
- `/adventure hunt` starts an owner-bound, five-minute turn-based fight; `/adventure fight session action [item]` supports attack, defend, potion, and escape. These are slash-command interactions; Adventure does not use buttons. Every command handler defers an ephemeral reply before store work, then edits that reply with the result/error. A victory grants the monster's fixed EXP, coins through the shared Economy transaction ledger, and catalog material loot. Failed/expired/repeated actions cannot settle rewards again. The session owner is checked by the service before any action can mutate state. Expired sessions are marked expired on access or the next hunt start; ended records older than one day are pruned when another hunt starts.
- `/adventure quest` reports progress toward three hunt wins and claims a daily reward once: 50 EXP, 75 coins and 2 Herbs. Rank F→S is progression-only and recalculated after a hunt win or quest claim. Requirements are cumulative: F starts at 0 EXP; E needs 100 EXP/3 hunts/0 quests; D 250/6/1; C 500/9/2; B 900/12/3; A 1,500/15/4; S 2,400/18/5. Hunt count records sessions started, while quest progress specifically requires hunt wins. Rank is not user-selectable.
- `/adventure equip slot item` and `unequip slot` consume/return owned weapon, armor, and accessory items. Catalog attack adds directly to hit damage; magic adds floor(total magic/2) damage; defense and mitigation reduce incoming damage. `/adventure use item` consumes owned healing potions outside combat; combat `/adventure fight ... action:potion item:...` also activates catalog healing/temporary attack/defense effects. Mana Potion has no catalog effect and cannot be used.
- `/adventure open-box` consumes one owned Mystery Box at no additional coin cost and draws one server-side reward with equal 20% odds: 3 Slime Gel, 2 Monster Fang, 1 Health Potion, 1 Magic Crystal, or 1 Rare Herb. No player-supplied reward is accepted.
- Adventure profiles, sessions, equipment references, Economy inventory, balances and transaction history remain in `data/economy.json` version 1. JSON persistence uses synchronous single-process read/modify/atomic rename; it is not a multi-process transaction/locking system. Run one bot process against a given Economy file. Inventory additions validate safe integer bounds; a failed write/validation does not persist partial consumption or rewards.
- If the player owns Monster Bait when a hunt successfully starts, exactly one bait is consumed in the same write as the session and guarantees +1 unit of that monster's loot on victory. The bait remains spent after loss, escape, or expiry. A hunt request that fails before session creation does not consume it.
- Mana Potion remains catalog-only with no active use because this RPG has no mana statistic, resource pool, spell actions, or defined Mana Potion effect. The service rejects using it instead of applying an invented effect.
- Local service and mocked handler/schema tests cover hunt payout/expiry/replay, bait win/loss-path behavior, owner rejection, private acknowledgment, quest claims, rank gates, equipment ownership, potion validation and Mystery Box reward consumption. Discord production interactions/command registration are not exercised; no requests were sent to Discord.

### Adventure administrator controls

- `/adventure admin rank target rank` accepts only F/E/D/C/B/A/S. It persists an admin override that normal EXP progression will not replace.
- `/adventure admin stats target attack defense max_hp current_hp` updates actual base combat fields. ATK/DEF/current HP allow 0–100,000; max HP is 1–100,000; current HP cannot exceed max HP. It is rejected while a hunt is active so the combat HP snapshot cannot drift.
- Combat uses base ATK + equipment ATK + floor(equipment magic/2) - monster DEF (minimum 1 damage). Incoming damage uses monster ATK - base DEF - equipment DEF - temporary DEF - defend reduction - mitigation (minimum 1). Derived profile values include equipment bonuses once; admin values change only base fields.
- `/adventure admin skillpoints target add|set amount` adjusts an audited integer balance from 0 to 1,000,000. The Adventure skill catalog and normal Skill Point progression are implemented: each rank gained through normal progression grants one point, while admin rank overrides do not. Players spend points through `/adventure learn` and `/adventure upgrade`; those operations enforce rank, prerequisite, level, and balance checks and persist skill levels in the shared Adventure profile. Service tests cover progression, spending, persistence, and combat effects; local tests do not establish live Discord command registration or interactions.
- `/adventure admin enemy target monster` sets the target's next encounter. Autocomplete uses the existing encounter records only: Slime, Goblin, and Dire Wolf with their current HP/ATK/DEF/EXP/coin/drop values. The selection is consumed atomically when the target starts `/adventure hunt`; changing it is rejected during an active hunt.
- Every admin mutation checks Administrator at execution, requires a registered target profile and deduplicates the Discord interaction ID. Actor/target/action/before/after are recorded in the Economy guild admin audit.

### Adventure skills

- `/adventure skills [skill]` lists the skill catalog, detail, rank/prerequisite, cost, level and ownership. `/adventure learn skill` learns at level 1; `/adventure upgrade skill` raises a learned skill. Skill levels, points and admin changes persist in the same Adventure profile in `data/economy.json`.
- Each rank gained through normal progression grants one Skill Point. Admin rank bypass does not grant progression points. Learn cost is the catalog cost; upgrade cost is `base cost × (current level + 1)`. Failed rank/prerequisite/point checks leave the point balance and skill unchanged.
- Passives apply in actual combat: Weapon Mastery adds 2 ATK/level, Vitality adds 10 effective maximum HP/level, Iron Guard subtracts 1 incoming damage/level, and Critical Eye grants 5 percentage points critical chance/level (maximum 50%, 1.5× damage). Vitality's maximum is reflected in the session and potion heal cap.
- `/adventure cast session skill` consumes the player's turn and runs the monster retaliation/expiry/action-ID checks used by `/adventure fight`. Arcane Slash deals 1.5× ATK (+0.25×/level); Flame Burst deals 1.8× ATK plus 4 damage/level. Crescent Nova is rank B, requires Flame Burst level 2, and may be cast once per hunt for 3× ATK. No mana or global cooldown system was added.
- Rank and prerequisites gate normal learning/upgrades. `/adventure admin skill target skill level` requires Administrator at execution, may set level 0 through the skill's actual maximum without cost, and writes before/after to the same admin audit. Admin skill-point updates remain available. Learning, upgrades and admin skill overrides are rejected while the target has an active hunt. No skill inventory or separate point wallet was created.
- Service tests assert persisted skill/point state and actual damage, critical, HP and mitigation outcomes, along with session owner/guild, expiry, duplicate action and once-per-session ultimate behavior. Discord command registration and live interaction were not tested against Discord; local handler/schema tests use mocks.
- Admin bypass and enemy selection have local service, mocked handler, autocomplete, and command-schema tests. No live Discord command registration was attempted.

## Nightmare Announcement Studio

- `/announcement create template channel [role]` creates a private draft from `update`, `info`, `event`, `announcement`, or `maintenance`. Manage Server is the default command permission and is checked again at runtime.
- The selected channel and optional role must belong to the current guild. The user must have ViewChannel and SendMessages there. At send, the bot must have ViewChannel, SendMessages, and EmbedLinks; a non-mentionable selected role also needs bot MentionEveryone permission.
- The ephemeral editor provides Edit (title, description, hex color, footer, message), Gambar (HTTPS main image and thumbnail), Preview, Kirim, and Batal. Kirim first asks for explicit confirmation before public delivery.
- Drafts bind to creator and guild and expire after 15 minutes. They are in-memory only; restart invalidates outstanding controls.
- Sends use `allowedMentions: { parse: [], users: [], roles: [selectedRoleId] }`. Only the role explicitly selected at draft creation can ping; free text containing @everyone/@here or other mentions is not parsed.
- The send state is claimed before calling Discord. A successful call locks the draft as sent. An API error locks it as uncertain and reports that delivery may have occurred, preventing a potentially duplicate retry. Check the destination before creating a replacement draft.
- `/notify configure` and `/notify send` remain separate and unchanged: join/leave persistent outbox, retry, dedupe, cooldown and mention allowlist are not routed through Studio. Local mocks do not prove live Discord delivery or command registration.

## Playground & mini-games

- `/playground guess-start [stake]` starts a 3-attempt number game; use `/playground guess game_id number` for each turn.
- `/playground trivia-start [stake]` starts a one-answer trivia game; use `/playground answer game_id choice` to settle it.
- `/playground flip choice stake` plays a heads/tails coin flip with a 1–100 coin stake.
- Optional entry fees are 0–100 coins; coin flip requires 1–100 coins. Game starts have a per-member 15-second cooldown, at most three active games, and a five-minute expiry.
- Fees, session state, settlement, and payouts are written through Economy's per-guild store. Repeated action IDs and already-settled games cannot pay again. Wins award 15 + twice the entry fee for number guessing, 30 + twice the entry fee for trivia, or twice the coin flip stake; losses forfeit only the entry fee/stake.

## Tickets

- An administrator with Manage Server runs `/ticket setup staff_role [category]`, then `/ticket panel` in the channel where the panel should appear.
- Members open a private channel with the panel button. Each user may have one open ticket at a time.
- The ticket creator or staff can close a ticket. Staff can reopen it with `/ticket reopen`; authorized button controls are also shown in the ticket channel.
- Closing attempts to attach a plain text transcript of up to 100 recent messages. Ticket data is stored in `data/tickets.json`.
- Close stores the transcript in the ticket record, notifies the member of the one-minute delay, and schedules deletion for 60 seconds after the persisted close time. Reopening clears the deadline. Startup recovery and failed-delete retries are enabled; tickets without a saved transcript are retained until one can be saved.

Ticket close/reopen command and button handlers have local tests for permission checks, transcript output, access updates, and permission failure rollback. No production Discord guild was used for testing.

## Notifications

- `/notify configure channel joins leaves [role]` requires Manage Server and selects a text/announcement channel, optional role mention, and join/leave event switches.
- `/notify send message` publishes an announcement to that configured channel. Manual announcements have a 30-second per-server cooldown. Mention parsing is disabled except for the explicitly configured role.
- Member join/leave listeners publish configured notifications and persist delivery keys to suppress duplicate event handling. Data is stored in `data/notifications.json`.
- Notification claims and payloads are saved before contacting Discord. Failed deliveries retry after restart and every five seconds, with exponential backoff capped at five minutes. Discord may accept a send while its response is lost, so a retry after an ambiguous timeout can duplicate that one notification; repeated event/interaction keys are otherwise suppressed.

## Local persistence

The bot creates the Economy, giveaway, ticket, and notification JSON files on first successful write. Keep `data/` in the normal bot backup process. The feature modules do not store Discord tokens or API credentials.

## Discord interaction acknowledgments

- The first `interactionCreate` listener handles announcement modals and message buttons; the second handles slash commands and autocomplete. Both observe the same event stream, but the first returns for non-buttons/non-announcement modals, so it does not execute slash handlers a second time.
- Giveaway entry and ticket buttons defer before persistent JSON lookups. Announcement public-send confirmation defers the component update before channel/role REST cache fetches. Slash command handlers defer before store or Discord API work; autocomplete responds once and does not retry a failed `respond()`.
- `[INTERACTION]` diagnostics report sanitized command/custom-ID prefix, interaction age, measured event-loop maximum stall since the previous interaction, handler time before the initial acknowledgment, acknowledgment method/latency, listener delay, and numeric Discord error code for slow (750 ms or more) or failed acknowledgments. `ageBeyondMaxLoopDelayMs` is only a comparison against the largest sampled stall, not a causal decomposition; gateway delivery delay and local clock offset still require independent verification. No token, option values, or message content is recorded. A failed/expired initial acknowledgment is not retried; a confirmed deferred response can receive an error edit.
- Local tests use mocked interactions and do not establish live Discord latency or delivery. For a fresh test-server run, compare `ageAtListenerMs`, `localLoopMaxDelayMs`, `ageBeyondMaxLoopDelayMs`, `listenerDelayMs`, `handlerDelayMs`, `ackMethod`, `ackAgeMs`, and `ackStatus`.
