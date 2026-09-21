/**
 * Builds every brand asset from one hand-drawn mark.  Run: npm run brand
 * Needs `sharp` (npm i -D sharp). Output: packages/design/brand/
 *
 * The mark: a code bracket pair "< >" (the name) around perspective road markings (the street).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let sharp;
try { sharp = require('sharp'); } catch {
  try { sharp = require(path.join(execSync('npm root -g').toString().trim(), 'sharp')); } catch { console.error('sharp is required: npm i -D sharp'); process.exit(1); }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'packages/design/brand');
fs.mkdirSync(out, { recursive: true });

const C = { graphite: '#121415', amber: '#E3A008', rust: '#C8501A', paper: '#ECEAE4' };

/** The mark, drawn in a 512 box. `ink` is the colour of the symbol. */
const glyph = (ink) => `
  <g fill="none" stroke="${ink}" stroke-width="46" stroke-linecap="square" stroke-linejoin="miter">
    <path d="M198 146 L92 256 L198 366"/>
    <path d="M314 146 L420 256 L314 366"/>
  </g>
  <g fill="${ink}">
    <path d="M245 118 L267 118 L270 186 L242 186 Z"/>
    <path d="M238 230 L274 230 L284 396 L228 396 Z"/>
  </g>`;

/** Place the glyph scaled about the centre of the 512 box. */
const placed = (ink, scale) => `<g transform="translate(256 256) scale(${scale}) translate(-256 -256)">${glyph(ink)}</g>`;

const variants = {
  app:     { tile: C.amber,    ink: C.graphite, strip: null,   prefix: '' },
  command: { tile: C.graphite, ink: C.amber,    strip: C.rust, prefix: 'command-' },
};

/** Full SVG document. bleed=true => square edge-to-edge tile (for OS-masked icons). */
function svg({ v, size = 512, bleed = false, scale = 1, tile = true, corner = 112 }) {
  const t = variants[v];
  const bg = tile ? (bleed ? `<rect width="512" height="512" fill="${t.tile}"/>` : `<rect width="512" height="512" rx="${corner}" fill="${t.tile}"/>`) : '';
  const strip = tile && t.strip ? (bleed ? `<rect y="474" width="512" height="38" fill="${t.strip}"/>` : `<clipPath id="c"><rect width="512" height="512" rx="${corner}"/></clipPath><rect y="474" width="512" height="38" fill="${t.strip}" clip-path="url(#c)"/>`) : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">${bg}${strip}${placed(t.ink, scale)}</svg>`;
}

const write = (name, data) => fs.writeFileSync(path.join(out, name), data);
const png = async (name, svgText, size, opts = {}) => {
  const buf = await sharp(Buffer.from(svgText), { density: 384 }).resize(size, opts.h || size).png({ compressionLevel: 9 }).toBuffer();
  write(name, buf);
  return buf;
};

const made = [];
for (const [key, t] of Object.entries(variants)) {
  const p = t.prefix;
  // Scalable marks
  write(`${p}mark.svg`, svg({ v: key }));
  write(`${p}mark-glyph.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${glyph(t.tile === C.amber ? C.graphite : C.amber)}</svg>`);

  // Favicon: a slightly simplified, heavier version so it survives at 16px
  const fav = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="120" fill="${t.tile}"/>${t.strip ? `<clipPath id="c"><rect width="512" height="512" rx="120"/></clipPath><rect y="466" width="512" height="46" fill="${t.strip}" clip-path="url(#c)"/>` : ''}<g fill="none" stroke="${t.ink}" stroke-width="64" stroke-linecap="square" stroke-linejoin="miter"><path d="M190 140 L86 256 L190 372"/><path d="M322 140 L426 256 L322 372"/></g><rect x="232" y="128" width="48" height="256" fill="${t.ink}"/></svg>`;
  write(`${p}favicon.svg`, fav);
  const f16 = await png(`${p}favicon-16.png`, fav, 16);
  const f32 = await png(`${p}favicon-32.png`, fav, 32);
  const f48 = await png(`${p}favicon-48.png`, fav, 48);

  // Multi-size .ico with embedded PNGs (supported by every current browser and by Windows)
  const parts = [[16, f16], [32, f32], [48, f48]];
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(parts.length, 4);
  let offset = 6 + parts.length * 16;
  const dir = Buffer.concat(parts.map(([s, b]) => { const e = Buffer.alloc(16); e[0] = s; e[1] = s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(b.length, 8); e.writeUInt32LE(offset, 12); offset += b.length; return e; }));
  write(`${p}favicon.ico`, Buffer.concat([head, dir, ...parts.map(([, b]) => b)]));

  // Home-screen and app icons
  await png(`${p}apple-touch-icon.png`, svg({ v: key, bleed: true, scale: 0.8 }), 180);       // iOS rounds it itself
  await png(`${p}icon-192.png`, svg({ v: key }), 192);
  await png(`${p}icon-512.png`, svg({ v: key }), 512);
  await png(`${p}maskable-192.png`, svg({ v: key, bleed: true, scale: 0.62 }), 192);          // inside the 80% safe zone
  await png(`${p}maskable-512.png`, svg({ v: key, bleed: true, scale: 0.62 }), 512);

  // Android adaptive icon layers (108dp @4x = 432px, content inside the 66% safe zone)
  await png(`${p}adaptive-foreground-432.png`, svg({ v: key, tile: false, scale: 0.5 }).replace('<svg ', '<svg '), 432);
  write(`${p}adaptive-background.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="432" height="432"><rect width="432" height="432" fill="${t.tile}"/>${t.strip ? `<rect y="396" width="432" height="36" fill="${t.strip}"/>` : ''}</svg>`);
  await png(`${p}adaptive-background-432.png`, fs.readFileSync(path.join(out, `${p}adaptive-background.svg`), 'utf8'), 432);

  // Windows tiles (transparent tile art; the browserconfig TileColor shows behind it)
  for (const s of [70, 150, 310]) await png(`${p}mstile-${s}.png`, svg({ v: key, scale: 1 }), s);
  const wide = `<svg xmlns="http://www.w3.org/2000/svg" width="620" height="300" viewBox="0 0 620 300"><rect width="620" height="300" fill="${t.tile}"/>${t.strip ? `<rect y="272" width="620" height="28" fill="${t.strip}"/>` : ''}<g transform="translate(154 30) scale(0.6)">${glyph(t.ink)}</g><rect x="464" y="120" width="10" height="60" fill="${t.ink}" opacity=".0"/></svg>`;
  await png(`${p}mstile-310x150.png`, wide, 310, { h: 150 });

  made.push(key);
}

// Safari pinned-tab icon: single colour, no tile
write('safari-pinned-tab.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${glyph('#000')}</svg>`);

write('browserconfig.xml', `<?xml version="1.0" encoding="utf-8"?>
<browserconfig><msapplication><tile>
  <square70x70logo src="/design/brand/mstile-70.png"/>
  <square150x150logo src="/design/brand/mstile-150.png"/>
  <square310x310logo src="/design/brand/mstile-310.png"/>
  <wide310x150logo src="/design/brand/mstile-310x150.png"/>
  <TileColor>${C.graphite}</TileColor>
</tile></msapplication></browserconfig>
`);

const manifest = (o) => JSON.stringify({
  lang: 'en-GB', dir: 'ltr', display: 'standalone', orientation: 'portrait-primary', categories: ['automotive', 'utilities'],
  ...o,
  icons: [
    { src: `/design/brand/${o.p}icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: `/design/brand/${o.p}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: `/design/brand/${o.p}maskable-192.png`, sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: `/design/brand/${o.p}maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: `/design/brand/${o.p}favicon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  ],
  p: undefined,
}, null, 2);

fs.writeFileSync(path.join(root, 'apps/mobile/manifest.webmanifest'), manifest({
  p: '', id: '/app/', name: 'Street Code', short_name: 'Street Code', description: 'Your vehicles, servicing, drivers and papers in one place.',
  start_url: '/app/', scope: '/app/', background_color: C.paper, theme_color: C.graphite,
  shortcuts: [
    { name: 'My garage', url: '/app/#/garage', icons: [{ src: '/design/brand/icon-192.png', sizes: '192x192' }] },
    { name: 'Start driving', url: '/app/#/drive', icons: [{ src: '/design/brand/icon-192.png', sizes: '192x192' }] },
    { name: 'Alerts', url: '/app/#/alerts', icons: [{ src: '/design/brand/icon-192.png', sizes: '192x192' }] },
  ],
}));
fs.writeFileSync(path.join(root, 'apps/command/manifest.webmanifest'), manifest({
  p: 'command-', id: '/command/', name: 'Street Code Command', short_name: 'SC Command', description: 'Roadside vehicle and licence checks for the police.',
  start_url: '/command/', scope: '/command/', background_color: C.graphite, theme_color: C.graphite, orientation: 'any',
}));

console.log(`Brand built (${made.join(', ')}): ${fs.readdirSync(out).length} files in ${path.relative(root, out)}`);
