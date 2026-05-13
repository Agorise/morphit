<script lang="ts">
	/**
	 * AppStoreIcon — small label-only glyphs for the Android app stores
	 * Morphit distributes through. Same minimalist approach as
	 * AltNetworkIcon: no third-party brand assets (each store has
	 * different trademark/logo-use policies — a text glyph in
	 * currentColor sidesteps all of that). Consistent size, consistent
	 * hover affordance.
	 *
	 * If an operator wants to swap in official brand logos on their
	 * instance, they can fork this component — the callers render
	 * <AppStoreIcon store="..." /> so the swap is localized.
	 */
	import { _ } from 'svelte-i18n';

	interface Props {
		store:
			| 'fdroid'
			| 'aptoide'
			| 'aptoide_connect'
			| 'apkpure'
			| 'uptodown'
			| 'apkmirror'
			| 'alternativeto'
			| 'obtainium'
			| 'direct';
		size?: number;
		class?: string;
	}

	let { store, size = 24, class: cls = '' }: Props = $props();

	// Short identifier text per store. Kept monospaced-looking via
	// text-anchor=middle + fixed viewBox so every tile renders the
	// same visual weight regardless of glyph width.
	const glyphMap = {
		fdroid: 'F/D',
		aptoide: 'Ap',
		aptoide_connect: 'Ap+',
		apkpure: 'P!',
		uptodown: '↓',
		apkmirror: '⟲',
		alternativeto: 'Alt',
		obtainium: 'Ob',
		direct: '.apk'
	} as const;

	const glyph = $derived(glyphMap[store]);
	const ariaKey = $derived(`app_stores.${store}.name`);
	// Glyph font size shrinks for longer labels so they fit in the
	// same 20px interior of the rounded-square container.
	const fontSize = $derived(glyph.length <= 2 ? 11 : glyph.length === 3 ? 9 : 8);
</script>

<svg
	class={cls}
	width={size}
	height={size}
	viewBox="0 0 24 24"
	xmlns="http://www.w3.org/2000/svg"
	role="img"
	aria-label={$_(ariaKey)}
>
	<rect
		x="2"
		y="2"
		width="20"
		height="20"
		rx="4"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
	/>
	<text
		x="12"
		y="16"
		text-anchor="middle"
		font-family="system-ui, sans-serif"
		font-size={fontSize}
		font-weight="900"
		fill="currentColor">{glyph}</text
	>
</svg>
