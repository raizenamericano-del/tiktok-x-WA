import { motion } from 'framer-motion';
import { ArrowRight, CheckCheck, Crown, Download, Music4, RefreshCw, Rocket, Send, UploadCloud } from 'lucide-react';

/** Kartu sukses setelah video terkirim */
export default function SuccessCard({ result, onReset, onResend }) {
  const meta = result?.meta || {};
  const isTikTok = (result?.platform || meta.platform) === 'tiktok';
  const sentToWa = !!meta.sentToWa;
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94, y: 18 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 190, damping: 20 }}
      className="card overflow-hidden"
    >
      <div className="h-1.5 w-full bg-gradient-to-r from-brand via-fuchsia to-mint" />
      <div className="p-6 text-center sm:p-9">
        {/* roket */}
        <div className="relative mx-auto h-28 w-28">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-fuchsia"
              style={{ animation: `trail 1.15s ease-out ${i * 0.22}s infinite` }}
            />
          ))}
          <motion.div
            initial={{ y: 66, opacity: 0, rotate: 18 }}
            animate={{ y: 0, opacity: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 210, damping: 15, delay: 0.1 }}
            className="absolute inset-0 grid place-items-center"
          >
            <div className="grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-brand via-fuchsia to-mint shadow-glow">
              <Rocket className="h-10 w-10 text-white" />
            </div>
          </motion.div>
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-full bg-brand/25"
            animate={{ scale: [1, 1.55], opacity: [0.5, 0] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'easeOut', delay: 0.5 }}
          />
        </div>

        <motion.h2 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className="font-display mt-3 text-2xl font-extrabold tracking-tight text-white sm:text-3xl">
          {isTikTok ? 'File TikTok lu udah jadi! 🎵' : 'Video kekirim! 🎉'}
        </motion.h2>
        <motion.p initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.55 }} className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-slate-300">
          {isTikTok ? (
            sentToWa ? (
              <>File-nya udah dikirim ke <b className="font-mono text-mint">{result?.targets?.join(', ')}</b> — tinggal diunduh di HP, terus upload ke TikTok.</>
            ) : (
              <>File siap upload ke TikTok — tekan <b className="text-white">Simpan File TikTok</b> di bawah.</>
            )
          ) : (
            <>Udah masuk ke <b className="font-mono text-mint">{result?.targets?.join(', ') || result?.target}</b>{' '}
            — siap di-forward ke Status.</>
          )}
        </motion.p>

        {/* statistik hasil */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.65 }} className="mx-auto mt-5 grid max-w-lg grid-cols-2 gap-2 sm:grid-cols-4">
          <Res label="Resolusi" value={meta.resolution || '—'} />
          <Res label="Ukuran" value={`${meta.sizeMB || '—'} MB`} />
          <Res label="Durasi" value={`${Math.round(meta.durationSec || 0)}s`} />
          <Res label="Engine" value={meta.mode ? `mode ${meta.mode}` : meta.engine?.split(' ')[0] || 'PureHD'} />
        </motion.div>

        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }} className="mt-4 flex flex-wrap items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
          <span className="inline-flex items-center gap-1">
            <CheckCheck className="h-3 w-3 text-mint" /> {isTikTok ? (sentToWa ? 'terkirim ke WA (buat pindah ke HP)' : 'file siap diunduh') : 'terkirim ke server WA'}
          </span>
          {meta.videoKbps ? <span className="chip">{Math.round(meta.videoKbps / 1000 * 10) / 10} Mbps video</span> : null}
          {meta.trimmed ? <span className="chip-amber">dipotong 30s</span> : null}
          {meta.engine ? <span className="chip-mint">{meta.engine}</span> : null}
        </motion.div>

        {/* cara forward */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.9 }} className="mx-auto mt-6 max-w-md rounded-2xl border border-brand/25 bg-brand/[0.07] p-4 text-left">
          <div className={`flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] ${isTikTok ? 'text-fuchsia' : 'text-brand-400'}`}>
            {isTikTok ? <Music4 className="h-3.5 w-3.5" /> : <Crown className="h-3.5 w-3.5" />}
            {isTikTok ? 'Step upload ke TikTok' : 'Step di HP lu'}
          </div>
          {isTikTok ? (
            <ol className="mt-2.5 space-y-1.5 text-[12px] leading-relaxed text-slate-300">
              {sentToWa && (
                <li className="flex gap-2"><b className="text-white">1.</b> <span>Buka WA → <b className="text-white">download</b> file videonya ke HP</span></li>
              )}
              <li className="flex gap-2"><b className="text-white">{sentToWa ? '2' : '1'}.</b> <span>Buka <b className="text-white">tiktok.com</b> (desktop) — kualitas paling bagus, gak kena re-encode app HP</span></li>
              <li className="flex gap-2"><b className="text-white">{sentToWa ? '3' : '2'}.</b> <span>Nyalain <b className="text-white">Settings → Content preferences → Allow high-quality uploads</b></span></li>
              <li className="flex gap-2"><b className="text-white">{sentToWa ? '4' : '3'}.</b> <span>Upload file-nya → caption → <b className="text-white">Post</b>. Bitrate 8–12 Mbps-nya udah pas, jadi TikTok gak nambah pecah.</span></li>
            </ol>
          ) : (
            <ol className="mt-2.5 space-y-1.5 text-[12px] leading-relaxed text-slate-300">
              <li className="flex gap-2"><b className="text-white">1.</b> Buka WA → chat dari nomor pengirim</li>
              <li className="flex gap-2"><b className="text-white">2.</b> <span><b className="text-white">Tekan tahan</b> videonya (jangan di-download ulang)</span></li>
              <li className="flex gap-2"><b className="text-white">3.</b> <span>Pilih <b className="text-white">Teruskan</b> → <b className="text-white">Status</b></span></li>
              <li className="flex gap-2"><b className="text-white">4.</b> <span>Gas post! Kualitasnya udah di-encode maksimal — gak pecah.</span></li>
            </ol>
          )}
        </motion.div>

        {/* aksi */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1 }} className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {result?.entryId && (
            <a className="btn-primary" href={`/api/download/${result.entryId}`} download>
              <Download className="h-4 w-4" /> {isTikTok ? 'Simpan File TikTok' : 'Simpan Versi HD'}
            </a>
          )}
          {result?.entryId && (
            <button className="btn-ghost" onClick={() => onResend?.(result.entryId)}>
              <RefreshCw className="h-4 w-4" /> Kirim Ulang
            </button>
          )}
          <button className="btn-ghost" onClick={onReset}>
            <UploadCloud className="h-4 w-4" /> Video Lain <ArrowRight className="h-4 w-4" />
          </button>
        </motion.div>

        <p className="mt-4 inline-flex items-center gap-1.5 text-[10px] text-slate-500">
          {isTikTok ? (
            <><Music4 className="h-3 w-3" /> Tips: upload lewat web (tiktok.com) + aktifin "Allow high-quality uploads" — dua hal ini paling ngefek biar hasilnya gak pecah.</>
          ) : (
            <><Send className="h-3 w-3" /> Tips: video di atas 30 detik tetep bakal dicap 30 detik sama Status — makanya fitur potong otomatis engine dipakai.</>
          )}
        </p>
      </div>
    </motion.div>
  );
}

function Res({ label, value }) {
  return (
    <div className="tile">
      <div className="text-[9.5px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-0.5 font-mono text-xs font-bold text-slate-100">{value}</div>
    </div>
  );
}
