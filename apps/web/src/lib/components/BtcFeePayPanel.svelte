<script lang="ts">
	/**
	 * BtcFeePayPanel — "pay the listing fee" for an order that has its OWN
	 * Bitcoin fee address (v1.20.0, MK-H2).
	 *
	 * Once the release op pins the treasury xpub, a BTC-fee order is posted
	 * first (no transaction ID to paste) and then paid to an address made for
	 * that one listing. This panel:
	 *   1. waits for the user's indexer to report the order's address index
	 *      (the order op must become irreversible first — about a minute);
	 *   2. re-derives the address from the CHAIN-verified xpub and shows it only
	 *      if it matches what the indexer said ($lib/orders/btcFeeAddress);
	 *   3. keeps checking, and tells the user when the payment is on its way,
	 *      received, and when the order is live.
	 * The indexer watches the address (externalFeeRecheck); nothing here talks
	 * to a Bitcoin explorer, so the user's IP is never linked to the address.
	 *
	 * Used on the post-success card and on My orders.
	 */
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import type { OrderRecord } from '@morphit/indexer-client';
	import { chainPinnedTreasury, initRelease, release } from '$stores/release';
	import { getOrdersByAccount } from '$lib/indexer/client';
	import { checkIndexerFeeAddress, satsToBtc } from '$lib/orders/btcFeeAddress';
	import { loadPinnedBtcXpubs } from '$lib/orders/btcFeeKeyHistory';
	import { checkFeeNow, crossCheckFeeAddress, type FeeCrossCheck } from '$lib/orders/btcFeeCheck';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import QrPanel from '$lib/components/QrPanel.svelte';
	import StatusLine from '$lib/components/StatusLine.svelte';
	import type { AddressPayload } from '$lib/chat/payload';

	interface Props {
		account: string;
		permlink: string;
		/** The order as already fetched (My orders); omitted on the post
		 *  success card, where the panel fetches it itself. */
		order?: OrderRecord | null;
		/** Called when the fee is confirmed (the order is now live). */
		onpaid?: () => void;
	}

	let { account, permlink, order = null, onpaid }: Props = $props();

	let fetched = $state<OrderRecord | null>(null);
	let qrShown = $state(false);
	/** No address after a few minutes: the order was most likely refused
	 *  (e.g. the daily limit of BTC-fee listings). Nothing has been paid at
	 *  that point, so say so plainly instead of spinning forever. */
	let slow = $state(false);
	const current = $derived(fetched ?? order);

	/** (V3-10) Treasury keys @morphit pinned on chain, loaded only when this
	 *  order was numbered under a key that is no longer the current pin. */
	let pastKeys = $state<ReadonlySet<string> | null>(null);
	const check = $derived.by(() => {
		const o = current;
		if (o === null || o.btc_fee === undefined) return null;
		return checkIndexerFeeAddress($chainPinnedTreasury, o.btc_fee, {
			...(pastKeys !== null ? { verifiedXpubs: pastKeys } : {})
		});
	});
	$effect(() => {
		if (check !== null && !check.ok && check.reason === 'unverified_key' && pastKeys === null) {
			void loadPinnedBtcXpubs().then((keys) => (pastKeys = keys));
		}
	});
	/** (V3-5) Did other instances give this order the same address? Asked once
	 *  the address is known and checks out here; 'disagree' hides it. */
	let peerCheck = $state<FeeCrossCheck | null>(null);
	let peerCheckAsked = false;
	$effect(() => {
		if (check !== null && check.ok && !peerCheckAsked) {
			peerCheckAsked = true;
			void crossCheckFeeAddress(account, permlink).then((v) => (peerCheck = v));
		}
	});
	/** (V3-3) "I've paid — check now". */
	let checkingNow = $state(false);
	let checkAgainAt = $state(0);
	let nowTick = $state(Date.now());
	async function checkNow(): Promise<void> {
		if (checkingNow || Date.now() < checkAgainAt) return;
		checkingNow = true;
		try {
			const r = await checkFeeNow(account, permlink);
			if (r !== null) {
				checkAgainAt = Date.now() + r.retryAfterS * 1000;
				await refresh();
				if (current?.fee_status === 'verified') onpaid?.();
			}
		} finally {
			checkingNow = false;
		}
	}
	$effect(() => {
		if (checkAgainAt <= nowTick) return;
		const t = setInterval(() => (nowTick = Date.now()), 1000);
		return () => clearInterval(t);
	});
	const waitS = $derived(Math.max(0, Math.ceil((checkAgainAt - nowTick) / 1000)));
	const paid = $derived(current?.fee_status === 'verified');

	const qrPayload = $derived.by((): AddressPayload | null => {
		const c = check;
		if (c === null || !c.ok) return null;
		return {
			method: 'btc',
			address: c.address,
			...(c.remainingSats > 0 ? { amount: c.amountBtc } : {})
		} as AddressPayload;
	});

	async function refresh(): Promise<void> {
		const r = await getOrdersByAccount(account, { limit: 100 });
		if (!r.ok) return;
		const found = r.data.items.find((o) => o.permlink === permlink);
		if (found !== undefined) fetched = found;
	}

	onMount(() => {
		void initRelease();
		// Fast while waiting for the address (it appears ~1 min after posting),
		// then slower while waiting for the Bitcoin payment to confirm.
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const slowTimer = setTimeout(() => (slow = true), 5 * 60_000);
		const tick = async (): Promise<void> => {
			if (stopped) return;
			await refresh();
			if (stopped) return;
			if (current?.fee_status === 'verified') {
				onpaid?.();
				return;
			}
			const haveAddress = current?.btc_fee !== undefined;
			timer = setTimeout(() => void tick(), haveAddress ? 60_000 : 15_000);
		};
		if (current?.btc_fee === undefined || current.fee_status !== 'verified') void tick();
		return () => {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			clearTimeout(slowTimer);
		};
	});
</script>

<section class="card mb-4 text-left" aria-labelledby="btc-fee-pay-{permlink}">
	<h3 id="btc-fee-pay-{permlink}" class="mb-2 font-display text-lg font-bold">
		{$_('btc_fee_pay.heading')}
	</h3>

	{#if paid}
		<StatusLine kind="ok">{$_('btc_fee_pay.paid')}</StatusLine>
	{:else if current === null || current.btc_fee === undefined}
		<StatusLine kind="loading">{$_('btc_fee_pay.waiting_address')}</StatusLine>
		{#if slow}
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">{$_('btc_fee_pay.slow')}</p>
		{/if}
	{:else if $chainPinnedTreasury === null && $release.kind === 'error'}
		<!-- The chain-verified release (source of the xpub) could not be read,
		     so the address cannot be double-checked: never show it unchecked. -->
		<StatusLine kind="error">{$_('btc_fee_pay.mismatch')}</StatusLine>
	{:else if $chainPinnedTreasury === null}
		<StatusLine kind="loading">{$_('btc_fee_pay.checking')}</StatusLine>
	{:else if check !== null && !check.ok && check.reason === 'unverified_key' && pastKeys === null}
		<StatusLine kind="loading">{$_('btc_fee_pay.checking')}</StatusLine>
	{:else if check !== null && !check.ok}
		<StatusLine kind="error">{$_('btc_fee_pay.mismatch')}</StatusLine>
	{:else if check !== null && check.ok && peerCheck === null}
		<StatusLine kind="loading">{$_('btc_fee_pay.checking')}</StatusLine>
	{:else if check !== null && check.ok && peerCheck === 'disagree'}
		<!-- (V3-5) Another Morphit instance numbered this order differently: this
		     server's copy of the chain may be off. Paying could fund someone
		     else's listing, so no address is shown. -->
		<p class="text-sm text-ink-700 dark:text-ink-200">{$_('btc_fee_pay.peer_disagrees')}</p>
	{:else if check !== null && check.ok}
		<p class="mb-3 text-sm text-ink-600 dark:text-ink-300">{$_('btc_fee_pay.intro')}</p>

		{#if check.remainingSats > 0}
			<p class="mb-2 text-sm font-semibold">
				{$_('btc_fee_pay.amount', { values: { amount: check.amountBtc } })}
			</p>
		{/if}

		<p class="mb-1 text-xs text-ink-500">{$_('btc_fee_pay.address_label')}</p>
		<code
			class="mb-3 block w-full break-all rounded-lg border border-ink-300 bg-ink-50 px-3 py-2 font-mono text-sm dark:border-ink-700 dark:bg-ink-900"
		>
			{check.address}
		</code>

		<div class="mb-3 flex flex-wrap gap-2">
			<CopyButton
				value={check.address}
				label={$_('btc_fee_pay.copy')}
				class="rounded-md border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-ink-50 dark:border-ink-600 dark:bg-ink-800 dark:hover:bg-ink-700"
				idleColorClass="text-ink-700 dark:text-ink-100"
			/>
			<button
				type="button"
				onclick={() => (qrShown = !qrShown)}
				class="rounded-md border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50 dark:border-ink-600 dark:bg-ink-800 dark:text-ink-100 dark:hover:bg-ink-700"
				aria-expanded={qrShown}
			>
				{qrShown
					? $_('post_order.fee_method.fee_address_hide_qr')
					: $_('post_order.fee_method.fee_address_show_qr')}
			</button>
			<a
				href={check.uri}
				class="rounded-md border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50 dark:border-ink-600 dark:bg-ink-800 dark:text-ink-100 dark:hover:bg-ink-700"
			>
				{$_('btc_fee_pay.open_wallet')}
			</a>
		</div>

		{#if qrShown && qrPayload !== null}
			<div class="mb-3"><QrPanel payload={qrPayload} /></div>
		{/if}

		{#if check.receivedSats > 0 && check.remainingSats > 0}
			<p class="mb-2 text-sm">
				{$_('btc_fee_pay.received_partial', { values: { amount: satsToBtc(check.receivedSats) } })}
			</p>
		{/if}
		{#if check.remainingSats === 0}
			<StatusLine kind="loading">{$_('btc_fee_pay.all_sent')}</StatusLine>
		{:else if check.unconfirmedSats > 0}
			<StatusLine kind="loading">
				{$_('btc_fee_pay.on_its_way', { values: { amount: satsToBtc(check.unconfirmedSats) } })}
			</StatusLine>
		{/if}

		<div class="mt-3">
			<button
				type="button"
				onclick={checkNow}
				disabled={checkingNow || waitS > 0}
				class="rounded-md border border-ink-300 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-60 dark:border-ink-600 dark:bg-ink-800 dark:text-ink-100 dark:hover:bg-ink-700"
			>
				{checkingNow
					? $_('btc_fee_pay.checking_now')
					: waitS > 0
						? $_('btc_fee_pay.check_again_in', { values: { seconds: waitS } })
						: $_('btc_fee_pay.check_now')}
			</button>
		</div>

		<p class="mt-3 text-xs text-ink-500 dark:text-ink-400">{$_('btc_fee_pay.when_live')}</p>
	{/if}
</section>
