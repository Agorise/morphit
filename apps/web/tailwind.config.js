import tailwindPlugin from 'tailwindcss/plugin';

/** A theme colour: `--<name>-rgb` from src/theme.css, alpha-aware. */
const token = (name) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{html,js,svelte,ts}'],
	darkMode: 'class',
	theme: {
		extend: {
			fontFamily: {
				sans: ['Comfortaa', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
				display: ['Comfortaa', 'system-ui', 'sans-serif']
			},
			// Every colour is a CSS custom property from src/theme.css (the one
			// colour source of truth — per-instance theming, docs/BRANDING.md).
			// `rgb(var(--x-rgb) / <alpha-value>)` keeps every opacity modifier
			// (`bg-morphit-emerald/10`, `ring-ink-700/50`) working. The Morphit
			// values, and why each one is what it is, live in theme.css.
			colors: {
				morphit: {
					lime: token('brand-1'),
					accent: token('brand-accent'),
					// The primary accent (text, borders, rings, badges). On the
					// Morphit palette it is the gradient's middle stop, #00DA69.
					emerald: token('brand-primary'),
					// Deepened brand emerald for chat bubbles (see theme.css / app
					// history: a fixed deepened value, never an opacity, so it reads
					// the same on every surface).
					'emerald-bubble': token('brand-bubble'),
					teal: token('brand-secondary'),
					// Primary button face — a deepened brand teal so its text clears
					// WCAG AA — and the text colour that goes on it.
					btn: token('brand-btn-face'),
					'btn-text': token('brand-btn-text'),
					ink: token('shadow') // deep navy used for card shadows
				},
				// Neutral surface/text scale, tuned for readability in dark mode.
				ink: {
					50: token('surface-50'),
					100: token('surface-100'),
					200: token('surface-200'),
					300: token('surface-300'),
					400: token('surface-400'),
					500: token('surface-500'),
					600: token('surface-600'),
					700: token('surface-700'),
					800: token('surface-800'),
					900: token('surface-900'),
					950: token('surface-950')
				}
			},
			backgroundImage: {
				'morphit-gradient': 'var(--morphit-gradient)',
				'morphit-gradient-soft':
					'linear-gradient(135deg, rgb(var(--brand-1-rgb) / 0.08) 0%, rgb(var(--brand-2-rgb) / 0.06) 50%, rgb(var(--brand-3-rgb) / 0.08) 100%)'
			},
			boxShadow: {
				'morphit-glow':
					'0 0 0 1px rgb(var(--brand-2-rgb) / 0.25), 0 10px 40px -10px rgb(var(--brand-2-rgb) / 0.35)',
				'morphit-card':
					'0 1px 2px rgb(var(--shadow-rgb) / 0.04), 0 8px 24px -8px rgb(var(--shadow-rgb) / 0.08)',
				'morphit-card-hover':
					'0 2px 4px rgb(var(--shadow-rgb) / 0.06), 0 16px 40px -12px rgb(var(--shadow-rgb) / 0.14)'
			},
			borderRadius: {
				xl2: '1.25rem'
			},
			fontSize: {
				// Slightly larger base for grandma-friendliness
				base: ['1.0625rem', { lineHeight: '1.65' }],
				lg: ['1.1875rem', { lineHeight: '1.6' }]
			},
			maxWidth: {
				prose: '68ch'
			},
			animation: {
				'gradient-pan': 'gradientPan 12s ease-in-out infinite',
				'pulse-soft': 'pulseSoft 2.4s ease-in-out infinite',
				'fade-up': 'fadeUp 360ms cubic-bezier(0.2, 0.8, 0.2, 1) both'
			},
			keyframes: {
				gradientPan: {
					'0%, 100%': { backgroundPosition: '0% 50%' },
					'50%': { backgroundPosition: '100% 50%' }
				},
				pulseSoft: {
					'0%, 100%': { opacity: '1' },
					'50%': { opacity: '0.7' }
				},
				fadeUp: {
					from: { opacity: '0', transform: 'translateY(8px)' },
					to: { opacity: '1', transform: 'translateY(0)' }
				}
			}
		}
	},
	plugins: [
		// Pointer-type variants — Tailwind v3 ships no built-in pointer-*
		// variants, so `pointer-fine:` / `pointer-coarse:` classes were
		// previously silently dropped (emitting no CSS). `pointer-fine:`
		// matches a mouse/trackpad (desktop); `pointer-coarse:` matches
		// touch (phones/tablets). Used for the handful of touch-only /
		// desktop-only affordances that can't be a viewport-width swap —
		// e.g. the avatar menu's "sign in to another device" scan entry
		// (opens a phone camera; pointless on a PC) and the unlock
		// screen's "use phone instead" (pointless on a phone).
		tailwindPlugin(function ({ addVariant }) {
			addVariant('pointer-fine', '@media (pointer: fine)');
			addVariant('pointer-coarse', '@media (pointer: coarse)');
		})
	]
};
