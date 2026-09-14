'use strict';
/**
 * ============================================================================
 * KyyPureStatus — Generator ikon & aset brand
 * ============================================================================
 * Sumber aset (vector, tinggal edit kalau mau rebranding):
 *   client/public/brand/logo-mark.svg        → app icon (rounded, ada shine)
 *   client/public/brand/logo-mark-flat.svg   → maskable icon + favicon kecil
 *   client/public/brand/logo-mark-mono.svg   → versi mono (buat kalau butuh)
 *
 * Jalankan:  npm run icons
 *
 * Mesin render dipilih otomatis (urut prioritas):
 *   1. sharp          → npm i -D sharp          (paling praktis, node-native)
 *   2. python3+cairo  → pip install cairosvg    (butuh python di mesin ini)
 *   3. ffmpeg         → kalau build-nya ada librsvg (decoder svg)
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'client', 'public');
const BRAND = path.join(PUB, 'brand');

const TARGETS = [
  { src: 'logo-mark.svg', out: 'icons/icon-192.png', size: 192 },
  { src: 'logo-mark.svg', out: 'icons/icon-512.png', size: 512 },
  { src: 'logo-mark.svg', out: 'icons/icon-1024.png', size: 1024 },
  { src: 'logo-mark-flat.svg', out: 'icons/maskable-512.png', size: 512 },
  { src: 'logo-mark.svg', out: 'apple-touch-icon.png', size: 180 },
  { src: 'logo-mark.svg', out: 'favicon.png', size: 64 },
  { src: 'logo-mark.svg', out: 'favicon-48.png', size: 48 },
  { src: 'logo-mark-flat.svg', out: 'favicon-32.png', size: 32 },
];

/* ---------------- mesin render ---------------- */

function hasSharp() {
  try { require.resolve('sharp'); return true; } catch { return false; }
}
function hasPythonCairo() {
  const r = spawnSync('python3', ['-c', 'import cairosvg'], { encoding: 'utf8' });
  return r.status === 0;
}
function hasFfmpegSvg() {
  const bin = process.env.FFMPEG_PATH || (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();
  const r = spawnSync(bin, ['-hide_banner', '-decoders'], { encoding: 'utf8' });
  return r.status === 0 && /svg/.test(r.stdout || '');
}

async function renderSharp(svg, out, size) {
  const sharp = require('sharp');
  await sharp(fs.readFileSync(svg), { density: Math.max(72, Math.round((size / 1024) * 384)) })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(out);
  return true;
}

function renderCairo(svg, out, size) {
  const py = `import cairosvg,sys
cairosvg.svg2png(url=sys.argv[1], write_to=sys.argv[2], output_width=int(sys.argv[3]), output_height=int(sys.argv[3]))`;
  const r = spawnSync('python3', ['-c', py, svg, out, String(size)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || 'cairosvg gagal').trim().split('\n').slice(-1)[0]);
  return true;
}

function renderFfmpeg(svg, out, size) {
  const bin = process.env.FFMPEG_PATH || (() => { try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; } })();
  const r = spawnSync(
    bin,
    ['-hide_banner', '-loglevel', 'error', '-i', svg, '-vf', `scale=${size}:${size}:flags=lanczos`, '-frames:v', '1', '-y', out],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error((r.stderr || 'ffmpeg gagal').trim().split('\n').slice(-1)[0]);
  return true;
}

/* ---------------- main ---------------- */
(async () => {
  const engine = hasSharp() ? 'sharp' : hasPythonCairo() ? 'python-cairosvg' : hasFfmpegSvg() ? 'ffmpeg(librsvg)' : null;
  if (!engine) {
    console.error(
      '❌ Gak ada mesin render SVG yang tersedia.\n' +
      '   Pilih salah satu:\n' +
      '     • npm i -D sharp            (rekomendasi)\n' +
      '     • pip install cairosvg\n' +
      '     • install ffmpeg dengan dukungan librsvg\n' +
      '   Catatan: ikon PNG yang sekarang ada di client/public sudah jadi,\n' +
      '   jadi generator ini cuma perlu kalau mau ganti logo.'
    );
    process.exit(1);
  }
  console.log(`🎨 Render ikon pakai: ${engine}\n`);

  let ok = 0;
  let fail = 0;
  for (const t of TARGETS) {
    const input = path.join(BRAND, t.src);
    const output = path.join(PUB, t.out);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    if (!fs.existsSync(input)) {
      console.log(`⚠  skip (SVG gak ada): ${t.src}`);
      fail += 1;
      continue;
    }
    try {
      if (engine === 'sharp') await renderSharp(input, output, t.size);
      else if (engine === 'python-cairosvg') renderCairo(input, output, t.size);
      else renderFfmpeg(input, output, t.size);
      console.log(`✅ ${t.out} — ${t.size}px · ${(fs.statSync(output).size / 1024).toFixed(1)} KB`);
      ok += 1;
    } catch (e) {
      console.log(`❌ ${t.out} — ${e.message}`);
      fail += 1;
    }
  }
  console.log(`\nSelesai: ${ok} dibuat, ${fail} gagal.`);
  process.exit(fail ? 1 : 0);
})();
