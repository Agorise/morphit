<script lang="ts">
	/**
	 * CopyButton — one copy-to-clipboard control used everywhere (fee
	 * addresses, keys, feed URLs, transaction ids…) so the "Copied" feedback
	 * is identical across the app: after a click it turns GREEN and shows a ✓
	 * (Ken #6). Encapsulates the clipboard write + the flash-then-revert timer
	 * so call sites don't each re-implement it (and drift).
	 *
	 * Styling: pass the button's structural classes (border/bg/padding/hover)
	 * in `class` and the IDLE text colour in `idleColorClass`. The component
	 * owns the text colour so the copied state can swap to green cleanly — do
	 * NOT put a text colour in `class` or it'll fight the green.
	 */
	import { _ } from 'svelte-i18n';

	interface Props {
		/** The exact text written to the clipboard. */
		value: string;
		/** Idle label. Defaults to the shared "Copy". */
		label?: string;
		/** Label shown (after the ✓) while flashing. Defaults to "Copied". */
		copiedLabel?: string;
		/** Native tooltip. */
		title?: string;
		/** Accessible name, when the visible label isn't enough on its own. */
		ariaLabel?: string;
		/** Structural classes (no text colour — see the component doc). */
		class?: string;
		/** Text colour while idle (e.g. "text-ink-700 dark:text-ink-100"). */
		idleColorClass?: string;
		/** Called after a successful (or attempted) copy, for callers that
		 *  want to react (analytics-free; e.g. close a menu). */
		oncopied?: () => void;
	}

	let {
		value,
		label,
		copiedLabel,
		title,
		ariaLabel,
		class: klass = '',
		idleColorClass = '',
		oncopied
	}: Props = $props();

	let copied = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function doCopy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(value);
		} catch {
			// Clipboard API unavailable (insecure context / very old browser).
			// Still flash so the user gets feedback; they can select the text
			// manually. Deliberately silent — nothing sensitive to log.
		}
		copied = true;
		oncopied?.();
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			copied = false;
			timer = null;
		}, 1500);
	}
</script>

<button
	type="button"
	onclick={doCopy}
	{title}
	aria-label={ariaLabel}
	data-copied={copied}
	class="{klass} {copied ? 'text-green-600 dark:text-green-400' : idleColorClass}"
>
	{#if copied}
		<span aria-hidden="true">✓</span>
		{copiedLabel ?? $_('common.copied')}
	{:else}
		{label ?? $_('common.copy')}
	{/if}
</button>
