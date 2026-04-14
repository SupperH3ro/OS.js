/*
 * OS.js - JavaScript Cloud/Web Desktop Platform
 *
 * Copyright (c) Anders Evenrud <andersevenrud@gmail.com>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * @author  Anders Evenrud <andersevenrud@gmail.com>
 * @licence Simplified BSD License
 */

const LABEL_TAGS = [
  {match: /^log ?out$/i, tag: 'logout'},
  {match: /save session/i, tag: 'save-logout'},
  {match: /^about/i, tag: 'about'},
  {match: /^settings$/i, tag: 'settings'},
  {match: /^quit$/i, tag: 'quit'},
  {match: /^open$/i, tag: 'open'},
  {match: /^close$/i, tag: 'close'},
  {match: /^run$/i, tag: 'run'}
];

let HIDDEN_TITLES = new Set();

const tagMenuEntry = (entry) => {
  const label = entry.querySelector('span:last-child');
  if (!label) return;
  const text = (label.textContent || '').trim();

  // Hide entries whose title matches a grouped/hidden app
  if (HIDDEN_TITLES.has(text)) {
    entry.dataset.labelAction = 'hidden';
    return;
  }

  if (entry.dataset.labelAction && entry.dataset.labelAction !== 'hidden') return;

  for (const {match, tag} of LABEL_TAGS) {
    if (match.test(text)) {
      entry.dataset.labelAction = tag;
      return;
    }
  }
};

const tagAllMenuEntries = (root = document) => {
  root.querySelectorAll('.osjs-gui-menu-entry').forEach(tagMenuEntry);
};

const slug = (text) => (text || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const tagWindowHeader = (header) => {
  const title = header.querySelector('.osjs-window-title');
  if (!title) return;
  const s = slug(title.textContent);
  if (s) header.dataset.appTitle = s;
};

const tagAllWindowHeaders = (root = document) => {
  root.querySelectorAll('.osjs-window-header').forEach(tagWindowHeader);
};

const observeMenus = () => {
  let pending = false;
  const retagAll = () => {
    pending = false;
    document.querySelectorAll('.osjs-gui-menu-entry').forEach((el) => {
      delete el.dataset.labelAction;
      tagMenuEntry(el);
    });
    tagAllWindowHeaders();
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(retagAll);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
};

const playStartupChime = () => {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const now = ctx.currentTime;
    // Soft ascending major triad: C5, E5, G5, then sustained C6 on top
    const voices = [
      {f: 523.25, start: 0.00, vel: 0.18, len: 2.4},
      {f: 659.25, start: 0.12, vel: 0.16, len: 2.3},
      {f: 783.99, start: 0.24, vel: 0.15, len: 2.2},
      {f: 1046.5, start: 0.36, vel: 0.13, len: 2.1}
    ];
    const master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);
    voices.forEach(({f, start, vel, len}) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const t0 = now + start;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(vel, t0 + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      osc.connect(gain).connect(master);
      osc.start(t0);
      osc.stop(t0 + len + 0.05);
    });
  } catch (e) { /* audio may be blocked — ignore */ }
};

const muteDefaultLoginLogout = (core) => {
  try {
    if (!core.has('osjs/sounds')) return;
    const sounds = core.make('osjs/sounds');
    const orig = sounds.play.bind(sounds);
    sounds.play = (name) => {
      if (name === 'service-login' || name === 'service-logout') return;
      return orig(name);
    };
  } catch (e) {}
};

const refreshHiddenTitles = (core) => {
  try {
    const packages = core.make('osjs/packages');
    const list = (typeof packages.getPackages === 'function')
      ? packages.getPackages((m) => m && m.jaby && m.jaby.hidden === true)
      : (packages.metadata || []).filter((m) => m && m.jaby && m.jaby.hidden === true);
    HIDDEN_TITLES = new Set(
      list
        .map((m) => (m.title && (m.title.en_EN || m.title)) || m.name)
        .filter(Boolean)
    );
  } catch (e) {}
};

export const register = (core, desktop, options, metadata) => {
  refreshHiddenTitles(core);
  observeMenus();
  tagAllMenuEntries();
  tagAllWindowHeaders();
  muteDefaultLoginLogout(core);


  desktop.on('theme:window:change', (win, name, value) => {
    if (name === 'minimized' && value === false) {
      win.state.styles.display = 'block';
      win._updateDOM();
    }
  });

  desktop.on('theme:window:transitionend', (ev, win) => {
    if (ev.propertyName === 'opacity') {
      const {$element} = win;
      const css = window.getComputedStyle($element);

      win.state.styles.display = css.visibility === 'hidden'
        ? 'none'
        : 'block';

      win._updateDOM();
    }
  });
};

