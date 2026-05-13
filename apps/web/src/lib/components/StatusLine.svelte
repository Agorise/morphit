<script lang="ts">
	/**
	 * StatusLine — the feedback line grandma sees under every input,
	 * next to every async operation.
	 *
	 * Four states, four visual treatments:
	 *
	 *   idle     → empty, but the line's minimum height is reserved
	 *              so nothing shifts when a message appears
	 *   loading  → spinner + muted text, aria-live polite
	 *   ok       → checkmark + emerald text, aria-live polite
	 *   warn     → warning triangle + amber text, aria-live polite
	 *   error    → same as warn but aria-live assertive so screen
	 *              readers interrupt
	 *
	 * Usage is always children-based — the caller writes the message
	 * text; this component handles the icon, color, spacing, and
	 * aria plumbing.
	 *
	 * See docs/UX-STANDARD.md rule #3.
	 */

	import type { Snippet } from 'svelte';

	interface Props {
		/** The status kind. Drives the icon and color. */
		kind: 'idle' | 'loading' | 'ok' | 'warn' | 'error';
		/** The message, as a Svelte snippet. */
		children?: Snippet;
		/** Optional ID for aria-describedby on the related input. */
		id?: string;
	}

	let { kind, children, id }: Props = $props();

	const ariaLive = $derived(kind === 'error' ? 'assertive' : 'polite');

	const color = $derived.by(() => {
		switch (kind) {
			case 'idle':
				return '';
			case 'loading':
				return 'text-ink-500 dark:text-ink-400';
			case 'ok':
				return 'text-morphit-emerald font-semibold';
			case 'warn':
				return 'text-amber-700 dark:text-amber-300';
			case 'error':
				return 'text-red-700 dark:text-red-300 font-semibold';
		}
	});
</script>

<p {id} class="mt-2 flex min-h-[1.5rem] items-center gap-2 text-sm {color}" aria-live={ariaLive}>
	{#if kind === 'loading'}
		<svg class="h-4 w-4 flex-none animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="3" stroke-opacity="0.25" />
			<path
				d="M21 12a9 9 0 0 0-9-9"
				stroke="currentColor"
				stroke-width="3"
				stroke-linecap="round"
			/>
		</svg>
	{:else if kind === 'ok'}
		<svg class="h-4 w-4 flex-none" viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<path
				d="M5 12l4 4L19 7"
				stroke="currentColor"
				stroke-width="3"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	{:else if kind === 'warn' || kind === 'error'}
		<svg class="h-4 w-4 flex-none" viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<path
				d="M12 3L2 20h20L12 3z"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linejoin="round"
			/>
			<path d="M12 10v4M12 17v.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
		</svg>
	{/if}
	{#if children}
		<span>{@render children()}</span>
	{/if}
</p>
