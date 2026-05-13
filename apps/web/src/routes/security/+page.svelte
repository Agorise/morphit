<script lang="ts">
	import { _ } from 'svelte-i18n';
	import Head from '$components/Head.svelte';

	/**
	 * Locale strings for chat_body, open_source_body, and
	 * footer_body contain `{chat_crypto_doc}`, `{security_doc}`,
	 * and `{morphit_account}` placeholders that must be rendered
	 * as inline <code> elements (not interpolated as plain text,
	 * since the values are file paths / account names that look
	 * better in monospace).  We split the locale string on each
	 * placeholder and render the surrounding text as plain text
	 * with the placeholder replaced by a <code> element.
	 *
	 * Helper: split on a single token, returning [before, after]
	 * and falling back to [whole, ''] if the token is missing
	 * (translator drift defense — the sentence still reads, just
	 * without the styled element).
	 */
	function splitOn(text: string, token: string): [string, string] {
		const idx = text.indexOf(token);
		if (idx === -1) return [text, ''];
		return [text.slice(0, idx), text.slice(idx + token.length)];
	}

	const chatBody = $derived($_('security.chat_body'));
	const openSourceBody = $derived($_('security.open_source_body'));
	const footerBody = $derived($_('security.footer_body'));

	const chatBodyParts = $derived(splitOn(chatBody, '{chat_crypto_doc}'));
	const openSourceParts = $derived(splitOn(openSourceBody, '{security_doc}'));
	const footerParts = $derived(splitOn(footerBody, '{morphit_account}'));
</script>

<Head routeKey="security" />

<div class="mx-auto max-w-prose px-4 py-12 md:py-16">
	<header class="mb-8 text-center">
		<h1 class="font-display text-4xl font-extrabold">
			<span class="brand-gradient-text">{$_('security.heading')}</span>
		</h1>
		<p class="mt-3 text-ink-600 dark:text-ink-300">
			{$_('security.subtitle')}
		</p>
	</header>

	<div class="space-y-6">
		<article class="card">
			<h2 class="font-display text-xl font-bold">{$_('security.keys_title')}</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{$_('security.keys_body')}
			</p>
		</article>

		<article class="card">
			<h2 class="font-display text-xl font-bold">{$_('security.tracking_title')}</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{$_('security.tracking_body')}
			</p>
		</article>

		<article class="card">
			<h2 class="font-display text-xl font-bold">{$_('security.chat_title')}</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{chatBodyParts[0]}<code class="font-mono text-sm">docs/adr/0015-chat-crypto.md</code
				>{chatBodyParts[1]}
			</p>
		</article>

		<article class="card">
			<h2 class="font-display text-xl font-bold">{$_('security.reproducible_title')}</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{$_('security.reproducible_body')}
			</p>
		</article>

		<article class="card">
			<h2 class="font-display text-xl font-bold">{$_('security.open_source_title')}</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{openSourceParts[0]}<code class="font-mono text-sm">docs/SECURITY.md</code
				>{openSourceParts[1]}
			</p>
		</article>

		<article class="card" id="bounty">
			<h2 class="font-display text-xl font-bold">{$_('security.bounty_title')}</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{$_('security.bounty_body')}
			</p>
			<p class="mt-3 text-ink-700 dark:text-ink-200">
				<a
					href="https://git.agorise.net/agorise/morphit/src/branch/main/docs/SECURITY.md#bug-bounty-program"
					class="text-morphit-emerald hover:underline"
					rel="noopener">{$_('security.bounty_link')}</a
				>
			</p>
		</article>

		<article class="card" id="canary">
			<h2 class="font-display text-xl font-bold">{$_('security.canary_title')}</h2>
			<p class="mt-2 text-ink-700 dark:text-ink-200">
				{$_('security.canary_body')}
			</p>
			<p class="mt-3 text-ink-700 dark:text-ink-200">
				<a href="/canary.txt" class="text-morphit-emerald hover:underline" rel="noopener"
					>{$_('security.canary_link')}</a
				>
				·
				<a href="/pgp_keys.asc" class="text-morphit-emerald hover:underline" rel="noopener"
					>{$_('security.canary_pgp_link')}</a
				>
			</p>
		</article>
	</div>

	<footer class="mt-10 text-center text-sm text-ink-500">
		<p>
			{footerParts[0]}<code>morphit</code>{footerParts[1]}
		</p>
	</footer>
</div>
