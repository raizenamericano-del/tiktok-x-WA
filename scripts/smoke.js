'use strict';
/**
 * KyyPureStatus — Smoke test end-to-end (tanpa WhatsApp asli)
 *
 * Jalankan:  MOCK_SEND=true npm run smoke
 *
 * Menguji:
 *  1. Server boot + /api/config + /api/status
 *  2. Pembuatan video uji via ffmpeg (testsrc)
 *  3. Pipeline kompresi: profil adaptif (30s→1080p, 60s→720p)
 *  4. Upload (multer) → socket video:process → events sampai send:done
 */
process.env.MOCK_SEND = 'true';
process.env.PORT = '3999';
process.env.DATA_DIR = '/tmp/kyps_smoke';
process.env.FFMPEG_THREADS = '1'; // sandbox: 1 thread biar aman memory

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { io: socketClient } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
fs.rmSync('/tmp/kyps_smoke', { recursive: true, force: true });

const videoLib = require(path.join(ROOT, 'server', 'video'));
const server = require(path.join(ROOT, 'server', 'index'));

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

/** Buat video uji via ffmpeg (testsrc + sine audio), dengan retry (sandbox kadang flaky) */
function makeTestVideo(out, seconds, size) {
  const args = [
    '-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=${size}:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-c:a', 'aac', '-shortest', out,
  ];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const r = spawnSync(videoLib.BIN, args, { encoding: 'utf8', maxBuffer: 1e6 });
    if (r.status === 0) return out;
    console.log(`     (retry ${attempt}/3 membuat video uji)`);
  }
  throw new Error('Gagal membuat video uji');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n=== 1. Server boot ===');
  await server.start();
  await sleep(1200);

  const cfgRes = await fetch('http://localhost:3999/api/config');
  const cfg = await cfgRes.json();
  ok('GET /api/config', cfgRes.ok && cfg.appName === 'KyyPureStatus', `v${cfg.version}`);
  ok('engine v4 terdeteksi', cfg.engine?.name === 'PureHD Engine' && cfg.engine?.version?.startsWith('4'), `${cfg.engine?.name} v${cfg.engine?.version}`);
  ok('pilihan mode encode lengkap', Array.isArray(cfg.modes) && cfg.modes.length === 3, cfg.modes.map((m) => m.key).join('/'));

  const healthRes = await fetch('http://localhost:3999/api/health');
  const health = await healthRes.json();
  ok('GET /api/health', healthRes.ok && health.ok === true, `engine ${health.engine}`);

  const engRes = await fetch('http://localhost:3999/api/engine');
  const eng = await engRes.json();
  ok('GET /api/engine (caps ffmpeg)', engRes.ok && typeof eng.caps?.libx264 === 'boolean', `x264=${eng.caps?.libx264}`);

  const stRes = await fetch('http://localhost:3999/api/status');
  const st = await stRes.json();
  ok('GET /api/status (flag mock)', st.mock === true && st.realSession === false, `state=${st.state}`);

  console.log('\n=== 2. Video engine (profil adaptif) ===');
  // Durasi sedikit lebih pendek dari 30/60 biar test cepat & hemat resource,
  // tapi tetap dalam rentang profil yang diuji (≤30 → 1080p, 31–60 → 720p)
  const v30 = makeTestVideo('/tmp/kyps_smoke/v30.mp4', 15, '1920x1080');
  const v60 = makeTestVideo('/tmp/kyps_smoke/v60.mp4', 45, '1280x720');

  const m30 = videoLib.extractMeta(await videoLib.probe(v30));
  const m60 = videoLib.extractMeta(await videoLib.probe(v60));
  ok('durasi terdeteksi (15s)', Math.round(m30.durationSec) === 15);
  ok('durasi terdeteksi (45s)', Math.round(m60.durationSec) === 45);

  const p30 = videoLib.plan(m30);
  const p60 = videoLib.plan(m60);
  ok('≤60 dtk → 1080p (PureHD v4)', p30.profileKey === '1080p', `${p30.width}x${p30.height}`);
  ok('≤60 dtk → 1080p (PureHD v4)', p60.profileKey === '1080p', `${p60.width}x${p60.height}`);

  // Override kualitas manual
  const p30q = videoLib.plan(m30, { quality: '720p' });
  ok('override 720p pada video 15s', p30q.profileKey === '720p' && p30q.width === 1280, `${p30q.width}x${p30q.height}`);

  // Auto-trim 30 detik (khusus Status)
  const mLong = { ...m60, durationSec: 95 };
  const pTrim = videoLib.plan(mLong, { trim: 'auto30' });
  ok('auto-trim 30s dipakai saat diminta', pTrim.durationSec === 30 && pTrim.trimmed === true, `${pTrim.durationSec}s, ${pTrim.profileKey}`);

  // Mode 2-pass (maksimal)
  const pMax = videoLib.plan(m30, { mode: 'max' });
  ok('mode max = 2-pass', pMax.twoPass === true, `bitrate ${pMax.videoKbps}k`);

  const out720 = '/tmp/kyps_smoke/out_60.mp4';
  const c60 = videoLib.compressVideo(v60, out720, m60, (p) => {
    if (Math.round(p.percent) % 25 === 0) console.log(`     progress: ${p.percent.toFixed(0)}% (speed ${p.speed || '?'}x)`);
  }, { mode: 'turbo' });
  const r60 = await c60.promise;
  ok('kompresi 60s selesai', fs.existsSync(out720), `${(r60.sizeBytes / 1048576).toFixed(1)} MB, ${r60.width}x${r60.height}`);

  const out1080 = '/tmp/kyps_smoke/out_30.mp4';
  const c30 = videoLib.compressVideo(v30, out1080, m30, () => {}, { mode: 'balanced' });
  const r30 = await c30.promise;
  ok('kompresi 30s selesai', fs.existsSync(out1080) && r30.width === 1920, `${r30.width}x${r30.height}`);

  // Cancel test
  const cCanc = videoLib.compressVideo(v60, '/tmp/kyps_smoke/out_cancel.mp4', m60, () => {}, { mode: 'max' });
  setTimeout(() => cCanc.cancel(), 300);
  let canceled = false;
  try {
    await cCanc.promise;
  } catch (e) {
    canceled = /dibatalkan/i.test(e.message);
  }
  ok('pembatalan kompresi berfungsi', canceled);

  console.log('\n=== 3. Pipeline lengkap via socket (upload → kompres → kirim mock) ===');
  const sock = socketClient('http://localhost:3999', { transports: ['websocket'] });
  await new Promise((res, rej) => { sock.on('connect', res); sock.on('connect_error', rej); });

  // Upload file via FormData
  const form = new FormData();
  form.append('video', new Blob([fs.readFileSync(v30)], { type: 'video/mp4' }), 'uji_30s.mp4');
  const upRes = await fetch('http://localhost:3999/api/upload', { method: 'POST', body: form });
  const up = await upRes.json();
  ok('upload sukses', upRes.ok && up.uploadId, `plan: ${up.plan.profileLabel}, ${up.plan.width}x${up.plan.height}`);

  const events = [];
  sock.on('compress:start', (d) => events.push(['compress:start', d]));
  sock.on('compress:progress', (d) => events.push(['compress:progress', d.percent]));
  sock.on('compress:done', (d) => events.push(['compress:done', d]));
  sock.on('send:start', (d) => events.push(['send:start', d.target]));
  sock.on('send:done', (d) => events.push(['send:done', d]));
  sock.on('send:error', (d) => events.push(['send:error', d]));
  sock.on('history:update', (h) => events.push(['history:update', h.length]));

  sock.emit('video:process', { uploadId: up.uploadId, target: '081234567890', caption: 'Tes KyyPureStatus' });

  // Tunggu send:done / send:error
  const done = await new Promise((res) => {
    const t = setTimeout(() => res(null), 90000);
    const check = () => {
      const e = events.find(([n]) => n === 'send:done' || n === 'send:error');
      if (e) { clearTimeout(t); res(e); }
      else setTimeout(check, 200);
    };
    check();
  });

  ok('job selesai', !!done, done ? (done[0] === 'send:done' ? `ke ${done[1].target}` : done[1].message) : 'timeout');
  ok('events compress:start & progress & done', events.some(([n]) => n === 'compress:start') && events.some(([n]) => n === 'compress:progress') && events.some(([n]) => n === 'compress:done'));
  ok('events send:start', events.some(([n]) => n === 'send:start'));
  ok('history ter-update', events.some(([n]) => n === 'history:update'));

  const histRes = await fetch('http://localhost:3999/api/history');
  const hist = await histRes.json();
  ok('riwayat tersimpan', hist[0]?.status === 'success', `${hist[0]?.originalName} → ${hist[0]?.target}`);
  ok('video hasil kompres disimpan utk resend', fs.existsSync(path.join(process.env.DATA_DIR, 'videos', hist[0]?.videoFile || '__none__')));

  // Kirim ulang (resend)
  const ev2 = [];
  sock.on('send:done', (d) => ev2.push(d));
  sock.emit('video:resend', { id: hist[0].id });
  const r2 = await new Promise((res) => {
    const t = setTimeout(() => res(null), 30000);
    const check = () => {
      if (ev2.length) { clearTimeout(t); res(ev2[ev2.length - 1]); } else setTimeout(check, 200);
    };
    check();
  });
  ok('kirim ulang (resend) sukses', !!r2 && r2.resendId === hist[0].id);

  // Kirim multi-target (upload baru — uploadId lama sudah dikonsumsi)
  const form2 = new FormData();
  form2.append('video', new Blob([fs.readFileSync(v30)], { type: 'video/mp4' }), 'uji_multi.mp4');
  const up2 = await (await fetch('http://localhost:3999/api/upload', { method: 'POST', body: form2 })).json();
  const ev3 = [];
  sock.on('send:done', (d) => ev3.push(d));
  sock.emit('video:process', { uploadId: up2.uploadId, targets: '6281111111111, 6282222222222' });
  const r3 = await new Promise((res) => {
    const t = setTimeout(() => res(null), 30000);
    const check = () => {
      if (ev3.length) { clearTimeout(t); res(ev3[ev3.length - 1]); } else setTimeout(check, 200);
    };
    check();
  });
  ok('kirim multi-target (2 nomor)', !!r3 && r3.targets?.length === 2, r3 ? r3.targets.join(', ') : 'timeout');


  console.log('\n=== 4. Mode TikTok (platform tiktok) ===');
  // Video portrait 1080x1920 biar spek TikTok bisa dicek apa adanya
  const vTT = makeTestVideo('/tmp/kyps_smoke/vTT.mp4', 15, '1080x1920');
  const mTT = videoLib.extractMeta(await videoLib.probe(vTT));

  const ttPlan = videoLib.plan(mTT, { platform: 'tiktok', quality: 'auto' });
  ok('plan TikTok → 1080x1920 (9:16)', ttPlan.width === 1080 && ttPlan.height === 1920, `${ttPlan.width}x${ttPlan.height}`);
  ok('plan TikTok → fps integer (24/25/30/50/60)', [24, 25, 30, 50, 60].includes(ttPlan.fps), `${ttPlan.fps} fps`);
  ok('plan TikTok → bitrate ABR 8-12 Mbps + minrate', ttPlan.videoKbps >= 8000 && ttPlan.minrateKbps > 0, `${Math.round(ttPlan.minrateKbps / 1000)}-${Math.round(ttPlan.videoKbps / 1000)} Mbps`);
  ok('plan TikTok → audio AAC 192k', ttPlan.audioKbps === 192, `${ttPlan.audioKbps}k`);
  ok('plan TikTok → tanpa potong 30 dtk', !ttPlan.trimmed, `trim=${ttPlan.trim}`);
  const tt720 = videoLib.plan(mTT, { platform: 'tiktok', quality: '720p' });
  ok('plan TikTok 720p → 720x1280 + cap turun ke 8 Mbps', tt720.width === 720 && tt720.videoKbps <= 8000, `${tt720.width}x${tt720.height} · ${Math.round(tt720.videoKbps / 1000)} Mbps`);
  ok('platform TikTok terdaftar di /api/config', (cfg.platforms || []).some((p) => p.key === 'tiktok' && p.trimAllowed === false), (cfg.platforms || []).map((p) => p.key).join('/'));
  ok('profilesTikTok tersedia di /api/config', Array.isArray(cfg.profilesTikTok) && cfg.profilesTikTok.length === 2, (cfg.profilesTikTok || []).map((p) => p.key).join('/'));
  ok('batas ukuran TikTok (TT_MAX_OUTPUT_MB)', cfg.limits?.ttMaxOutputMB > 50, `${cfg.limits?.ttMaxOutputMB} MB`);
  // Mode WA harus tetap tidak berubah (regresi)
  ok('mode WA tetap cap 50 MB & trim dibolehkan', cfg.limits?.maxOutputMB === 50 && (cfg.platforms || []).some((p) => p.key === 'wa' && p.trimAllowed === true));

  // Pipeline TikTok TANPA nomor tujuan → harus tetap jalan (encode-only)
  const formTT = new FormData();
  formTT.append('video', new Blob([fs.readFileSync(vTT)], { type: 'video/mp4' }), 'uji_tiktok.mp4');
  const upTT = await (await fetch('http://localhost:3999/api/upload', { method: 'POST', body: formTT })).json();
  const evTT = [];
  sock.on('send:done', (d) => evTT.push(['done', d]));
  sock.on('send:error', (d) => evTT.push(['error', d]));
  sock.emit('video:process', { uploadId: upTT.uploadId, platform: 'tiktok' });
  const rTT = await new Promise((res) => {
    const t = setTimeout(() => res(null), 120000);
    const check = () => {
      if (evTT.length) { clearTimeout(t); res(evTT[evTT.length - 1]); }
      else setTimeout(check, 200);
    };
    check();
  });
  ok('TikTok tanpa nomor tujuan → sukses', !!rTT && rTT[0] === 'done', rTT ? (rTT[0] === 'done' ? 'encoded' : rTT[1].message) : 'timeout');
  if (rTT && rTT[0] === 'done') {
    const d = rTT[1];
    ok('hasil TikTok 1080x1920 & tanpa kirim WA', d.meta?.resolution === '1080x1920' && d.sentToWa === false, `${d.meta?.resolution} · sent:${d.sentToWa}`);
    ok('event compress:done bawa platform tiktok', events.some(([n, x]) => n === 'compress:done' && x.platform === 'tiktok'));
    const dl = await fetch(`http://localhost:3999/api/download/${d.entryId}`);
    ok('file TikTok bisa diunduh (/api/download)', dl.ok && (await dl.arrayBuffer()).byteLength > 10000, `HTTP ${dl.status}`);
    const histTT = await (await fetch('http://localhost:3999/api/history')).json();
    ok('riwayat nyimpen platform tiktok', histTT[0]?.platform === 'tiktok', `${histTT[0]?.platform} · ${histTT[0]?.resolution}`);
  }

  sock.close();
  server.httpServer.close();
  console.log(`\n=== HASIL: ${pass} lolos, ${fail} gagal ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('Smoke test crash:', e);
  process.exit(1);
});
