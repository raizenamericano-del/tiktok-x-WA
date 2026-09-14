import { motion } from 'framer-motion';
import { Check, Gauge, Info, MonitorPlay, Music4, Ruler, Scissors, Sparkles, Timer, Waves, Wand2, Droplets, Smartphone } from 'lucide-react';

const QUALITY_HINT = {
  auto: 'Otomatis pilih yang paling pas',
  '1080p': 'Full HD — paling tajam',
  '720p': 'HD — ukuran lebih kecil',
  '480p': 'SD — hemat data',
  '360p': 'Hemat kuota banget',
};

// Checklist upload TikTok — dihitung dari plan biar user tahu udah sesuai spek
const mbps = (k) => {
  const v = k / 1000;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

const TT_CHECKLIST = (plan) => [
  { label: 'Resolusi native 1080 (nggak di-rescale TikTok)', ok: Math.min(plan.width, plan.height) >= 1080 || plan.width >= 1920 },
  { label: `fps integer ${plan.fps} (24/25/30/50/60)`, ok: [24, 25, 30, 50, 60].includes(plan.fps) },
  { label: `Bitrate ${mbps(plan.minrateKbps || 0)}–${mbps(plan.videoKbps)} Mbps (TikTok minta 8–16)`, ok: plan.videoKbps >= 8000 },
  { label: 'H.264 High + MP4 + faststart', ok: true },
  { label: `Audio AAC ${plan.audioKbps}k stereo`, ok: plan.audioKbps >= 128 },
  { label: `Ukuran ${plan.estimatedMB} MB (aman, limit upload 280 MB)`, ok: plan.estimatedMB <= 280 },
];

const MODE_ICON = {
  turbo: <Gauge className="h-3.5 w-3.5" />,
  balanced: <Wand2 className="h-3.5 w-3.5" />,
  max: <Sparkles className="h-3.5 w-3.5" />,
};

/**
 * Kontrol mesin video: kualitas, mode encode, auto-trim + preview rencana.
 */
export default function EngineControls({
  cfg, uploadId, quality, setQuality, mode, setMode, trim, setTrim,
  sharpen, setSharpen, forceUpscale, setForceUpscale,
  platform, setPlatform, plan, plans, qualities, loading,
}) {
  const modes = cfg?.modes || [];
  const isTikTok = platform === 'tiktok';
  const pack = (cfg?.platforms || []).find((x) => x.key === platform);
  // Profil yang dipakai = profil platform aktif (WA 1080p vs TikTok 1080x1920)
  const profiles = isTikTok ? (cfg?.profilesTikTok || []) : (cfg?.profiles || []);
  const qualityKeys = qualities || (isTikTok ? ['auto', '1080p', '720p'] : ['auto', '1080p', '720p', '480p', '360p']);
  const activePlan = plan;

  return (
    <div className="space-y-5">
      {/* ---------- Platform tujuan ---------- */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="label !mb-0">Upload Buat Apa?</label>
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{pack?.hint || ''}</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {(cfg?.platforms || []).map((pf) => {
            const active = platform === pf.key;
            const Icon = pf.key === 'tiktok' ? Music4 : Smartphone;
            return (
              <button
                key={pf.key}
                onClick={() => setPlatform(pf.key)}
                className={`relative flex items-start gap-3 rounded-xl border p-3.5 text-left transition-all duration-200 ${
                  active
                    ? pf.key === 'tiktok'
                      ? 'border-fuchsia/50 bg-fuchsia/[0.1] shadow-glow'
                      : 'border-brand/50 bg-brand/[0.12] shadow-glow'
                    : 'border-white/[0.08] bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]'
                }`}
              >
                <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
                  active ? (pf.key === 'tiktok' ? 'bg-fuchsia/20 text-fuchsia' : 'bg-brand/20 text-brand-400') : 'bg-white/5 text-slate-400'
                }`}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className={`block text-xs font-extrabold ${active ? 'text-white' : 'text-slate-300'}`}>
                    {pf.emoji} {pf.label}
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-tight text-slate-500">{pf.hint}</span>
                </span>
                {active && <span className={`absolute right-2 top-2 h-1.5 w-1.5 rounded-full ${pf.key === 'tiktok' ? 'bg-fuchsia' : 'bg-brand'}`} />}
              </button>
            );
          })}
        </div>
      </div>

      {/* ---------- Kualitas ---------- */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="label !mb-0">Resolusi Output</label>
          {activePlan && (
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              hasil ≈ {activePlan.width}×{activePlan.height}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {qualityKeys.map((key) => {
            const p = profiles.find((x) => x.key === key) || profiles.find((x) => x.key === (key === '1080p' ? 'tiktok1080' : 'tiktok720'));
            const active = quality === key;
            const est = plans?.[key]?.estimatedMB;
            return (
              <button
                key={key}
                onClick={() => setQuality(key)}
                className={`relative overflow-hidden rounded-xl border p-3 text-left transition-all duration-200 ${
                  active
                    ? 'border-brand/50 bg-brand/[0.12] shadow-glow'
                    : 'border-white/[0.08] bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]'
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="quality-glow"
                    className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-brand/40"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  />
                )}
                <div className={`text-sm font-extrabold ${active ? 'text-white' : 'text-slate-300'}`}>
                  {key === 'auto' ? 'Auto' : p?.short || key}
                </div>
                <div className="mt-0.5 text-[10px] leading-tight text-slate-500">
                  {key === 'auto' ? QUALITY_HINT.auto : QUALITY_HINT[key] || `${p?.bitrateMbps} Mbps cap`}
                </div>
                {est ? (
                  <div className={`mt-1.5 font-mono text-[10px] font-bold ${active ? 'text-brand-400' : 'text-slate-600'}`}>
                    ≈ {est} MB
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* ---------- Mode encode ---------- */}
      <div>
        <label className="label">Mode Engine</label>
        <div className="grid gap-2 sm:grid-cols-3">
          {modes.map((m) => {
            const active = mode === m.key;
            return (
              <button
                key={m.key}
                onClick={() => setMode(m.key)}
                className={`relative flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all duration-200 ${
                  active ? 'border-mint/45 bg-mint/[0.08]' : 'border-white/[0.08] bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]'
                }`}
              >
                <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg ${active ? 'bg-mint/15 text-mint' : 'bg-white/5 text-slate-400'}`}>
                  {MODE_ICON[m.key]}
                </span>
                <span className="min-w-0">
                  <span className={`block text-xs font-extrabold ${active ? 'text-white' : 'text-slate-300'}`}>{m.label}</span>
                  <span className="mt-0.5 block text-[10px] leading-tight text-slate-500">{m.desc}</span>
                </span>
                {active && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-mint" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* ---------- Auto-trim (khusus WA) ---------- */}
      {!isTikTok && (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3.5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-fuchsia/[0.12] text-fuchsia">
            <Scissors className="h-4 w-4" />
          </span>
          <div>
            <div className="text-xs font-extrabold text-white">Potong 30 detik otomatis (khusus Status)</div>
            <div className="mt-0.5 text-[10px] leading-tight text-slate-500">
              Status WA maksimal 30 detik. Kalau aktif, engine yang motong rapi dari awal — bukan dipotong acak sama WA.
            </div>
          </div>
        </div>
        <button
          onClick={() => setTrim(!trim)}
          className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${
            trim ? 'border-mint/40 bg-mint/25' : 'border-white/10 bg-white/[0.06]'
          }`}
          aria-pressed={trim}
          aria-label="Aktifkan potong 30 detik"
        >
          <motion.span
            layout
            transition={{ type: 'spring', stiffness: 500, damping: 32 }}
            className={`absolute top-[3px] h-4 w-4 rounded-full ${trim ? 'left-[26px] bg-mint' : 'left-[3px] bg-slate-400'}`}
          />
        </button>
      </div>
      )}

      {/* ---------- Paksa 1080 (khusus TikTok, sumber kecil) ---------- */}
      {isTikTok && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3.5">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-fuchsia/[0.12] text-fuchsia">
              <MonitorPlay className="h-4 w-4" />
            </span>
            <div>
              <div className="text-xs font-extrabold text-white">Paksa 1080×1920 kalau sumbernya kecil</div>
              <div className="mt-0.5 text-[10px] leading-tight text-slate-500">
                Defaultnya engine TIDAK upscale (upscale cuma nambah ukuran file, detail nggak nambah).
                Nyalain kalau video lu di bawah 1080 dan mau pas full-screen di TikTok.
              </div>
            </div>
          </div>
          <button
            onClick={() => setForceUpscale(!forceUpscale)}
            className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${
              forceUpscale ? 'border-fuchsia/45 bg-fuchsia/25' : 'border-white/10 bg-white/[0.06]'
            }`}
            aria-pressed={forceUpscale}
            aria-label="Aktifkan paksa 1080"
          >
            <motion.span
              layout
              transition={{ type: 'spring', stiffness: 500, damping: 32 }}
              className={`absolute top-[3px] h-4 w-4 rounded-full ${forceUpscale ? 'left-[26px] bg-fuchsia' : 'left-[3px] bg-slate-400'}`}
            />
          </button>
        </div>
      )}

      {/* ---------- Extra tajam ---------- */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3.5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand/[0.12] text-brand-400">
            <Droplets className="h-4 w-4" />
          </span>
          <div>
            <div className="text-xs font-extrabold text-white">Extra tajam (unsharp halus)</div>
            <div className="mt-0.5 text-[10px] leading-tight text-slate-500">
              Bikin tampilan lebih crisp di HP. Default mati karena bikin SSIM turun sedikit —
              nyalain kalau lu lebih suka kelihatan "tajam" walau detail asli sedikit berubah.
            </div>
          </div>
        </div>
        <button
          onClick={() => setSharpen(!sharpen)}
          className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${
            sharpen ? 'border-brand/45 bg-brand/30' : 'border-white/10 bg-white/[0.06]'
          }`}
          aria-pressed={sharpen}
          aria-label="Aktifkan extra tajam"
        >
          <motion.span
            layout
            transition={{ type: 'spring', stiffness: 500, damping: 32 }}
            className={`absolute top-[3px] h-4 w-4 rounded-full ${sharpen ? 'left-[26px] bg-brand-400' : 'left-[3px] bg-slate-400'}`}
          />
        </button>
      </div>

      {/* ---------- Plan preview ---------- */}
      {activePlan && (
        <div className="rounded-2xl border border-white/[0.08] bg-ink-950/50 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Info className="h-3.5 w-3.5 text-brand-400" />
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Rencana Encode</span>
            </div>
            <span className={`chip ${loading ? 'chip-amber' : 'chip-brand'}`}>{loading ? 'ngitung…' : activePlan.profileLabel}</span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric icon={<Ruler className="h-3 w-3" />} label="Resolusi" value={`${activePlan.width}×${activePlan.height}`} />
            <Metric icon={<Timer className="h-3 w-3" />} label="Durasi" value={`${activePlan.durationSec}s`} accent={activePlan.trimmed} />
            <Metric
              icon={<Gauge className="h-3 w-3" />}
              label="Bitrate"
              value={isTikTok && activePlan.minrateKbps
                ? `${mbps(activePlan.minrateKbps)}–${mbps(activePlan.videoKbps)} Mbps`
                : `${(activePlan.videoKbps / 1000).toFixed(1)} Mbps`}
            />
            <Metric icon={<Waves className="h-3 w-3" />} label="Perkiraan" value={`${activePlan.estimatedMB} MB`} />
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="chip">{activePlan.fps} fps</span>
            <span className="chip">{activePlan.audioMode}</span>
            {activePlan.twoPass && <span className="chip-brand">2-pass ABR</span>}
            {isTikTok && !activePlan.twoPass && <span className="chip-brand">ABR + minrate</span>}
            {activePlan.hdrTonemap && <span className="chip-mint">HDR → SDR</span>}
            {activePlan.denoise && <span className="chip-mint">denoise</span>}
            {activePlan.sharpen > 0 && <span className="chip-mint">extra tajam {activePlan.sharpen}</span>}
            {activePlan.trimmed && <span className="chip-amber">dipotong {activePlan.durationSec}s</span>}
          </div>

          {isTikTok && (
            <div className="mt-3 rounded-xl border border-fuchsia/25 bg-fuchsia/[0.05] p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-extrabold text-fuchsia">
                <Music4 className="h-3.5 w-3.5" /> Checklist upload TikTok
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {TT_CHECKLIST(activePlan).map((c) => (
                  <div key={c.label} className="flex items-start gap-1.5 text-[10px] leading-tight">
                    <span className={`mt-[1px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full ${
                      c.ok ? 'bg-mint/20 text-mint' : 'bg-amber-400/20 text-amber-300'
                    }`}>
                      <Check className="h-2.5 w-2.5" />
                    </span>
                    <span className={c.ok ? 'text-slate-400' : 'text-amber-300'}>{c.label}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2.5 border-t border-white/[0.07] pt-2 text-[10px] leading-relaxed text-slate-400">
                <span className="font-bold text-slate-300">Biar makin gak pecah:</span> di TikTok nyalain{' '}
                <span className="font-mono text-[9.5px] text-fuchsia">Settings → Content preferences → Allow high-quality uploads</span>,
                lalu upload lewat <span className="font-bold text-slate-300">tiktok.com</span> (web) — app HP sering nge-encode ulang sebelum kirim.
              </div>
            </div>
          )}

          {activePlan.notes?.length > 0 && (
            <ul className="mt-3 space-y-1">
              {activePlan.notes.map((n, i) => (
                <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-slate-400">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand-400" /> {n}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ icon, label, value, accent }) {
  return (
    <div className="tile">
      <div className="flex items-center gap-1 text-[9.5px] font-bold uppercase tracking-wider text-slate-500">
        {icon} {label}
      </div>
      <div className={`mt-1 font-mono text-xs font-bold ${accent ? 'text-fuchsia' : 'text-slate-100'}`}>{value}</div>
    </div>
  );
}
