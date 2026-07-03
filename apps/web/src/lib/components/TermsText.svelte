<script lang="ts">
	/**
	 * TermsText — renders user-authored order `terms` with a small, safe
	 * markdown subset (cp406): headings, bold, italics, unordered/ordered
	 * lists, horizontal rules, and line feeds. The Blurt-image-link carve-out
	 * (an https link to img.blurt.blog opens in a fresh tab) is preserved.
	 *
	 * SECURITY: there is NO `{@html}` here. The text is parsed by
	 * parseTermsMarkdown() into a plain structured tree and every leaf is
	 * rendered through Svelte's normal text/attribute escaping, so markup in
	 * `terms` can never become live DOM. The only href produced is the
	 * validated, normalized `safeBlurtImageUrl` (baked into the parse tree).
	 * External anchors carry the site-wide privacy hardening —
	 * `target="_blank"`, `rel="noopener noreferrer nofollow"`, and
	 * `referrerpolicy="no-referrer"`.
	 *
	 * For the compact orderbook-card preview, callers use stripMarkdown()
	 * instead (a single plain line), NOT this component.
	 */
	import { parseTermsMarkdown, type TermsInline } from '$lib/utils/termsMarkdown';

	interface Props {
		text: string | null | undefined;
	}

	let { text }: Props = $props();

	const blocks = $derived(parseTermsMarkdown(text));
</script>

{#snippet inline(runs: TermsInline[])}{#each runs as r}{#if r.t === 'bold'}<strong class="font-semibold">{r.v}</strong>{:else if r.t === 'italic'}<em>{r.v}</em>{:else if r.t === 'link'}<a
				href={r.href}
				target="_blank"
				rel="noopener noreferrer nofollow"
				referrerpolicy="no-referrer"
				class="break-all underline">{r.v}</a
			>{:else}{r.v}{/if}{/each}{/snippet}

{#each blocks as block}
	{#if block.type === 'heading'}
		{#if block.level === 1}
			<p class="mt-3 font-display text-base font-bold first:mt-0">{@render inline(block.runs)}</p>
		{:else if block.level === 2}
			<p class="mt-3 font-display text-sm font-bold first:mt-0">{@render inline(block.runs)}</p>
		{:else}
			<p class="mt-2 text-sm font-semibold first:mt-0">{@render inline(block.runs)}</p>
		{/if}
	{:else if block.type === 'hr'}
		<hr class="my-3 border-ink-200 dark:border-ink-700" />
	{:else if block.type === 'ul'}
		<ul class="mt-1 list-disc space-y-0.5 pl-5">
			{#each block.items as item}<li>{@render inline(item)}</li>{/each}
		</ul>
	{:else if block.type === 'ol'}
		<ol class="mt-1 list-decimal space-y-0.5 pl-5">
			{#each block.items as item}<li>{@render inline(item)}</li>{/each}
		</ol>
	{:else}
		<p class="mt-2 whitespace-pre-line first:mt-0">{@render inline(block.runs)}</p>
	{/if}
{/each}
