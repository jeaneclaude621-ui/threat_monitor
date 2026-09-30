// Renders the app icons from dev/icon/*.svg into public/.
//   node dev/icon/render.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const here = new URL('.', import.meta.url);
const out = new URL('../../public/', import.meta.url);
const jobs = [
  ['icon.svg', 'apple-touch-icon.png', 180],
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
];
for (const [src, dest, size] of jobs) {
  const svg = readFileSync(new URL(src, here), 'utf8');
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(new URL(dest, out), png);
  console.log(dest, size, png.length, 'bytes');
}
