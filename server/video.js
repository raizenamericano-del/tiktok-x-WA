'use strict';
/**
 * ============================================================================
 *  KyyPureStatus — PureHD Engine v4  (by KyyDevv)
 * ============================================================================
 *  Mesin kompresi video khusus WhatsApp Status. Fokus: TETAP TAJAM walau
 *  WhatsApp nge-encode ulang saat video di-post ke Status.
 *
 *  Yang beda dari engine v3 (yang bikin hasil "pecah-pecah"):
 *   1. Scaling pakai LANCZOS + full_chroma_int (v3: default bilinear → blur).
 *   2. HDR/10-bit (HDR iPhone/Android) di-tonemap ke BT.709 dulu → warna gak
 *      washed-out/kebiru.
 *   3. x264 di-tune: AQ-mode 3 (anti-banding di scene gelap), psy-rd, trellis,
 *      subme 8, rc-lookahead 60, deblock -1,-1 → detail naik di bitrate sama.
 *   4. Framerate dinormalisasi lewat filter `fps` (v3: `-r 30` bikin frame
 *      dobel/drop → gerakan patah-patah).
 *   5. Bitrate ladder naik (1080p cap 8 Mbps vs 6 Mbps) + preset default
 *      `medium` (v3: `faster`).
 *   6. Mode encode adaptif:
 *        turbo    → 1-pass CRF (paling cepat)
 *        balanced → 1-pass CRF + VBV cap (default, kualitas tinggi & cepat)
 *        max      → 2-pass ABR target-size (paling rapi, ukuran pasti aman)
 *   7. Light unsharp luma — bikin detail tetap kerasa setelah WA re-encode.
 *   8. Loudness audio dinormalisasi (EBU R128 -16 LUFS) → suara rata.
 *   9. Faststart + tag BT.709 + GOP 2 detik → seek cepat & kompatibel player.
 *  10. Auto-trim 30 detik (opsional) khusus Status → resolusi bisa tetap 1080p.
 * ============================================================================
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const config = require('./config');
const { log } = require('./logger');

/* ------------------------------------------------------------------ *
 * Binary ffmpeg/ffprobe
 * ------------------------------------------------------------------ */
const BIN =
  config.FFMPEG_PATH ||
  (typeof ffmpegStatic === 'string' ? ffmpegStatic : 'ffmpeg');
const PROBE = typeof ffprobeStatic?.path === 'string' ? ffprobeStatic.path : 'ffprobe';
ffmpeg.setFfmpegPath(BIN);
ffmpeg.setFfprobePath(PROBE);
log.info(`FFmpeg : ${BIN}`);
log.info(`FFprobe: ${PROBE}`);

/* ------------------------------------------------------------------ *
 * Konstanta engine
 * ------------------------------------------------------------------ */
const ENGINE = {
  name: 'PureHD Engine',
  version: '4.2.0',
  // fps maksimum output (WhatsApp Status nyaman di 30 fps; 60 fps bikin bitrate
  // habis buat motion & sering di-reencode jelek sama WA)
  maxFps: 30,
  // GOP 2 detik → seek cepat di WA & stabil saat di-reencode
  gop: 60,
  audioBitrate: '128k',
  audioSampleRate: 48000,
  // Loudness target (EBU R128) — suara rata, gak ada video yang kekecilan/gede
  loudnorm: 'loudnorm=I=-16:TP=-1.5:LRA=11',
};

/* ------------------------------------------------------------------ *
 * Tuning x264 DINAMIS + batas level H.264
 * ------------------------------------------------------------------
 * Kenapa harus dinamis? Level H.264 itu punya batas DPB (decoded picture
 * buffer). Contoh nyata dari laporan user:
 *   Output 1080x1920 (portrait) = 68x120 = 8.160 macroblock.
 *   Dengan ref=5, x264 butuh DPB 40.800 mbs, sedangkan level 4.2 cuma
 *   boleh 34.816 mbs  →  x264 NOLAK buka encoder:
 *   "DPB size (5 frames, 40800 mbs) > level limit (4 frames, 34816 mbs)"
 *   "Error while opening encoder - maybe incorrect parameters..."
 * Video 720p/480p gak kena karena MBs-nya kecil → itu sebabnya video
 * "kecil/burik" jalan sedangkan video HD portrait gagal.
 * Solusi: level + jumlah ref dihitung dari ukuran frame, bukan hardcode.
 */
const X264_BASE = {
  'b-adapt': 2,
  'b-pyramid': 'normal',
  me: 'umh',
  'me_range': 24,
  subme: 8,
  trellis: 2,
  'aq-mode': 3,
  'aq-strength': 0.9,
  'psy-rd': '1.0,0.15',
  deblock: '-1,-1',
  'mixed-refs': 1,
  weightp: 2,
  direct: 'auto',
  scenecut: 40,
  '8x8dct': 1,
  'chroma-me': 1,
  'fast-pskip': 1,
  mbtree: 1,
};

// maxMBs = batas macroblock per frame; dpb = batas DPB dalam macroblock
const LEVELS = [
  { level: '4.1', maxMBs: 8192, dpb: 32768 },
  { level: '4.2', maxMBs: 8704, dpb: 34816 },
  { level: '5.0', maxMBs: 22080, dpb: 110400 },
  { level: '5.1', maxMBs: 36864, dpb: 184320 },
];

const macroblocks = (w, h) => Math.ceil(w / 16) * Math.ceil(h / 16);

/** Pilih level terkecil yang masih cukup buat frame + DPB diminta. */
function chooseLevel(width, height, dpbFrames) {
  const mbs = macroblocks(width, height);
  for (const l of LEVELS) {
    if (mbs <= l.maxMBs && mbs * dpbFrames <= l.dpb) return l.level;
  }
  return null; // null = biarkan x264 auto (video ekstrem)
}

/**
 * Racik -x264-params sesuai beban. Mode "lean" dipakai kalau sumbernya
 * berat (2K/4K, >60fps, HEVC) atau server-nya cuma punya sedikit thread —
 * ref & rc-lookahead itu penyumbang RAM terbesar di x264.
 */
function buildX264Params({ refs = 5, bframes = 3, lookahead = 60, lean = false } = {}) {
  const p = {
    ...X264_BASE,
    ref: lean ? Math.min(refs, 2) : refs,
    bframes: lean ? Math.min(bframes, 2) : bframes,
    'rc-lookahead': lean ? Math.min(lookahead, 25) : lookahead,
  };
  return Object.entries(p).map(([k, v]) => `${k}=${v}`).join(':');
}

/* Bitrate ladder (cap Mbps, CRF, sharpening) ------------------------- */
const PROFILES = [
  // capMbps = plafon bitrate (VBV maxrate), crf = kualitas (makin kecil = makin detail),
  // sharpen = unsharp luma yang DIPAKAI HANYA kalau user menyalakan "Extra Tajam".
  // Angka ini hasil tuning pakai scripts/engine-bench.js: unsharp bawaan bikin SSIM
  // (fidelity ke sumber) turun, jadi default-nya 0 dan disediakan sebagai opsi.
  { key: '1080p', label: 'Full HD 1080p', short: '1080p', box: { w: 1920, h: 1080 }, capMbps: 8, crf: 18, sharpen: 0 },
  { key: '720p', label: 'HD 720p', short: '720p', box: { w: 1280, h: 720 }, capMbps: 5, crf: 18, sharpen: 0 },
  { key: '480p', label: 'SD 480p', short: '480p', box: { w: 854, h: 480 }, capMbps: 2.8, crf: 19, sharpen: 0 },
  { key: '360p', label: 'Hemat 360p', short: '360p', box: { w: 640, h: 360 }, capMbps: 1.8, crf: 20, sharpen: 0 },
];

// Kekuatan unsharp saat "Extra Tajam" dinyalakan (dipakai di semua profil)
const SHARPEN_STRENGTH = { '1080p': 0.24, '720p': 0.22, '480p': 0.18, '360p': 0, 'tiktok1080': 0.2 };

/* ------------------------------------------------------------------ *
 * PROFIL TIKTOK / REELS / SHORTS
 * ------------------------------------------------------------------
 * Angka ini ngikutin rekomendasi resmi + praktik creator:
 *   • Resolusi 1080x1920 (9:16) — native TikTok, jangan bikin TikTok upscale
 *   • Bitrate  8–12 Mbps untuk 30fps, 12–16 Mbps untuk 60fps
 *     (di bawah 8 Mbps → TikTok nambah kompresi, di atas 16 Mbps mubazir)
 *   • fps integer: 24 / 25 / 30 / 50 / 60 (TikTok gak suka fps pecahan)
 *   • H.264 High profile + MP4 + AAC 192k (bukan HEVC — HEVC di-re-encode
 *     lebih agresif sama TikTok)
 *   • Rec.709 (udah di-set di videoOptions)
 *
 * Kenapa "ga pecah"? TikTok selalu kompres ulang. Yang bisa kita lakuin:
 * kasih sumber sebersih & sekaya mungkin di bitrate yang TikTok harapkan,
 * di resolusi yang sama biar TikTok gak rescale lagi.
 */
const TT_PROFILES = [
  { key: 'tiktok1080', label: 'Full HD 1080×1920', short: '1080p', box: { w: 1920, h: 1080 }, capMbps: 12, crf: 17, sharpen: 0 },
  { key: 'tiktok720', label: 'HD 720×1280', short: '720p', box: { w: 1280, h: 720 }, capMbps: 8, crf: 18, sharpen: 0 },
];

// fps integer yang diterima TikTok
const TT_FPS = [24, 25, 30, 50, 60];

/** fps terbaik untuk TikTok: integer, gak lebih dari 60, gak "naik" tanpa guna */
function pickPlatformFps(meta, maxFps) {
  const src = meta.fps || 30;
  if (src <= maxFps + 0.6) {
    // sumber udah di bawah batas → pakai nilai integer terdekat (24/25/30/50/60)
    const snapped = TT_FPS.filter((f) => f <= maxFps).find((f) => Math.abs(f - src) <= 1.2);
    if (snapped) return snapped;
    return Math.max(1, Math.round(src));
  }
  // sumber > batas (mis. 120fps) → turun ke nilai TT_FPS terdekat di bawah batas
  const below = TT_FPS.filter((f) => f <= maxFps && f <= src);
  return below.length ? below[below.length - 1] : maxFps;
}

/* Platform = tujuan upload. Beda platform, beda target & batasan. */
const PLATFORMS = {
  wa: {
    key: 'wa',
    label: 'Status WhatsApp',
    emoji: '💬',
    hint: 'MP4 hemat, maks 30 detik, siap di-forward',
    profiles: PROFILES,
    maxFps: ENGINE.maxFps,
    audioKbps: 128,
    // ladder by durasi (Status cuma 30 dtk, jadi makin panjang makin diturunin)
    pick(durationSec, quality) {
      if (quality && quality !== 'auto') {
        const p = PROFILES.find((x) => x.key === quality);
        if (p) return p;
      }
      if (durationSec <= 60) return PROFILES[0];
      if (durationSec <= 120) return PROFILES[1];
      if (durationSec <= 240) return PROFILES[2];
      return PROFILES[3];
    },
    fps: (meta) => Math.min(ENGINE.maxFps, Math.round(meta.fps || 30)),
    trimAllowed: true,
    sizeCapMB: () => config.MAX_OUTPUT_MB,
  },
  tiktok: {
    key: 'tiktok',
    label: 'TikTok · Reels · Shorts',
    emoji: '🎵',
    hint: '1080×1920 9:16, bitrate tinggi anti-pecah',
    profiles: TT_PROFILES,
    maxFps: 60,
    audioKbps: 192,
    // TikTok gak peduli durasi (sampai 10 menit) → resolusi gak diturunin,
    // yang diturunin cuma bitrate kalau filenya kebablasan batas upload HP.
    pick(_durationSec, quality) {
      if (quality === '720p' || quality === 'tiktok720') return TT_PROFILES[1];
      return TT_PROFILES[0];
    },
    fps: (meta) => pickPlatformFps(meta, 60),
    trimAllowed: false,
    sizeCapMB: () => config.TT_MAX_OUTPUT_MB,
  },
};

const getPlatform = (key) => PLATFORMS[key] || PLATFORMS.wa;

/* Mode encode ------------------------------------------------------- */
const MODES = {
  turbo: {
    key: 'turbo',
    label: 'Turbo',
    desc: 'Paling cepat — hasil tetap bagus buat klip pendek.',
    crfBump: 1,
    preset: config.FFMPEG_PRESET_FAST,
    twoPass: false,
  },
  balanced: {
    key: 'balanced',
    label: 'Seimbang',
    desc: 'Default. Kualitas HD, waktu encode wajar.',
    crfBump: 0,
    preset: config.FFMPEG_PRESET,
    twoPass: false,
  },
  max: {
    key: 'max',
    label: 'Maksimal',
    desc: '2-pass — paling bersih & ukuran pasti aman.',
    crfBump: -1,
    preset: config.FFMPEG_PRESET_SLOW,
    twoPass: true,
  },
};

/* ------------------------------------------------------------------ *
 * Capability detection (sekali saat boot, dipakai UI + engine)
 * ------------------------------------------------------------------ */
function detectCapabilities() {
  const out = { libx264: false, libx265: false, aac: true, zscale: false, tonemap: false, version: null };
  // Probe encoder: coba 2x (proses spawn bisa gagal sesaat / kehabisan resource)
  // dan diverifikasi sekali lagi lewat "ffmpeg -h encoder=libx264". Ini penting:
  // kalau probe gagal dan kita diam-diam turun ke encoder mpeg4, hasil videonya
  // jelek banget — user bakal nyebutnya "pecah-pecah" tanpa tahu sebabnya.
  for (let attempt = 0; attempt < 2 && !out.libx264; attempt++) {
    try {
      const enc = require('child_process').execFileSync(BIN, ['-hide_banner', '-encoders'], {
        encoding: 'utf8',
        timeout: 20000,
      });
      out.libx264 = /libx264/.test(enc);
      out.libx265 = /libx265/.test(enc);
    } catch (_) { /* noop */ }
  }
  if (!out.libx264) {
    try {
      const h = require('child_process').execFileSync(BIN, ['-hide_banner', '-h', 'encoder=libx264'], {
        encoding: 'utf8',
        timeout: 20000,
      });
      out.libx264 = /Encoder libx264|libx264/i.test(h);
    } catch (_) { /* noop */ }
  }
  try {
    const fil = require('child_process').execFileSync(BIN, ['-hide_banner', '-filters'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    out.zscale = /\bzscale\b/.test(fil);
    out.tonemap = /\btonemap\b/.test(fil);
  } catch (_) { /* noop */ }
  try {
    const v = require('child_process').execFileSync(BIN, ['-version'], { encoding: 'utf8', timeout: 15000 });
    out.version = (v.split('\n')[0] || '').replace('ffmpeg version ', '').split(' ')[0];
  } catch (_) { /* noop */ }
  return out;
}
const CAPS = detectCapabilities();
log.info(`Engine  : ${ENGINE.name} v${ENGINE.version} · x264=${CAPS.libx264 ? 'yes' : 'no'} · hdr=${CAPS.zscale && CAPS.tonemap ? 'yes' : 'no'} · ffmpeg=${CAPS.version || '?'}`);
if (!CAPS.libx264) {
  log.warn(
    '⚠️  libx264 TIDAK terdeteksi di ffmpeg ini — engine terpaksa pakai encoder cadangan ' +
    '(mpeg4) yang kualitasnya jauh lebih rendah. Cek FFMPEG_PATH / instalasi ffmpeg.'
  );
}

const CODEC = CAPS.libx264 ? 'libx264' : 'mpeg4'; // fallback super jadul (praktis tak pernah kepakai)

/* ------------------------------------------------------------------ *
 * Probe & metadata
 * ------------------------------------------------------------------ */
function probe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, meta) => (err ? reject(err) : resolve(meta)));
  });
}

function ratioToFps(str) {
  if (!str) return 0;
  const [a, b] = String(str).split('/').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return a / b;
}

const roundEven = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Metadata lengkap — dipakai engine buat mutusin filter & strategi encode.
 */
function extractMeta(ffMeta) {
  const streams = ffMeta.streams || [];
  const v = streams.find((s) => s.codec_type === 'video') || {};
  const a = streams.find((s) => s.codec_type === 'audio') || null;
  const fmt = ffMeta.format || {};

  const duration =
    parseFloat(v.duration || 0) ||
    parseFloat(fmt.duration || 0) ||
    0;

  const rot = Math.abs((parseInt(v.tags?.rotate ?? v.tags?.rotation ?? 0, 10) || 0) % 360);
  const rotation = rot === 90 || rot === 180 || rot === 270 ? rot : 0;

  const fps = ratioToFps(v.avg_frame_rate) || ratioToFps(v.r_frame_rate) || 30;
  const rFps = ratioToFps(v.r_frame_rate) || fps;

  const pixFmt = String(v.pix_fmt || 'yuv420p');
  const transfer = String(v.color_transfer || v.color_trc || '').toLowerCase();
  const primaries = String(v.color_primaries || '').toLowerCase();
  const isHDR =
    /10le|12le|10be|12be/.test(pixFmt) &&
    (/smpte2084|arib-std-b67|bt2020/.test(transfer) || /bt2020/.test(primaries) || transfer === '');

  const postW = rotation === 90 || rotation === 270 ? (v.height || 0) : (v.width || 0);
  const postH = rotation === 90 || rotation === 270 ? (v.width || 0) : (v.height || 0);

  const srcBitrate = parseInt(v.bit_rate || fmt.bit_rate || 0, 10) || 0;
  const px = Math.max(1, postW * postH);
  // bit per pixel per frame → indikator seberapa "tipis" sumbernya
  const bpp = (srcBitrate / Math.max(fps, 1) / px) || 0;

  return {
    durationSec: Math.max(0, duration),
    width: postW,
    height: postH,
    srcWidth: v.width || 0,
    srcHeight: v.height || 0,
    hasAudio: !!a,
    audioChannels: a ? a.channels || 2 : 0,
    audioSampleRate: a ? parseInt(a.sample_rate || 0, 10) || 48000 : 0,
    rotation,
    fps: Math.round(fps * 100) / 100,
    rFps: Math.round(rFps * 100) / 100,
    isVFR: Math.abs(fps - rFps) > 0.6,
    pixFmt,
    isHDR,
    srcBitrate,
    bpp: Math.round(bpp * 1000) / 1000,
    vCodec: v.codec_name || '',
    aCodec: a?.codec_name || '',
    sizeBytes: parseInt(fmt.size || 0, 10) || 0,
  };
}

/* ------------------------------------------------------------------ *
 * Perencanaan (plan) — dipakai UI sebelum encode
 * ------------------------------------------------------------------ */
function pickProfile(durationSec, quality) {
  if (quality && quality !== 'auto') {
    const p = PROFILES.find((x) => x.key === quality);
    if (p) return p;
  }
  if (durationSec <= 60) return PROFILES[0]; // 1080p
  if (durationSec <= 120) return PROFILES[1]; // 720p
  if (durationSec <= 240) return PROFILES[2]; // 480p
  return PROFILES[3]; // 360p
}

function pickMode(mode) {
  return MODES[mode] || MODES.balanced;
}

/**
 * Dimensi output: AR dijaga, selalu genap, default TIDAK upscale.
 * @param {object} profile profil terpilih
 * @param {object} meta    metadata sumber
 * @param {object} opts    { platform, forceUpscale }
 *
 * Bedanya per platform:
 *  • WA     → kotak 16:9 (portrait dibalik jadi 9:16), video panjang diturunin resolusi
 *  • TikTok → TikTok native 1080 lebar buat portrait (1080x1920 dan varian lebih
 *             tinggi), 1080 tinggi buat landscape. Ini bikin TikTok GAK rescale
 *             lagi → gak ada blur tambahan dari sisi TikTok.
 */
function targetDims(profile, meta, opts = {}) {
  const plat = getPlatform(opts.platform);
  const portrait = (meta.height || 0) >= (meta.width || 0);
  let box;
  if (plat.key === 'tiktok') {
    box = portrait
      ? { w: Math.min(profile.box.w, profile.box.h), h: 2400 } // lebar = 1080 (atau 720)
      : { w: profile.box.w, h: profile.box.h };                // 1920x1080 (atau 1280x720)
  } else {
    box = portrait ? { w: profile.box.h, h: profile.box.w } : profile.box;
  }
  const srcW = meta.width || box.w;
  const srcH = meta.height || box.h;
  const ceiling = opts.forceUpscale ? Infinity : 1;
  const factor = Math.min(box.w / srcW, box.h / srcH, ceiling);
  return {
    width: roundEven(srcW * factor),
    height: roundEven(srcH * factor),
    upscaled: factor > 1,
    forcedUpscale: opts.forceUpscale && factor > 1,
    box,
  };
}

/** Filter chain lengkap sesuai karakter sumber */
function buildFilters(meta, dims, opts = {}) {
  const parts = [];

  // 1) Framerate → CFR maks 30 fps (anti gerakan patah-patah)
  parts.push(`fps=${opts.fps || ENGINE.maxFps}`);

  // 2) Scale LANCZOS (tajam) + AR presisi, tidak pernah upscale.
  //    PENTING: scale ditaruh SEBELUM denoise/unsharp. Kalau dibalik, filter
  //    berat jalan di resolusi & fps SUMBER (contoh 1440x2560@120fps) —
  //    boros RAM & CPU berlipat. Setelah scale, bebannya jatuh ~20x.
  parts.push(
    `scale=${dims.width}:${dims.height}:flags=lanczos+accurate_rnd+full_chroma_int:sws_dither=none`
  );
  parts.push('setsar=1');

  // 2b) HDR / 10-bit → tonemap ke BT.709 8-bit (biar warna gak pucet).
  //     Ditaruh SETELAH scale: tonemap pakai frame float32 RGB yang gede
  //     (1440x2560 = 59 MB/frame). Kalau jalan di resolusi sumber, RAM-nya
  //     bisa meledak. Setelah scale ke 1080x1920 jadi ~3x lebih hemat.
  if (meta.isHDR && CAPS.zscale && CAPS.tonemap) {
    parts.push(
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
      'format=yuv420p'
    );
  }

  // 3) Denoise ringan (sekarang di resolusi output — murah & tetap efektif)
  if (opts.denoise) parts.push('hqdn3d=2:1.5:6:6');

  // 4) Light unsharp LUMA aja → detail tetap kerasa setelah WA re-encode
  const sharpen = opts.sharpen ?? 0;
  if (sharpen > 0) parts.push(`unsharp=5:5:${sharpen}:5:5:0.0`);

  parts.push('format=yuv420p');
  return parts.join(',');
}

/**
 * Rencana encode (ditampilkan ke user + dipakai engine).
 * @param {object} meta hasil extractMeta()
 * @param {object} options { quality, mode, trim:'none'|'auto30', trimStartSec }
 */
function plan(meta, options = {}) {
  const opts = typeof options === 'string' ? { quality: options } : options || {};
  const mode = pickMode(opts.mode);
  const plat = getPlatform(opts.platform);
  const sourceDur = meta.durationSec;

  // Auto-trim 30 detik CUMA buat Status WA (TikTok gak ada batas 30 dtk)
  const wantTrim = plat.trimAllowed && (opts.trim === 'auto30' || opts.trim === true || opts.trim === '30s');
  const startSec = Math.max(0, Math.min(parseFloat(opts.trimStartSec) || 0, Math.max(0, sourceDur - 1)));
  const remaining = Math.max(1, sourceDur - startSec);
  const durationSec = wantTrim ? Math.min(remaining, 30) : remaining;
  const trimmed = wantTrim && durationSec < sourceDur - 0.05;

  let profile = plat.pick(durationSec, opts.quality);
  const autoQuality = !opts.quality || opts.quality === 'auto';
  const fps = plat.fps(meta);
  const srcPxEarly = (meta.width || 0) * (meta.height || 0);
  const heavyEarly = srcPxEarly > 2073600 || (meta.fps || 0) > 60 || /hevc|h265/.test(meta.vCodec || '');
  // Container RAM-nya kecil (Railway free/starter) + video berat → turunkan
  // target biar PASTI selesai, daripada gagal kehabisan RAM.
  // (TikTok: 720p masih HD & masih di atas minimum TikTok 540x960)
  const ecoDownscale = config.LOW_MEM && heavyEarly && autoQuality && plat.profiles[0] === profile;
  if (ecoDownscale) profile = plat.profiles[1];
  // forceUpscale: khusus TikTok, kalau user mau maksa pas 1080 (sumber kecil)
  const dims = targetDims(profile, meta, {
    platform: plat.key,
    forceUpscale: plat.key === 'tiktok' && opts.forceUpscale === true,
  });

  const totalBudgetMB = plat.sizeCapMB();
  const audioKbps = meta.hasAudio ? plat.audioKbps : 0;

  // Estimasi bitrate video yang realistis:
  // - mode max  → 2-pass, isi sampai maks (dibatasi cap profil & MAX_OUTPUT_MB)
  // - mode lain → perkiraan hasil CRF x264 (≈ 55% dari cap utk konten normal)
  // TikTok: plafon bitrate SKALA ke resolusi hasil (bukan resolusi profil),
  // biar video 720p gak dibengkakin jadi 12 Mbps (mubazir) —
  // panduan: 1080p ≈ 12 Mbps · 720p ≈ 8 Mbps · 480p ≈ 5 Mbps
  const shortSide = Math.min(dims.width || 1080, dims.height || 1920);
  const ttCapBase = Math.max(2.5, Math.min(12, (shortSide / 1080) * 12));
  // 50/60fps butuh ~1/3 bitrate ekstra biar gerakan gak pecah
  const ttFpsBoost = plat.key === 'tiktok' && fps >= 50 ? 1.34 : 1;
  const capKbps = Math.round((plat.key === 'tiktok' ? ttCapBase : profile.capMbps) * 1000 * ttFpsBoost);
  const sizeBudgetKbps = Math.floor((totalBudgetMB * 1024 * 8) / Math.max(1, durationSec));
  // TikTok: selalu kejar plafon (ABR) karena TikTok re-encode agresif.
  // WA: cukup CRF (~62% plafon) karena tujuannya hemat kuota Status.
  const qualityKbps = mode.twoPass || plat.key === 'tiktok' ? capKbps : Math.round(capKbps * 0.62);

  let videoKbps = Math.min(qualityKbps, capKbps);
  videoKbps = Math.min(videoKbps, Math.max(300, sizeBudgetKbps - audioKbps));
  videoKbps = Math.max(320, Math.round(videoKbps));
  // Batas bawah bitrate (khusus TikTok): jangan sampai TikTok nerima file "tipis"
  const minrateKbps = plat.key === 'tiktok' ? Math.round(videoKbps * 0.7) : 0;

  const estimatedMB = Math.max(
    1,
    Math.round(((videoKbps + audioKbps) * durationSec) / 8192)
  );

  // ---- Beban encoder & kompatibilitas level -------------------------------
  // Sumber berat: >2 MP, >60 fps, atau HEVC (decode-nya paling rakus RAM).
  const srcPx = srcPxEarly;
  const heavy = heavyEarly;
  const lowMem = !!config.LOW_MEM;
  const lean = heavy || lowMem || config.FFMPEG_THREADS <= 2;
  const refs0 = Math.min(5, Math.max(1, Math.round(profile.capMbps / 2)));  // 1080p→4, 720p→2
  const refs = lean ? Math.min(refs0, 2) : refs0;
  const bframes = lean ? 2 : 3;
  // rc-lookahead = penyumbang RAM terbesar x264 (diukur: 60 → 763 MB,
  // 25 → 454 MB, 15 → 355 MB untuk sumber 1440x2560@120fps).
  const lookahead = lean ? 15 : 60;
  const level = chooseLevel(dims.width, dims.height, refs + bframes + 1);
  const preset = lowMem && heavy ? 'veryfast' : heavy && !mode.twoPass ? 'fast' : mode.preset;
  const encThreads = Math.max(1, Math.min(lean ? 2 : config.FFMPEG_THREADS, 12));

  const notes = [];
  if (plat.key === 'tiktok') {
    notes.push(
      `Mode TikTok: ${dims.width}×${dims.height} · ${fps} fps · bitrate ${Math.round(minrateKbps / 1000)}–${(capKbps / 1000).toFixed(1)} Mbps ` +
      `(ABR, biar TikTok gak nambah kompresi) · audio AAC ${audioKbps}k.`
    );
    if (dims.width < 1080 && dims.height < 1920 && !dims.forcedUpscale) {
      notes.push('Sumber lebih kecil dari 1080 — engine sengaja TIDAK upscale (upscale cuma nambah file, detail gak nambah).');
    }
  }
  if (lowMem && heavy) {
    notes.push(
      `Server ini RAM-nya ${config.MEM.limitMB} MB — engine otomatis pakai mode hemat ` +
      `(target ${profile.short}${ecoDownscale ? ' karena video berat' : ''}, lookahead 15, 2 thread). ` +
      'Hasilnya tetap HD dan aman dari gagal proses.'
    );
  }
  if (heavy) {
    notes.push(
      `Sumber ${meta.width}x${meta.height} @ ${Math.round(meta.fps)}fps${/hevc/i.test(meta.vCodec || '') ? ' (HEVC)' : ''} — ` +
      `beban berat, engine pakai setting hemat (level ${level || 'auto'}, preset ${preset}). ` +
      `Video seperti ini bisa butuh beberapa menit; mode Turbo paling cepat.`
    );
  }
  if (trimmed) notes.push(`Dipangkas ${Math.round(durationSec)} detik (maks Status) — sisa ${Math.round(sourceDur)} dtk diabaikan.`);
  if (!dims.upscaled && (dims.width < profile.box.w && dims.height < profile.box.h) && (meta.width <= profile.box.w && meta.height <= profile.box.h)) {
    notes.push('Ukuran asli lebih kecil dari target — tidak di-upscale biar gak makin pecah.');
  }
  if (meta.isVFR) notes.push('Framerate sumber tidak stabil (VFR) — dinormalisasi ke CFR.');
  if (meta.isHDR) notes.push('Sumber HDR/10-bit — dikonversi ke SDR BT.709 biar warna normal di WA.');
  if (meta.bpp && meta.bpp < 0.03) notes.push('Sumber bitrate-nya tipis banget — denoise ringan dipakai biar noise-nya berkurang.');
  if ((typeof opts.sharpen === 'number' ? opts.sharpen : opts.sharpen === true ? 1 : 0) > 0) {
    notes.push('Extra tajam aktif (unsharp halus) — tampilan lebih crisp, detail asli sedikit berubah.');
  }
  if (!wantTrim && sourceDur > 30.5) notes.push('Video >30 dtk bakal kepotong otomatis sama WA saat di-post ke Status.');

  return {
    engine: { name: ENGINE.name, version: ENGINE.version },
    platform: plat.key,
    platformLabel: plat.label,
    mode: mode.key,
    modeLabel: mode.label,
    modeDesc: mode.desc,
    profileKey: profile.key,
    profileLabel: profile.label,
    quality: profile.key,
    width: dims.width,
    height: dims.height,
    portrait: dims.height > dims.width,
    fps,
    durationSec: Math.round(durationSec * 10) / 10,
    sourceDurationSec: Math.round(sourceDur * 10) / 10,
    trimmed,
    trimStartSec: Math.round(startSec * 10) / 10,
    videoKbps,
    minrateKbps,
    audioKbps,
    audioMode: meta.hasAudio ? (meta.audioChannels === 1 ? 'mono 48kHz' : 'stereo 48kHz') : 'tanpa audio',
    estimatedMB,
    maxOutputMB: totalBudgetMB,
    audioKbps2: audioKbps,
    twoPass: mode.twoPass,
    // Parameter encoder hasil hitungan (dipakai compressVideo & ditampilin di UI)
    enc: { refs, bframes, lookahead, level, preset, lean, heavy, lowMem, threads: encThreads },
    mem: { limitMB: config.MEM.limitMB, lowMem },
    // Denoise: default MATI. Cuma nyala otomatis kalau sumbernya benar-benar tipis/berisik
    // (bpp < 0.03) atau user minta eksplisit.
    denoise: opts.denoise === false ? false : (opts.denoise === true || !!(meta.bpp && meta.bpp < 0.03)),
    // Sharpening: mati secara default (lihat catatan di PROFILES). Nyalain lewat opsi "extra tajam".
    sharpen: typeof opts.sharpen === 'number'
      ? opts.sharpen
      : (opts.sharpen === true ? (SHARPEN_STRENGTH[profile.key] || 0) : 0),
    hdrTonemap: !!(meta.isHDR && CAPS.zscale && CAPS.tonemap),
    notes,
    trimNote: notes.find((n) => /kepotong otomatis/i.test(n)) || null,
  };
}

/* ------------------------------------------------------------------ *
 * Util ffmpeg
 * ------------------------------------------------------------------ */
const killTree = (proc) => {
  if (!proc) return;
  try { proc.kill('SIGKILL'); } catch (_) { /* noop */ }
};

function parseTimemark(tm) {
  const m = String(tm || '').match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const [, h, mm, ss] = m;
  return (parseInt(h || '0', 10) * 3600) + (parseInt(mm, 10) * 60) + parseFloat(ss);
}

function mulBitrate(str, factor) {
  const m = String(str).match(/^([\d.]+)([kM])?$/);
  if (!m) return str;
  return `${Math.round(parseFloat(m[1]) * factor)}${m[2] || ''}`;
}

/**
 * Jalanin ffmpeg sekali (satu pass) dengan progress + stderr ringkas.
 * @returns {{promise: Promise<void>, cancel: Function}}
 */
function runFfmpeg(input, output, outputOptions, durationSec, onProgress, opts = {}) {
  let canceled = false;
  let proc = null;
  const startedAt = Date.now();
  const stderrTail = [];

  const args = [
    '-hide_banner',
    '-nostdin',
    // 'warning' bikin ffmpeg gak nge-print statistik sama sekali → makanya progress
    // bar v3 sering macet. Solusi: minta progress mesin lewat -progress pipe:2.
    '-loglevel', 'warning',
    '-stats_period', '0.4',
    '-progress', 'pipe:2',
    ...(opts.inputOptions || []),
    '-i', input,
    ...outputOptions,
    '-y', output,
  ];

  const promise = new Promise((resolve, reject) => {
    proc = spawn(BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const total = durationSec || 0;

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail.push(text);
      if (stderrTail.length > 40) stderrTail.shift();
      if (canceled || !onProgress) return;
      // Format mesin (dari -progress pipe:2):
      //   out_time_us=4100000 \n fps=45 \n speed=2.3x \n progress=continue
      const usMatch = text.match(/out_time_us=(\d+)/) || text.match(/out_time_ms=(\d+)/);
      const timeMatch = text.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      let outSec = null;
      if (usMatch) outSec = parseInt(usMatch[1], 10) / 1e6;
      else if (timeMatch) outSec = parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseFloat(timeMatch[3]);
      else {
        // fallback: baris statistik manusiawi
        const m = text.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) outSec = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
      }
      if (outSec == null || !Number.isFinite(outSec)) return;

      const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
      const speedMatch = text.match(/speed=\s*([\d.]+)x/);
      const fpsMatch = text.match(/(?:^|\n)fps=([\d.]+)/) || text.match(/fps=\s*([\d.]+)/);
      const speed = speedMatch ? parseFloat(speedMatch[1]) : outSec / elapsed;
      const phaseDur = opts.passDuration || total;
      const pct = phaseDur ? Math.min(99.5, (outSec / phaseDur) * 100) : 0;
      try {
        onProgress({
          percent: Math.max(0, Math.round(pct * 10) / 10),
          outSec: Math.round(outSec * 10) / 10,
          speed: speed > 0 && Number.isFinite(speed) ? Math.round(speed * 100) / 100 : null,
          fps: fpsMatch ? Math.round(parseFloat(fpsMatch[1])) : null,
          etaSec: speed > 0 && phaseDur ? Math.max(0, (phaseDur - outSec) / speed) : null,
          pass: opts.pass || null,
        });
      } catch (_) { /* noop */ }
    });

    proc.on('error', (err) => reject(canceled ? new Error('Proses dibatalkan') : err));
    proc.on('close', (code, signal) => {
      if (canceled) return reject(new Error('Proses dibatalkan'));
      if (code === 0) return resolve();

      // Ambil baris stderr yang BERISI (bukan baris progress key=value)
      const meaningful = stderrTail
        .join('')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^(frame|fps|stream_\d|bitrate|total_size|out_time|dup_frames|drop_frames|speed|progress)=/.test(l))
        .slice(-8);
      const tail = meaningful.join(' | ').slice(0, 600) || 'tanpa detail';

      const err = new Error(
        `ffmpeg gagal (exit ${code == null ? 'kill' : code}${signal ? `/${signal}` : ''}): ${tail}`
      );
      err.exitCode = code;
      err.signal = signal || null;
      err.detail = tail;
      // OOM / dibunuh OS: exit 137 (SIGKILL), 9, atau proses mati tanpa code
      err.oom =
        code === 137 || code === 9 || signal === 'SIGKILL' || signal === 'SIGABRT' ||
        code == null ||
        /cannot allocate memory|out of memory|killed/i.test(tail);
      return reject(err);
    });
  });

  return {
    promise,
    cancel: () => { canceled = true; killTree(proc); },
  };
}

/** Opsi audio konsisten (AAC 48k, + loudnorm) */
function audioOptions({ hasAudio, channels, normalize, bitrate }) {
  if (!hasAudio) return ['-an'];
  const af = normalize ? `-af ${ENGINE.loudnorm}` : null;
  const opts = [
    '-c:a', 'aac',
    '-b:a', bitrate || ENGINE.audioBitrate,
    '-ar', String(ENGINE.audioSampleRate),
    '-ac', String(channels === 1 ? 1 : 2),
  ];
  if (af) opts.push(...af.split(' '));
  return opts;
}

/** Opsi video output (x264 High) */
function videoOptions({ vf, crf, bitrateKbps, minrateKbps, preset, tune = [], enc = {} }) {
  const x264 = buildX264Params({
    refs: enc.refs ?? 4,
    bframes: enc.bframes ?? 3,
    lookahead: enc.lookahead ?? 60,
    lean: !!enc.lean,
  });
  const x264Only = CODEC === 'libx264';
  const opts = [
    '-map', '0:v:0',
    '-c:v', CODEC,
    ...(x264Only ? ['-preset', preset, '-profile:v', 'high', '-x264-params', x264, '-sc_threshold', '40'] : []),
    '-pix_fmt', 'yuv420p',
    '-vf', vf,
    '-g', String(ENGINE.gop),
    ...(x264Only ? ['-keyint_min', String(Math.round(ENGINE.gop / 2))] : []),
    '-movflags', '+faststart',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-map_metadata', '-1',
    '-threads', String(enc.threads || config.FFMPEG_THREADS),
    ...tune,
  ];
  // Level cuma dipasang kalau hasil hitungan DPB-nya aman (lihat chooseLevel)
  if (enc.level && x264Only) opts.push('-level', enc.level);
  if (crf != null) {
    // CRF + VBV cap: kualitas maksimal, tapi bitrate gak ngebut ke angkasa
    opts.push('-crf', String(crf));
    if (bitrateKbps) {
      opts.push('-maxrate', `${Math.round(bitrateKbps)}k`, '-bufsize', `${Math.round(bitrateKbps * 1.75)}k`);
    }
  } else {
    // ABR (1-pass atau 2-pass): ukuran & bitrate terjamin.
    // minrate dipakai khusus TikTok: TikTok selalu kompres ulang, jadi kita
    // WAJIB kirim bitrate tinggi (8–12 Mbps). Kalau pakai CRF, konten simpel
    // bisa keluar cuma 3 Mbps → di TikTok langsung kelihatan pecah.
    opts.push('-b:v', `${Math.round(bitrateKbps)}k`);
    if (minrateKbps) opts.push('-minrate', `${Math.round(minrateKbps)}k`);
    opts.push(
      '-maxrate', `${Math.round(bitrateKbps * (minrateKbps ? 1.25 : 1.15))}k`,
      '-bufsize', `${Math.round(bitrateKbps * (minrateKbps ? 2 : 1.75))}k`
    );
  }
  return opts;
}

/* ------------------------------------------------------------------ *
 * Kompresi utama
 * ------------------------------------------------------------------ */
/**
 * @param {string} input  path file sumber
 * @param {string} output path output (.mp4)
 * @param {object} meta   hasil extractMeta()
 * @param {Function} onProgress ({percent, etaSec, speed, pass})
 * @param {object|string} options { quality, mode, trim, trimStartSec, targetMB }
 * @returns {{promise: Promise<object>, cancel: Function}}
 */
function compressVideo(input, output, meta, onProgress, options = {}) {
  const opts = typeof options === 'string' ? { quality: options } : options || {};
  const p = plan(meta, opts);

  const plat = getPlatform(p.platform);
  const profile = plat.profiles.find((x) => x.key === p.profileKey) || plat.profiles[0];
  const mode = pickMode(p.mode);
  const dims = { width: p.width, height: p.height };

  const vf = buildFilters(meta, dims, {
    fps: p.fps,
    denoise: p.denoise,
    sharpen: p.sharpen,
  });
  log.debug(`Filter: ${vf}`);

  // Batas ukuran: ikut platform (WA 50MB, TikTok 280MB biar aman di upload HP)
  const maxBytes = (opts.targetMB || plat.sizeCapMB()) * 1024 * 1024;
  const passlog = path.join(os.tmpdir(), `kyps_${crypto.randomBytes(6).toString('hex')}`);
  const cleanupPasslog = () => {
    for (const suffix of ['-0.log', '-0.log.mbtree', '.log', '.log.mbtree']) {
      try { fs.rmSync(passlog + suffix, { force: true }); } catch (_) { /* noop */ }
    }
  };

  let activeRun = null;

  const report = (payload) => {
    try { onProgress && onProgress(payload); } catch (_) { /* noop */ }
  };

  /** Satu percobaan encode (dipakai retry ladder di bawah) */
  const mkSpec = (over = {}) => {
    const prof = over.profile || profile;
    const dm = over.dims || { width: p.width, height: p.height };
    const enc = { ...(p.enc || {}), ...(over.enc || {}) };
    return {
      name: over.name || 'utama',
      profile: prof,
      mode: over.mode || mode,
      dims: dm,
      enc: { ...enc, threads: enc.threads || config.FFMPEG_THREADS },
      preset: over.preset || enc.preset || mode.preset,
      denoise: over.denoise !== undefined ? over.denoise : p.denoise,
      sharpen: over.sharpen !== undefined ? over.sharpen : p.sharpen,
    };
  };

  const filtersFor = (spec) =>
    buildFilters(meta, spec.dims, { fps: p.fps, denoise: spec.denoise, sharpen: spec.sharpen });

  // Thread decoder: sumber berat & RAM kecil → 2 thread (buffer frame ikut sedikit).
  // Frame 1440x2560 10-bit itu ±7 MB/frame; 8 thread decoder = ratusan MB sendiri.
  const decodeThreads = () => {
    const t = config.FFMPEG_THREADS;
    return (p.enc?.lean || p.enc?.heavy) ? Math.max(1, Math.min(2, t)) : Math.max(1, Math.min(4, t));
  };

  /** Encode 1-pass CRF (turbo/balanced) */
  const encodeCrf = async (spec) => {
    const vf = filtersFor(spec);
    if (spec.name === 'utama') log.debug(`Filter: ${vf}`);
    const crf = Math.max(12, Math.min(30, spec.profile.crf + spec.mode.crfBump));
    const run = runFfmpeg(
      input,
      output,
      [
        ...videoOptions({
          vf,
          crf,
          bitrateKbps: spec.profile.capMbps * 1000,
          preset: spec.preset,
          enc: spec.enc,
        }),
        '-map', '0:a:0?',
        ...audioOptions({
          hasAudio: meta.hasAudio,
          channels: meta.audioChannels,
          normalize: config.AUDIO_NORMALIZE,
          bitrate: `${p.audioKbps}k`,
        }),
      ],
      p.durationSec,
      report,
      {
        inputOptions: [...trimInputOptions(p), '-threads', String(decodeThreads())],
        pass: 1,
        passDuration: p.durationSec,
      }
    );
    activeRun = run;
    await run.promise;
  };

  /**
   * Encode 1-pass ABR dengan lantai bitrate (dipakai TikTok).
   * Kenapa bukan CRF? CRF memilih bitrate sendiri — konten simpel bisa keluar
   * 3 Mbps. TikTok SELALU re-encode, jadi file 3 Mbps bakal kelihatan pecah.
   * ABR + minrate bikin bitrate nempel di target (mis. 8–12 Mbps).
   */
  const encodeAbr1 = async (spec) => {
    const vf = filtersFor(spec);
    if (spec.name === 'utama') log.debug(`Filter: ${vf}`);
    const run = runFfmpeg(
      input,
      output,
      [
        ...videoOptions({
          vf,
          crf: null,
          bitrateKbps: p.videoKbps,
          minrateKbps: p.minrateKbps,
          preset: spec.preset,
          enc: spec.enc,
        }),
        '-map', '0:a:0?',
        ...audioOptions({
          hasAudio: meta.hasAudio,
          channels: meta.audioChannels,
          normalize: config.AUDIO_NORMALIZE,
          bitrate: `${p.audioKbps}k`,
        }),
      ],
      p.durationSec,
      report,
      {
        inputOptions: [...trimInputOptions(p), '-threads', String(decodeThreads())],
        pass: null,
        passDuration: p.durationSec,
      }
    );
    activeRun = run;
    await run.promise;
  };

  /** Encode 2-pass ABR target-size (mode max / fallback ukuran) */
  const encodeTwoPass = async (videoKbps, onPhase, spec) => {
    const vf = filtersFor(spec);
    if (spec.name === 'utama') log.debug(`Filter: ${vf}`);
    const pass1 = runFfmpeg(
      input,
      process.platform === 'win32' ? 'NUL' : '/dev/null',
      [
        '-map', '0:v:0',
        '-c:v', CODEC,
        ...(CODEC === 'libx264'
          ? [
              '-preset', spec.preset,
              '-profile:v', 'high',
              ...(spec.enc.level ? ['-level', spec.enc.level] : []),
              '-x264-params', buildX264Params({
                refs: spec.enc.refs, bframes: spec.enc.bframes, lookahead: spec.enc.lookahead, lean: spec.enc.lean,
              }),
            ]
          : []),
        '-pix_fmt', 'yuv420p',
        '-vf', vf,
        '-g', String(ENGINE.gop),
        '-b:v', `${Math.round(videoKbps)}k`,
        '-pass', '1',
        '-passlogfile', passlog,
        '-an',
        '-f', 'null',
      ],
      p.durationSec,
      (prog) => onPhase && onPhase({ ...prog, percent: prog.percent * 0.45, pass: 1 }),
      {
        inputOptions: [...trimInputOptions(p), '-threads', String(decodeThreads())],
        pass: 1,
        passDuration: p.durationSec,
      }
    );
    activeRun = pass1;
    await pass1.promise;

    const pass2 = runFfmpeg(
      input,
      output,
      [
        ...videoOptions({ vf, crf: null, bitrateKbps: videoKbps, preset: spec.preset, tune: [], enc: spec.enc }),
        '-map', '0:a:0?',
        ...audioOptions({
          hasAudio: meta.hasAudio,
          channels: meta.audioChannels,
          normalize: config.AUDIO_NORMALIZE,
          bitrate: `${p.audioKbps}k`,
        }),
        '-pass', '2',
        '-passlogfile', passlog,
      ],
      p.durationSec,
      (prog) => onPhase && onPhase({ ...prog, percent: 45 + prog.percent * 0.53, pass: 2 }),
      {
        inputOptions: [...trimInputOptions(p), '-threads', String(decodeThreads())],
        pass: 2,
        passDuration: p.durationSec,
        startPercent: 45,
      }
    );
    activeRun = pass2;
    await pass2.promise;
  };

  /**
   * Retry ladder — inilah yang bikin video "susah" tetap kekirim.
   * Percobaan 1: setting utama (kualitas terbaik).
   * Percobaan 2: setting hemat  (preset veryfast, ref 2, lookahead 20, level auto, tanpa denoise).
   * Percobaan 3: turun satu tingkat resolusi + setting hemat (jalan terakhir).
   * Error yang gak ada harapan (format rusak, disk penuh, dibatalkan) gak diulang.
   */
  const noRetry = (err) =>
    /dibatalkan|cancel/i.test(err.message) ||
    /invalid data|moov atom|could not find codec|decoder|no such file|permission denied|ENOSPC|no space/i.test(err.message);

  const runLadder = async () => {
    const lowerProfile = plat.profiles[Math.min(plat.profiles.indexOf(profile) + 1, plat.profiles.length - 1)];
    const leanEnc = { refs: 2, bframes: 2, lookahead: 20, level: null, lean: true };

    const specs = [mkSpec({ name: 'utama' })];
    specs.push(mkSpec({
      name: 'hemat',
      preset: 'veryfast',
      enc: leanEnc,
      denoise: false,
      sharpen: 0,
    }));
    if (lowerProfile && lowerProfile.key !== profile.key) {
      specs.push(mkSpec({
        name: 'aman',
        profile: lowerProfile,
        dims: targetDims(lowerProfile, meta, { platform: plat.key, forceUpscale: false }),
        preset: 'veryfast',
        enc: leanEnc,
        denoise: false,
        sharpen: 0,
      }));
    }

    let lastErr = null;
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      try {
        if (i > 0) {
          log.warn(`Percobaan ${i + 1} (${spec.name}): ${spec.dims.width}x${spec.dims.height} preset ${spec.preset} — sebab: ${(lastErr && lastErr.message || '').slice(0, 200)}`);
          report({
            percent: 0, etaSec: null, speed: null,
            pass: mode.twoPass ? 1 : null,
            phase: `ulang-${spec.name}`,
            retry: {
              attempt: i + 1,
              total: specs.length,
              name: spec.name,
              width: spec.dims.width,
              height: spec.dims.height,
              reason: (lastErr && lastErr.detail) || (lastErr && lastErr.message) || '',
            },
          });
          fs.rmSync(output, { force: true });
        }
        // TikTok selalu ABR (bitrate terjamin tinggi); WA pakai CRF (efisien).
        const useAbr = spec.mode.twoPass || plat.key === 'tiktok';
        if (useAbr && spec.mode.twoPass) await encodeTwoPass(p.videoKbps, report, spec);
        else if (useAbr) await encodeAbr1(spec);
        else await encodeCrf(spec);
        if (i > 0) log.info(`Berhasil di percobaan ${i + 1} (${spec.name}) — ${spec.dims.width}x${spec.dims.height}`);
        return spec;
      } catch (err) {
        lastErr = err;
        if (noRetry(err)) throw err;
        if (i === specs.length - 1) throw err;
      }
    }
    throw lastErr || new Error('Encode gagal');
  };


  const final = (async () => {
    try {
      const usedSpec = await runLadder();

      let size = fs.existsSync(output) ? fs.statSync(output).size : 0;

      // Ukuran masih kegedean → ulang pakai 2-pass ABR biar PASTI masuk batas
      if (size > maxBytes) {
        const totalBudgetMB = plat.sizeCapMB();
  const audioKbps = meta.hasAudio ? plat.audioKbps : 0;
        const budgetKbps = Math.floor((maxBytes * 8 * 0.97) / Math.max(1, p.durationSec)) - audioKbps;
        const abrKbps = Math.max(280, Math.min(Math.round(budgetKbps), profile.capMbps * 1000));
        log.warn(`Hasil ${(size / 1048576).toFixed(1)}MB > batas ${(maxBytes / 1048576).toFixed(0)}MB — re-encode 2-pass @ ${abrKbps}k`);
        report({ percent: 0, etaSec: null, speed: null, pass: 0, note: 'Optimasi ukuran…' });
        fs.rmSync(output, { force: true });
        const prevTwoPass = mode.twoPass;
        mode.twoPass = true; // pakai jalur 2-pass untuk encode ulang
        await encodeTwoPass(abrKbps, report, usedSpec);
        mode.twoPass = prevTwoPass;
        size = fs.existsSync(output) ? fs.statSync(output).size : 0;
      }

      // Baca ulang metadata hasil akhir (realita, bukan estimasi)
      let outMeta = null;
      try { outMeta = extractMeta(await probe(output)); } catch (_) { /* noop */ }

      return {
        file: output,
        sizeBytes: size,
        sizeMB: +(size / 1048576).toFixed(2),
        width: outMeta?.width || usedSpec.dims.width,
        height: outMeta?.height || usedSpec.dims.height,
        durationSec: outMeta?.durationSec || p.durationSec,
        fps: outMeta?.fps || p.fps,
        platform: plat.key,
        platformLabel: plat.label,
        profileKey: usedSpec.profile.key,
        profileLabel: usedSpec.profile.label,
        fellBack: usedSpec.name !== 'utama' ? usedSpec.name : null,
        mode: mode.key,
        modeLabel: mode.label,
        engine: `${ENGINE.name} v${ENGINE.version}`,
        videoKbps: p.videoKbps,
        audioKbps: p.audioKbps,
        trimmed: p.trimmed,
        hdrTonemap: p.hdrTonemap,
        estimatedMB: p.estimatedMB,
        plan: p,
      };
    } catch (err) {
      fs.rmSync(output, { force: true });
      throw err;
    } finally {
      cleanupPasslog();
    }
  })();

  return {
    promise: final,
    cancel: () => {
      try { activeRun && activeRun.cancel(); } catch (_) { /* noop */ }
    },
  };
}

/** Opsi input untuk trim (kalau plan pakai auto-trim 30 detik) */
function trimInputOptions(p) {
  if (!p.trimmed) return [];
  const args = ['-ss', String(p.trimStartSec || 0)];
  if (p.durationSec) args.push('-t', String(p.durationSec));
  return args;
}

/* ------------------------------------------------------------------ *
 * Thumbnail (buat riwayat) — square crop biar rapi di UI
 * ------------------------------------------------------------------ */
function extractThumbnail(input, outFile, opts = {}) {
  const durationSec = typeof opts === 'number' ? opts : opts.durationSec || 0;
  const startSec = typeof opts === 'object' && opts.startSec ? opts.startSec : 0;
  const at = Math.min(Math.max(0.5, startSec + Math.min(durationSec * 0.15, 6)), Math.max(0.5, durationSec - 0.1));
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-ss', String(at),
      '-i', input,
      '-frames:v', '1',
      '-vf', 'scale=360:-2:flags=lanczos,crop=min(360\\,iw):min(360\\,ih)',
      '-q:v', '3',
      '-y', outFile,
    ];
    const proc = spawn(BIN, args, { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0 && fs.existsSync(outFile)));
  });
}

/** Ekstrak 1 frame penuh (buat preview/compare) */
function extractFrame(input, outFile, atSec) {
  return new Promise((resolve) => {
    const proc = spawn(
      BIN,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(atSec), '-i', input, '-frames:v', '1', '-y', outFile],
      { stdio: 'ignore' }
    );
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0 && fs.existsSync(outFile)));
  });
}

/** SSIM output vs sumber (buat QA kualitas) */
function ssim(reference, test) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostdin',
      '-i', reference, '-i', test,
      '-lavfi', 'ssim=stats_file=-',
      '-f', 'null', '-',
    ];
    const proc = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d.toString(); });
    proc.stderr.on('data', (d) => { buf += d.toString(); });
    proc.on('close', () => {
      const all = buf.match(/All:([\d.]+)/g);
      if (!all || !all.length) return resolve(null);
      const last = all[all.length - 1].split(':')[1];
      return resolve(parseFloat(last));
    });
    proc.on('error', () => resolve(null));
  });
}

function rm(file) {
  try { fs.rmSync(file, { force: true }); } catch (_) { /* noop */ }
}

module.exports = {
  BIN,
  PROBE,
  ENGINE,
  CAPS,
  PROFILES,
  TT_PROFILES,
  PLATFORMS,
  MODES,
  pickProfile,
  pickMode,
  probe,
  extractMeta,
  plan,
  targetDims,
  buildFilters,
  compressVideo,
  extractThumbnail,
  extractFrame,
  ssim,
  rm,
  // kompat lama
  FPS: ENGINE.maxFps,
};
