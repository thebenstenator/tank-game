'use strict';

// Logical world size. Height is fixed; width follows the window's aspect ratio
// (set at the start of each round) so the battlefield fills the screen.
const WORLD_H = 960;
let W = 1280, H = 720;
function fitWorldToWindow() {
  const aspect = clamp(window.innerWidth / Math.max(1, window.innerHeight), 1.3, 2.4);
  H = WORLD_H;
  W = Math.round(H * aspect);
  // Full power on flat ground with no wind carries ~1.35 field widths, whatever the window shape.
  MUZZLE_MAX = Math.sqrt(RANGE_FACTOR * W * GRAVITY);
}
const GRAVITY = 260;        // px/s²
const RANGE_FACTOR = 1.35;
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
const WEAPONS = {
  baby:     { name: 'Baby Missile', price: 0,    bundle: 0, radius: 20,  damage: 38,  color: '#ffe08a', ai: 1,  desc: 'Free and unlimited. Small, but honest.' },
  missile:  { name: 'Missile',      price: 1500, bundle: 5, radius: 32,  damage: 58,  color: '#ffb14a', ai: 3,  desc: 'A solid all-rounder with a bigger blast.' },
  babynuke: { name: 'Baby Nuke',    price: 4000, bundle: 2, radius: 58,  damage: 85,  color: '#ff7a3d', ai: 6,  desc: 'Leaves a crater worth remembering.' },
  nuke:     { name: 'Nuke',         price: 9000, bundle: 1, radius: 105, damage: 115, color: '#ff4d6d', ai: 10, desc: 'Rearranges the landscape. And your enemies.' },
  mirv:     { name: 'MIRV',         price: 6000, bundle: 2, radius: 30,  damage: 50,  color: '#7cd3ff', ai: 7,  behavior: 'mirv', count: 5, desc: 'Splits into five warheads at the top of its arc.' },
  funky:    { name: 'Funky Bomb',   price: 5000, bundle: 2, radius: 36,  damage: 48,  color: '#d58cff', ai: 6,  behavior: 'funky', count: 7, desc: 'Explodes, then sprays bomblets everywhere.' },
  leapfrog: { name: 'Leapfrog',     price: 2500, bundle: 3, radius: 26,  damage: 44,  color: '#9cf06a', ai: 4,  behavior: 'leapfrog', bounces: 3, desc: 'Hops forward, exploding three times.' },
  roller:   { name: 'Roller',       price: 2000, bundle: 4, radius: 34,  damage: 62,  color: '#ffd84a', ai: 4,  behavior: 'roller', desc: 'Rolls downhill until it finds a valley — or a tank.' },
  dirt:     { name: 'Dirt Ball',    price: 1000, bundle: 5, radius: 42,  damage: 0,   color: '#c08a5a', ai: 0,  behavior: 'dirt', desc: 'Buries things. Good for walls and petty revenge.' },
};
const WEAPON_ORDER = Object.keys(WEAPONS);

const ITEMS = {
  shield:    { name: 'Shield',    price: 3500, bundle: 1, color: '#6fe3ff', desc: 'Absorbs 100 damage. Press S on your turn to raise it.' },
  parachute: { name: 'Parachute', price: 1200, bundle: 2, color: '#f2f2f2', desc: 'Opens automatically when you fall. No fall damage.' },
};

// How a tank goes out when destroyed. weight = relative chance.
// Every effect except 'fizzle' can badly hurt anyone parked nearby.
const DEATH_EFFECTS = [
  { id: 'fizzle',   label: 'FIZZLED',        weight: 14 },
  { id: 'blast',    label: 'DESTROYED',      weight: 30 },
  { id: 'bigboom',  label: 'KABOOM!',        weight: 18 },
  { id: 'shrapnel', label: 'SHRAPNEL!',      weight: 15 },
  { id: 'cookoff',  label: 'AMMO COOK-OFF!', weight: 14 },
  { id: 'meltdown', label: 'MELTDOWN!',      weight: 9 },
];
const SHRAPNEL = { name: 'Shrapnel', radius: 20, damage: 26, color: '#ffb870' };

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
