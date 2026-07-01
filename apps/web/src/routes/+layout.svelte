<script lang="ts">
	/**
	 * Root +layout.svelte — minimal wrapper for the redirect shell.
	 *
	 * Part 121 cp7.  This file deliberately does NOT include the
	 * full app chrome (header, banners, language switcher, avatar
	 * menu, footer) because the root route is the bare `/` redirect
	 * shell that the user is on for ~one frame before being
	 * redirected to `/<lang>/`.  Loading the full chrome here
	 * would defeat the purpose of the prefix-routing approach
	 * (the chrome would render in English, then the redirect
	 * would happen, then the chrome would re-render in the
	 * user's locale — that's the FOUC we're trying to eliminate).
	 *
	 * The full chrome lives in `[lang]/+layout.svelte` and applies
	 * to every page under the locale prefix.
	 *
	 * `app.css` is still imported here so the redirect shell has
	 * the base styling (font, color tokens).  The shell's visible
	 * content is "Loading…" so the styling matters only for that
	 * brief flash, but it should match the rest of the site.
	 */

	import '../app.css';

	interface Props {
		children: import('svelte').Snippet;
	}
	let { children }: Props = $props();
</script>

{@render children()}
