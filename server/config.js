'use strict';
/**
 * ============================================================================
 *  KyyPureStatus — Konfigurasi server (env-based, Railway-ready)
 *  by KyyDevv
 * ============================================================================
 */
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Data dir: Railway volume mount path > DATA_DIR env > ./data
// (selalu absolute — dibutuhkan res.sendFile dll)
const DATA_DIR = path.resolve(
  process.env.DATA_DIR ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(ROOT, 'data')
);

const AUTH_DIR = process.env.AUTH_DIR || path.join(DATA_DIR, 'auth_info');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads'); // file upload sementara
const VIDEOS_DIR = path.join(DATA_DIR, 'videos'); // video hasil kompres (untuk resend)
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

// Pastikan folder ada
[AUTH_DIR, UPLOAD_DIR, VIDEOS_DIR].forEach((dir) => {
  fs.mkdirSync(dir, { recursive: true });
});

const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const bool = (v, d = false) => (v == null || v === '' ? d : v === 'true' || v === '1' || v === 'yes');

const config = {
  ROOT,
  DATA_DIR,
  AUTH_DIR,
  UPLOAD_DIR,
  VIDEOS_DIR,
  HISTORY_FILE,

  PORT: num(process.env.PORT, 3000),
  APP_KEY: (process.env.APP_KEY || '').trim(),
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').trim(),

  /* ---------------- Batas ukuran ---------------- */
  MAX_UPLOAD_MB: num(process.env.MAX_UPLOAD_MB, 100),
  // Batas ukuran output (WA video message aman sampai ~64MB)
  MAX_OUTPUT_MB: num(process.env.MAX_OUTPUT_MB, 50),
  // Batas ukuran khusus TikTok: 280 MB biar masih aman di-upload dari HP
  // (limit TikTok app: 287 MB iOS / 72 MB Android; dari web sampai 4 GB)
  TT_MAX_OUTPUT_MB: num(process.env.TT_MAX_OUTPUT_MB, 280),
  // Limit Status WhatsApp (dipakai UI buat kasih rekomendasi)
  STATUS_MAX_MB: num(process.env.STATUS_MAX_MB, 16),
  STATUS_MAX_SEC: num(process.env.STATUS_MAX_SEC, 30),

  MOCK_SEND: bool(process.env.MOCK_SEND, false),

  /* ---------------- Mesin video (PureHD Engine v4) ---------------- */
  FFMPEG_PATH: (process.env.FFMPEG_PATH || '').trim(),
  // Preset x264 per mode: turbo / balanced / max
  FFMPEG_PRESET_FAST: (process.env.FFMPEG_PRESET_FAST || 'veryfast').trim(),
  FFMPEG_PRESET: (process.env.FFMPEG_PRESET || 'medium').trim(),
  FFMPEG_PRESET_SLOW: (process.env.FFMPEG_PRESET_SLOW || 'slow').trim(),
  // Jumlah thread ffmpeg (default: min(CPU, 6) — aman utk container kecil)
  FFMPEG_THREADS: Math.max(1, Math.min(parseInt(process.env.FFMPEG_THREADS, 10) || os.cpus().length || 2, 12)),
  // Normalisasi loudness audio (EBU R128 -16 LUFS) — suara rata
  AUDIO_NORMALIZE: bool(process.env.AUDIO_NORMALIZE, true),
  // Mode encode default: turbo | balanced | max
  ENGINE_MODE: (process.env.ENGINE_MODE || 'balanced').trim(),
  // Auto-trim 30 detik default buat Status (bisa diubah user di UI)
  AUTO_TRIM_STATUS: bool(process.env.AUTO_TRIM_STATUS, false),

  /* ---------------- WhatsApp / Baileys ---------------- */
  WA_BROWSER: (process.env.WA_BROWSER || 'ubuntu').trim(), // ubuntu | macos | windows | baileys
  WA_BROWSER_NAME: (process.env.WA_BROWSER_NAME || 'Chrome').trim(),
  // Masa berlaku pairing code (WhatsApp ±2 menit) & QR
  PAIRING_TTL_MS: num(process.env.PAIRING_TTL_MS, 120000),
  QR_TIMEOUT_MS: num(process.env.QR_TIMEOUT_MS, 60000),
  CONNECT_TIMEOUT_MS: num(process.env.CONNECT_TIMEOUT_MS, 60000),
  KEEP_ALIVE_MS: num(process.env.KEEP_ALIVE_MS, 25000),
  // Auto-restart socket kalau koneksi terus gagal (jaga session hidup di Railway)
  RECONNECT_MAX_DELAY_MS: num(process.env.RECONNECT_MAX_DELAY_MS, 30000),

  /* ---------------- Riwayat & retensi file ---------------- */
  KEEP_VIDEOS: num(process.env.KEEP_VIDEOS, 12), // video terakhir yang disimpan (untuk Kirim Ulang / Unduh)
  MAX_HISTORY: num(process.env.MAX_HISTORY, 40),
  UPLOAD_TTL_MS: 60 * 60 * 1000, // file upload kedaluwarsa setelah 1 jam

  VERSION: '4.2.0',
  APP_NAME: 'KyyPureStatus',
  BRAND: 'KyyDevv',
  TAGLINE: 'Status HD, Auto Tajam',
};

module.exports = config;

/* ------------------------------------------------------------------ *
 * Deteksi RAM container (Railway/Fly/Docker) — dipakai engine buat
 * memilih setting hemat kalau RAM-nya kecil. os.totalmem() ngasih RAM
 * HOST (bukan limit container), jadi kita baca cgroup-nya.
 * ------------------------------------------------------------------ */
function containerMemoryMB() {
  const readNum = (file) => {
    try {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (!v || v === 'max') return 0;
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0 || n > 1e15) return 0; // 1e15+ ≈ unlimited
      return n;
    } catch { return 0; }
  };
  const cgv2 = readNum('/sys/fs/cgroup/memory.max');
  const cgv1 = readNum('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const cgCurrent = readNum('/sys/fs/cgroup/memory.current');
  const bytes = cgv2 || cgv1 || 0;
  const mb = bytes ? Math.round(bytes / 1048576) : 0;
  const hostMB = Math.round(os.totalmem() / 1048576);
  return { limitMB: mb || hostMB, fromCgroup: !!bytes, hostMB, usedMB: cgCurrent ? Math.round(cgCurrent / 1048576) : 0 };
}

const memInfo = containerMemoryMB();
// LOW_MEM: auto (default) | on | off. auto → hemat kalau RAM ≤ 1200 MB
const lowMemEnv = String(process.env.LOW_MEM || 'auto').toLowerCase();
const LOW_MEM = lowMemEnv === 'on' ? true : lowMemEnv === 'off' ? false : memInfo.limitMB <= 1200;

module.exports = {
  ...module.exports,
  MEM: memInfo,
  LOW_MEM,
};
