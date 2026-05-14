<script lang="ts">
	/**
	 * Morphit — /cheat-sheet
	 *
	 * Tier 3.5 of the grandma-friendly investigation: a one-page
	 * printable reference that explains the project's core
	 * concept-pairs that grandmas confuse:
	 *
	 *   - account name vs seed phrase vs password
	 *   - network fee vs listing fee vs trade payment
	 *   - the supported tradable assets at a glance
	 *   - what to do if you lose your seed
	 *
	 * Designed for paper.  The on-screen view shows the same
	 * content with regular SvelteKit-app styling; clicking
	 * "Print cheat-sheet" activates the same visibility-isolation
	 * pattern as SeedBackupPrint (Part 92) so the printout is
	 * just the cheat-sheet, no chrome.
	 *
	 * Static content — doesn't load any user data, can be
	 * printed by anyone (signed in or not).  All copy is in the
	 * locale dictionary so it prints in the user's chosen
	 * language.
	 */

	import { _ } from 'svelte-i18n';
	import { browser } from '$app/environment';
	import Head from '$components/Head.svelte';

	function triggerPrint(): void {
		if (!browser) return;
		const html = document.documentElement;
		html.classList.add('morphit-printing-cheatsheet');

		const onAfterPrint = (): void => {
			html.classList.remove('morphit-printing-cheatsheet');
			window.removeEventListener('afterprint', onAfterPrint);
		};
		window.addEventListener('afterprint', onAfterPrint);

		requestAnimationFrame(() => window.print());
	}
</script>

<Head routeKey="cheat_sheet" />

<div class="screen-only mx-auto max-w-3xl px-4 py-10 md:py-14">
	<header class="mb-8">
		<h1 class="font-display text-3xl font-extrabold">
			<span class="brand-gradient-text">{$_('cheat_sheet.heading')}</span>
		</h1>
		<p class="mt-2 text-ink-700 dark:text-ink-200">
			{$_('cheat_sheet.intro')}
		</p>
		<div class="mt-4">
			<button type="button" onclick={triggerPrint} class="btn-secondary">
				{$_('cheat_sheet.print_button')}
			</button>
		</div>
	</header>
</div>

<div class="morphit-cheat-sheet" aria-label={$_('cheat_sheet.aria_label') as string}>
	<header class="cheat-header">
		<h1>{$_('cheat_sheet.heading')}</h1>
		<p class="cheat-subtitle">{$_('cheat_sheet.subtitle')}</p>
	</header>

	<!-- Section 1: account name vs seed phrase vs password -->
	<section class="cheat-section">
		<h2>{$_('cheat_sheet.section_identity.heading')}</h2>
		<dl class="cheat-table">
			<div class="cheat-row">
				<dt>{$_('cheat_sheet.section_identity.account_name')}</dt>
				<dd>{$_('cheat_sheet.section_identity.account_name_body')}</dd>
			</div>
			<div class="cheat-row">
				<dt>{$_('cheat_sheet.section_identity.seed_phrase')}</dt>
				<dd>{$_('cheat_sheet.section_identity.seed_phrase_body')}</dd>
			</div>
			<div class="cheat-row">
				<dt>{$_('cheat_sheet.section_identity.password')}</dt>
				<dd>{$_('cheat_sheet.section_identity.password_body')}</dd>
			</div>
		</dl>
	</section>

	<!-- Section 2: fees -->
	<section class="cheat-section">
		<h2>{$_('cheat_sheet.section_fees.heading')}</h2>
		<dl class="cheat-table">
			<div class="cheat-row">
				<dt>{$_('cheat_sheet.section_fees.listing_fee')}</dt>
				<dd>{$_('cheat_sheet.section_fees.listing_fee_body')}</dd>
			</div>
			<div class="cheat-row">
				<dt>{$_('cheat_sheet.section_fees.network_fee')}</dt>
				<dd>{$_('cheat_sheet.section_fees.network_fee_body')}</dd>
			</div>
			<div class="cheat-row">
				<dt>{$_('cheat_sheet.section_fees.trade_payment')}</dt>
				<dd>{$_('cheat_sheet.section_fees.trade_payment_body')}</dd>
			</div>
		</dl>
	</section>

	<!-- Section 3: assets -->
	<section class="cheat-section">
		<h2>{$_('cheat_sheet.section_assets.heading')}</h2>
		<dl class="cheat-table">
			<div class="cheat-row">
				<dt>BTC</dt>
				<dd>{$_('cheat_sheet.section_assets.btc')}</dd>
			</div>
			<div class="cheat-row">
				<dt>XMR</dt>
				<dd>{$_('cheat_sheet.section_assets.xmr')}</dd>
			</div>
			<div class="cheat-row">
				<dt>BLURT</dt>
				<dd>{$_('cheat_sheet.section_assets.blurt')}</dd>
			</div>
			<div class="cheat-row">
				<dt>USDT</dt>
				<dd>{$_('cheat_sheet.section_assets.usdt')}</dd>
			</div>
		</dl>
	</section>

	<!-- Section 4: emergency -->
	<section class="cheat-section">
		<h2>{$_('cheat_sheet.section_recovery.heading')}</h2>
		<ol class="cheat-list">
			<li>
				<strong>{$_('cheat_sheet.section_recovery.lost_seed_label')}</strong>
				{$_('cheat_sheet.section_recovery.lost_seed_body')}
			</li>
			<li>
				<strong>{$_('cheat_sheet.section_recovery.lost_password_label')}</strong>
				{$_('cheat_sheet.section_recovery.lost_password_body')}
			</li>
			<li>
				<strong>{$_('cheat_sheet.section_recovery.lost_device_label')}</strong>
				{$_('cheat_sheet.section_recovery.lost_device_body')}
			</li>
			<li>
				<strong>{$_('cheat_sheet.section_recovery.suspect_compromise_label')}</strong>
				{$_('cheat_sheet.section_recovery.suspect_compromise_body')}
			</li>
		</ol>
	</section>

	<footer class="cheat-footer">
		<p>{$_('cheat_sheet.footer')}</p>
	</footer>
</div>

<style>
	/* Screen mode: hide the print version, show the page UI. */
	.morphit-cheat-sheet {
		display: none;
	}

	/* Print mode: visibility-based isolation, identical pattern
	   to SeedBackupPrint (Part 92). */
	@media print {
		:global(html.morphit-printing-cheatsheet *) {
			visibility: hidden;
		}
		:global(html.morphit-printing-cheatsheet .morphit-cheat-sheet),
		:global(html.morphit-printing-cheatsheet .morphit-cheat-sheet *) {
			visibility: visible;
		}
		:global(html.morphit-printing-cheatsheet body) {
			background: white;
		}

		.morphit-cheat-sheet {
			display: block;
			position: absolute;
			inset: 0;
			padding: 0.5in;
			margin: 0;
			background: white;
			color: black;
			font-family: 'Helvetica', 'Arial', sans-serif;
			font-size: 9pt;
			line-height: 1.35;
		}

		.cheat-header h1 {
			font-size: 16pt;
			font-weight: 700;
			margin: 0 0 2pt 0;
			color: black;
		}
		.cheat-subtitle {
			font-size: 8.5pt;
			color: #444;
			margin: 0 0 10pt 0;
		}

		.cheat-section {
			margin-bottom: 10pt;
			padding-bottom: 6pt;
			border-bottom: 0.5pt solid #ccc;
		}
		.cheat-section:last-of-type {
			border-bottom: none;
		}
		.cheat-section h2 {
			font-size: 11pt;
			font-weight: 700;
			margin: 0 0 4pt 0;
			color: black;
			padding: 2pt 4pt;
			background: #eee;
		}

		.cheat-table {
			margin: 0;
		}
		.cheat-row {
			display: grid;
			grid-template-columns: 1.4in 1fr;
			gap: 8pt;
			padding: 3pt 0;
			border-bottom: 0.5pt dashed #ddd;
		}
		.cheat-row:last-child {
			border-bottom: none;
		}
		.cheat-row dt {
			font-weight: 700;
			color: black;
			font-size: 9pt;
		}
		.cheat-row dd {
			margin: 0;
			color: #222;
			font-size: 8.5pt;
		}

		.cheat-list {
			list-style: decimal;
			padding-left: 16pt;
			margin: 0;
		}
		.cheat-list li {
			padding: 3pt 0;
			font-size: 8.5pt;
			color: #222;
		}
		.cheat-list li strong {
			color: black;
		}

		.cheat-footer {
			margin-top: 10pt;
			padding-top: 6pt;
			border-top: 0.5pt solid #999;
		}
		.cheat-footer p {
			font-size: 7.5pt;
			color: #666;
			margin: 0;
			text-align: center;
		}
	}
</style>
