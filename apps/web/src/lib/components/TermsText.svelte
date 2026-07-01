<script lang="ts">
	/**
	 * TermsText — renders user-authored order `terms` as plain text,
	 * with ONE carve-out: an https link to an image on Blurt's own
	 * image server (`img.blurt.blog`) becomes a clickable external
	 * link that opens in a fresh tab. Everything else — including any
	 * other URL — stays inert, escaped plain text. cp388.
	 *
	 * No `{@html}`: every segment is rendered through Svelte's normal
	 * text/attribute escaping, and the href is the validated, normalized
	 * URL from `safeBlurtImageUrl`. The anchor carries the same privacy
	 * hardening as every other external link in the app —
	 * `target="_blank"`, `rel="noopener noreferrer nofollow"`, and an
	 * explicit `referrerpolicy="no-referrer"` so the Blurt host never
	 * learns which Morphit order page the viewer came from (belt and
	 * suspenders on top of the site-wide `Referrer-Policy: no-referrer`).
	 *
	 * The caller supplies the block wrapper (and `whitespace-pre-wrap`
	 * so newlines in the terms survive); this component emits only the
	 * inline run of text + anchors.
	 */
	import { linkifyBlurtImageSegments, safeBlurtImageUrl } from '$lib/utils/blurtImageLink';

	interface Props {
		text: string | null | undefined;
	}

	let { text }: Props = $props();

	const segments = $derived(linkifyBlurtImageSegments(text ?? ''));
</script>

{#each segments as seg}{#if seg.link}<a
			href={safeBlurtImageUrl(seg.value)}
			target="_blank"
			rel="noopener noreferrer nofollow"
			referrerpolicy="no-referrer"
			class="break-all underline">{seg.value}</a
		>{:else}{seg.value}{/if}{/each}
