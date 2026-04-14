#!/usr/bin/env node

// Discover JabyOS apps from the Docker socket by reading Traefik labels.
// Writes apps.config.json in the same shape consumed by build-apps.js.
//
// Pipeline:
//   scripts/discover-apps.js  →  apps.config.json  →  scripts/build-apps.js
//                                                  →  npm run package:discover
//                                                  →  npm run build
//
// Labels we consume:
//   traefik.enable=true                              (required)
//   traefik.http.routers.<r>.rule                    (Host(`x.y.z`) → url)
//   traefik.http.routers.<r>.entrypoints             (websecure → https)
//   traefik.http.routers.<r>.tls(=true)              (https hint)
//   jabyos.title=Display Name                        (override title)
//   jabyos.icon=television|folder|...                (one of build-apps.js ICONS)
//   jabyos.color=#hex                                (accent color)
//   jabyos.hidden=true                               (skip)
//   jabyos.url=https://…                             (override url entirely)
//   jabyos.priority=N                                (sort; higher = earlier)
//   jabyos.width=1200 / jabyos.height=800            (window size)

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_OUT = path.join(ROOT, 'apps.config.json');
const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

const CAP = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const stripComposeSuffix = (name) => name
  .replace(/^\//, '')
  .replace(/-\d+$/, '');  // strip trailing compose instance suffix (-1)

const dedupTokens = (tokens) => {
  const out = [];
  for (const t of tokens) {
    if (!out.length || out[out.length - 1].toLowerCase() !== t.toLowerCase()) {
      out.push(t);
    }
  }
  return out;
};

const tokensOf = (name) => dedupTokens(
  stripComposeSuffix(name).split(/[-_\s.]+/).filter(Boolean)
);

const titleFromName = (name) => tokensOf(name).map(CAP).join(' ') || name;

const slugToPascal = (name) => tokensOf(name)
  .map((p) => CAP(p.toLowerCase()))
  .join('') || 'App';

const CATEGORY_FROM_ICON = {
  television: 'multimedia',
  film: 'multimedia',
  'play-circle': 'multimedia',
  download: 'network',
  'magnifying-glass': 'utility',
  sparkle: 'utility',
  folder: 'utility',
  default: 'utility'
};

const guessFromName = (nameLc) => {
  if (/sonarr|tv/.test(nameLc)) return {icon: 'television', color: '#35c5f0', category: 'multimedia'};
  if (/radarr|movie|film/.test(nameLc)) return {icon: 'film', color: '#ffc230', category: 'multimedia'};
  if (/prowlarr|jackett|indexer/.test(nameLc)) return {icon: 'magnifying-glass', color: '#f97316', category: 'multimedia'};
  if (/plex|jellyfin|emby|media/.test(nameLc)) return {icon: 'play-circle', color: '#e5a00d', category: 'multimedia'};
  if (/seerr|overseerr|ombi|request/.test(nameLc)) return {icon: 'sparkle', color: '#a855f7', category: 'multimedia'};
  if (/torrent|qbit|transmission|deluge|flood|aria|airdc|dc\+\+/.test(nameLc)) return {icon: 'download', color: '#22c55e', category: 'network'};
  if (/file|nextcloud|owncloud|seafile|filebrowser/.test(nameLc)) return {icon: 'folder', color: '#3b82f6', category: 'utility'};
  return {icon: 'default', color: '#3b82f6', category: 'utility'};
};

const fetchContainers = () => new Promise((resolve, reject) => {
  const req = http.request({
    socketPath: SOCKET,
    path: '/containers/json?all=false',
    method: 'GET',
    headers: {'Host': 'localhost'}
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      } else {
        reject(new Error(`Docker API HTTP ${res.statusCode}: ${body}`));
      }
    });
  });
  req.on('error', reject);
  req.end();
});

const extractHosts = (ruleValue) => {
  const out = [];
  const re = /Host\(\s*`([^`]+)`\s*\)/g;
  let m;
  while ((m = re.exec(ruleValue))) out.push(m[1]);
  return out;
};

const containerToApp = (c) => {
  const labels = c.Labels || {};
  if (labels['traefik.enable'] !== 'true') return null;
  if (labels['jabyos.hidden'] === 'true') return null;

  // Group label keys per router name: traefik.http.routers.<router>.<field>
  const routers = {};
  for (const [k, v] of Object.entries(labels)) {
    const m = k.match(/^traefik\.http\.routers\.([^.]+)\.(.+)$/);
    if (!m) continue;
    (routers[m[1]] ||= {})[m[2]] = v;
  }

  // Collect all hosts across all routers; prefer secure ones first
  let hosts = [];
  let secure = false;
  for (const [, r] of Object.entries(routers)) {
    if (!r.rule) continue;
    const rhosts = extractHosts(r.rule);
    if (!rhosts.length) continue;
    const isSecure = /websecure/.test(r.entrypoints || '') || r.tls === 'true' || /\.tls$/i.test(Object.keys(r).join('|'));
    if (isSecure) secure = true;
    hosts = hosts.concat(rhosts.map((h) => ({host: h, secure: isSecure})));
  }
  if (!hosts.length) return null;

  hosts.sort((a, b) => Number(b.secure) - Number(a.secure));
  const chosen = hosts[0];

  const rawName = (c.Names && c.Names[0]) || c.Id.slice(0, 12);
  const pascal = slugToPascal(rawName);
  const nameLc = rawName.replace(/^\//, '').toLowerCase();
  const guess = guessFromName(nameLc);

  const override = (k) => labels[`jabyos.${k}`];
  const url = override('url') || `${chosen.secure ? 'https' : 'http'}://${chosen.host}`;

  // Group resolution: explicit label > compose project (opt-out with jabyos.group=false)
  let group;
  if (override('group') === 'false') {
    group = null;
  } else if (override('group')) {
    group = override('group');
  } else if (labels['com.docker.compose.project']) {
    group = labels['com.docker.compose.project'];
  }

  return {
    name: override('name') || pascal,
    title: override('title') || titleFromName(rawName),
    url,
    icon: override('icon') || guess.icon,
    color: override('color') || guess.color,
    category: override('category') || guess.category,
    group: group || undefined,
    groupTitle: override('group.title') || undefined,
    groupIcon: override('group.icon') || undefined,
    groupColor: override('group.color') || undefined,
    width: Number(override('width')) || undefined,
    height: Number(override('height')) || undefined,
    priority: Number(override('priority')) || 0,
    _sourceContainer: rawName.replace(/^\//, '')
  };
};

const main = async () => {
  let containers;
  try {
    containers = await fetchContainers();
  } catch (e) {
    console.error(`⚠  Could not reach Docker socket at ${SOCKET}: ${e.message}`);
    console.error('   Keeping existing apps.config.json unchanged.');
    process.exit(0);
  }

  const apps = [];
  const seen = new Set();
  for (const c of containers) {
    const app = containerToApp(c);
    if (!app) continue;
    if (seen.has(app.name)) continue;
    seen.add(app.name);
    apps.push(app);
  }

  apps.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  // Build groups; only keep groups with >=2 members
  const groups = {};
  for (const a of apps) {
    if (!a.group) continue;
    const g = groups[a.group] || (groups[a.group] = {members: 0});
    g.members++;
    if (a.groupTitle && !g.title) g.title = a.groupTitle;
    if (a.groupIcon && !g.icon) g.icon = a.groupIcon;
    if (a.groupColor && !g.color) g.color = a.groupColor;
    if (!g.category) g.category = a.category;
  }
  for (const a of apps) {
    if (a.group && groups[a.group] && groups[a.group].members < 2) {
      delete a.group;
    }
  }
  for (const name of Object.keys(groups)) {
    const g = groups[name];
    if (g.members < 2) { delete groups[name]; continue; }
    if (!g.title) g.title = titleFromName(name);
    if (!g.icon) g.icon = 'folder';
    if (!g.color) g.color = '#6366f1';
    delete g.members;
  }

  for (const a of apps) {
    delete a.priority;
    delete a._sourceContainer;
    delete a.groupTitle;
    delete a.groupIcon;
    delete a.groupColor;
    for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
  }

  const force = process.argv.includes('--force');
  let existingHasApps = false;
  if (fs.existsSync(CONFIG_OUT)) {
    try {
      const cur = JSON.parse(fs.readFileSync(CONFIG_OUT, 'utf8'));
      existingHasApps = Array.isArray(cur.apps) && cur.apps.length > 0;
    } catch (_) {}
  }

  if (apps.length === 0 && existingHasApps && !force) {
    console.log('⚠  Discovered 0 Traefik-routed apps but existing apps.config.json has entries — keeping it.');
    console.log('   Pass --force to overwrite with an empty list.');
    process.exit(0);
  }

  const out = {
    $schema: 'Generated by scripts/discover-apps.js from Docker Traefik labels. Regenerate any time; do not hand-edit.',
    apps,
    groups
  };

  fs.writeFileSync(CONFIG_OUT, JSON.stringify(out, null, 2) + '\n');
  const groupCount = Object.keys(groups).length;
  console.log(`✔ Discovered ${apps.length} app(s), ${groupCount} group(s):`);
  for (const a of apps) console.log(`   ${a.name.padEnd(18)} → ${a.url}${a.group ? '  [group: ' + a.group + ']' : ''}`);
  for (const [n, g] of Object.entries(groups)) console.log(`   📁 ${g.title} (${n})`);
};

main();
