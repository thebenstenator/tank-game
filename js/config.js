'use strict';

// Logical world size. Height is fixed; width follows the window's aspect ratio
// (set at the start of each round) so the battlefield fills the screen.
const WORLD_H = 960;
const HUD_RESERVE = 104;  // CSS px kept clear at the bottom for the HUD strip
let W = 1280, H = 720;
function fitWorldToWindow() {
  const aspect = clamp(window.innerWidth / Math.max(1, window.innerHeight - HUD_RESERVE), 1.3, 2.4);
  setWorldSize(Math.round(WORLD_H * aspect), WORLD_H);
}
/** Set the battlefield size directly (online guests use the host's). */
function setWorldSize(w, h) {
  W = w;
  H = h;
  // Full power on flat ground with no wind carries ~1.6 field widths, whatever the window shape.
  MUZZLE_MAX = Math.sqrt(RANGE_FACTOR * W * GRAVITY);
}
const GRAVITY = 260;        // px/s²
const RANGE_FACTOR = 1.6;
let MUZZLE_MAX = 720;       // muzzle speed (px/s) at power 1000; set by fitWorldToWindow
/** Range grows linearly with power: power 500 reaches about half as far as 1000. */
function muzzleSpeed(power) { return MUZZLE_MAX * Math.sqrt(Math.max(0, power) / 1000); }
// Wind unit → px/s² sideways acceleration. Rough feel on a mid-range shot:
// 10 = nudge, 20 = must aim for it, 40 = huge, 60+ = chaos.
const WIND_SCALE = 3.5;
// Max wind per setting, and how far it can drift between turns.
const WIND_LEVELS = {
  none:     { max: 0,  shift: 0 },
  light:    { max: 15, shift: 3 },
  moderate: { max: 30, shift: 5 },
  strong:   { max: 50, shift: 7 },
  gale:     { max: 75, shift: 10 },
};
const PHYS_DT = 1 / 120;    // fixed physics step (AI simulation uses the same)
const DEG = Math.PI / 180;
const MAX_PLAYERS = 6;

const PLAYER_COLORS = ['#ff5d5d', '#4cb3ff', '#7ee06a', '#ffc94a', '#c084fc', '#ff8fc7'];
const DEFAULT_NAMES = ['Red', 'Blue', 'Green', 'Gold', 'Violet', 'Rose'];

// price = cost of one bundle; bundle = how many you get.
// core (optional) = kill zone: full damage if the blast lands within this many px of a
// tank's centre, then falling off to nothing at radius + 14. Without it, damage falls off from 8px.
const WEAPONS = {
  baby:     { name: 'Baby Missile', price: 0,    bundle: 0, radius: 20,  damage: 51,  color: '#ffe08a', ai: 1,  desc: 'Free and unlimited. Small, but honest.' },
  tracer:   { name: 'Tracer',       price: 300,  bundle: 10, radius: 0,  damage: 0,   color: '#9fe8ff', ai: 0,  behavior: 'tracer', desc: 'Harmless. Leaves its path on screen so you can line up the real shot.' },
  missile:  { name: 'Missile',      price: 1500, bundle: 5, radius: 40,  damage: 66,  color: '#ffb14a', ai: 3,  desc: 'A solid all-rounder with a bigger blast.' },
  babynuke: { name: 'Baby Nuke',    price: 4000, bundle: 2, radius: 66,  damage: 110, core: 42, color: '#ff7a3d', ai: 6,  desc: 'Lethal within a tank-width of the target. Leaves a crater worth remembering.' },
  nuke:     { name: 'Nuke',         price: 11250, bundle: 1, radius: 210, damage: 130, core: 124, color: '#ff4d6d', ai: 10, desc: 'Lethal across a wide zone. Rearranges the landscape — and your enemies.' },
  mirv:     { name: 'MIRV',         price: 6000, bundle: 2, radius: 30,  damage: 50,  color: '#7cd3ff', ai: 7,  behavior: 'mirv', count: 5, desc: 'Splits into five warheads at the top of its arc.' },
  funky:    { name: 'Funky Bomb',   price: 5000, bundle: 2, radius: 36,  damage: 48,  color: '#d58cff', ai: 6,  behavior: 'funky', count: 7, desc: 'Explodes, then sprays bomblets everywhere.' },
  napalm:   { name: 'Napalm',       price: 5000, bundle: 2, radius: 22,  damage: 20,  color: '#ff8a1f', ai: 6,  behavior: 'napalm', count: 22, desc: 'Splashes burning fuel that runs downhill and pools in valleys.' },
  leapfrog: { name: 'Leapfrog',     price: 2500, bundle: 3, radius: 26,  damage: 44,  color: '#9cf06a', ai: 4,  behavior: 'leapfrog', bounces: 3, desc: 'Hops forward, exploding three times.' },
  roller:   { name: 'Roller',       price: 2000, bundle: 4, radius: 34,  damage: 62,  color: '#ffd84a', ai: 4,  behavior: 'roller', desc: 'Rolls downhill until it finds a valley — or a tank.' },
  burrower: { name: 'Burrower',     price: 3000, bundle: 3, radius: 30,  damage: 52,  color: '#d6a35c', ai: 4,  behavior: 'burrow', dig: 260, desc: 'Tunnels through the dirt after it lands, then explodes. The ground above caves in.' },
  laser:    { name: 'Laser',        price: 7500, bundle: 2, radius: 4,   damage: 60,  color: '#ff3b6b', ai: 7,  behavior: 'laser', desc: 'A straight beam: no gravity, no wind, cuts through terrain. Power sets its length.' },
  dirt:     { name: 'Dirt Ball',    price: 1000, bundle: 5, radius: 42,  damage: 0,   color: '#c08a5a', ai: 0,  behavior: 'dirt', desc: 'Buries things. Good for walls and petty revenge.' },
  fountain: { name: 'Dirt Fountain', price: 1500, bundle: 3, radius: 18, damage: 0,   color: '#b88352', ai: 0,  behavior: 'fountain', count: 11, desc: 'Erupts into a spray of dirt clods that rain down and bury things.' },
  excavator: { name: 'Excavator',   price: 1200, bundle: 3, radius: 80,  damage: 0,   color: '#e8d27a', ai: 0,  behavior: 'excavate', desc: 'Blows away a big chunk of dirt with no blast damage. Dig yourself out — or drop an enemy into a pit.' },
};
for (const id in WEAPONS) WEAPONS[id].id = id;
const WEAPON_ORDER = Object.keys(WEAPONS);
// Clods thrown by the Dirt Fountain
const CLOD = { id: 'clod', name: 'Dirt clod', radius: 17, damage: 0, color: '#b88352', behavior: 'dirt' };

const ITEMS = {
  shield:    { name: 'Shield',    price: 3500, bundle: 1, color: '#6fe3ff', desc: 'Absorbs 100 damage. Press S on your turn to raise it.' },
  parachute: { name: 'Parachute', price: 1200, bundle: 2, color: '#f2f2f2', desc: 'Opens automatically when you fall. No fall damage.' },
};

// How a destroyed tank goes out. Any weapon can cause any death; weight = how often.
// The tame ones are common, the big chain-reaction ones are rare treats.
const DEATH_EFFECTS = [
  { id: 'blast',    name: 'Blast',         label: 'DESTROYED',      weight: 30 },
  { id: 'fizzle',   name: 'Fizzle',        label: 'FIZZLED',        weight: 14 },
  { id: 'vaporize', name: 'Vaporized',     label: 'VAPORIZED',      weight: 10 },
  { id: 'shrapnel', name: 'Shrapnel',      label: 'SHRAPNEL!',      weight: 11 },
  { id: 'cookoff',  name: 'Ammo cook-off', label: 'AMMO COOK-OFF!', weight: 10 },
  { id: 'inferno',  name: 'Inferno',       label: 'INFERNO!',       weight: 8 },
  { id: 'runaway',  name: 'Loose turret',  label: 'LOOSE TURRET!',  weight: 7 },
  { id: 'sinkhole', name: 'Sinkhole',      label: 'SINKHOLE!',      weight: 6 },
  { id: 'funky',    name: 'Funky',         label: 'FUNKY!',         weight: 5 },
  { id: 'bigboom',  name: 'Big boom',      label: 'KABOOM!',        weight: 5 },
  { id: 'meltdown', name: 'Meltdown',      label: 'MELTDOWN!',      weight: 2 },
];
const SHRAPNEL = { id: 'shrapnel', name: 'Shrapnel', radius: 20, damage: 26, color: '#ffb870' };

const SHOP_ORDER =[...WEAPON_ORDER.filter(id => WEAPONS[id].price > 0), 'shield', 'parachute'];
function shopEntry(id) { return WEAPONS[id] || ITEMS[id]; }

// Visual themes. Terrain colors are [r,g,b]; mountains listed far → near.
const THEMES = [
  {
    name: 'Dusk Valley',
    sky: [[0, '#120c2c'], [0.45, '#4b2a63'], [0.75, '#c2537a'], [1, '#ffa25e']],
    body: { type: 'sun', x: 0.72, y: 0.66, r: 46, color: '#ffe2b0', glow: 'rgba(255,170,100,0.55)' },
    stars: 0.45,
    mountains: ['#4a2a5e', '#2e1b42'],
    haze: 'rgba(255,140,120,0.22)',
    top: [124, 214, 104], mid: [112, 78, 58], deep: [42, 28, 34],
  },
  {
    name: 'Midnight Ridge',
    sky: [[0, '#02030a'], [0.6, '#0b1838'], [1, '#1d3b66']],
    body: { type: 'moon', x: 0.24, y: 0.2, r: 30, color: '#eef3ff', glow: 'rgba(160,190,255,0.35)' },
    stars: 1,
    mountains: ['#1a2d52', '#0f1c36'],
    haze: 'rgba(80,120,200,0.14)',
    top: [96, 182, 140], mid: [60, 64, 82], deep: [18, 20, 30],
  },
  {
    name: 'Red Desert',
    sky: [[0, '#1f6fb5'], [0.6, '#7fc3e8'], [1, '#ffe0b0']],
    body: { type: 'sun', x: 0.8, y: 0.17, r: 36, color: '#fffbe8', glow: 'rgba(255,240,200,0.6)' },
    stars: 0,
    mountains: ['#e0a07a', '#c97b55'],
    haze: 'rgba(255,215,175,0.3)',
    top: [244, 196, 124], mid: [204, 112, 64], deep: [110, 48, 30],
  },
  {
    name: 'Frozen Wastes',
    sky: [[0, '#2f5f96'], [0.7, '#a9cde8'], [1, '#eaf5ff']],
    body: { type: 'sun', x: 0.3, y: 0.22, r: 32, color: '#ffffff', glow: 'rgba(255,255,255,0.5)' },
    stars: 0,
    mountains: ['#a9c1dc', '#86a3c4'],
    haze: 'rgba(235,247,255,0.35)',
    top: [246, 250, 255], mid: [140, 166, 194], deep: [54, 72, 100],
  },
  {
    name: 'Alien World',
    sky: [[0, '#050d14'], [0.5, '#0f3b3a'], [1, '#4fd1a5']],
    body: { type: 'planet', x: 0.66, y: 0.25, r: 64, color: '#c77dff', glow: 'rgba(200,120,255,0.35)' },
    stars: 0.8,
    mountains: ['#164a4a', '#0c2e30'],
    haze: 'rgba(80,255,190,0.14)',
    top: [205, 128, 255], mid: [64, 42, 96], deep: [20, 12, 36],
  },
  {
    name: 'Volcanic Rift',
    sky: [[0, '#0a0505'], [0.6, '#3a0e0a'], [1, '#c43c12']],
    body: null,
    stars: 0.2,
    mountains: ['#33130f', '#1d0a08'],
    haze: 'rgba(255,90,30,0.22)',
    top: [255, 124, 44], mid: [62, 42, 40], deep: [22, 15, 15],
    embers: true,
  },
];
