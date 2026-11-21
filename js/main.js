'use strict';

(() => {
  const canvas = document.getElementById('game');
  const game = new Game(canvas);
  window.game = game; // handy for poking at things in the console
  game.preview();
  UI.init(game);

  const HOLD_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

  window.addEventListener('keydown', e => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    game.fine = e.shiftKey;
    if (e.code === 'KeyM') { UI.toggleMute(); return; }
    if (e.code === 'KeyF') { UI.toggleFullscreen(); return; }
    if (e.code === 'KeyN' && game.dev) { game.devNewMap(); return; }
    if (!document.getElementById('shop').classList.contains('hidden')) {
      if (e.code === 'ArrowLeft' || e.code === 'KeyQ' || e.code === 'PageUp') { e.preventDefault(); UI.shopPage(-1); return; }
      if (e.code === 'ArrowRight' || e.code === 'KeyE' || e.code === 'PageDown') { e.preventDefault(); UI.shopPage(1); return; }
    }

    const human = game.humanTurn;
    if (HOLD_KEYS.has(e.code)) {
      e.preventDefault();
      if (human && !e.repeat) game.keys[e.code] = { t: 0, started: false };
      return;
    }
    if (!human) {
      if (game.state !== 'setup' && (e.code === 'Space' || e.code === 'Tab')) e.preventDefault();
      return;
    }
    switch (e.code) {
      case 'Space':
      case 'Enter': e.preventDefault(); if (!e.repeat) game.fire(); break;
      case 'Tab': e.preventDefault(); game.cycleWeapon(e.shiftKey ? -1 : 1); break;
      case 'KeyQ': game.cycleWeapon(-1); break;
      case 'KeyE': game.cycleWeapon(1); break;
      case 'PageUp': e.preventDefault(); game.nudgePower(100); break;
      case 'PageDown': e.preventDefault(); game.nudgePower(-100); break;
      case 'KeyS': game.activateShield(game.current); break;
    }
  });

  // Browsers only allow audio after a user gesture: wake it on the first one so the menu music can start.
  const wake = () => { Sound.init(); window.removeEventListener('pointerdown', wake); window.removeEventListener('keydown', wake); };
  window.addEventListener('pointerdown', wake);
  window.addEventListener('keydown', wake);

  window.addEventListener('keyup', e => {
    delete game.keys[e.code];
    game.fine = e.shiftKey;
  });
  window.addEventListener('blur', () => { game.keys = {}; });

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (game.skipping) game.fastForward(); else game.update(dt);
    Net.tick(dt);
    Music.update(game.state === 'setup');
    game.render();
    UI.updateHUD(game);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
