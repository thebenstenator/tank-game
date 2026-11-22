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
| Click angle / power | Type an exact value (Enter to apply, Esc to cancel, Tab to switch). Angle is degrees off vertical; add L or R to pick a side |
| Tab / Q / E | Cycle weapon |
| S | Raise shield |
| Space / Enter | Fire |
| F | Full screen on/off |
| M | Mute |

The HUD along the bottom has buttons for all of these. Once every human is knocked out of a round, a **Skip to end** button fast-forwards the CPUs to the result.

**Weapon test range** (button under Start on the local setup screen): you get infinite ammo of everything against five target tanks that never take a turn. Destroyed targets respawn after each shot, N rolls new terrain, and the menu button leaves.

## Rules

- 2–6 tanks, any mix of humans (hot-seat) and CPUs (Easy / Normal / Hard).
- Range scales with power (500 goes about half as far as 1000), and full power carries about 1.6 field widths on flat ground.
- Damage lowers max power (500 + health × 5), so wounded tanks shoot shorter but can still fight back.
- Terrain is destructible. A fresh hole holds for a moment before the loose dirt above it starts to fall. Tanks that fall take damage unless they have a parachute.
- Wind is a setting: None, Light (up to 15), Moderate (30, default), Strong (50) or Gale (75). Around 20 you have to aim for it; 60+ is chaos. It can drift between turns.
- Terrain style is a setting: Gentle, Hilly, Mountainous, Wild (default — jagged peaks near the ceiling, pits near the floor) or Random per round.
- Weapons: Baby Missile (free), Missile, Baby Nuke, Nuke (huge blast and a mushroom cloud), MIRV, Funky Bomb, Napalm (burning fuel that sticks where it lands and spreads), Leapfrog, Roller, Burrower (tunnels in a straight line and blows up under the first enemy it passes), Laser (straight beam through terrain; power sets its length), plus utilities: Tracer (shows a path, no damage), Dirt Ball, Dirt Fountain (erupts a spray of dirt clods into the air) and Excavator (clears dirt).
- Destroyed tanks go out in one of eleven ways, whatever hit them: plain blasts, fizzles and vaporizing are common; shrapnel, ammo cook-offs, infernos, a runaway turret, sinkholes and funky bomblets turn up less often; a big boom is rare and a full meltdown with a mushroom cloud is rarer still. Most deaths can damage or chain-kill nearby tanks; collateral kills are credited to whoever destroyed the first tank.
- Earn cash for damage dealt, kills and round wins; spend it in the armory between rounds.

## Code layout

- `js/config.js` — constants, weapons, items, visual themes
- `js/terrain.js` — pixel-mask terrain, carving, falling dirt, coloring
- `js/background.js` — sky / celestial body / mountain rendering
- `js/game.js` — tanks, physics, weapons, turn flow, rendering
- `js/ai.js` — CPU aiming (simulates shots with the real physics) and shopping
- `js/ui.js` — menus, HUD, armory, standings
- `js/audio.js` — synthesized sound effects (WebAudio)
- `js/music.js` — the menu march, played live from a little score
- `js/net.js` — online play: rooms, host/guest messages, snapshots
