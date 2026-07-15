<!--
	AssetChoiceSelect — pick ONE coin from an explicit list, with logos.

	v1.5.0 (tt.txt B). The "Share crypto address" modal used to render one
	tab-button per asset — 16 of them, each `flex-1` — which wrapped into a
	wall of blocks that blew the modal past the viewport on a phone. Ken:
	"Just use a select box that has all of the coin choices … in it with
	their logo, rather than all of those blocks."

	A native <select> cannot render per-option SVG logos, so this is a small
	custom listbox (trigger button + popover), deliberately mirroring
	AssetFilterSelect's interaction + a11y + z-index posture so the two feel
	identical. It is NOT the same component:

	  - AssetFilterSelect is the orderbook FILTER — it owns an "Any" option,
	    the `barter` goods sentinel, and the operator disabled-assets rule.
	  - This one picks exactly one coin from an explicit allow-list handed in
	    by the caller (e.g. only the assets a seller actually accepts), with
	    no "Any" and no barter (you cannot share a crypto ADDRESS for
	    goods/services).

	What they DO share is the single source of truth that matters: coin name,
	display ticker and logo all come from `$lib/assets/registry` (ASSETS), so
	the label a user reads here can never drift from the orderbook's.

	Options are alphabetized BY NAME, matching AssetFilterSelect ("Bitcoin
	(BTC)", "Bitcoin Cash (BCH)", "Blurt (BLURT)", …). Logos live inside the
	{#if open} block with loading="lazy" decoding="async", so a user who
	never opens the menu pays zero bytes for coin icons (priorities #1/#4).
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { ASSETS } from '$lib/assets/registry';
	import type { ChatAssetTicker } from '$lib/chat/payload';

	interface Props {
		/** The tickers the caller allows, in any order. Rendered
		 *  alphabetically by coin NAME. */
		options: readonly ChatAssetTicker[];
		/** The selected ticker. Bindable. */
		value: ChatAssetTicker;
		/** Disable the trigger (e.g. while a send is in flight). */
		disabled?: boolean;
		/** Accessible name for the listbox. */
		ariaLabel: string;
		/** Called after the user picks, so a caller can run side effects
		 *  (the address modal drops a pinned multi-network choice here). */
		onSelect?: (v: ChatAssetTicker) => void;
	}

	let { options, value = $bindable(), disabled = false, ariaLabel, onSelect }: Props = $props();

	let open = $state(false);
	let focused = $state(false);
	let rootEl = $state<HTMLDivElement>();
	let buttonEl = $state<HTMLButtonElement>();

	/** The caller's allow-list, resolved against the registry and sorted by
	 *  display name. Unknown tickers are dropped rather than rendered as a
	 *  bare code with a broken logo. */
	const coins = $derived(
		options
			.map((t) => ASSETS.find((a) => a.ticker === t))
			.filter((a): a is (typeof ASSETS)[number] => a !== undefined)
			.slice()
			.sort((a, b) => a.displayName.localeCompare(b.displayName))
	);

	const selected = $derived(ASSETS.find((a) => a.ticker === value));

	function choose(v: ChatAssetTicker): void {
		value = v;
		open = false;
		buttonEl?.focus();
		onSelect?.(v);
	}

	function onWindowKeydown(e: KeyboardEvent): void {
		if (open && e.key === 'Escape') {
			// Swallow it: inside a modal, Escape would otherwise close the
			// whole dialog while the user only meant to dismiss this menu.
			e.stopPropagation();
			open = false;
			buttonEl?.focus();
		}
	}

	// Outside-close on pointerdown in the capture phase — fires BEFORE any
	// option handler detaches its own node. Same rationale as
	// AssetFilterSelect.
	$effect(() => {
		if (!open) return;
		const onDocPointerDown = (e: PointerEvent): void => {
			if (rootEl && !rootEl.contains(e.target as Node)) open = false;
		};
		document.addEventListener('pointerdown', onDocPointerDown, true);
		return () => document.removeEventListener('pointerdown', onDocPointerDown, true);
	});
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="relative {open ? 'z-30' : 'z-10'}" bind:this={rootEl}>
	<button
		bind:this={buttonEl}
		type="button"
		{disabled}
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-label={ariaLabel}
		onclick={() => (open = !open)}
		onfocus={() => (focused = true)}
		onblur={() => (focused = false)}
		class="flex w-full items-center gap-2 rounded-xl border border-ink-200 bg-white px-3 py-2 text-left transition-colors duration-150 ease-out hover:border-ink-300 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-ink-700 dark:bg-ink-900 dark:hover:border-ink-600 {focused ||
		open
			? 'border-morphit-emerald ring-1 ring-morphit-emerald'
			: ''}"
	>
		{#if selected}
			<img
				src={selected.logoSvgPath}
				alt=""
				width="20"
				height="20"
				class="h-5 w-5 shrink-0 rounded-full"
			/>
			<span class="grow truncate"
				>{selected.displayName} <span class="opacity-60">({selected.displayTicker})</span></span
			>
		{:else}
			<span class="grow truncate">{ariaLabel}</span>
		{/if}
		<svg
			class="h-4 w-4 shrink-0 opacity-60"
			viewBox="0 0 20 20"
			fill="currentColor"
			aria-hidden="true"
		>
			<path
				fill-rule="evenodd"
				d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z"
				clip-rule="evenodd"
			/>
		</svg>
	</button>

	{#if open}
		<ul
			role="listbox"
			aria-label={ariaLabel}
			class="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border-2 border-ink-200 bg-white py-1 shadow-lg dark:border-ink-700 dark:bg-ink-900"
		>
			{#each coins as a (a.ticker)}
				<li role="option" aria-selected={value === a.ticker}>
					<button
						type="button"
						onclick={() => choose(a.ticker)}
						class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-ink-100 dark:hover:bg-ink-800 {value ===
						a.ticker
							? 'bg-ink-100 font-medium dark:bg-ink-800'
							: ''}"
					>
						<img
							src={a.logoSvgPath}
							alt=""
							loading="lazy"
							decoding="async"
							width="20"
							height="20"
							class="h-5 w-5 shrink-0 rounded-full"
						/>
						<span>{a.displayName} <span class="opacity-60">({a.displayTicker})</span></span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
