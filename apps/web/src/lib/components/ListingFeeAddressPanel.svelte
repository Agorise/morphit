<script lang="ts">
	/**
	 * ListingFeeAddressPanel — renders the canonical BTC/XMR fee
	 * address to the user with copy button and optional QR code.
	 *
	 * Part 106 of the audit campaign closed a real fork-attack
	 * vulnerability in the listing-fee path: pre-Part-106, the
	 * UI text said "send to our address" but never displayed the
	 * address itself, leaving the operator free to social-
	 * engineer a hostile address into the user's flow.  This
	 * component closes that gap by rendering the address
	 * authoritatively, with a "chain-pinned by @morphit" badge
	 * when the value comes from a signed release op.
	 *
	 * **Part 107 privacy correction**: the XMR view-key
	 * disclosure that the initial Part 106 design included has
	 * been REMOVED.  The view key is operator-private and is
	 * never published anywhere — not on chain, not in this UI,
	 * not in any API response.  Users who want to verify their
	 * incoming XMR payment can do so with the standard tools
	 * (Monero CLI/GUI's `prove_key` / payment-proof flow), not
	 * by being given the treasury's view key.
	 *
	 * Two-source resolution (mirrors the indexer's TreasurySource):
	 *
	 *   1. Chain-pinned — the most recent signed `morphit_release_v1`
	 *      op's `treasury` block, validated by
	 *      releaseValidate.validateTreasury() on the way in.
	 *      Renders with a "chain-pinned by @morphit" badge.
	 *
	 *   2. Local fallback — when no chain-pin is present, the
	 *      indexer's env-var address may be served via /v1/release
	 *      with a flag (future enhancement; today we only render
	 *      the chain-pinned form).  When neither is available,
	 *      the component renders the "fee_address_unavailable"
	 *      message and the parent should disable the BTC/XMR
	 *      radio button.
	 *
	 * Reuses the existing QrPanel for QR rendering — the BIP-21 /
	 * Monero URI building lives in `$lib/chat/payload.ts`.
	 */

	import { _ } from 'svelte-i18n';
	import { chainPinnedTreasury } from '$stores/release';
	import { MORPHIT_ACCOUNT } from '$net/config';
	import QrPanel from '$lib/components/QrPanel.svelte';
	import type { AddressPayload } from '$lib/chat/payload';

	interface Props {
		/** Which fee asset is the user paying with. */
		method: 'btc' | 'xmr';
	}

	let { method }: Props = $props();

	let qrShown = $state(false);
	let copyAddrFlash = $state(false);

	/** The canonical address + amount for the chosen method,
	 *  resolved from the chain-pinned treasury block.  Null when
	 *  no chain-pin is available (operator hasn't broadcast a
	 *  release op with a treasury for this asset).
	 *
	 *  The amount field is rendered for user convenience; the
	 *  indexer's verification still enforces the EXACT amount
	 *  (in the asset's smallest unit), so under/overpayment
	 *  still rejects regardless of what the QR / display shows. */
	const resolved = $derived.by(() => {
		const t = $chainPinnedTreasury;
		if (t === null) return null;
		if (method === 'btc') {
			if (t.btc === null) return null;
			// Convert satoshis to BTC for display.  Use a fixed
			// 8-decimal repr to avoid any "0.00001" float drift.
			const btc = (t.btc.satoshis / 100_000_000).toFixed(8);
			return {
				method,
				address: t.btc.address,
				amount: btc,
				satoshis: t.btc.satoshis
			};
		}
		// xmr
		if (t.xmr === null) return null;
		// Convert piconero string (which can exceed Number range
		// safely as a string) to XMR fixed-12.  Use BigInt to
		// keep precision through the divide.
		const piconeroBig = BigInt(t.xmr.piconero);
		const xmrIntegerPart = piconeroBig / 1_000_000_000_000n;
		const xmrFractionalPart = piconeroBig % 1_000_000_000_000n;
		const fracStr = xmrFractionalPart.toString().padStart(12, '0').replace(/0+$/, '');
		const xmrStr = fracStr.length > 0 ? `${xmrIntegerPart}.${fracStr}` : `${xmrIntegerPart}`;
		return {
			method,
			address: t.xmr.address,
			amount: xmrStr,
			satoshis: undefined as number | undefined
		};
	});

	/** Payload for QrPanel.  AddressPayload's `method` accepts the
	 *  full ChatAssetTicker union ('btc' | 'xmr' | 'blurt' | 'usdt'
	 *  | 'usdc' | 'dai' | 'bch' | 'ltc' | 'dash' | 'doge' | 'zec' — see
	 *  apps/web/src/lib/chat/payload.ts as the canonical source)
	 *  — but listing fees can only be paid in BTC/XMR/BLURT per
	 *  the Memory #23 fee_method-frozen invariant.  We only ever
	 *  produce method ∈ {'btc', 'xmr'} from this panel (BLURT
	 *  goes through a separate Pay-Now flow). */
	const qrPayload = $derived.by((): AddressPayload | null => {
		if (resolved === null) return null;
		// AddressPayload has slightly more shape than we strictly
		// need (orderPermlink, note, memo) — those are chat-trade
		// concepts; for listing fees we just need address +
		// amount.  The chat payload type accepts these as
		// optional, so we pass undefined for the chat-only
		// fields.
		return {
			method: resolved.method,
			address: resolved.address,
			amount: resolved.amount,
			orderPermlink: undefined,
			note: undefined,
			memo: undefined
		} as AddressPayload;
	});

	async function copyAddress(): Promise<void> {
		if (resolved === null) return;
		try {
			await navigator.clipboard.writeText(resolved.address);
			copyAddrFlash = true;
			setTimeout(() => {
				copyAddrFlash = false;
			}, 1200);
		} catch {
			// Clipboard API not available (insecure context, very
			// old browser).  Silent — the user can long-press to
			// copy from the rendered address text.
		}
	}

	function toggleQr(): void {
		qrShown = !qrShown;
	}
</script>

{#if resolved === null}
	<section class="card mb-4 border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30">
		<p class="text-sm text-amber-800 dark:text-amber-200">
			{$_('post_order.fee_method.fee_address_unavailable', {
				values: { asset: method.toUpperCase() }
			})}
		</p>
	</section>
{:else}
	<section class="card mb-4">
		<h2 class="mb-3 font-display text-lg font-bold">
			{#if method === 'btc'}
				{$_('post_order.fee_method.fee_address_heading_btc')}
			{:else}
				{$_('post_order.fee_method.fee_address_heading_xmr')}
			{/if}
		</h2>

		<!-- Address (selectable, monospaced, breakable for long XMR addresses) -->
		<div class="mb-3">
			<code
				class="block w-full break-all rounded-lg border border-ink-300 bg-ink-50 px-3 py-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-900"
				aria-label={method === 'btc'
					? $_('post_order.fee_method.fee_address_heading_btc')
					: $_('post_order.fee_method.fee_address_heading_xmr')}
			>
				{resolved.address}
			</code>
		</div>

		<!-- Amount line -->
		<p class="mb-3 text-sm text-ink-600 dark:text-ink-300">
			{#if method === 'btc'}
				{$_('post_order.fee_method.fee_address_amount_btc', {
					values: { amount: resolved.amount, sats: resolved.satoshis ?? 0 }
				})}
			{:else}
				{$_('post_order.fee_method.fee_address_amount_xmr', {
					values: { amount: resolved.amount }
				})}
			{/if}
		</p>

		<!-- Action buttons: copy + show QR -->
		<div class="mb-3 flex flex-wrap gap-2">
			<button
				type="button"
				onclick={copyAddress}
				class="rounded-md border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50 dark:border-ink-600 dark:bg-ink-800 dark:text-ink-100 dark:hover:bg-ink-700"
			>
				{copyAddrFlash
					? $_('post_order.fee_method.fee_address_copied')
					: $_('post_order.fee_method.fee_address_copy')}
			</button>
			<button
				type="button"
				onclick={toggleQr}
				class="rounded-md border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50 dark:border-ink-600 dark:bg-ink-800 dark:text-ink-100 dark:hover:bg-ink-700"
				aria-expanded={qrShown}
			>
				{qrShown
					? $_('post_order.fee_method.fee_address_hide_qr')
					: $_('post_order.fee_method.fee_address_show_qr')}
			</button>
		</div>

		{#if qrShown && qrPayload !== null}
			<div class="mb-3">
				<QrPanel payload={qrPayload} />
			</div>
		{/if}

		<!-- Chain-pinned badge.  When chainPinnedTreasury is non-
		     null AND came from a signed release op, the
		     authenticity is verified.  We show this unconditionally
		     for the chain-pinned path because the resolved object
		     wouldn't be populated without it (today; if env-fallback
		     is ever surfaced via /v1/release, gate this on a flag). -->
		<p
			class="mt-2 text-xs text-ink-500 dark:text-ink-400"
			aria-label={$_('post_order.fee_method.fee_address_chain_pinned_aria')}
		>
			✓ {$_('post_order.fee_method.fee_address_chain_pinned', {
				values: { account: MORPHIT_ACCOUNT }
			})}
		</p>
	</section>
{/if}
