# Mag IA · Arcane Idle RPG

A complete fantasy magic idle-RPG that lives in **one file**: [`index.html`](index.html).

Open that file in any modern browser (double-click it, or serve the folder) and the whole
game runs — no build step, no Node, no server, no account, no external assets.

## Play

```
open index.html          # macOS
xdg-open index.html      # Linux
start index.html         # Windows
```

If your browser blocks `localStorage` on `file://` origins, serve it instead:

```
python3 -m http.server 8080     # then visit http://localhost:8080
```

## What is in it

| System | Notes |
| --- | --- |
| Idle economy | 10 mages mint Magic Coins continuously into a capped **pouch**; Collect, overflow, and a 2-minute **Blessing of Haste** (×2 for 15s). |
| Offline progress | Computed from saved timestamps, capped (8h baseline, extendable), at a reduced rate; clock rollback and future timestamps are clamped. |
| Active combat | Canvas arena, mana + cooldowns + a global cooldown, 5 spells (Fireball, Frost Nova, Arcane Burst, Light Mend, Gilded Curse), free Focus Blast, 12 enemy types each with a real trait, 7 bosses with unique abilities and keys, 35 stages of scaling. |
| Collection | Mage shop with unique-mage purchase validation, per-mage ranks (cost curve ×1.3), talents that stack permanently, an active-lead slot, and a circle synergy bonus. |
| Tower | 14 procedurally drawn floors: multipliers, pouch capacity, mana, cooldown, offline-efficiency, damage, and feature unlocks (Relic Forge at floor 4). |
| Relics | Four attunable relic types with their own caps and a soft cap on the global bonus, earned from battles/achievements or bought with coins. |
| Quests | 5 daily missions rolled deterministically per local calendar day from a 12-mission pool with 5 goal tiers, streaks, progress bars, and claim-once guards. |
| Achievements | 20 lifetime achievements, auto-unlocked, paid out exactly once. |
| Save | Validated, versioned, throttled `localStorage` save (key `magia.save.v1`) with export/import codes and a two-step Reset. |
| Feel | WebAudio synth (created only after your first tap), procedural SVG/canvas art, particles, floating numbers, screen shake, reduced-motion mode, haptics where supported. |

Magic Coins are an in-game toy currency with no cash value; nothing here is a financial
reward, referral scheme, or payment integration.

## Code layout (inside the single file)

The inline script is organised as cooperating modules so a backend can drive the exact same
logic later without a rewrite:

```
Util · DATA tables · State · Save · Econ · Prog · Shop · Combat
Quest · Ach · Audio · FX · Render · Scene/Sprites/BattleScene · Loop · Boot
```

Only `window.MagIA` is exposed globally — a thin adapter surface
(`state()`, `save()`, `load()`, `stats()`, `combat`, `econ`, `shop`, `quests`,
`achievements`, `render`, `router`, `loop`, `config`, `data`) intended for a future
server-authoritative build. `localStorage` is convenience storage for standalone play and is
**not** treated as a trustworthy record of value.

## Testing notes

Balance and logic were exercised headlessly (jsdom + a canvas op-recorder) across: boot, every
screen render, all 19 enemy/boss visuals, purchase/claim validation and double-claim guards,
offline capping and clock abuse, corrupted-save recovery, reset, day rollover, and hour-long
simulated sessions with no errors and no NaN/negative state.
