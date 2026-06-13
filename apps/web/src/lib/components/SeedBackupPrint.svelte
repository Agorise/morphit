<script lang="ts">
	/**
	 * SeedBackupPrint — printable backup card for the seed phrase
	 * shown during /onboarding.
	 *
	 * Tier 1.3 follow-up (Part 92): the doc said "no printable PDF
	 * template, no 'send to my printer' button, no QR code that
	 * links to a printable backup card.  The user is on her own
	 * to find a pen and figure out how to write 12 words
	 * legibly."
	 *
	 * This ships the print path without adding any new
	 * dependencies (no client-side PDF library, no server round
	 * trip — the seed phrase MUST NEVER leave the device).  The
	 * browser's built-in print-to-paper / print-to-PDF
	 * machinery handles the rest, and the user can choose
	 * either.
	 *
	 * Privacy posture:
	 *   - Pure local rendering.  No network, no PDF library,
	 *     no server interaction.
	 *   - The print stylesheet uses CSS `visibility: hidden`
	 *     on every element except the backup card and its
	 *     descendants, so a user who saves-to-PDF gets a
	 *     clean single page with just the seed material.
	 *   - Browser print preview is a known, audited path; we
	 *     are not introducing a new code path that touches
	 *     the seed.  The seed words are already rendered in
	 *     the on-screen review, so this component just
	 *     renders them again with print-friendly layout.
	 *   - On `afterprint`, the print-mode flag is removed so
	 *     the screen UI returns to normal.
	 *
	 * Mechanics — paint + pagination isolation (cp249):
	 *
	 *   A plain `display: none` on "everything but the card"
	 *   can't be expressed cleanly because SvelteKit renders the
	 *   whole app inside `<div id="svelte" style="display:
	 *   contents">` (see `apps/web/src/app.html`): the card lives
	 *   DEEP inside that subtree, so any selector that hides the
	 *   subtree also hides the card.
	 *
	 *   So we isolate in two independent dimensions:
	 *     - PAINT: at print time every element is `visibility:
	 *       hidden`, then the card + its descendants are forced
	 *       `visibility: visible`.
	 *     - PAGINATION: the `#svelte` app subtree is collapsed to
	 *       a zero-height, overflow-clipped box so it generates
	 *       no page boxes.  This is the part that kills the blank
	 *       bands / extra blank pages the paint-only approach left
	 *       behind — `visibility: hidden` keeps layout boxes, so
	 *       on a tall review page they still paginated.
	 *
	 *   The card itself is `position: fixed`, so its containing
	 *   block is the page box, not `#svelte`: it escapes the
	 *   height:0/overflow:hidden clip and prints alone on a single
	 *   page, sized to its own content (no full-page `inset: 0`
	 *   stretch, which was the source of the trailing whitespace).
	 *
	 *   Triggered via an html-level class flag
	 *   `morphit-printing-seed` so a regular Ctrl+P on the
	 *   onboarding page (no flag set) prints the page
	 *   normally.  Only this component's button activates
	 *   the seed-only print mode.
	 *
	 * Layout (US-Letter / A4 friendly — works on either):
	 *   - Top: title "My Morphit backup card"
	 *   - Account name (if registered) + generation date
	 *   - Body: 12 words in a 3×4 grid with numbered slots
	 *     and large monospace text optimized for legibility
	 *     when printed
	 *   - Footer: paper-storage warning + reminder
	 *   - No QR code (printing the seed as a QR would
	 *     create a scanner-attack surface; paper writing of
	 *     the words is the recommended path).
	 */

	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';

	interface Props {
		/** The 12 seed words.  Order matters. */
		readonly words: readonly string[];
		/** User's chosen Blurt account name, if registered.
		 *  May be empty during onboarding-before-registration;
		 *  the card still prints with a "(account name not yet
		 *  chosen)" note. */
		readonly accountName?: string;
	}

	let { words, accountName = '' }: Props = $props();

	const generatedAt = $derived(
		new Date().toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'long',
			day: 'numeric'
		})
	);

	function triggerPrint(): void {
		if (!browser) return;
		const html = document.documentElement;
		html.classList.add('morphit-printing-seed');

		const onAfterPrint = (): void => {
			html.classList.remove('morphit-printing-seed');
			window.removeEventListener('afterprint', onAfterPrint);
		};
		window.addEventListener('afterprint', onAfterPrint);

		// Defer to next frame so the class application paints
		// before the print snapshot is taken.  Some browsers
		// snapshot synchronously on print(), making the class
		// addition above pre-paint matter.
		requestAnimationFrame(() => window.print());
	}
</script>

<button
	type="button"
	onclick={triggerPrint}
	class="btn-secondary"
	aria-label={$_('onboarding.backup.print_card.aria') as string}
>
	{$_('onboarding.backup.print_card.button')}
</button>

<!-- The printable card.  Always in DOM; hidden on screen via
     `display: none`.  When the user clicks Print, the
     html.morphit-printing-seed flag activates the print
     stylesheet's paint + pagination isolation (see the
     @media print block below). -->
<div class="morphit-seed-print-card" aria-hidden="true">
	<header class="seed-print-header">
		<h1>{$_('onboarding.backup.print_card.title')}</h1>
		<p class="seed-print-subtitle">{$_('onboarding.backup.print_card.subtitle')}</p>
	</header>

	<dl class="seed-print-meta">
		<dt>{$_('onboarding.backup.print_card.account_label')}</dt>
		<dd>
			{#if accountName}@{accountName}{:else}<em>{$_('onboarding.backup.print_card.no_account_yet')}</em
				>{/if}
		</dd>
		<dt>{$_('onboarding.backup.print_card.generated_label')}</dt>
		<dd>{generatedAt}</dd>
	</dl>

	<ol class="seed-print-grid">
		{#each words as word, i}
			<li>
				<span class="seed-print-num">{i + 1}.</span>
				<span class="seed-print-word">{word}</span>
			</li>
		{/each}
	</ol>

	<footer class="seed-print-footer">
		<p class="seed-print-warning">
			<strong>{$_('onboarding.backup.print_card.warning_heading')}</strong>
			{$_('onboarding.backup.print_card.warning_body')}
		</p>
		<p class="seed-print-instructions">
			{$_('onboarding.backup.print_card.instructions')}
		</p>
	</footer>
</div>

<style>
	/* ── Screen mode: hide the printable card entirely. ─────────
	   On-screen, the user already sees the seed phrase in the
	   onboarding card above; the print version is purely for
	   the printout. */
	.morphit-seed-print-card {
		display: none;
	}

	/* ── Print mode: format the card for paper, on ONE page. ──── */
	@media print {
		/* cp249 — the backup card printed with large blank bands
		   above and below it (often spilling onto extra blank pages).
		   Root cause: the old approach set every element to
		   `visibility: hidden` — which hides PAINT but keeps LAYOUT
		   boxes — then positioned the card `absolute; inset: 0`.  The
		   onboarding review page is tall, so all those hidden-but-
		   present boxes kept generating page boxes; the card landed
		   inside a multi-page document with blank space fore and aft,
		   and `inset: 0` stretched the card itself to a full page so
		   even its own box was mostly empty.

		   Fix isolates in two independent dimensions:
		     1. PAINT — hide everything, re-show only the card.
		     2. PAGINATION — collapse the whole SvelteKit app subtree
		        (`#svelte`, which is `display: contents` in app.html)
		        to a zero-height, overflow-clipped box so it generates
		        no page boxes at all.  This is the part that removes
		        the blank bands / extra pages.
		   The card is `position: fixed`, so its containing block is
		   the page box (not `#svelte`): it escapes the height:0 /
		   overflow:hidden clip and prints alone on a single page,
		   sized to its own content (no `inset: 0` stretch).

		   Everything is gated on the `morphit-printing-seed` <html>
		   flag, so a plain Ctrl+P on the onboarding page (no flag)
		   still prints normally, and none of this affects on-screen
		   layout. */

		/* 1. Paint isolation. */
		:global(html.morphit-printing-seed body *) {
			visibility: hidden;
		}
		:global(html.morphit-printing-seed .morphit-seed-print-card),
		:global(html.morphit-printing-seed .morphit-seed-print-card *) {
			visibility: visible;
		}

		/* 2. Pagination isolation: remove the app subtree from the
		   page flow so it contributes zero pages. */
		:global(html.morphit-printing-seed #svelte) {
			display: block !important;
			height: 0 !important;
			overflow: hidden !important;
		}
		:global(html.morphit-printing-seed body) {
			margin: 0 !important;
			padding: 0 !important;
			background: white;
		}
		/* Containing-block guard: a stray transform/filter/contain on
		   an ancestor would re-anchor the fixed card back inside the
		   now-collapsed subtree (and clip it).  Neutralise them — this
		   is print-only and cannot affect on-screen layout. */
		:global(html.morphit-printing-seed #svelte *) {
			transform: none !important;
			filter: none !important;
			backdrop-filter: none !important;
			perspective: none !important;
			contain: none !important;
			will-change: auto !important;
		}

		.morphit-seed-print-card {
			display: block;
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			/* no `bottom`/`inset`: height is content-driven, so the
			   card hugs the top of the page instead of stretching to
			   fill it (which left the trailing blank band). */
			padding: 0.6in;
			margin: 0;
			background: white;
			color: black;
			font-family: 'Helvetica', 'Arial', sans-serif;
			font-size: 11pt;
			line-height: 1.4;
		}

		.seed-print-header h1 {
			font-size: 18pt;
			font-weight: 700;
			margin: 0 0 4pt 0;
			color: black;
		}
		.seed-print-subtitle {
			font-size: 10pt;
			color: #444;
			margin: 0 0 16pt 0;
		}

		.seed-print-meta {
			display: grid;
			grid-template-columns: max-content 1fr;
			gap: 4pt 12pt;
			margin: 0 0 24pt 0;
			padding: 8pt 12pt;
			background: #f6f6f6;
			border: 1pt solid #ccc;
			border-radius: 4pt;
		}
		.seed-print-meta dt {
			font-weight: 600;
			color: #555;
			font-size: 10pt;
		}
		.seed-print-meta dd {
			margin: 0;
			font-family: 'Courier New', monospace;
			font-size: 11pt;
			color: black;
		}

		.seed-print-grid {
			list-style: none;
			padding: 16pt;
			margin: 0 0 24pt 0;
			display: grid;
			grid-template-columns: repeat(3, 1fr);
			gap: 12pt;
			border: 2pt solid black;
		}
		.seed-print-grid li {
			display: flex;
			align-items: baseline;
			gap: 8pt;
			padding: 8pt;
			border-bottom: 1pt dashed #999;
		}
		.seed-print-num {
			font-size: 9pt;
			color: #666;
			min-width: 1.5em;
			text-align: right;
			font-family: 'Helvetica', 'Arial', sans-serif;
		}
		.seed-print-word {
			font-family: 'Courier New', monospace;
			font-size: 14pt;
			font-weight: 600;
			letter-spacing: 0.5pt;
			color: black;
		}

		.seed-print-footer {
			border-top: 1pt solid #ccc;
			padding-top: 12pt;
		}
		.seed-print-warning {
			font-size: 10pt;
			color: black;
			margin: 0 0 8pt 0;
			padding: 8pt;
			border: 1pt solid black;
			background: #fffae6;
		}
		.seed-print-instructions {
			font-size: 9pt;
			color: #444;
			margin: 0;
		}
	}
</style>
