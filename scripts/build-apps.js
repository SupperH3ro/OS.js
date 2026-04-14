#!/usr/bin/env node

// Generate iframe-backed JabyOS app packages directly into their dist/
// state — no webpack needed. Each app is trivial wrapper code.
//
// Reads apps.config.json; outputs src/packages/apps/<Name>/ with
// metadata.json, package.json, and a ready-to-serve dist/{main.js,icon.svg}.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'apps.config.json');
const OUT = path.join(ROOT, 'src/packages/apps');

const ICONS = {
  television: (c) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${c}' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><rect x='2' y='5' width='20' height='13' rx='2' fill='${c}22'/><path d='M8 21h8M12 18v3'/><path d='M7 9l3 3-3 3'/></svg>`,
  film: (c) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${c}' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='4' width='18' height='16' rx='2' fill='${c}22'/><path d='M3 8h4M17 8h4M3 16h4M17 16h4M7 4v16M17 4v16'/></svg>`,
  'magnifying-glass': (c) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${c}' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><circle cx='11' cy='11' r='7' fill='${c}22'/><path d='m21 21-4.3-4.3'/></svg>`,
  sparkle: (c) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${c}' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><path d='M12 3l2.5 6 6 2.5-6 2.5L12 20l-2.5-6-6-2.5 6-2.5z' fill='${c}22'/></svg>`,
  download: (c) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${c}' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9' fill='${c}22'/><path d='M12 7v8M8 11l4 4 4-4'/></svg>`,
  folder: (c) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${c}' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'><path d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' fill='${c}22'/><path d='M3 11h18' opacity='0.5'/></svg>`,
  'play-circle': (c) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${c}' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9' fill='${c}22'/><path d='M10 8l6 4-6 4z' fill='${c}' stroke='none'/></svg>`,
  default: (c) => `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${c}' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'><rect x='3' y='4' width='18' height='16' rx='2' fill='${c}22'/><path d='M3 9h18'/></svg>`
};

const iconSvg = (app) => {
  const color = app.color || '#3b82f6';
  const fn = ICONS[app.icon] || ICONS.default;
  return fn(color);
};

const metadata = (app) => ({
  type: 'application',
  name: app.name,
  icon: 'icon.svg',
  category: 'jabyapps',
  singleton: true,
  server: null,
  title: {en_EN: app.title},
  description: {en_EN: app.title},
  files: ['main.js'],
  jaby: {
    url: app.url,
    color: app.color || '#3b82f6'
  }
});

const pkgJson = (app) => ({
  name: `@jabyos/app-${app.name.toLowerCase()}`,
  version: '0.1.0',
  description: `JabyOS iframe app: ${app.title}`,
  files: ['dist/', 'metadata.json'],
  osjs: {type: 'package'}
});

// Pre-baked dist/main.js — no webpack, just IIFE using window.OSjs.
const distMain = (app) => `(function(){
  var APP = ${JSON.stringify(app.name)};
  var URL = ${JSON.stringify(app.url)};
  var W = ${app.width || 1200};
  var H = ${app.height || 800};
  var T = ${JSON.stringify(app.title)};

  function register(core, args, options, metadata) {
    var proc = core.make('osjs/application', {args: args, options: options, metadata: metadata});
    proc.createWindow({
      id: APP + 'Window',
      title: T,
      icon: proc.resource(metadata.icon),
      dimension: {width: W, height: H},
      position: {left: 160, top: 80}
    })
      .on('destroy', function () { proc.destroy(); })
      .render(function ($content) {
        var iframe = document.createElement('iframe');
        iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;';
        iframe.src = URL;
        iframe.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write; autoplay; encrypted-media; camera; microphone; geolocation');
        iframe.setAttribute('allowfullscreen', 'true');
        $content.appendChild(iframe);
      });
    return proc;
  }

  if (typeof window !== 'undefined' && window.OSjs && window.OSjs.register) {
    window.OSjs.register(APP, register);
  }
})();
`;

const main = () => {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, {recursive: true});

  const keep = new Set(cfg.apps.map((a) => a.name));
  for (const dir of fs.readdirSync(OUT)) {
    if (!keep.has(dir)) {
      fs.rmSync(path.join(OUT, dir), {recursive: true, force: true});
      console.log(`- removed ${dir}`);
    }
  }

  for (const app of cfg.apps) {
    const dir = path.join(OUT, app.name);
    // Wipe and regen to avoid stale files from older generator versions
    fs.rmSync(dir, {recursive: true, force: true});
    const distDir = path.join(dir, 'dist');
    fs.mkdirSync(distDir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata(app), null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson(app), null, 2) + '\n');
    fs.writeFileSync(path.join(distDir, 'main.js'), distMain(app));
    fs.writeFileSync(path.join(distDir, 'icon.svg'), iconSvg(app));
    console.log(`+ ${app.name.padEnd(12)} → ${app.url}`);
  }

  console.log(`\n✔ ${cfg.apps.length} iframe app(s) generated.`);
  console.log('  Next: npm run package:discover && npm run build');
};

main();
