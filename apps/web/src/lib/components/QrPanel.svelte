<script lang="ts">
	/**
	 * QrPanel — renders a payment URI as a scannable QR code.
	 *
	 * Phase F.2 (QR scanning UX): the buyer scans the seller's
	 * desktop screen with their mobile wallet's QR scanner.  The
	 * URI encoded in the QR carries the address + (optional)
	 * amount in the asset's native URI scheme:
	 *
	 *   - BTC:  BIP-21 (`bitcoin:bc1q...?amount=0.005`)
	 *   - XMR:  official URI scheme (`monero:4...?tx_amount=0.5`)
	 *   - BCH:  CashAddr (`bitcoincash:q...?amount=0.5`)
	 *   - LTC:  BIP-21 derivative (`litecoin:ltc1...?amount=0.5`)
	 *   - DASH: BIP-21 derivative (`dash:X...?amount=0.5`)
	 *   - BLURT: bare account name (no widely-supported scheme)
	 *   - USDT: no widely-supported single URI scheme across the four
	 *          networks Morphit ships (ERC-20/TRC-20/SPL/BEP-20); the
	 *          QR encodes the bare address and the network is
	 *          conveyed out-of-band in the chat-side network pill.
	 *
	 * Canonical reference for the per-asset URI shape is
	 * `buildPaymentUri` in `apps/web/src/lib/chat/payload.ts` —
	 * that function is authoritative; this comment block is a
	 * summary, not a contract.
	 *
	 * Lazy-loaded library: `qrcode` (~30kB).  The dynamic import
	 * keeps it out of even the chat chunk; users who never tap
	 * "Show QR" don't pay the bytes.
	 *
	 * Render style: SVG injected as innerHTML.  SVG is
	 * resolution-independent (sharp on any zoom), small (no PNG
	 * encoding overhead), and parses fast in browsers.
	 *
	 * White background + ~10% padding is non-negotiable for
	 * scan reliability — the buyer's wallet camera needs a
	 * clean quiet zone and high contrast.
	 */

	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { buildPaymentUri, type AddressPayload } from '$lib/chat/payload';

	interface Props {
		/** The payload whose address (and optional amount) becomes
		 *  the QR contents. */
		payload: AddressPayload;
	}

	let { payload }: Props = $props();

	/** Computed URI — re-derived if payload changes (e.g. user
	 *  edits an in-flight payload, though that doesn't happen in
	 *  current UI; here for correctness). */
	const uri = $derived(buildPaymentUri(payload));

	let svg = $state<string | null>(null);
	// Boolean-only — used for truthy gating; visible message is
	// pulled from i18n at the render site, not from this var.
	let error = $state<boolean>(false);

	/** Render the QR.  Called on mount and when uri changes.
	 *  Lazy-imports the library; tolerates the import failing
	 *  (e.g. user hasn't installed deps in development) by
	 *  surfacing a fallback message rather than crashing. */
	async function render(): Promise<void> {
		error = false;
		svg = null;
		try {
			const qr = await import('qrcode');
			const out = await qr.toString(uri, {
				type: 'svg',
				errorCorrectionLevel: 'M',
				margin: 2
			});
			svg = out;
		} catch (err) {
			console.warn('[QrPanel] qr render failed:', err);
			error = true;
		}
	}

	onMount(() => {
		void render();
	});

	// Re-render if the payload's URI changes during the panel's
	// lifetime.  $effect runs after onMount too — use a guard so
	// we don't double-render on the initial mount.
	let firstRun = true;
	$effect(() => {
		// Touch uri to register the dependency.
		void uri;
		if (firstRun) {
			firstRun = false;
			return;
		}
		void render();
	});
</script>

<div class="qr-panel">
	{#if error}
		<p class="text-xs text-red-700 dark:text-red-300">
			{$_('chat.address.qr_error')}
		</p>
	{:else if svg !== null}
		<!-- SVG injection: trusted source (qrcode library output)
		     and the inputs (address regex-validated, amount
		     regex-validated) prevent any user-controlled HTML/JS
		     from reaching the DOM here.  The library generates
		     pure <svg><rect>…</rect></svg> markup. -->
		<div class="qr-svg" aria-label={$_('chat.address.qr_aria') as string}>
			{@html svg}
		</div>
	{:else}
		<div class="qr-skeleton" aria-busy="true">
			<span class="text-xs text-ink-500">{$_('chat.address.qr_loading')}</span>
		</div>
	{/if}
</div>

<style>
	.qr-panel {
		/* White card around the QR — high contrast is critical for
		   scan reliability across lighting conditions.  The
		   surrounding bubble may be emerald/ink-tinted; this card
		   isolates the QR. */
		background: white;
		padding: 0.75rem;
		border-radius: 0.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		aspect-ratio: 1;
		max-width: 280px;
		margin: 0 auto;
	}

	.qr-svg :global(svg) {
		width: 100%;
		height: 100%;
		display: block;
	}

	.qr-skeleton {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		min-height: 200px;
	}
</style>
