# Howitzer Hills

A turn-based artillery game in the spirit of the early-90s DOS classics, with modern visuals.
Plain HTML5 Canvas + JavaScript — no build step, no dependencies.

## Play

Open `index.html` in a browser. (Fonts load from Google Fonts; everything else is local.)

## Controls

| Key | Action |
| --- | --- |
| ← / → | Rotate barrel (hold to sweep, tap for 1°) |
| ↑ / ↓ | Power (hold Shift for fine control) |
| PgUp / PgDn | Power ±100 |
| Click angle / power | Type an exact value (Enter to apply, Esc to cancel, Tab to switch) |
| Tab / Q / E | Cycle weapon |
| S | Raise shield |
| Space / Enter | Fire |
| M | Mute |

The HUD buttons do the same thing with the mouse.

## Rules

- 2–6 tanks, any mix of humans (hot-seat) and CPUs (Easy / Normal / Hard).
- Range scales with power (500 goes about half as far as 1000), and full power carries about 1.6 field widths on flat ground.
- Damage lowers max power (500 + health × 5), so wounded tanks shoot shorter but can still fight back.
- Terrain is destructible and loose dirt falls. Tanks that fall take damage unless they have a parachute.
- Wind is a setting: None, Light (up to 15), Moderate (30, default), Strong (50) or Gale (75). Around 20 you have to aim for it; 60+ is chaos. It can drift between turns.
- Terrain style is a setting: Gentle, Hilly, Mountainous, Wild (default — jagged peaks near the ceiling, pits near the floor) or Random per round.
- Destroyed tanks go out with a random death effect — fizzle, blast, big boom, shrapnel, ammo cook-off or a full meltdown — and the blast can damage or chain-kill nearby tanks. Collateral kills are credited to whoever destroyed the first tank.
- Earn cash for damage dealt, kills and round wins; spend it in the armory between rounds.

## Code layout

- `js/config.js` — constants, weapons, items, visual themes
- `js/terrain.js` — pixel-mask terrain, carving, falling dirt, coloring
- `js/background.js` — sky / celestial body / mountain rendering
- `js/game.js` — tanks, physics, weapons, turn flow, rendering
- `js/ai.js` — CPU aiming (simulates shots with the real physics) and shopping
- `js/ui.js` — menus, HUD, armory, standings
- `js/audio.js` — synthesized sound effects (WebAudio)
