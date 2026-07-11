<script lang="ts">
	/**
	 * LoadingDots — a label whose trailing "…" types itself out (t.txt item 2).
	 *
	 * Ken: transient "Loading account…"-style text should have its three dots
	 * animate like a typewriter — appearing one at a time, then resetting —
	 * rather than sitting there static. Pass the FULL label (with or without a
	 * trailing ellipsis); the component strips any trailing dots/ellipsis and
	 * renders the base text followed by a CSS-animated dot run. Reusable for any
	 * "temporary text that shows on the screen".
	 *
	 * Accessibility: the animated dots are decorative (`aria-hidden`); the base
	 * text carries the meaning. A fixed-width dot slot means the surrounding
	 * layout never shifts as the dots cycle, and `prefers-reduced-motion` users
	 * get a static ellipsis instead of the animation.
	 */
	interface Props {
		/** The loading label, e.g. "Loading account…" or "Loading account...". */
		label: string;
	}
	let { label }: Props = $props();

	// Strip a trailing ellipsis or run of ASCII dots (and any trailing space) so
	// the animated slot is the ONLY source of dots.
	const base = $derived(label.replace(/[\s.\u2026]+$/u, ''));
</script>

<span>{base}<span class="dots" aria-hidden="true"></span></span>

<style>
	/* Fixed-width slot so following content never shifts as the dots cycle;
	   dots fill in from the left. */
	.dots {
		display: inline-block;
		width: 1.5ch;
		text-align: left;
	}
	.dots::after {
		content: '';
		animation: loading-dots-typewriter 1.4s steps(1, end) infinite;
	}
	@keyframes loading-dots-typewriter {
		0% {
			content: '';
		}
		25% {
			content: '.';
		}
		50% {
			content: '..';
		}
		75% {
			content: '...';
		}
		100% {
			content: '';
		}
	}
	/* Respect reduced-motion: show a static ellipsis, no animation. */
	@media (prefers-reduced-motion: reduce) {
		.dots::after {
			content: '\2026';
			animation: none;
		}
	}
</style>
