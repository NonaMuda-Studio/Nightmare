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

Buy and sell prices are coins. Server administrators can override buy prices with `/economy-admin price`; sale prices are fixed by the catalog. Rank gate uses the Adventure profile and defaults to F. Items with rank above F cannot be bought until that profile reaches the required rank. The combat/effect field describes the intended effect; only crafting and inventory effects are live in this stage, so equipment bonuses and potion use must not be treated as active gameplay yet.

| Item | Buy / sell | Rank | Effect or use |
|---|---:|:---:|---|
| Health Potion | 100 / 40 | F | Intended +30 HP; potion use is pending. |
| Greater Health Potion | 260 / 100 | E | Intended +70 HP; potion use is pending. |
| Mana Potion | 120 / 48 | F | Mana system is not implemented. |
| Strength Potion | 240 / 96 | E | Intended +5 attack for 3 turns; pending. |
| Defense Potion | 240 / 96 | E | Intended +5 defense for 3 turns; pending. |
| Monster Bait | 60 / 24 | F | Hunt bonus is planned; hunting is pending. |
| Magic Wand | 500 / 200 | E | Intended +4 attack, +4 magic; pending equipment. |
| Magic Staff | 1,100 / 440 | C | Intended +7 attack, +8 magic; pending equipment. |
| Spell Tome | 750 / 300 | D | Intended +5 magic; pending equipment. |
| Magic Crystal | 180 / 72 | F | Crafting material. |
| Mage Robe | 650 / 260 | E | Intended +4 defense; pending equipment. |
| Enchanted Ring | 900 / 360 | D | Intended +2 attack, +3 magic; pending equipment. |
| Magic Shield | 850 / 340 | D | Intended +8 defense, 2 damage mitigation; pending equipment. |
| Iron Sword | 350 / 140 | F | Intended +5 attack; crafting result, equipment pending. |
| Steel Sword | 800 / 320 | D | Intended +9 attack; equipment pending. |
| Enchanted Sword | 2,200 / 880 | B | Intended +15 attack, +3 magic; crafting result, equipment pending. |
| Iron Armor | 450 / 180 | F | Intended +6 defense; equipment pending. |
| Mage Armor | 1,400 / 560 | C | Intended +10 defense, +2 magic; equipment pending. |
| Dragon Armor | 6,000 / 2,400 | S | Intended +20 defense, 5 mitigation; equipment pending. |
| Mystery Box | 500 / cannot sell | F | Box can be purchased and stored; opening/reward odds are not implemented. |
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

### Adventure RPG and crafting (partial)

- `/adventure register name` creates one F-rank profile per user/server. `/adventure profile` displays stats and the Economy balance.
- `/adventure inventory` and `/adventure materials` read the same Economy inventory as `/economy inventory`; no RPG-only wallet/inventory exists.
- `/adventure recipes` lists recipes; `/adventure craft item [amount]` checks all required inputs and rank, then consumes materials and inserts the output in one persisted Economy write. Missing materials leave inventory unchanged. Craft quantity is 1–100.
- Current recipes (ingredients per one craft): Health Potion: 2 Slime Gel + 1 Herb; Greater Health Potion: 2 Health Potion + 1 Rare Herb + 1 Magic Crystal; Magic Wand: 2 Ancient Wood + 1 Magic Crystal; Magic Staff: 3 Ancient Wood + 2 Magic Crystal + 1 Rare Core; Iron Sword: 3 Iron Ore + 1 Monster Fang; Enchanted Sword: 1 Iron Sword + 2 Magic Crystal + 1 Shadow Essence; Magic Shield: 2 Iron Ore + 1 Magic Crystal + 2 Monster Fang; Mage Robe: 3 Ancient Cloth + 1 Magic Crystal; Monster Bait: 1 Slime Gel + 1 Herb (produces 2).
- Registration, profile, craft, missing materials, shared inventory, restart persistence, and concurrent craft attempts have local tests. Hunting, quests, rank promotion, equipment, active potion effects, material drops and Mystery Box opening remain unimplemented.

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
