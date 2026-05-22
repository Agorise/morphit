<!--
	PrioritiesSection — 4 cards bragging about Morphit's 4 design
	priorities (memory rule, in order):

	  1. Privacy & anonymity (priority #1, above all else)
	  2. Decentralization & unstoppability
	  3. Grandma-friendliness
	  4. Tiny footprint

	WHY THIS COMPONENT EXISTS (Part 122 cp115)

	The existing 4-point card grid on the home page (non_custodial,
	no_kyc, uncensorable, grandma) talks about USER-FACING properties
	("your coins move directly between you and your partner") aimed at
	a potential trader.  This new section talks about OPERATING
	PRIORITIES — the values Morphit was designed around, aimed at a
	privacy-conscious skeptic, journalist, or potential operator
	deciding whether to trust + recommend the project.

	The two sections coexist intentionally.  Users picking between
	"sounds good but is it safe?" and "what are these people actually
	prioritizing?" get answers to both.

	PRIORITY #1 EMPHASIS

	Per memory, privacy is the #1 priority, above ALL else.  The
	first card is visually distinguished (subtle accent border) to
	reinforce that ordering without shouting.

	BUDGET (priorities #3 + #4)

	  - Pure CSS, no JS.  All text, no images.  ~2 KB at runtime.
	  - Each card emits an inline SVG icon (single <svg> with a path).
	  - Lays out as a 4-col grid on lg+, 2-col on md, 1-col on sm.
	-->
<script lang="ts">
	import { _ } from 'svelte-i18n';

	// 4 priorities, in canonical memory-rule order.  Each maps to
	// home.priorities.<key>.{title,body} in every locale file.
	const PRIORITIES = [
		{ key: 'privacy', accent: 'lime' as const },
		{ key: 'decentralization', accent: 'green' as const },
		{ key: 'grandma', accent: 'teal' as const },
		{ key: 'tiny_footprint', accent: 'lime' as const }
	];
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
			<li class="priorities-card priorities-card-{p.accent}" data-priority={i + 1}>
				<div class="priorities-icon" aria-hidden="true">
					{#if p.key === 'privacy'}
						<!-- Padlock — privacy. -->
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
							<rect x="5" y="11" width="14" height="9" rx="2" />
							<path d="M8 11V8a4 4 0 0 1 8 0v3" />
							<circle cx="12" cy="15.5" r="1" fill="currentColor" />
						</svg>
					{:else if p.key === 'decentralization'}
						<!-- Network nodes — decentralization. -->
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
							<circle cx="12" cy="5" r="2" />
							<circle cx="5" cy="18" r="2" />
							<circle cx="19" cy="18" r="2" />
							<circle cx="12" cy="13" r="2" />
							<path d="M12 7v4M10.5 14.5 7 16.5M13.5 14.5 17 16.5" />
						</svg>
					{:else if p.key === 'grandma'}
						<!-- Heart inside a chat bubble — grandma-friendliness. -->
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
							<path d="M4 5h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-6l-4 3v-3H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
							<path
								d="M12 14.5s-3-1.6-3-3.7c0-1 .8-1.8 1.8-1.8.6 0 1 .3 1.2.7.2-.4.6-.7 1.2-.7 1 0 1.8.8 1.8 1.8 0 2.1-3 3.7-3 3.7Z"
								fill="currentColor"
								stroke="none"
							/>
						</svg>
					{:else}
						<!-- Feather — tiny footprint. -->
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
							<path d="M20 4c-7 0-13 6-13 13l-3 3h3v-3c0-7 6-13 13-13Z" />
							<path d="M14 10l-6 6" />
							<path d="M16 12h-4" />
						</svg>
					{/if}
				</div>

				<h3 class="priorities-card-title">
					{$_(`home.priorities.${p.key}.title`)}
				</h3>
				<p class="priorities-card-body">
					{$_(`home.priorities.${p.key}.body`)}
				</p>
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
		list-style: none;
		padding: 0;
		margin: 0;
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

	.priorities-card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1.5rem;
		border-radius: 1rem;
		border: 1px solid rgb(226 232 240); /* ink-200 */
		background: white;
		min-height: 11rem;
		position: relative;
	}

	:global(.dark) .priorities-card {
		background: rgb(15 23 42); /* ink-900 */
		border-color: rgb(30 41 59); /* ink-800 */
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
	}

	:global(.dark) .priorities-card-body {
		color: rgb(203 213 225); /* ink-300 */
	}

	/* Per-card accent — uses the three brand gradient stops.  Priority
	 * #1 (privacy) gets the leftmost (lime) accent; #2 the middle
	 * (green); #3 the rightmost (teal); #4 wraps back to lime. */
	.priorities-card-lime .priorities-icon {
		color: #8eef26;
	}
	.priorities-card-green .priorities-icon {
		color: #00da69;
	}
	.priorities-card-teal .priorities-icon {
		color: #02a6b2;
	}

	/* Priority #1 visually anchored with a brand-gradient top border.
	 * Doesn't shout — just lets a careful reader notice the ordering. */
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
