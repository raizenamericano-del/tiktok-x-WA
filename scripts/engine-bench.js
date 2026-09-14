'use strict';
/**
 * ============================================================================
 * KyyPureStatus — Engine Benchmark  v4 (metrik yang BENER)
 * ============================================================================
 * Kenapa SSIM mentah menyesatkan?
 *   Video hasil kita BUKAN hasil akhir — WhatsApp Status akan meng-encode
 *   ulang videonya. Yang menentukan "tajam atau pecah" di Status adalah
 *   seberapa banyak detail yang MASIH TERSISA setelah re-encode itu.
 *
 * Metrik di script ini:
 *   1) Encode sumber pakai masing-masing engine (v3 lama vs v4 PureHD).
 *   2) Simulasi re-encode WhatsApp (2 profil: status HD & status hemat).
 *   3) Ukur SSIM + PSNR hasil simulasi vs VIDEO SUMBER ASLI.
 *      → nilai lebih tinggi = detail lebih banyak yang bertahan = lebih tajam.
 *
 * Jalankan:
 *   node scripts/engine-bench.js                 (pakai file di /samples)
 *   node scripts/engine-bench.js video1.mp4 ...  (file sendiri)
 *   node scripts/engine-bench.js --hq            (pakai sumber HQ sintetis 1080p 20Mbps)
 * ============================================================================
 */
process.env.FFMPEG_THREADS = process.env.FFMPEG_THREADS || '4';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const videoLib = require('../server/video');

const OUT = path.join(os.tmpdir(), 'kyps_bench');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const BIN = videoLib.BIN;
const PROBE_BIN = videoLib.PROBE;
const THREADS = process.env.FFMPEG_THREADS || '4';

/* ---------- parameter engine LAMA (v3, apa adanya dari git history) ---------- */
const V3 = {
  params: 'ref=4:bframes=3:me=umh:subq=7:rc-lookahead=40:me_range=24',
  profile: (dur) => (dur <= 30
    ? { key: '1080p', crf: 17, mbps: 6, box: { w: 1920, h: 1080 } }
    : dur <= 60
    ? { key: '720p', crf: 17, mbps: 4, box: { w: 1280, h: 720 } }
    : { key: '480p', crf: 16, mbps: 2.5, box: { w: 854, h: 480 } }),
};

/* ---------- simulasi re-encode WhatsApp Status ---------- */
const WA_PROFILES = {
  'WA-status-hd': ['-vf', 'scale=-2:min(1280\\,ih)', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-maxrate', '2200k', '-bufsize', '4400k', '-r', '30', '-c:a', 'aac', '-b:a', '96k'],
  'WA-status-low': ['-vf', 'scale=-2:min(720\\,ih)', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '31', '-maxrate', '1100k', '-bufsize', '2200k', '-r', '30', '-c:a', 'aac', '-b:a', '64k'],
};

/* ---------- helper ffmpeg ---------- */
function run(args, collect = false) {
  return new Promise((resolve, reject) => {
    const p = spawn(BIN, args, { stdio: ['ignore', collect ? 'pipe' : 'ignore', 'pipe'] });
    let err = '';
    let out = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    if (collect) p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').slice(-3).join(' | ')))));
    p.on('error', reject);
  });
}

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const mb = (b) => `${(b / 1048576).toFixed(2)} MB`;

/**
 * Ukur SSIM + PSNR vs referensi.
 * Catatan penting:
 *  - Statistik filter ffmpeg ditulis ke **stderr** (versi awal script ini salah baca stdout → 0).
 *  - Video uji hasil simulasi WA resolusinya bisa beda dari sumber (WA nge-scale),
 *    jadi keduanya di-scale ke dimensi yang sama dulu — kalau tidak, ffmpeg nolak
 *    ("Width and height of input videos must be same").
 */
function probeDims(file) {
  const r = spawnSync(PROBE_BIN, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' });
  const [w, h] = (r.stdout || '').trim().split(',').map(Number);
  return w && h ? { w, h } : null;
}

async function measure(ref, test, dims) {
  const d = dims || probeDims(test) || { w: 1280, h: 720 };
  const W = d.w - (d.w % 2);
  const H = d.h - (d.h % 2);
  const graph = (filter) =>
    `[0:v]scale=${W}:${H}:flags=bicubic[ref];[1:v]scale=${W}:${H}[t];[ref][t]${filter}`;

  const grab = (filter, re) =>
    new Promise((resolve) => {
      const p = spawn(BIN, ['-hide_banner', '-nostdin', '-i', ref, '-i', test, '-lavfi', graph(filter), '-f', 'null', '-'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buf = '';
      const onData = (x) => { buf += x.toString(); };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      p.on('close', () => {
        const m = [...buf.matchAll(re)].map((x) => parseFloat(x[1]));
        resolve(m.length ? m[m.length - 1] : null);
      });
      p.on('error', () => resolve(null));
    });

  const [ssim, psnr] = await Promise.all([
    grab('ssim', /All:([\d.]+)/g),
    grab('psnr', /average:([\d.]+)/g),
  ]);
  return { ssim, psnr, w: W, h: H };
}

/* ---------- engine v3 (cara lama) ---------- */
async function encodeV3(input, output, meta) {
  const pr = V3.profile(meta.durationSec);
  const portrait = meta.height >= meta.width;
  const box = portrait ? { w: pr.box.h, h: pr.box.w } : pr.box;
  const f = Math.min(box.w / meta.width, box.h / meta.height, 1);
  const w = Math.max(2, Math.floor((meta.width * f) / 2) * 2);
  const h = Math.max(2, Math.floor((meta.height * f) / 2) * 2);
  const started = Date.now();
  await run([
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', input,
    '-map_metadata', '-1',
    '-c:v', 'libx264', '-preset', 'faster', '-profile:v', 'high', '-level', '4.1',
    '-pix_fmt', 'yuv420p', '-r', '30', '-threads', THREADS,
    '-vf', `scale=${w}:${h}`,
    '-x264-params', V3.params,
    '-crf', String(pr.crf), '-maxrate', `${pr.mbps}M`, '-bufsize', `${pr.mbps * 2}M`,
    '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-y', output,
  ]);
  return { ms: Date.now() - started, size: fs.statSync(output).size, w, h, label: `v3 · ${pr.key}` };
}

/* ---------- engine v4 (PureHD) ---------- */
async function encodeV4(input, output, meta, opts) {
  const started = Date.now();
  const handle = videoLib.compressVideo(input, output, meta, () => {}, opts);
  const r = await handle.promise;
  const label = `v4 · ${r.mode}${opts.extraLabel || ''}`;
  return { ms: Date.now() - started, size: r.sizeBytes, w: r.width, h: r.height, label, plan: r.plan };
}

/* ---------- sumber HQ sintetis (detail tinggi, mirip rekaman HP) ---------- */
async function makeHqSource() {
  const out = path.join(OUT, 'source_hq_1080p.mp4');
  if (fs.existsSync(out)) return out;
  console.log('🎞️  Bikin sumber HQ sintetis (1080p · 20 Mbps · detail tinggi + noise + gerakan)…');
  await run([
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=10',
    '-f', 'lavfi', '-i', 'sine=frequency=420:duration=10',
    '-vf', 'noise=alls=14:allf=t+u',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest',
    '-y', out,
  ]);
  return out;
}

/* ---------- jalankan benchmark 1 file ---------- */
async function bench(file) {
  const name = path.basename(file);
  const meta = videoLib.extractMeta(await videoLib.probe(file));
  console.log(`\n${'═'.repeat(94)}`);
  console.log(`📼 ${name} — ${meta.width}x${meta.height} · ${meta.durationSec.toFixed(1)}s · ${meta.fps}fps · ${meta.vCodec} · ${meta.srcBitrate ? (meta.srcBitrate / 1e6).toFixed(1) + ' Mbps' : '?'} · bpp ${meta.bpp}`);
  console.log('═'.repeat(94));

  const QUICK = process.env.BENCH_QUICK === '1';
  const variants = QUICK
    ? [
        { run: () => encodeV3(file, path.join(OUT, `${name}.v3.mp4`), meta) },
        { run: () => encodeV4(file, path.join(OUT, `${name}.v4.balanced.mp4`), meta, { mode: 'balanced' }) },
      ]
    : [
        { run: () => encodeV3(file, path.join(OUT, `${name}.v3.mp4`), meta) },
        { run: () => encodeV4(file, path.join(OUT, `${name}.v4.balanced.mp4`), meta, { mode: 'balanced' }) },
        { run: () => encodeV4(file, path.join(OUT, `${name}.v4.sharp-off.mp4`), meta, { mode: 'balanced', sharpen: false, denoise: false, extraLabel: ' (tanpa filter)' }) },
        { run: () => encodeV4(file, path.join(OUT, `${name}.v4.max.mp4`), meta, { mode: 'max' }) },
      ];

  const rows = [];
  for (const v of variants) {
    const r = await v.run();
    rows.push({ ...r, wa: {} });
    process.stdout.write(`   ⟳ ${r.label.padEnd(26)} ${String(`${r.w}x${r.h}`).padEnd(12)} ${mb(r.size).padEnd(10)} ${secs(r.ms)}\n`);
  }

  // simulasi re-encode WhatsApp
  console.log('   ⟳ simulasi re-encode WhatsApp Status…');
  for (const r of rows) {
    const src = path.join(OUT, r.label.startsWith('v3') ? `${name}.v3.mp4` : r.label.includes('tanpa filter') ? `${name}.v4.sharp-off.mp4` : r.label.includes('max') ? `${name}.v4.max.mp4` : `${name}.v4.balanced.mp4`);
    for (const [waName, args] of Object.entries(WA_PROFILES)) {
      const waFile = path.join(OUT, `${name}.${waName}.${path.basename(src)}`);
      await run(['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', src, ...args, '-movflags', '+faststart', '-y', waFile]);
      r.wa[waName] = await measure(file, waFile);
    }
  }

  // tabel hasil
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n   ${pad('engine', 26)}${pad('res', 12)}${pad('ukuran', 10)}${pad('SSIM-hd', 10)}${pad('SSIM-low', 10)}${pad('PSNR-hd', 9)}waktu`);
  console.log(`   ${'─'.repeat(90)}`);
  for (const r of rows) {
    console.log(
      `   ${pad(r.label, 26)}${pad(`${r.w}x${r.h}`, 12)}${pad(mb(r.size), 10)}` +
      `${pad(r.wa['WA-status-hd']?.ssim?.toFixed(4) ?? 'n/a', 10)}` +
      `${pad(r.wa['WA-status-low']?.ssim?.toFixed(4) ?? 'n/a', 10)}` +
      `${pad(r.wa['WA-status-hd']?.psnr?.toFixed(2) ?? 'n/a', 9)}${secs(r.ms)}`
    );
  }

  const base = rows[0];
  const hd = rows.find((r) => r.label.includes('max')) || rows[1];
  const bal = rows.find((r) => r.label.includes('balanced')) || rows[1];
  const b = base.wa['WA-status-hd']?.ssim || 0;
  console.log(`   ${'─'.repeat(90)}`);
  console.log(`   📈 Detail yang bertahan (SSIM setelah re-encode HD) — v3 ${b.toFixed(4)} → balanced ${(bal.wa['WA-status-hd']?.ssim || 0).toFixed(4)} → max ${(hd.wa['WA-status-hd']?.ssim || 0).toFixed(4)}`);
  console.log(`   📈 Tahan banting di bitrate rendah: v3 ${(base.wa['WA-status-low']?.ssim || 0).toFixed(4)} → balanced ${(bal.wa['WA-status-low']?.ssim || 0).toFixed(4)} → max ${(hd.wa['WA-status-low']?.ssim || 0).toFixed(4)}`);
  return { file: name, v3: b, balanced: bal.wa['WA-status-hd']?.ssim, max: hd.wa['WA-status-hd']?.ssim };
}

(async () => {
  const args = process.argv.slice(2);
  const wantHq = args.includes('--hq');
  const files = args.filter((a) => !a.startsWith('--'));

  console.log(`\n🎬 PureHD Engine Benchmark — ${videoLib.ENGINE.name} v${videoLib.ENGINE.version}`);
  console.log(`FFmpeg: ${BIN}`);
  console.log('Metrik: SSIM hasil SIMULASI re-encode WhatsApp vs video sumber asli (makin tinggi = makin tajam di Status).');

  const list = files.length
    ? files
    : [
        ...(wantHq ? [await makeHqSource()] : []),
        ...fs.readdirSync(path.join(__dirname, '..', 'samples'))
          .filter((f) => /\.(mp4|mov|mkv)$/i.test(f))
          .map((f) => path.join(__dirname, '..', 'samples', f)),
      ];

  const summary = [];
  for (const f of list) {
    try { summary.push(await bench(f)); } catch (e) { console.error(`❌ Gagal: ${f} — ${e.message}`); }
  }

  console.log(`\n${'═'.repeat(94)}\nRINGKASAN — SSIM setelah re-encode WhatsApp (tinggi = lebih tajam)`);
  console.log('─'.repeat(94));
  console.log(`${'file'.padEnd(34)}${'v3 (lama)'.padEnd(14)}${'v4 balanced'.padEnd(14)}${'v4 max'.padEnd(14)}selisih vs v3`);
  for (const s of summary) {
    const d = (s.balanced || 0) - (s.v3 || 0);
    console.log(
      `${String(s.file).padEnd(34)}${(s.v3 ?? 0).toFixed(4).padEnd(14)}${(s.balanced ?? 0).toFixed(4).padEnd(14)}${(s.max ?? 0).toFixed(4).padEnd(14)}` +
      `${d >= 0 ? '+' : ''}${(d * 100).toFixed(2)}% poin`
    );
  }
  console.log(`\nHasil encode lengkap ada di: ${OUT}\n`);
  process.exit(0);
})();
