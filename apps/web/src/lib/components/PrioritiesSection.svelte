<!--
	PrioritiesSection — 7 cards bragging about Morphit's top design
	properties.  Card order, titles, and bodies are Ken-specified
	(cp115-cp5, 2026-05-22) and MUST NOT be paraphrased or reordered:

	  1. Privacy first       → /faq#privacy_practices
	  2. True P2P            → /faq#no_escrow_arbitration
	  3. Unstoppable by design → /faq#help_make_unstoppable
	  4. Discoverability     → /faq#what_is_blurt
	  5. Encrypted Chat      → /faq#chat_privacy
	  6. Reputation is everything → /faq#what_is_reputation
	  7. Trade anything      → /faq#trade_goods_services

	WHY THESE FAQ TARGETS

	Each target was chosen for two properties:
	  (a) Semantic exact-or-near-match to the card's content
	  (b) Already a hub in FAQ_RELATED — landing visitors see
	      multiple "Related" suggestions, encouraging onward
	      browsing rather than bounce.  Top inbound-density
	      targets (privacy_practices @ 20 inbound, what_is_blurt
	      @ 12, chat_privacy @ 9, what_is_reputation @ 7) match
	      the card semantics; the remaining three (no_escrow_-
	      arbitration, help_make_unstoppable, trade_goods_services)
	      are picked for semantic exactness.

	CARD CARDS ARE LINKS, NOT BUTTONS

	Each card is a full <a href> so the WHOLE card is the click
	target (Fitts's law — bigger hit zone).  This means:
	  - Right-click "open in new tab" works
	  - Cmd-click / Ctrl-click opens in new tab
	  - Long-press on mobile shows the URL preview
	  - Bookmarkable, share-able, SEO-crawlable

	HOVER + CLICK UX (subtle)

	  - Hover: card lifts 2px (transform: translateY) + border
	    intensifies + icon nudges 2px to the right (suggests
	    "you're going somewhere").  Pure CSS, GPU-composited.
	  - Focus: same lift effect + a brand-color focus ring for
	    keyboard navigation accessibility.
	  - Active (mouse down / touch): card returns to baseline
	    (transform: translateY(0)) for tactile press feedback.
	  - All transitions: 180ms ease-out — fast enough to feel
	    snappy, slow enough to register as deliberate.
	  - prefers-reduced-motion: reduce → transitions disabled,
	    visual changes still apply but instantly.

	ACCESSIBILITY

	  - Each card has a descriptive aria-label so screen-reader
	    users hear "Privacy first — learn more in our FAQ" rather
	    than just the title.
	  - Card #1's anchor border is decorative; no SR impact.
	  - Focus-visible ring is the standard Tailwind morphit-
	    emerald color, 2px solid, 2px offset.

	BUDGET (priorities #3 + #4)

	  - Pure CSS for hover/focus/active.  No JS.
	  - Each card emits a single inline <svg> icon.
	  - Lays out as 4 cols on lg / 2 cols on md / 1 col on sm.
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';

	// 7 priorities in Ken's specified order.  Each entry binds a
	// title/body locale key + an accent color + a FAQ target.  The
	// FAQ targets were picked for cross-link density (see top-of-file
	// docstring).
	interface PriorityCard {
		readonly key: string;
		readonly accent: 'lime' | 'green' | 'teal';
		readonly faqKey: string;
	}

	const PRIORITIES: ReadonlyArray<PriorityCard> = [
		{ key: 'privacy',         accent: 'lime',  faqKey: 'privacy_practices' },
		{ key: 'true_p2p',        accent: 'green', faqKey: 'no_escrow_arbitration' },
		{ key: 'unstoppable',     accent: 'teal',  faqKey: 'help_make_unstoppable' },
		{ key: 'discoverability', accent: 'lime',  faqKey: 'what_is_blurt' },
		{ key: 'encrypted_chat',  accent: 'green', faqKey: 'chat_privacy' },
		{ key: 'reputation',      accent: 'teal',  faqKey: 'what_is_reputation' },
		{ key: 'trade_anything',  accent: 'lime',  faqKey: 'trade_goods_services' }
	];

	// Per-locale FAQ URL builder.  Uses the localePath() helper so
	// /faq becomes /es/faq, /de/faq, etc.  Anchors via `#<key>` —
	// the legacy hash form, supported by FaqSearch's $effect block
	// at line 53 of FaqSearch.svelte.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const faqHref = $derived((faqKey: string) =>
		`${localePath('/faq', currentLang)}#${faqKey}`
	);
</script>

<section class="priorities-section" aria-labelledby="priorities-heading">
	<header class="priorities-header">
		<p class="priorities-eyebrow">{$_('home.priorities.eyebrow')}</p>
		<h2 id="priorities-heading" class="priorities-heading">
			{$_('home.priorities.heading')}
		</h2>
	</header>

	<ul class="priorities-grid">
		{#each PRIORITIES as p, i (p.key)}
			<li>
				<a
					class="priorities-card priorities-card-{p.accent}"
					data-priority={i + 1}
					href={faqHref(p.faqKey)}
					aria-label={$_('home.priorities.card_aria_label', {
						values: { title: $_(`home.priorities.${p.key}.title`) }
					})}
				>
					<div class="priorities-icon" aria-hidden="true">
						{#if p.key === 'privacy'}
							<!-- Padlock — Privacy first. -->
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
								<rect x="5" y="11" width="14" height="9" rx="2" />
								<path d="M8 11V8a4 4 0 0 1 8 0v3" />
								<circle cx="12" cy="15.5" r="1" fill="currentColor" />
							</svg>
						{:else if p.key === 'true_p2p'}
							<!-- Two-way arrows — True P2P (assets move directly). -->
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
								<path d="M4 9h13" />
								<path d="M14 6l3 3-3 3" />
								<path d="M20 15H7" />
								<path d="M10 18l-3-3 3-3" />
							</svg>
						{:else if p.key === 'unstoppable'}
							<!-- Shield with bolt — Unstoppable by design. -->
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
								<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z" />
								<path d="m13 9-3 4h3l-1 4 4-5h-3l1-3Z" fill="currentColor" stroke="none" />
							</svg>
						{:else if p.key === 'discoverability'}
							<!-- Broadcast / radio waves — Discoverability. -->
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
								<circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
								<path d="M8.5 8.5a5 5 0 0 0 0 7" />
								<path d="M15.5 8.5a5 5 0 0 1 0 7" />
								<path d="M5.5 5.5a9 9 0 0 0 0 13" />
								<path d="M18.5 5.5a9 9 0 0 1 0 13" />
							</svg>
						{:else if p.key === 'encrypted_chat'}
							<!-- Padlocked chat bubble — Encrypted Chat. -->
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
								<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-6l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
								<rect x="9" y="9" width="6" height="4.5" rx="0.8" fill="currentColor" stroke="none" />
								<path d="M10.5 9V7.5a1.5 1.5 0 0 1 3 0V9" />
							</svg>
						{:else if p.key === 'reputation'}
							<!-- Star — Reputation is everything. -->
							<svg
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="1.6"
								stroke-linejoin="round"
							>
								<path d="m12 3 2.7 5.7 6.3.9-4.6 4.4 1.1 6.3L12 17.4l-5.5 2.9 1.1-6.3L3 9.6l6.3-.9L12 3Z" />
							</svg>
						{:else}
							<!-- Stacked coins — Trade anything. -->
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
								<ellipse cx="12" cy="6" rx="7" ry="2.4" />
								<path d="M5 6v4c0 1.3 3.1 2.4 7 2.4s7-1.1 7-2.4V6" />
								<path d="M5 10v4c0 1.3 3.1 2.4 7 2.4s7-1.1 7-2.4v-4" />
								<path d="M5 14v4c0 1.3 3.1 2.4 7 2.4s7-1.1 7-2.4v-4" />
							</svg>
						{/if}
					</div>

					<h3 class="priorities-card-title">
						{$_(`home.priorities.${p.key}.title`)}
					</h3>
					<p class="priorities-card-body">
						{$_(`home.priorities.${p.key}.body`)}
					</p>

					<!-- "Learn more" affordance.  Visually subtle but signals
					     the card is interactive.  Arrow glyph shifts on hover. -->
					<span class="priorities-card-cta" aria-hidden="true">
						{$_('common.learn_more')}
						<span class="nav-arrow nav-arrow-right">⇨</span>
					</span>
				</a>
			</li>
		{/each}
	</ul>
</section>

<style>
	.priorities-section {
		margin-top: 4rem;
		margin-bottom: 4rem;
	}

	.priorities-header {
		text-align: center;
		margin-bottom: 2rem;
	}

	.priorities-eyebrow {
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: rgb(100 116 139); /* ink-500 */
		margin: 0;
	}

	.priorities-heading {
		margin: 0.5rem 0 0;
		font-size: 1.875rem;
		font-weight: 800;
		line-height: 1.2;
		letter-spacing: -0.02em;
	}

	.priorities-grid {
		display: grid;
		gap: 1rem;
		grid-template-columns: 1fr;
		/* All rows the SAME height (sized to the tallest row), so every
		 * card matches the tallest card regardless of how much text a
		 * given locale puts in it (Ken cp228 — multilingual-safe equal
		 * heights without a brittle fixed min-height). */
		grid-auto-rows: 1fr;
		list-style: none;
		padding: 0;
		margin: 0;
	}

	/* Each <li> is a single-cell grid so its <a> card stretches to fill the
	 * li in BOTH axes; combined with grid-auto-rows:1fr above, every card
	 * ends up identical in height across the whole 7-card set. */
	.priorities-grid > li {
		display: grid;
	}

	@media (min-width: 640px) {
		.priorities-grid {
			grid-template-columns: repeat(2, 1fr);
		}
	}
	@media (min-width: 1024px) {
		.priorities-grid {
			grid-template-columns: repeat(4, 1fr);
		}
	}

	/* The card is now an <a>, so reset link styling first. */
	.priorities-card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1.5rem;
		border-radius: 1rem;
		border: 1px solid rgb(226 232 240); /* ink-200 */
		background: white;
		min-height: 12rem;
		position: relative;
		text-decoration: none;
		color: inherit;
		/* Smooth transition for hover lift + border intensification. */
		transition:
			transform 180ms ease-out,
			border-color 180ms ease-out,
			box-shadow 180ms ease-out;
		/* Will-change tells the compositor to promote the card to its
		 * own layer.  Cheap on the GPU; avoids layer-creation jank on
		 * the first hover. */
		will-change: transform, border-color;
	}

	:global(.dark) .priorities-card {
		background: rgb(15 23 42); /* ink-900 */
		border-color: rgb(30 41 59); /* ink-800 */
	}

	/* HOVER: lift 2 px, intensify border, brighten title.
	 * Cmd/Ctrl-click + right-click still work because the card
	 * is a real <a href>. */
	.priorities-card:hover {
		transform: translateY(-2px);
		border-color: rgb(148 163 184); /* ink-400 */
		box-shadow: 0 6px 18px -8px rgb(2 6 23 / 0.12);
	}
	:global(.dark) .priorities-card:hover {
		border-color: rgb(71 85 105); /* ink-600 */
		box-shadow: 0 6px 18px -8px rgb(0 0 0 / 0.5);
	}

	/* FOCUS-VISIBLE: keyboard-only focus ring.  No double-treatment
	 * for mouse focus. */
	.priorities-card:focus-visible {
		outline: none;
		transform: translateY(-2px);
		box-shadow:
			0 0 0 2px rgb(255 255 255),
			0 0 0 4px rgb(0 218 105), /* morphit-emerald */
			0 6px 18px -8px rgb(2 6 23 / 0.12);
	}
	:global(.dark) .priorities-card:focus-visible {
		box-shadow:
			0 0 0 2px rgb(15 23 42),
			0 0 0 4px rgb(0 218 105),
			0 6px 18px -8px rgb(0 0 0 / 0.5);
	}

	/* ACTIVE: tactile press feedback.  Drops back to baseline so
	 * the card feels physical. */
	.priorities-card:active {
		transform: translateY(0);
		transition-duration: 60ms;
	}

	/* Honor user's motion preference — no animation, but the
	 * lift/border state changes still apply (instant). */
	@media (prefers-reduced-motion: reduce) {
		.priorities-card {
			transition: none;
		}
	}

	.priorities-icon {
		width: 2rem;
		height: 2rem;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.priorities-icon svg {
		width: 100%;
		height: 100%;
	}

	.priorities-card-title {
		font-size: 1.125rem;
		font-weight: 700;
		margin: 0;
		letter-spacing: -0.01em;
	}

	.priorities-card-body {
		font-size: 0.9375rem;
		line-height: 1.5;
		color: rgb(71 85 105); /* ink-600 */
		margin: 0;
		/* Push the CTA to the bottom of the card. */
		flex: 1;
	}

	:global(.dark) .priorities-card-body {
		color: rgb(203 213 225); /* ink-300 */
	}

	/* "Learn more →" affordance.  Sits at the bottom of the card. */
	.priorities-card-cta {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.8125rem;
		font-weight: 600;
		color: rgb(100 116 139); /* ink-500 */
		margin-top: 0.5rem;
	}
	:global(.dark) .priorities-card-cta {
		color: rgb(148 163 184); /* ink-400 */
	}

	/* On hover the CTA text shifts to the brand color; the arrow glyph
	 * slides + greens via the global .nav-arrow rules in app.css. */
	.priorities-card:hover .priorities-card-cta,
	.priorities-card:focus-visible .priorities-card-cta {
		color: rgb(0 218 105); /* morphit-emerald */
	}

	/* Brand-color accent rotation per card. */
	.priorities-card-lime .priorities-icon {
		color: #8eef26;
	}
	.priorities-card-green .priorities-icon {
		color: #00da69;
	}
	.priorities-card-teal .priorities-icon {
		color: #02a6b2;
	}

	/* Priority #1 (Privacy first) anchored with the brand-gradient
	 * top border.  Reinforces ordering without shouting. */
	.priorities-card[data-priority='1']::before {
		content: '';
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 3px;
		background: linear-gradient(
			to right,
			#8eef26,
			#00da69,
			#02a6b2
		);
		border-top-left-radius: 1rem;
		border-top-right-radius: 1rem;
	}
</style>
