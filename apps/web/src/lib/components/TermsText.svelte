<script lang="ts">
	/**
	 * TermsText — renders user-authored order `terms` with a small, safe
	 * markdown subset (cp406): headings, bold, italics, unordered/ordered
	 * lists, blockquotes, links, horizontal rules, and line feeds. The
	 * Blurt-image-link carve-out (an https link to img.blurt.blog opens in a
	 * fresh tab) is preserved. cp413 (Ken): added blockquotes + heavier
	 * heading/bold weights. cp414 (Ken): added `[text](url)` hyperlinks
	 * (scheme-validated in termsMarkdown.ts). cp415 (Ken): inline bold → 800;
	 * links render in the brand emerald (visible on the dark terms panel) and,
	 * on click/tap, open a "Leaving Morphit" confirmation before opening the
	 * destination in a new tab. cp416 (Ken): the confirmation body names the
	 * destination host ("Are you sure you want to visit example.com?") for
	 * anti-phishing.
	 *
	 * SECURITY: there is NO `{@html}` here. The text is parsed by
	 * parseTermsMarkdown() into a plain structured tree and every leaf is
	 * rendered through Svelte's normal text/attribute escaping, so markup in
	 * `terms` can never become live DOM. The only hrefs produced are the
	 * validated `safeBlurtImageUrl` (auto-linked images) and `safeContactUrl`
	 * (explicit `[text](url)` links) — both reject dangerous schemes, baked
	 * into the parse tree. External anchors carry the site-wide privacy
	 * hardening — `target="_blank"`, `rel="noopener noreferrer nofollow"`, and
	 * `referrerpolicy="no-referrer"` — and the actual navigation goes through
	 * an anchor-click (noopener/noreferrer) after the user confirms.
	 *
	 * For the compact orderbook-card preview, callers use stripMarkdown()
	 * instead (a single plain line, ALL markdown stripped), NOT this component.
	 */
	import { _ } from 'svelte-i18n';
	import { parseTermsMarkdown, type TermsInline } from '$lib/utils/termsMarkdown';
	import ConfirmModal from './ConfirmModal.svelte';

	interface Props {
		text: string | null | undefined;
	}

	let { text }: Props = $props();

	const blocks = $derived(parseTermsMarkdown(text));

	// The external URL awaiting the user's "Leaving Morphit" confirmation.
	// null = no modal open. Always one of the already-validated safe hrefs
	// from the parse tree (safeBlurtImageUrl / safeContactUrl).
	let pendingUrl = $state<string | null>(null);

	/** The phishing-relevant destination shown in the confirmation body. For
	 *  http/https that's the bare host (e.g. "example.com"); for schemes with
	 *  no host (mailto/matrix/xmpp/nostr) it falls back to the target after the
	 *  scheme, else the raw string. Rendered as escaped text by ConfirmModal. */
	function destinationHost(url: string): string {
		try {
			const u = new URL(url);
			return u.hostname || u.pathname || url;
		} catch {
			return url;
		}
	}

	const leaveHost = $derived(pendingUrl ? destinationHost(pendingUrl) : '');

	function onLinkClick(e: MouseEvent, href: string): void {
		// Intercept the normal click so we can show the interstitial. Keep the
		// real <a href> so screen readers announce the link, hover shows the
		// destination, and right-click "open in new tab" still works for power
		// users (that path bypasses the click event, which is fine).
		e.preventDefault();
		pendingUrl = href;
	}

	function confirmLeave(): void {
		const url = pendingUrl;
		pendingUrl = null;
		if (!url || typeof document === 'undefined') return;
		// Anchor-click (inside this button's user gesture) reliably opens a new
		// TAB — not a popup — with noopener/noreferrer, so the destination can't
		// reach window.opener and gets no referrer.
		const a = document.createElement('a');
		a.href = url;
		a.target = '_blank';
		a.rel = 'noopener noreferrer';
		a.click();
	}

	function cancelLeave(): void {
		pendingUrl = null;
	}
</script>

{#snippet inline(runs: TermsInline[])}{#each runs as r}{#if r.t === 'bold'}<strong class="font-extrabold">{r.v}</strong>{:else if r.t === 'italic'}<em>{r.v}</em>{:else if r.t === 'link'}<a
				href={r.href}
				target="_blank"
				rel="noopener noreferrer nofollow"
				referrerpolicy="no-referrer"
				onclick={(e) => onLinkClick(e, r.href)}
				class="break-all font-semibold text-morphit-emerald underline underline-offset-2 hover:no-underline">{r.v}</a
			>{:else}{r.v}{/if}{/each}{/snippet}

{#each blocks as block}
	{#if block.type === 'heading'}
		{#if block.level === 1}
			<p class="mt-3 font-display text-base font-extrabold first:mt-0">{@render inline(block.runs)}</p>
		{:else if block.level === 2}
			<p class="mt-3 font-display text-sm font-extrabold first:mt-0">{@render inline(block.runs)}</p>
		{:else}
			<p class="mt-2 text-sm font-bold first:mt-0">{@render inline(block.runs)}</p>
		{/if}
	{:else if block.type === 'hr'}
		<!-- cp595 (t.txt) — Ken: use the SAME green as the order-terms blockquote
		     (border-morphit-emerald/40) on the horizontal rule and the list
		     markers below, so a user's markdown `---`, `- ` and `1.` all render
		     in the brand emerald they like. `/40` matches the blockquote border
		     exactly; #00DA69 is bright enough that /40 reads clearly even on the
		     small ::marker glyphs. Logical `border` (not border-t) + no dark
		     variant, mirroring the blockquote token. -->
		<hr class="my-3 border-morphit-emerald/40" />
	{:else if block.type === 'ul'}
		<ul class="mt-1 list-disc space-y-0.5 ps-5 marker:text-morphit-emerald/40">
			{#each block.items as item}<li>{@render inline(item)}</li>{/each}
		</ul>
	{:else if block.type === 'ol'}
		<ol class="mt-1 list-decimal space-y-0.5 ps-5 marker:text-morphit-emerald/40">
			{#each block.items as item}<li>{@render inline(item)}</li>{/each}
		</ol>
	{:else if block.type === 'blockquote'}
		<!-- cp474 (t.txt #12) — Ken: "whenever i use a blockquote (markdown) in
		     the terms textarea, please indent that rendered blockquote on the ui."
		     It had a quote BAR (border + pl-3 inside it) but no margin, so the bar
		     sat flush against the same edge as every paragraph and the quote never
		     read as set apart — the one thing a blockquote is for. `ms-4` indents
		     the whole quote, bar included.

		     Logical properties, not physical: `dir` really is flipped for Farsi
		     (app.html sets documentElement.dir = 'rtl' for fa), so the old
		     `border-l-4` + `pl-3` put the quote bar on the far side of its own
		     right-aligned text for those readers. `border-s`/`ps`/`ms` are
		     identical to `border-l`/`pl`/`ml` in LTR and correct in RTL. -->
		<blockquote
			class="ms-4 mt-2 whitespace-pre-line border-s-4 border-morphit-emerald/40 ps-3 text-ink-600 first:mt-0 dark:text-ink-300"
			>{@render inline(block.runs)}</blockquote
		>
	{:else}
		<p class="mt-2 whitespace-pre-line first:mt-0">{@render inline(block.runs)}</p>
	{/if}
{/each}

<ConfirmModal
	open={pendingUrl !== null}
	variant="neutral"
	title={$_('terms.leave_site.title') as string}
	body={$_('terms.leave_site.body', { values: { site: leaveHost } }) as string}
	confirmLabel={$_('terms.leave_site.confirm') as string}
	cancelLabel={$_('terms.leave_site.cancel') as string}
	onConfirm={confirmLeave}
	onCancel={cancelLeave}
/>
