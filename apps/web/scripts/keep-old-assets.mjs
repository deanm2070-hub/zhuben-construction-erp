// Keeps the hashed files of the last few builds next to the new ones. A page opened before a deploy (or the installed
// app left open) loads parts on demand (DWG reader, SketchUp reader, exports) by their old names; without this they
// are gone the moment the new build goes live and the import fails until the page is reloaded.
// Reads the live site's assets-history.json, downloads the files of earlier builds that this build does not have, and
// writes the new history. Any network failure only means fewer old files are kept: the build never fails over it.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE = (process.env.SITE_URL || 'https://zhuben-construction-erp.deanm2070.workers.dev').replace(/\/$/, '');
const KEEP_BUILDS = 4, KEEP_DAYS = 14;
const dist = new URL('../dist/', import.meta.url).pathname, assets = join(dist, 'assets');
const { build } = JSON.parse(readFileSync(join(dist, 'version.json'), 'utf8'));
const mine = readdirSync(assets);

const get = async (path, type) => {
  const r = await fetch(`${SITE}/${path}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return type === 'json' ? r.json() : type === 'text' ? r.text() : Buffer.from(await r.arrayBuffer());
};

let past = [];
try {
  past = (await get('assets-history.json', 'json')).builds || [];
} catch {
  // the first time: what the live build uses, read from its page and its main script
  try {
    const html = await get('', 'text'), files = new Set([...html.matchAll(/assets\/([\w.-]+)/g)].map(m => m[1]));
    for (const f of [...files]) if (f.endsWith('.js')) for (const m of (await get(`assets/${f}`, 'text')).matchAll(/assets\/([\w.-]+\.(?:js|css|wasm))|"\.\/([\w.-]+\.(?:js|css|wasm))"/g)) files.add(m[1] || m[2]);
    if (files.size) past = [{ build: 'live', files: [...files] }];
  } catch (e) { console.warn('keep-old-assets: live site not reachable,', e.message); }
}
past = past.filter(b => b.build !== build && (b.build === 'live' || Date.now() - Date.parse(b.build) < KEEP_DAYS * 864e5)).slice(0, KEEP_BUILDS);

const kept = [];
for (const b of past) {
  const have = [];
  for (const f of b.files) {
    if (!/^[\w.-]+$/.test(f)) continue;
    if (existsSync(join(assets, f))) { have.push(f); continue; }
    try { mkdirSync(assets, { recursive: true }); writeFileSync(join(assets, f), await get(`assets/${f}`)); have.push(f); kept.push(f); }
    catch (e) { console.warn('keep-old-assets: skipped', f, e.message); }
  }
  b.files = have;
}
writeFileSync(join(dist, 'assets-history.json'), JSON.stringify({ builds: [{ build, files: mine }, ...past.filter(b => b.files.length)] }));
console.log(`keep-old-assets: ${kept.length} files of ${past.length} earlier build(s) kept`);
