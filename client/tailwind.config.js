/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Palet brand KyyPureStatus v4
        brand: { DEFAULT: '#7c5cff', 400: '#9b86ff', 500: '#7c5cff', 600: '#6543f0', dark: '#5435d6' },
        fuchsia: { DEFAULT: '#ff3f9a' },
        mint: { DEFAULT: '#22e3c4', 400: '#3df0d2', 500: '#22e3c4' },
        inks: {
          950: '#05050c',
          900: '#0a0a14',
          850: '#0e0e1c',
          800: '#131324',
          700: '#1c1c31',
          600: '#26263f',
        },
        // alias lama (kompat komponen yang belum dimigrasi)
        ink: {
          950: '#05050c',
          900: '#0a0a14',
          850: '#0e0e1c',
          800: '#131324',
          700: '#1c1c31',
        },
        line: 'rgba(255,255,255,0.09)',
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans Variable"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Space Grotesk Variable"', '"Plus Jakarta Sans Variable"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 18px 50px -18px rgba(0,0,0,0.75)',
        glow: '0 0 50px -12px rgba(124,92,255,0.65)',
        'glow-pink': '0 0 50px -12px rgba(255,63,154,0.55)',
        'glow-mint': '0 0 50px -12px rgba(34,227,196,0.5)',
        inset: 'inset 0 1px 0 0 rgba(255,255,255,0.06)',
      },
      borderRadius: {
        '4xl': '2rem',
        '5xl': '2.5rem',
      },
      keyframes: {
        shimmer: { '0%': { backgroundPosition: '-200% 0' }, '100%': { backgroundPosition: '200% 0' } },
        floaty: { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-10px)' } },
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.55' },
          '70%': { transform: 'scale(1.35)', opacity: '0' },
          '100%': { transform: 'scale(1.35)', opacity: '0' },
        },
        gradientX: { '0%,100%': { backgroundPosition: '0% 50%' }, '50%': { backgroundPosition: '100% 50%' } },
        scan: { '0%': { transform: 'translateY(-120%)' }, '100%': { transform: 'translateY(320%)' } },
        aurora: {
          '0%,100%': { transform: 'translate3d(0,0,0) scale(1)', opacity: '0.55' },
          '50%': { transform: 'translate3d(4%, -3%, 0) scale(1.15)', opacity: '0.85' },
        },
        morphpop: { '0%': { transform: 'scale(0.8)', opacity: '0' }, '100%': { transform: 'scale(1)', opacity: '1' } },
      },
      animation: {
        shimmer: 'shimmer 2.2s linear infinite',
        floaty: 'floaty 5.5s ease-in-out infinite',
        'pulse-ring': 'pulse-ring 2.2s cubic-bezier(0.4,0,0.6,1) infinite',
        gradientX: 'gradientX 9s ease infinite',
        scan: 'scan 2.6s ease-in-out infinite',
        aurora: 'aurora 16s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
