<script lang="ts">
	/**
	 * Morphit — /glossary
	 *
	 * Tier 1.4 from the grandma-friendly investigation: a single
	 * place where every word that appears in the UI gets a
	 * one-paragraph plain-language definition. No links to ten
	 * different FAQ entries; no "see also"; no chain of
	 * disambiguation. Just: "what does this word mean to a person
	 * trying to use Morphit for the first time?"
	 *
	 * Scope rules (hard-learned from the FAQ growth pattern):
	 *
	 *   1. One term per entry. If two words mean the same thing in
	 *      Morphit's UI ("listing fee" / "post fee"), pick one and
	 *      cross-reference in the body.
	 *   2. Plain language. Avoid defining a jargon term using
	 *      another jargon term — if the body needs another
	 *      glossary word, link to it inline.
	 *   3. The definition should answer: "if a grandma sees this
	 *      word in the UI, what does she need to know to keep
	 *      going?" Not: "here is the technical specification."
	 *
	 * The page is alphabetized in English. Other locales preserve
	 * the English alphabetical order rather than re-sorting per
	 * locale, because the term IDs (the keys) are stable English
	 * and the page structure stays predictable for someone using a
	 * URL anchor like `/glossary#fiat`.
	 */
	import Head from '$components/Head.svelte';
	import { _ } from 'svelte-i18n';

	/** The 22 terms covered by the glossary, in alphabetized
	 *  English order. Adding a new term: add the key here, add
	 *  glossary.<key>.title and glossary.<key>.body to all 10
	 *  locale JSONs, done. */
	const TERMS = [
		'active_key',
		'blurt',
		'blurt_power',
		'broadcast',
		'counterparty',
		'custom_json',
		'delegation',
		'federation',
		'feedback',
		'fiat',
		'indexer',
		'instance',
		'listing_fee',
		'network_fee',
		'operator',
		'password',
		'permlink',
		'posting_key',
		'relay',
		'release_op',
		'seed_phrase',
		'sign'
	] as const;
</script>

<Head routeKey="glossary" />

<section class="mx-auto max-w-3xl px-4 py-12 md:py-16">
	<header class="mb-10">
		<h1 class="font-display text-3xl font-bold md:text-4xl">
			<span class="brand-gradient-text">{$_('glossary.heading')}</span>
		</h1>
		<p class="mt-3 text-base text-ink-600 dark:text-ink-300">
			{$_('glossary.intro')}
		</p>
	</header>

	<dl class="space-y-8">
		{#each TERMS as key (key)}
			<div id={key}>
				<dt class="font-display text-xl font-bold">
					<a href="#{key}" class="hover:text-morphit-emerald">
						{$_(`glossary.${key}.title`)}
					</a>
				</dt>
				<dd class="mt-2 text-base text-ink-700 dark:text-ink-200">
					{$_(`glossary.${key}.body`)}
				</dd>
			</div>
		{/each}
	</dl>

	<footer class="mt-12 border-t border-ink-200 pt-6 text-sm text-ink-500 dark:border-ink-700">
		<p>{$_('glossary.footnote')}</p>
	</footer>
</section>
