'use strict';
/**
 * ============================================================================
 *  KyyPureStatus — WhatsApp Manager v4  (by KyyDevv)
 * ============================================================================
 *  PERBAIKAN PAIRING CODE (v3 → v4)
 *  ---------------------------------------------------------------------------
 *  Bug di v3 (bikin "pairing code gak fungsi"):
 *   1. `requestPairingCode()` dipanggil TERLALU CEPAT. Di v3, socket dibuat
 *      lalu request langsung ditembak — padahal WebSocket ke server WA belum
 *      `open`. Baileys mengirim node lewat `sendRawMessage()` yang akan throw
 *      `Boom('Connection Closed')` kalau socket belum open, jadi kode gak
 *      pernah diterbitkan / error "Connection Closed".
 *      → FIX: tunggu `waitForSocketOpen()` + tunggu handshake `pair-device`
 *        (event connection.update berisi `qr`) baru minta kode.
 *   2. Saat mode pairing, socket tetap mem-publish QR tiap ±20 detik dan
 *      `setState('qr')` MENGHAPUS `pairingCode` → kode yang sudah tampil di UI
 *      hilang sendiri. (Di v3 juga ada listener `sock.ev.on('pairing.code')`
 *      yang event-nya TIDAK PERNAH ada di Baileys — dead code.)
 *      → FIX: flag `pairingMode` (QR di-suppress selama pairing) + kode
 *        disimpan dengan masa berlaku & tidak dihapus oleh update QR.
 *   3. Setelah kode dimasukin di HP, WhatsApp meminta restart socket (stream
 *      error 515 "restart required"). Kalau tidak ditangani, user stuck di
 *      "pairing" selamanya walau kode sudah benar.
 *      → FIX: 515 → restart socket cepat (1.2s) tanpa menghapus session,
 *        lalu login otomatis pakai creds yang baru terdaftar.
 *   4. Session lama yang tidak valid (`creds.registered === false`) bikin
 *      requestPairingCode ditolak (409/428). → FIX: deteksi & bersihkan
 *      session mati sebelum pairing.
 *   5. Tidak ada validasi/ekspansi nomor (08xx / +62 / spasi) dan tidak ada
 *      info kedaluwarsa kode. → FIX: normalisasi nomor + TTL + refresh.
 * ============================================================================
 */
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const config = require('./config');
const { log } = require('./logger');

const silentLogger = pino({ level: config.LOG_LEVEL === 'debug' ? 'debug' : 'silent' });

const withTimeout = (p, ms, msg) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg || 'Timeout')), ms)),
  ]);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pilih browser descriptor (dipakai WA untuk nama perangkat yang di-link) */
function pickBrowser() {
  const osName = (config.WA_BROWSER || 'ubuntu').toLowerCase();
  const name = config.WA_BROWSER_NAME || 'Chrome';
  try {
    if (osName === 'macos' || osName === 'mac') return Browsers.macOS(name);
    if (osName === 'windows' || osName === 'win') return Browsers.windows(name);
    if (osName === 'baileys') return Browsers.baileys(name);
  } catch (_) { /* fallback di bawah */ }
  return Browsers.ubuntu(name);
}

/** Normalisasi nomor WA → 628xxxxxxxxxx (tanpa +, spasi, atau tanda hubung) */
function normalizeWaNumber(input) {
  let n = String(input || '').replace(/[^\d]/g, '');
  if (!n) throw new Error('Nomornya masih kosong. Isi nomor WA-nya dulu ya.');
  if (n.startsWith('0')) n = `62${n.slice(1)}`;         // 0812… → 62812…
  if (n.startsWith('620')) n = `62${n.slice(3)}`;        // 620812… (salah ketik umum)
  if (n.startsWith('8')) n = `62${n}`;                   // 812… → 62812…
  if (!/^\d{9,15}$/.test(n)) {
    throw new Error('Nomor WA-nya gak valid. Pakai format internasional, contoh: 6281234567890');
  }
  if (!/^62/.test(n)) {
    throw new Error('Nomornya harus pakai kode negara. Contoh Indonesia: 6281234567890 (bukan +62 / 0812)');
  }
  return n;
}

class WhatsAppManager {
  constructor(io) {
    this.io = io;
    this.sock = null;
    this.state = 'idle'; // idle|starting|qr|pairing|connecting|connected|reconnecting|disconnected|logged_out
    this.phone = null;
    this.connectedAt = null;
    this.latestQr = null;

    /* --- state pairing code --- */
    this.pairingMode = false;      // true = QR di-suppress, tunggu kode dipakai
    this.pairingCode = null;
    this.pairingNumber = null;
    this.pairingIssuedAt = null;
    this.pairingExpiresAt = null;
    this.pairingAttempts = 0;
    this._pairingReady = null;     // resolve saat handshake siap
    this._wantsPairAgain = false;  // dipakai saat refresh kode

    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.starting = false;
    this._shuttingDown = false;
    this.manualDisconnect = false;
    this._sentMessages = new Map(); // messageId → { target, at } untuk tracking centang
  }

  /* ================================================================== *
   * Status publik
   * ================================================================== */
  status() {
    return {
      mock: config.MOCK_SEND,
      state: this.state,
      phone: this.phone,
      realSession: this.state === 'connected',
      connectedAt: this.connectedAt,
      qr: this.state === 'qr' && !this.pairingMode ? this.latestQr : null,
      qrTimeoutMs: config.QR_TIMEOUT_MS,
      pairing: this.pairingInfo(),
      engine: { name: 'PureHD Engine', version: config.VERSION },
    };
  }

  pairingInfo() {
    if (!this.pairingCode && !this.pairingMode) return null;
    const expiresInMs = this.pairingExpiresAt ? Math.max(0, this.pairingExpiresAt - Date.now()) : 0;
    return {
      active: !!this.pairingCode || this.pairingMode,
      code: this.pairingCode,
      number: this.pairingNumber,
      issuedAt: this.pairingIssuedAt,
      expiresAt: this.pairingExpiresAt,
      expiresInMs,
      expired: !!this.pairingCode && expiresInMs <= 0,
      attempts: this.pairingAttempts,
      waiting: this.pairingMode && !this.pairingCode,
    };
  }

  /** Update state + broadcast ke semua client */
  setState(state) {
    this.state = state;
    if (state !== 'qr') this.latestQr = null;
    // JANGAN hapus pairingCode karena update QR/connection — kode hanya
    // dihapus eksplisit lewat _clearPairing() (fix bug v3)
    this._broadcast();
    log.info(
      `Koneksi WhatsApp: ${state}${this.phone ? ` (${this.phone})` : ''}` +
      (this.pairingCode ? ` · pairing code aktif untuk ${this.pairingNumber}` : '')
    );
  }

  _broadcast() {
    try { this.io.emit('conn:update', this.status()); } catch (_) { /* noop */ }
  }

  _emit(event, payload) {
    try { this.io.emit(event, payload); } catch (_) { /* noop */ }
  }

  /** Buang sesi setengah jadi (belum terdaftar) supaya pairing bisa jalan */
  _sessionRegistered() {
    try {
      const f = `${config.AUTH_DIR}/creds.json`;
      if (!fs.existsSync(f)) return false;
      const creds = JSON.parse(fs.readFileSync(f, 'utf8'));
      return !!creds?.registered;
    } catch (_) {
      return false;
    }
  }

  /* ================================================================== *
   * Koneksi socket
   * ================================================================== */
  async start({ forceFresh = false } = {}) {
    if (this.starting) return this.status();
    if (this._shuttingDown) return this.status();
    this.starting = true;

    try {
      this._teardown();
      this.setState('starting');

      const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);
      let version;
      try {
        version = (await withTimeout(fetchLatestBaileysVersion(), 10000)).version;
      } catch (_) {
        version = undefined; // pakai version default bawa Baileys
      }

      this.sock = makeWASocket({
        auth: state,
        version,
        logger: silentLogger,
        browser: pickBrowser(),
        markOnlineOnConnect: false,          // jangan ganggu notif HP
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
        fireInitQueries: true,
        emitOwnEvents: true,                 // supaya status centang bisa dilacak
        connectTimeoutMs: config.CONNECT_TIMEOUT_MS,
        keepAliveIntervalMs: config.KEEP_ALIVE_MS,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 250,
        qrTimeout: config.QR_TIMEOUT_MS,
        getMessage: async () => undefined,   // hindari error saat WA minta retry
        cachedGroupMetadata: async () => undefined,
      });

      this.sock.ev.on('creds.update', saveCreds);
      this.sock.ev.on('connection.update', (u) => this._onConnUpdate(u));
      this.sock.ev.on('messages.update', (updates) => this._onMessagesUpdate(updates));
      if (forceFresh) log.info('Socket dibuat ulang (fresh)');

      // Jaring aman: kalau 12 detik socket belum juga ngasih QR/handshake,
      // laporkan biar UI bisa kasih tombol coba lagi (bukan diam-diam stuck)
      setTimeout(() => {
        if (this.state === 'starting' && !this._shuttingDown) {
          log.warn('Handshake WhatsApp lambat (>12s) — masih menunggu...');
          this.setState('connecting');
        }
      }, 12000);

      if (this._wantsPairAgain && this.pairingNumber) {
        const num = this.pairingNumber;
        this._wantsPairAgain = false;
        log.info('Melanjutkan permintaan pairing code setelah socket siap…');
        this._requestPairingInternal(num).catch((e) => log.error('Pairing lanjutan gagal:', e.message));
      }
    } catch (err) {
      log.error('Gagal start socket:', err.message);
      this.setState('disconnected');
    } finally {
      this.starting = false;
    }
    return this.status();
  }

  _teardown() {
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end(undefined);
      } catch (_) { /* noop */ }
    }
    this.sock = null;
  }

  _onConnUpdate(update) {
    const { connection, lastDisconnect, qr } = update;

    /* --- QR datang = handshake ke server WA sudah selesai --- */
    if (qr) {
      this.latestQr = qr;
      if (this._pairingReady) {           // kabari penunggu requestPairingCode
        this._pairingReady();
        this._pairingReady = null;
      }
      if (this.pairingMode) {
        // Mode pairing: QR TIDAK ditampilkan & state TIDAK diubah → kode aman
        log.debug('QR diterima tapi diabaikan (mode pairing aktif)');
      } else {
        this.setState('qr');
      }
    }

    if (update.isNewLogin) {
      log.info('Perangkat baru berhasil ditautkan — menunggu restart koneksi (WA minta begini)');
      this.setState('connecting');
    }

    if (connection === 'connecting') {
      if (this.state !== 'pairing' && this.state !== 'qr') this.setState('connecting');
    }

    if (connection === 'open') {
      this.reconnectAttempts = 0;
      this.phone = (this.sock?.user?.id || '').split(':')[0] || null;
      this.connectedAt = Date.now();
      this._clearPairing();
      this.setState('connected');
      this._emit('notice', {
        type: 'success',
        title: 'WA-nya nyambung! 🎉',
        message: this.phone ? `Login sebagai ${this.phone}. Siap kirim video HD.` : 'Koneksi WhatsApp aktif.',
      });
    }

    if (connection === 'close') {
      this._onClose(lastDisconnect?.error);
    }
  }

  _onClose(err) {
    const code = err?.output?.statusCode || err?.statusCode;
    const reason = err?.message || 'unknown';
    this.phone = null;
    this.connectedAt = null;
    this.sock = null;
    clearTimeout(this.reconnectTimer);

    if (this._shuttingDown || this.manualDisconnect) {
      this.manualDisconnect = false;
      this.setState('idle');
      return;
    }

    // 401 logged out / 403 forbidden / 409 replaced → session mati
    if (
      code === DisconnectReason.loggedOut ||
      code === DisconnectReason.forbidden ||
      code === DisconnectReason.connectionReplaced ||
      code === DisconnectReason.multideviceMismatch
    ) {
      log.warn(`Session ditutup (code ${code} / ${reason}) — session lokal dibersihkan`);
      this.clearSession();
      this._clearPairing();
      this.setState(code === DisconnectReason.connectionReplaced ? 'disconnected' : 'logged_out');
      this._emit('notice', {
        type: 'warn',
        title: 'Session WA berakhir',
        message: 'Sesi kita ditutup WhatsApp. Sambungin ulang pakai QR / pairing code.',
      });
      return;
    }

    // 515 restart-required = SINYAL BAIK setelah pairing: WA minta socket
    // di-restart supaya login pakai creds baru. Restart cepat, jangan hapus apa pun.
    if (code === DisconnectReason.restartRequired) {
      log.info('WhatsApp minta restart koneksi (515) — restart cepat…');
      this.setState(this.pairingMode ? 'pairing' : 'connecting');
      this.reconnectTimer = setTimeout(() => this.start(), 1200);
      return;
    }

    // Putus sementara → reconnect dengan backoff + jitter
    const attempt = (this.reconnectAttempts += 1);
    const backoff = Math.min(config.RECONNECT_MAX_DELAY_MS, 1500 * 2 ** Math.min(attempt - 1, 4));
    const jitter = Math.floor(Math.random() * 700);
    log.warn(`Koneksi terputus (code ${code ?? 'unknown'} / ${reason}) — reconnect dalam ${((backoff + jitter) / 1000).toFixed(1)}s`);
    this.setState('reconnecting');
    if (attempt === 3) {
      this._emit('notice', { type: 'warn', title: 'Koneksi WA goyah', message: 'Lagi nyoba nyambungin ulang otomatis...' });
    }
    if (attempt > 12) {
      log.error('Reconnect gagal berkali-kali — berhenti mencoba. Buka halaman Koneksi untuk coba manual.');
      this.setState('disconnected');
      this.reconnectAttempts = 0;
      return;
    }
    this.reconnectTimer = setTimeout(() => this.start(), backoff + jitter);
  }

  /** Hapus file session lokal (logout penuh) */
  clearSession() {
    try {
      fs.rmSync(config.AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(config.AUTH_DIR, { recursive: true });
    } catch (_) { /* noop */ }
  }

  _clearPairing() {
    this.pairingMode = false;
    this.pairingCode = null;
    this.pairingNumber = null;
    this.pairingIssuedAt = null;
    this.pairingExpiresAt = null;
    this.pairingAttempts = 0;
    this._pairingReady = null;
  }

  async ensureStarted() {
    if (!this.sock) await this.start();
    return this.status();
  }

  /* ================================================================== *
   * QR
   * ================================================================== */
  async requestQR() {
    if (this.state === 'connected') return this.status();
    this._clearPairing();                    // pindah ke mode QR
    if (!this.sock || this.state === 'idle' || this.state === 'logged_out' || this.state === 'disconnected') {
      await this.start();
    }
    return this.status();
  }

  /* ================================================================== *
   * PAIRING CODE (inti perbaikan v4)
   * ================================================================== */
  async requestPairing(number, { refresh = false } = {}) {
    const clean = normalizeWaNumber(number);
    if (this.state === 'connected') {
      throw new Error('WA-nya udah nyambung. Logout dulu kalau mau nautin nomor lain.');
    }

    if (!refresh) this.pairingAttempts = 0;
    if (this.pairingAttempts >= 6) {
      throw new Error('Udah nyoba 6 kali nih. Tunggu ±1 menit dulu, terus coba lagi (WhatsApp bisa membatasi permintaan kode).');
    }

    // Session mati/setengah jadi bikin WhatsApp nolak permintaan kode → bersihkan
    if (!this._sessionRegistered() && !this.pairingCode) {
      const hasCreds = fs.existsSync(`${config.AUTH_DIR}/creds.json`);
      if (hasCreds && this.state !== 'connected') {
        log.info('Ada sisa session yang belum terdaftar — dibersihkan dulu biar pairing lancar');
        this.clearSession();
        this._teardown();
        this.sock = null;
      }
    }

    return this._requestPairingInternal(clean);
  }

  async _requestPairingInternal(clean) {
    this.pairingAttempts += 1;
    this.pairingNumber = clean;
    this.pairingMode = true;                 // suppress QR mulai sekarang
    this._broadcast();

    try {
      // 1) Pastikan socket ada & handshake WA sudah selesai.
      //    INI akar bug v3: request dikirim sebelum socket open → "Connection Closed".
      if (!this.sock || ['idle', 'logged_out', 'disconnected'].includes(this.state)) {
        await this.start();
      }
      if (!this.sock) throw new Error('Socket WhatsApp gagal dibuat. Coba lagi sebentar.');

      // 2) Tunggu socket benar-benar open (bukan cuma dibuat)
      await withTimeout(
        this.sock.waitForSocketOpen ? this.sock.waitForSocketOpen() : delay(1500),
        20000,
        'Koneksi ke server WhatsApp lambat. Coba lagi.'
      );

      // 3) Tunggu handshake `pair-device` (ditandai QR pertama dari server).
      //    Tanpa ini, WhatsApp sering menolak/mengabaikan permintaan kode.
      if (!this.latestQr && this.state !== 'qr') {
        await withTimeout(this._waitForHandshake(), 20000, 'WhatsApp belum siap nerima pairing code. Coba lagi ya.');
      }

      // 4) Minta kode (retry 1x kalau di detik itu socket sempat kedip)
      let code = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= 2 && !code; attempt += 1) {
        try {
          code = await withTimeout(
            this.sock.requestPairingCode(clean),
            25000,
            'Permintaan pairing code ke WhatsApp timeout.'
          );
        } catch (e) {
          lastErr = e;
          log.warn(`Percobaan pairing #${attempt} gagal: ${e.message}`);
          if (attempt === 1) await delay(1500);
        }
      }
      if (!code) throw lastErr || new Error('WhatsApp gak kasih pairing code. Coba lagi.');

      // 5) Simpan + hitung masa berlaku (WhatsApp ±2 menit)
      this.pairingCode = this._formatCode(code);
      this.pairingIssuedAt = Date.now();
      this.pairingExpiresAt = this.pairingIssuedAt + config.PAIRING_TTL_MS;
      this.setState('pairing');

      this._emit('pairing:code', this.pairingInfo());
      log.info(`Pairing code terbit untuk ${clean}: ${this.pairingCode} (berlaku ${Math.round(config.PAIRING_TTL_MS / 1000)}s)`);
      return this.pairingInfo();
    } catch (err) {
      // Gagal → balik ke mode QR biar user punya jalan lain, jangan stuck
      this.pairingMode = false;
      if (!this.pairingCode) this.setState(this.latestQr ? 'qr' : 'connecting');
      this._broadcast();
      const msg = String(err?.message || err);
      if (/Connection Closed/i.test(msg)) {
        throw new Error('Koneksi ke WhatsApp sempat ketutup sebelum kode dibuat. Klik "Ambil Kode" lagi ya (biasanya langsung sukses di percobaan ke-2).');
      }
      if (/401|logged out/i.test(msg)) {
        throw new Error('Session lama ditolak WhatsApp. Session lokal udah dibersihin — coba ambil kode lagi.');
      }
      throw new Error(`Gagal ambil pairing code: ${msg}`);
    }
  }

  /** Tunggu event connection.update berisi QR (tanda handshake selesai) */
  _waitForHandshake() {
    if (this.latestQr || this.state === 'qr') return Promise.resolve();
    return new Promise((resolve) => {
      this._pairingReady = resolve;
      setTimeout(() => {
        if (this._pairingReady === resolve) {
          this._pairingReady = null;
          resolve();
        }
      }, 20000);
    });
  }

  /** Batalkan mode pairing (dipakai endpoint /api/connect/pairing/cancel) */
  cancelPairing() {
    this._clearPairing();
  }

  _formatCode(code) {
    return String(code || '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase()
      .slice(0, 8);
  }

  _waitState(states, timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (states.includes(this.state)) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error('Koneksi ke WA belum siap, coba lagi'));
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  async _ensureConnected(timeoutMs) {
    if (config.MOCK_SEND && this.state !== 'connected') return; // mode uji
    if (this.state !== 'connected') {
      await this._waitState(['connected'], timeoutMs || 20000).catch(() => {
        throw new Error('WA belum nyambung. Scan QR / pairing code dulu ya di halaman Koneksi.');
      });
    }
  }

  /* ================================================================== *
   * Kirim video
   * ================================================================== */
  async isOnWhatsApp(number) {
    if (config.MOCK_SEND && this.state !== 'connected') return true; // mode uji
    await this._ensureConnected(20000);
    try {
      const res = await withTimeout(this.sock.onWhatsApp(`${number}@s.whatsapp.net`), 10000);
      return !!res?.[0]?.exists;
    } catch (_) {
      return true; // gagal cek → lanjut, biar error jelas muncul saat kirim
    }
  }

  /**
   * Kirim video sebagai pesan video native (bukan dokumen) supaya bisa
   * langsung di-forward ke Status dari HP.
   */
  async sendVideo(number, filePath, caption, meta = {}) {
    if (config.MOCK_SEND && this.state !== 'connected') {
      log.info(`[MOCK] Kirim video ke ${number}`);
      await delay(2000);
      return { mock: true, messageId: `MOCK-${Date.now()}`, jid: `${number}@s.whatsapp.net` };
    }

    await this._ensureConnected(25000);
    const jid = `${number}@s.whatsapp.net`;
    const stat = await fs.promises.stat(filePath).catch(() => null);

    const content = {
      video: { url: filePath, mimetype: 'video/mp4' },
      caption: caption || undefined,
      fileName: meta.fileName || 'KyyPureStatus.mp4',
      mimetype: 'video/mp4',
      // metadata ini dipakai WhatsApp buat preview + biar kualitas dipertahankan
      seconds: meta.durationSec ? Math.round(meta.durationSec) : undefined,
      width: meta.width || undefined,
      height: meta.height || undefined,
      fileLength: stat ? String(stat.size) : undefined,
    };
    Object.keys(content).forEach((k) => content[k] === undefined && delete content[k]);

    const res = await this.sock.sendMessage(jid, content, { mediaUploadTimeoutMs: 180000 });
    const messageId = res?.key?.id || null;
    if (messageId) this._sentMessages.set(messageId, { target: number, at: Date.now() });
    log.info(`Video terkirim ke ${jid} (id: ${messageId})`);
    return { mock: false, messageId, jid };
  }

  /** Update centang (SERVER_ACK/DELIVERY_ACK/READ) → dipakai UI */
  _onMessagesUpdate(updates) {
    for (const u of updates || []) {
      const id = u.key?.id;
      if (!id || !this._sentMessages.has(id)) continue;
      const status = u.update?.status;
      if (status == null) continue;
      // 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ, 5=PLAYED
      const info = this._sentMessages.get(id);
      this._emit('send:ack', { messageId: id, target: info.target, status });
      if (status >= 3) this._sentMessages.delete(id);
    }
  }

  /* ================================================================== *
   * Putus / logout / shutdown
   * ================================================================== */
  async disconnect() {
    this.manualDisconnect = true;
    this._clearPairing();
    try {
      if (this.sock) this.sock.end(new Error('disconnect manual'));
    } catch (_) { /* noop */ }
    this.sock = null;
    this.phone = null;
    this.connectedAt = null;
    this.setState('idle');
  }

  async logout() {
    this.manualDisconnect = true;
    try {
      if (this.sock && this.state === 'connected') {
        await withTimeout(this.sock.logout(), 10000).catch(() => {});
      }
    } catch (_) { /* noop */ }
    this._clearPairing();
    this.clearSession();
    this._teardown();
    this.phone = null;
    this.connectedAt = null;
    this.setState('logged_out');
  }

  async shutdown() {
    this._shuttingDown = true;
    clearTimeout(this.reconnectTimer);
    try {
      if (this.sock) this.sock.end(undefined);
    } catch (_) { /* noop */ }
  }
}

module.exports = WhatsAppManager;
module.exports.normalizeWaNumber = normalizeWaNumber;
