# Howitzer Hills

A turn-based artillery game in the spirit of the early-90s DOS classics, with modern visuals.
Plain HTML5 Canvas + JavaScript — no build step. Local play has no dependencies; online play uses [PeerJS](https://peerjs.com) from a CDN.

## Play

Open `index.html` in a browser, or play the hosted copy at https://thebenstenator.github.io/tank-game/. (Fonts load from Google Fonts.)

## Online play with friends

1. **Host:** open the game, choose **Host online**, and you get a 5-letter room code. Click **Copy invite** to copy a link with the code in it (or just read the code out).
2. **Friends:** open the game, choose **Join online**, enter their name and the code (an invite link fills the code in for them).
3. Everyone who joins shows up in the host's list. The host can add CPU tanks, set the rules and press **Start the War**.

Everyone plays on their own keyboard and mouse. While someone aims, everyone else sees their turret move live. Between rounds, everyone shops at the same time on their own screen. If a friend drops out, a CPU takes over their tank.

How it works: browsers connect directly to each other over WebRTC (PeerJS's free public server only introduces them). The host's browser runs the real game; when anyone fires, the host sends the shot and a random seed to everyone, so every screen plays the same shot, and at the start of each turn the host sends a full snapshot of terrain and tanks to correct any drift.

Things to know:
- **The host should keep the game tab in front.** Browsers pause background tabs, which pauses the game for everyone. Guests can switch away; they catch up when they come back.
- A few very strict networks (some offices and campuses) block direct browser connections. Home internet is almost always fine.
- Skip to end is local-only and isn't offered online.

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

The HUD along the bottom has buttons for all of these. Once every human is knocked out of a round, a **Skip to end** button fast-forwards the CPUs to the result.

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
- `js/net.js` — online play: rooms, host/guest messages, snapshots
