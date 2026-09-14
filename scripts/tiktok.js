#!/usr/bin/env node
'use strict';
/**
 * ============================================================================
 * KyyPureStatus — TikTok Exporter (CLI)
 * ----------------------------------------------------------------------------
 * Ubah video apapun jadi file yang siap upload ke TikTok / Reels / Shorts
 * dengan setting yang bikin hasilnya GAK di-pecahin sama kompresi TikTok:
 *
 *   • Resolusi 1080x1920 (9:16) — native TikTok, jadi TikTok gak rescale lagi
 *   • Bitrate 8–12 Mbps (30fps) / 12–16 Mbps (60fps)
 *   • fps integer: 24 / 25 / 30 / 50 / 60
 *   • H.264 High profile + MP4 + AAC 192k + Rec.709 + faststart
 *   • Sumber HDR di-tonemap ke SDR (biar warna gak pucet di TikTok)
 *   • Tidak upscale (kecuali pakai --upscale)
 *
 * Pemakaian:
 *   node scripts/tiktok.js video.mp4                    # 1 file, default
 *   node scripts/tiktok.js *.mp4 --out ./hasil          # banyak file
 *   node scripts/tiktok.js video.mp4 --quality 720p --mode max
 *   node scripts/tiktok.js video.mp4 --force60          # paksa 60 fps
 *   node scripts/tiktok.js video.mp4 --upscale          # sumber kecil → 1080
 *   node scripts/tiktok.js video.mp4 --sharp            # unsharp halus (opt-in)
 *   node scripts/tiktok.js video.mp4 --json             # output JSON (buat script lain)
 *
 * Bisa juga lewat npm:  npm run tiktok -- video.mp4
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');

// Di mode --json, semua log dimatikan supaya stdout isinya JSON murni.
if (process.argv.includes('--json')) process.env.LOG_LEVEL = 'silent';

const videoLib = require('../server/video.js');
const config = require('../server/config.js');
const { log } = require('../server/logger.js');

const C = {
  reset: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m',
  g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', r: '\x1b[31m', m: '\x1b[35m',
};

const fmtMB = (b) => `${(b / 1048576).toFixed(2)} MB`;
const fmtTime = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)}s`);

function usage(exitCode = 0) {
  console.log(`
${C.b}${C.m}⚡ KyyPureStatus — TikTok Exporter${C.reset} ${C.dim}(PureHD Engine v${videoLib.ENGINE.version})${C.reset}

${C.b}Pemakaian:${C.reset}
  node scripts/tiktok.js <video...> [opsi]

${C.b}Opsi:${C.reset}
  --out <dir>       Folder hasil (default: ./tiktok-out)
  --quality <q>     1080p | 720p | auto            ${C.dim}(default: 1080p)${C.reset}
  --mode <m>        turbo | balanced | max         ${C.dim}(default: balanced = 1-pass CRF)${C.reset}
  --fps <n>         Paksa fps: 24 | 25 | 30 | 50 | 60
  --force60         Paksa 60 fps (buat video gerak cepat)
  --upscale         Naikkan ke 1080 walau sumbernya lebih kecil
  --sharp           Extra tajam (unsharp halus) — opsional
  --json            Output ringkasan JSON saja
  --help            Bantuan ini

${C.b}Contoh:${C.reset}
  ${C.dim}$${C.reset} node scripts/tiktok.js 1000369296.mp4
  ${C.dim}$${C.reset} node scripts/tiktok.js *.mp4 --mode max --out ./buat-tiktok
  ${C.dim}$${C.reset} node scripts/tiktok.js video.mp4 --force60 --upscale
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    files: [], out: './tiktok-out', quality: '1080p', mode: 'balanced',
    fps: null, upscale: false, sharp: false, json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage(0);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--quality') opts.quality = argv[++i];
    else if (a === '--mode') opts.mode = argv[++i];
    else if (a === '--fps') opts.fps = parseInt(argv[++i], 10);
    else if (a === '--force60') opts.fps = 60;
    else if (a === '--upscale') opts.upscale = true;
    else if (a === '--sharp') opts.sharp = true;
    else if (a === '--json') opts.json = true;
    else if (a.startsWith('--')) { console.error(`${C.r}Opsi gak dikenal: ${a}${C.reset}`); usage(1); }
    else opts.files.push(a);
  }
  return opts;
}

async function exportOne(file, opts) {
  const meta = videoLib.extractMeta(await videoLib.probe(file));

  // Semua video TikTok lewat "plan" yang sama dengan web UI
  const planOpts = {
    platform: 'tiktok',
    quality: opts.quality,
    mode: opts.mode,
    forceUpscale: opts.upscale,
    sharpen: opts.sharp ? true : undefined,
    denoise: false,
    // TikTok gak dibatasi 30 detik → fitur potong otomatis selalu OFF
    trim: 'none',
    trimStartSec: 0,
  };
  let plan = videoLib.plan(meta, planOpts);

  // --fps manual (kalau user minta tertentu)
  if (opts.fps) {
    const allowed = [24, 25, 30, 50, 60];
    if (!allowed.includes(opts.fps)) {
      console.error(`${C.y}⚠ fps ${opts.fps} gak disarankan TikTok — pakai ${allowed.join('/')}. Dikoreksi otomatis.${C.reset}`);
      opts.fps = allowed.reduce((a, b) => (Math.abs(b - opts.fps) < Math.abs(a - opts.fps) ? b : a));
    }
    plan = videoLib.plan(meta, { ...planOpts, fps: opts.fps });
    // timpa fps hasil plan (plan.fps dipakai engine lewat buildFilters)
    plan.fps = opts.fps;
  }

  const base = path.basename(file).replace(/\.[^.]+$/, '');
  const outFile = path.join(path.resolve(opts.out), `${base}_tiktok_${plan.width}x${plan.height}.mp4`);

  if (!opts.json) {
    console.log(`\n${C.b}${C.c}▶ ${path.basename(file)}${C.reset}`);
    console.log(
      `   Sumber : ${meta.width}x${meta.height} · ${meta.fps}fps · ${meta.vCodec.toUpperCase()}` +
      `${meta.isHDR ? ' HDR' : ''} · ${meta.durationSec.toFixed(1)}s · ${fmtMB(meta.sizeBytes)}`
    );
    console.log(
      `   TikTok : ${C.b}${plan.width}x${plan.height}${C.reset} · ${plan.fps}fps · H.264 High · ` +
      `${Math.round(plan.minrateKbps / 1000)}–${(plan.videoKbps / 1000).toFixed(1)} Mbps (ABR) · AAC ${plan.audioKbps}k · ${plan.modeLabel}`
    );
  }

  const t0 = Date.now();
  let lastLine = 0;
  const handle = videoLib.compressVideo(file, outFile, meta, (p) => {
    if (opts.json) return;
    const now = Date.now();
    if (now - lastLine < 900) return; // jangan spam
    lastLine = now;
    const pct = (p.percent || 0).toFixed(1);
    const bar = '█'.repeat(Math.floor((p.percent || 0) / 4)).padEnd(25, '░');
    process.stdout.write(`\r   ${bar} ${pct.padStart(5)}%  ${p.speed ? p.speed + 'x' : ''}  ${p.fps ? p.fps + 'fps' : ''}   `);
  }, { ...planOpts, targetMB: config.TT_MAX_OUTPUT_MB });

  const res = await handle.promise;
  const secs = (Date.now() - t0) / 1000;

  // Verifikasi hasil: pastikan spesifikasinya beneran sesuai spek TikTok
  const outMeta = videoLib.extractMeta(await videoLib.probe(outFile));
  const checks = [
    { ok: outMeta.vCodec === 'h264', label: 'H.264 (bukan HEVC)', got: outMeta.vCodec },
    { ok: /^(yuv420p|yuvj420p)$/.test(outMeta.pixFmt), label: 'yuv420p 8-bit', got: outMeta.pixFmt },
    { ok: [24, 25, 30, 50, 60].some((f) => Math.abs(outMeta.fps - f) < 0.3), label: 'fps integer TikTok', got: outMeta.fps },
    { ok: outMeta.width <= 1920 && outMeta.height <= 2400, label: 'ukuran wajar', got: `${outMeta.width}x${outMeta.height}` },
    { ok: res.sizeMB <= 280, label: 'ukuran ≤ 280 MB (aman upload HP)', got: `${res.sizeMB} MB` },
  ];
  const kbps = Math.round((res.sizeBytes * 8) / Math.max(1, res.durationSec) / 1000);
  checks.push({ ok: kbps >= 6000, label: 'bitrate ≥ 6 Mbps (kualitas aman)', got: `${kbps} kbps` });

  if (!opts.json) {
    process.stdout.write('\r' + ' '.repeat(70) + '\r');
    console.log(`   ${C.g}✅ Selesai${C.reset} — ${res.width}x${res.height} · ${res.sizeMB} MB · ${kbps} kbps · ${fmtTime(secs)}`);
    for (const c of checks) {
      console.log(`      ${c.ok ? C.g + '✓' : C.y + '!'}${C.reset} ${c.label} ${C.dim}(${c.got})${C.reset}`);
    }
    console.log(`   ${C.dim}→ ${outFile}${C.reset}`);
    console.log(
      `   ${C.y}Tips:${C.reset} di TikTok nyalain ${C.b}Settings → Content preferences → Allow high-quality uploads${C.reset},\n` +
      `         dan upload lewat ${C.b}tiktok.com${C.reset} (web) biar gak kena kompresi ekstra dari app HP.`
    );
  }

  return {
    input: path.resolve(file), output: outFile,
    source: { width: meta.width, height: meta.height, fps: meta.fps, codec: meta.vCodec, durationSec: meta.durationSec, sizeMB: +(meta.sizeBytes / 1048576).toFixed(2) },
    output2: { width: res.width, height: res.height, fps: outMeta.fps, sizeMB: res.sizeMB, videoKbps: kbps, durationSec: res.durationSec, codec: outMeta.vCodec },
    plan: { platform: 'tiktok', quality: plan.profileKey, mode: plan.mode, audioKbps: plan.audioKbps },
    checks,
    encodeSec: +secs.toFixed(1),
  };
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.files.length) usage(1);

  const missing = opts.files.filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(`${C.r}File gak ketemu: ${missing.join(', ')}${C.reset}`);
    process.exit(1);
  }
  fs.mkdirSync(path.resolve(opts.out), { recursive: true });

  if (!opts.json) {
    console.log(`${C.b}${C.m}⚡ KyyPureStatus TikTok Exporter${C.reset} ${C.dim}· PureHD Engine v${videoLib.ENGINE.version}${C.reset}`);
    console.log(`${C.dim}   ${opts.files.length} file → ${path.resolve(opts.out)}${C.reset}`);
  }

  const results = [];
  let failed = 0;
  for (const f of opts.files) {
    try {
      results.push(await exportOne(f, opts));
    } catch (err) {
      failed++;
      if (opts.json) results.push({ input: path.resolve(f), error: err.message });
      else console.error(`   ${C.r}❌ Gagal: ${err.message.slice(0, 200)}${C.reset}`);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ ok: failed === 0, results }, null, 2));
  } else if (results.length > 1) {
    console.log(`\n${C.b}Ringkasan:${C.reset} ${results.length - failed} sukses, ${failed} gagal`);
    for (const r of results) {
      if (r.error) console.log(`   ${C.r}✗${C.reset} ${path.basename(r.input)} — ${r.error.slice(0, 80)}`);
      else console.log(`   ${C.g}✓${C.reset} ${path.basename(r.output)} ${C.dim}(${r.output2.width}x${r.output2.height} · ${r.output2.sizeMB}MB · ${r.output2.videoKbps}kbps)${C.reset}`);
    }
    console.log(`\n${C.dim}Folder: ${path.resolve(opts.out)}${C.reset}`);
  }
  process.exit(failed ? 1 : 0);
})();
