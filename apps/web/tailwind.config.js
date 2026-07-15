import tailwindPlugin from 'tailwindcss/plugin';

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
			colors: {
				// Morphit brand palette (from the logo gradient)
				morphit: {
					lime: '#8EEF26',
					accent: '#7FED2D',
					emerald: '#00DA69',
					// Deepened brand emerald for chat bubbles — mirrors
					// --morphit-emerald-bubble in app.css (see the rationale there).
					// Same pattern as `btn` below: the pure brand colour is too bright
					// a field to read thin text on, so the bubble gets a deepened
					// sibling rather than an opacity (which would blend with the page).
					'emerald-bubble': '#00B85A',
					teal: '#02A6B2',
					// Primary button face — mirrors --morphit-btn-face in app.css.
					// A deepened brand teal (white text clears WCAG AA); this is
					// the face used by the header Start button (.btn-primary) and,
					// site-wide, every filled primary CTA so they all match.
					btn: '#027c86',
					ink: '#0B1220', // deep navy for dark-mode surfaces
					paper: '#FEFEFE'
				},
				// Neutral grays tuned for readability in dark mode
				ink: {
					50: '#F7F8FA',
					100: '#EEF1F5',
					200: '#D9DFE7',
					300: '#B8C2D0',
					400: '#8A96A8',
					500: '#5D6B80',
					600: '#3E4A5C',
					700: '#2A3340',
					800: '#1A202B',
					900: '#0F141C',
					950: '#070A10'
				}
			},
			backgroundImage: {
				'morphit-gradient': 'linear-gradient(90deg, #8EEF26 0%, #00DA69 50%, #02A6B2 100%)',
				'morphit-gradient-soft':
					'linear-gradient(135deg, rgba(142,239,38,0.08) 0%, rgba(0,218,105,0.06) 50%, rgba(2,166,178,0.08) 100%)'
			},
			boxShadow: {
				'morphit-glow': '0 0 0 1px rgba(0,218,105,0.25), 0 10px 40px -10px rgba(0,218,105,0.35)',
				'morphit-card': '0 1px 2px rgba(11,18,32,0.04), 0 8px 24px -8px rgba(11,18,32,0.08)',
				'morphit-card-hover': '0 2px 4px rgba(11,18,32,0.06), 0 16px 40px -12px rgba(11,18,32,0.14)'
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
