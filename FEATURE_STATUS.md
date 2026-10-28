# Nightmare feature status

## Initial audit (2026-10-28)

| # | Feature | Initial status | Evidence |
|---|---|---|---|
| 1 | Giveaway | NOT IMPLEMENTED | No giveaway module, command, or restart recovery found. |
| 2 | Tickets | NOT IMPLEMENTED | No ticket module or ticket command found. |
| 3 | Notifications | NOT IMPLEMENTED | No configurable notification subsystem found. |
| 4 | Playground & mini-games | NOT IMPLEMENTED | No game commands or score store found. |
| 5 | Economy | NOT IMPLEMENTED | No economy store or commands found. |
| 6 | Leveling & XP | PARTIAL | Existing XP store, admin, rewards, rank card, UI, voice XP and commands; requires regression tests and code review. |
| 7 | Radio | NOT IMPLEMENTED | Music manager exists; no independent radio lifecycle/module found. |
| 8 | Welcome & goodbye | PARTIAL | Member cards and `/bg welcome`/`/bg goodbye` exist; message/channel template configuration is not evident. |
| 9 | AutoMod & anti-raid | NOT IMPLEMENTED | No moderation configuration or event handler found. |
| 10 | Music | PARTIAL | Music, playlists, lyrics, and profile handlers/commands exist; requires focused reliability verification. |
| 11 | AI chat | NOT IMPLEMENTED | No provider, context, or AI command found. No API credential configured by this work. |
| 12 | Server setup & management | PARTIAL | `/setup`, preview, confirmed reset, reaction roles, and bot profile exist; reset is destructive and will not be run. |

Initial audit also confirmed pre-existing uncommitted edits in `index.js`, `level-admin.js`, `music-system.js`, `rank-card.js`, `tests/terfokus.test.js`, `tests/xp-store.test.js`, and `xp-store.js`, plus new voice XP work and tests. These are preserved.

## Implementation progress (2026-10-28)

| # | Feature | Current status | Evidence / remaining work |
|---|---|---|---|
| 1 | Giveaway | DONE | `/giveaway create` publishes an entry button, requires Manage Server, persists giveaway/entries, deduplicates entries, selects unique winners, and runs due giveaway recovery/closure on startup and every 15 seconds. Store and command/button/rollback tests pass. |
| 2 | Tickets | DONE | `/ticket setup`, `/ticket panel`, `/ticket close`, `/ticket reopen`, and panel buttons create private channels with member/staff/bot permission overwrites, persist status/transcript/deletion deadline, and schedule deletion 60 seconds after close. Reopen cancels the timer; startup recovery and failed-delete retry are covered by fake-timer tests. |
| 3 | Notifications | DONE | `/notify configure` and `/notify send` are registered; join/leave event listeners use per-server destinations and switches. Persistent outbox, dedupe, exponential retry, Manage Server validation, role mention allowlists, and announcement cooldown are covered by tests. |
| 4 | Playground & mini-games | DONE | `/playground guess-start`, `guess`, `trivia-start`, `answer`, and `flip` use the Economy store for entry fee, game state, and settlement. Tests cover wins/losses, fees, insufficient funds, invalid/expired/duplicate actions, and concurrent settlement. |
| 5 | Economy | DONE | Economy commands and games use the same per-guild wallet. Entry debit, game state transition, and one-time payout are persisted in one atomic JSON write; daily/transfer/shop functions remain intact. |
| 6 | Leveling & XP | PARTIAL | Existing system was preserved. Targeted XP, rank card, voice XP and reset confirmation tests now pass; no full feature-by-feature audit was done in this turn. |
| 7 | Radio | NOT IMPLEMENTED | Independent radio lifecycle not yet added. |
| 8 | Welcome & goodbye | PARTIAL | Existing member card events/background commands preserved; per-guild channel/template configuration remains. |
| 9 | AutoMod & anti-raid | NOT IMPLEMENTED | Rate-limit primitive is not an AutoMod handler; thresholds/actions/audit configuration remain. |
| 10 | Music | PARTIAL | Existing commands/system preserved; music and queue tests passed in the final full suite. |
| 11 | AI chat | NOT IMPLEMENTED | No provider module or command. No credentials added. |
| 12 | Server setup & management | PARTIAL | Existing setup, preview, confirmed reset, reaction roles, and profile preserved. Destructive reset was not run. |

### Latest implementation and verification (2026-10-28)

`/giveaway`, `/economy`, `/ticket`, `/notify`, and `/playground` are registered and routed by the existing interaction dispatcher. Playground uses the same `economyStore` instance as `/economy`; its game sessions are stored inside each economy guild record. Giveaway and ticket buttons share the existing button listener. Notification join/leave events use the guild-member event pipeline. Data is isolated at `data/giveaways.json`, `data/economy.json`, `data/tickets.json`, and `data/notifications.json`; existing XP/music files are not migrated or overwritten.

- `node --check` passed for `index.js`, `nightmare-services.js`, `nightmare-interactions.js`, `notification-system.js`, `playground-system.js`, `ticket-deletion.js`, and the related test files.
- `npm test`: 84 passed, 0 failed.
- Playground/Economy game tests: 11 passed (including Economy service atomicity and `/playground` handler integration); ticket handler tests: 8 passed; ticket deletion fake-timer tests: 5 passed; notification tests: 4 passed.
- Full suite exercises existing music, playlist, leveling and voice XP tests. No production Discord server interaction was performed.

Notification delivery keys and payloads are persisted before sending. Failed deliveries are retried after restart and on a five-second worker using exponential backoff capped at five minutes. Discord may accept a send while its response is lost; such an ambiguous timeout can result in a duplicate when retried. Delivery is at-least-once under that condition, while duplicate event/interaction keys are suppressed.

## Current audit and implementation (2026-10-29)

The repository was re-audited before this stage. The existing data files remain format version 1 and are read in place; the live economy JSON contained one guild and one account. No production Discord server was contacted and no user data file was edited during this work.

| # | Feature | Current status | Verified state / remaining work |
|---|---|---|---|
| 1 | Giveaway | DONE | Existing button entry, persistent entries, unique winner selection, expiry recovery, permissions, and tests remain connected. |
| 2 | Tickets | DONE | `/ticket` command and buttons persist close deadline, transcript, and deletion state. Five fake-timer tests pass for 60 seconds, reopen, restart recovery, retry/permission failure, and missing channels. |
| 3 | Notifications | DONE | Existing `/notify` handler, per-server config, persistent outbox, duplicate suppression and retry tests remain connected. |
| 4 | Playground & mini-games | DONE | `/playground` remains connected to the same `economyStore` as `/economy`; existing win/loss, fee, duplicate-action and concurrency tests pass. |
| 5 | Economy | PARTIAL | Added 30 stable item IDs, catalog autocomplete, per-guild buy prices, `/economy sell`, item/admin commands, audit records, and a shared Economy crafting inventory. Atomic buy/sell/craft and handler tests pass. Mystery Box opening/odds, active potion use and complete Adventure progression remain unfinished, so the broad Economy/RPG scope is not marked DONE. |
| 6 | Leveling & XP | PARTIAL | Existing XP, voice XP, rank card, rewards and admin flow are preserved; regression tests pass. No full feature audit/config UI expansion was part of this stage. |
| 7 | Radio | NOT IMPLEMENTED | No independent radio session or verified stream provider. |
| 8 | Welcome & goodbye | PARTIAL | Existing member-card and `/bg` paths remain. Per-server message/channel templates still need implementation and audit. |
| 9 | AutoMod & anti-raid | NOT IMPLEMENTED | No configured moderation event pipeline or action/audit module. |
| 10 | Music | PARTIAL | Existing music/provider/playlist system remains unchanged by this stage; music and queue regression tests pass. |
| 11 | AI chat | NOT IMPLEMENTED | No provider-backed command; no credentials added. |
| 12 | Server setup & management | PARTIAL | Existing setup, preview, reset confirmation and reaction roles preserved. Production destructive operations were not run. |

### Economy and Adventure work in this stage

`/economy` now exposes balance, daily, transfer, shop, buy, sell, inventory and leaderboard. `/economy-admin add|remove|reset|price` and `/item give|remove` require Discord Administrator permission. Reset requires an explicit `confirm: true`. Administrative changes write actor, target, action, before/after values and timestamp in the same economy JSON transaction. Catalog selection is autocomplete (not static choice lists), so all current entries remain reachable without violating Discord's 25-choice limit.

`/adventure register|profile|inventory|materials|recipes|craft` is registered and dispatched. Registration/profile data lives inside the same guild record in `data/economy.json`; items and crafting inputs/outputs use the shared Economy inventory. Craft checks rank and all ingredients before consuming inputs, then writes ingredient consumption and output together. This is the first Adventure/crafting stage only: hunt/combat, quest, equipment effects, potion use, rank trials, and Mystery Box opening are still pending.

Catalog and recipe tables, actual command syntax, and known limits are in `NIGHTMARE_FEATURES.md`.

### Verification for this stage

- Ticket deletion focused tests: 5 passed, 0 failed.
- Economy/Adventure service, handler, and command schema tests: passed after resolving one test fixture mismatch (the audit assertion expected two records although price, balance, and item admin actions correctly wrote three).
- `node --check` over all project JavaScript files: passed.
- Final `npm test`: 90 passed, 0 failed (the previous baseline was 84/84).
- All tests use local fixtures and temporary files. No production Discord tests were performed.

### Earlier six test failures: causes and corrections

Three rank/card test failures had one harness cause: `tests/level-interaction.test.js` evaluates the handler in a VM but omitted production scope globals `performance` and `interactionDispatchStartedAt`; both are now supplied. The voice test called `tracker.clear` with one argument although the API requires `(guildId, userId)`; its fixture now passes both. The reset test threw generic `timeout`, unlike Discord.js collector expiration (`reason: time`); the mock now represents the actual collector reason. The economy service test's fake clock began only ten seconds after epoch, which correctly fell within the daily cooldown initialized at zero; it now models current time. These were test fixture issues, not production defects. The added interaction test initially also compared a Discord permission `BigInt` with a number and now uses the Discord.js constant.
