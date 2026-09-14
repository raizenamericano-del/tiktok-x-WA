import { useApp } from '../App.jsx';
import Logo from './Logo.jsx';

export default function Footer() {
  const { cfg } = useApp();
  return (
    <footer className="relative z-10 border-t border-line py-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-3 px-4 text-center sm:px-6">
        <Logo size={34} showText={false} />
        <div className="font-display text-sm font-bold text-white">
          Kyy<span className="grad-text">PureStatus</span>
        </div>
        <div className="text-xs text-slate-500">
          Dibuat dengan <span className="text-brand">♥</span> + kopi oleh{' '}
          <span className="font-semibold text-slate-300">KyyDevv</span> ·{' '}
          <span className="text-slate-400">v{cfg?.version || '2.0.0'}</span>
        </div>
        <div className="max-w-xl text-[10px] leading-relaxed text-slate-600">
          ⚠ Pake nomor sekunder ges — library gak resmi (Baileys) bisa bikin nomor lu kena banned. Pake yang
          bijak & patuh ToS WA. Video yang dikirim bukan karya KyyDevv.
        </div>
      </div>
    </footer>
  );
}
