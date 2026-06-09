<script lang="ts">
	/**
	 * RssFeedPicker — an RSS-icon trigger that, when clicked,
	 * opens a small popover letting the reader copy the feed URL
	 * in their preferred format: RSS 2.0, Atom 1.0, or JSON Feed.
	 *
	 * Every RSS surface on the site renders THIS component — the
	 * footer worldwide feed, the per-asset orderbook feed, and the
	 * per-trader profile feed — so all three formats are offered
	 * everywhere from one place, and the orange RSS glyph lives
	 * here exactly once (previously copy-pasted into 3 routes).
	 *
	 * On pick: copies `<origin><base>.<ext>` to the clipboard and
	 * shows a bottom snackbar confirming the format. The options
	 * are real <a href> links (target=_blank) so they stay useful
	 * without JS (middle-click, "copy link address") and so a
	 * clipboard failure (e.g. an insecure-context browser) degrades
	 * gracefully to opening the feed in a new tab — the reader is
	 * never left hanging.
	 *
	 * `base` is the feed path WITHOUT extension, e.g.
	 *   '/rss/orderbook'
	 *   '/rss/orderbook/by-asset/btc'
	 *   '/rss/orderbook/by-account/@alice'
	 */
	import { _ } from 'svelte-i18n';
	import { showToast } from '$lib/stores/toast';

	type RssFormat = 'rss' | 'atom' | 'json';

	let {
		base,
		label,
		text = '',
		triggerClass = 'chip',
		iconClass = 'h-4 w-4',
		align = 'left'
	}: {
		base: string;
		label: string;
		text?: string;
		triggerClass?: string;
		iconClass?: string;
		align?: 'left' | 'right';
	} = $props();

	let open = $state(false);
	let rootEl = $state<HTMLDivElement>();
	let buttonEl = $state<HTMLButtonElement>();

	const EXT: Readonly<Record<RssFormat, string>> = { rss: 'xml', atom: 'atom', json: 'json' };
	const COPIED_KEY: Readonly<Record<RssFormat, string>> = {
		rss: 'rss.copied_rss2',
		atom: 'rss.copied_atom',
		json: 'rss.copied_json'
	};
	const LABEL_KEY: Readonly<Record<RssFormat, string>> = {
		rss: 'rss.format_rss2',
		atom: 'rss.format_atom',
		json: 'rss.format_json'
	};
	const FORMATS: readonly RssFormat[] = ['rss', 'atom', 'json'];

	function urlFor(format: RssFormat): string {
		const origin = typeof location !== 'undefined' ? location.origin : '';
		return `${origin}${base}.${EXT[format]}`;
	}

	async function pick(format: RssFormat, e: MouseEvent): Promise<void> {
		// Cancel default navigation SYNCHRONOUSLY (before any await) —
		// otherwise the <a> navigates before the clipboard write resolves.
		e.preventDefault();
		const url = urlFor(format);
		open = false;
		buttonEl?.focus();
		try {
			await navigator.clipboard.writeText(url);
			showToast($_(COPIED_KEY[format]), 'success');
		} catch {
			// Clipboard unavailable (insecure context / permission denied)
			// — open the feed so the reader still gets it.
			window.open(url, '_blank', 'noopener,noreferrer');
			showToast($_('rss.copy_failed'), 'warn');
		}
	}

	function onWindowClick(e: MouseEvent): void {
		if (open && rootEl && !rootEl.contains(e.target as Node)) open = false;
	}
	function onWindowKeydown(e: KeyboardEvent): void {
		if (open && e.key === 'Escape') {
			open = false;
			buttonEl?.focus();
		}
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<div class="relative inline-flex" bind:this={rootEl}>
	<button
		bind:this={buttonEl}
		type="button"
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label={label}
		title={label}
		onclick={() => (open = !open)}
		class={triggerClass}
	>
		<svg class={iconClass} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
			<rect x="1.5" y="1.5" width="21" height="21" rx="4" fill="#F26522" />
			<circle cx="6.5" cy="17.5" r="2" fill="#fff" />
			<path
				d="M5 8.5 A 10.5 10.5 0 0 1 15.5 19"
				stroke="#fff"
				stroke-width="2.4"
				fill="none"
				stroke-linecap="round"
			/>
			<path
				d="M5 4.5 A 14.5 14.5 0 0 1 19.5 19"
				stroke="#fff"
				stroke-width="2.4"
				fill="none"
				stroke-linecap="round"
			/>
		</svg>
		{#if text}<span>{text}</span>{/if}
	</button>

	{#if open}
		<div
			role="menu"
			aria-label={$_('rss.choose_format')}
			class="absolute bottom-full z-30 mb-2 min-w-[8.5rem] rounded-xl border-2 border-ink-200 bg-white p-1 shadow-lg dark:border-ink-700 dark:bg-ink-900 {align ===
			'right'
				? 'right-0'
				: 'left-0'}"
		>
			<p class="px-2 pb-1 pt-1 text-xs font-semibold text-ink-500 dark:text-ink-400">
				{$_('rss.choose_format')}
			</p>
			{#each FORMATS as format (format)}
				<a
					role="menuitem"
					href={urlFor(format)}
					target="_blank"
					rel="noopener noreferrer"
					onclick={(e) => pick(format, e)}
					class="block rounded-lg px-3 py-2 text-sm hover:bg-ink-100 focus:bg-ink-100 focus:outline-none dark:hover:bg-ink-800 dark:focus:bg-ink-800"
				>
					{$_(LABEL_KEY[format])}
				</a>
			{/each}
		</div>
	{/if}
</div>
