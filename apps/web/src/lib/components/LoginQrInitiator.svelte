<script lang="ts">
	import { page } from '$app/stores';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, type LocaleCode } from '$i18n/locales';
	/**
	 * LoginQrInitiator (ADR-0022).
	 *
	 * Desktop-side UI for QR-based sign-in.  Renders a fresh QR
	 * code, opens an SSE wait connection, and on receiving a
	 * verified pairing bundle from the user's phone, completes
	 * the session and navigates home.
	 *
	 * Lifecycle:
	 *   1. Mount → start pairing session → render QR
	 *   2. Countdown to expiry (5 minutes) — visible to user
	 *   3. On 'received' → boot paired-readonly session +
	 *      success card + auto-navigate
	 *   4. On 'expired' → "QR expired, generate a new one" CTA
	 *   5. On 'rejected' → "couldn't verify the sign-in"
	 *      (generic message; don't leak which gate failed)
	 *   6. On unmount or user cancel → close SSE, abort
	 *
	 * Grandma-friendly choices:
	 *   - QR is large (224px @ 1x, scales fluidly).
	 *   - Big "expires in N seconds" countdown so an attacker
	 *     showing a stale screenshot is visibly suspicious.
	 *   - "Or type a 6-word phrase" fallback for users without
	 *     a working phone QR scanner.
	 *   - Refresh-when-expired is one tap, no scary error
	 *     dialogs.
	 *
	 * Session model (ADR-0022 — read-only desktop session, chosen
	 * over phone-mediated remote signing and on-chain subkey
	 * delegation; see ADR-0022 §"Why this design"):
	 *
	 *   The verifier (pairingClient.defaultVerifier) proves to the
	 *   desktop that the bundle was signed by the account's on-
	 *   chain posting key.  That proof is what `received` represents.
	 *   We turn `received` into a paired-readonly session via
	 *   bootFromPairedSession() in $stores/identity: the desktop
	 *   becomes signed-in for READ purposes (orderbook, profile,
	 *   chat history, settings the user can view) but CANNOT sign
	 *   Morphit ops on this device.  Posting key stays on the
	 *   phone, which is the strong privacy property ADR-0022 set
	 *   out to preserve.
	 *
	 *   Write ops (post order, send chat message, leave feedback,
	 *   share address, etc.) check $isUnlocked — which is false
	 *   under paired-readonly — and render a "use Morphit on your
	 *   phone" affordance instead of a sign-in nudge.
	 */

	import { onMount, onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { goto } from '$app/navigation';
	import { startPairingSession, type PairingState } from '$lib/auth/pairingClient';
	import { bootFromPairedSession } from '$stores/identity';
	import { setUserBlurtAccount } from '$blurt/ops/profile';

	let pairingState = $state<PairingState>({ kind: 'starting' });
	let qrSvg = $state<string | null>(null);
	// Boolean-only — the raw text was never rendered (gated by
	// truthiness, with the visible message coming from i18n at
	// the render site).  Keeping it boolean prevents accidental
	// regression to raw-text leakage and matches the pattern the
	// i18n-raw-exception-smoke enforces.
	let qrError = $state<boolean>(false);
	let secondsRemaining = $state<number>(0);
	let abortController: AbortController | null = null;
	let countdownTimer: ReturnType<typeof setInterval> | null = null;
	/** Pairing ID, captured during awaiting_phone so we can stash it
	 *  on the paired-readonly session record after `received`.
	 *  PairingState.received doesn't include pid in its public shape,
	 *  but we own this component's state and can keep our own
	 *  reference.  Reset on each fresh startSession(). */
	let capturedPairingId: string | null = null;

	async function renderQr(text: string): Promise<void> {
		try {
			const qr = await import('qrcode');
			qrSvg = await qr.toString(text, {
				type: 'svg',
				errorCorrectionLevel: 'M',
				margin: 2
			});
		} catch (err) {
			console.warn('[LoginQrInitiator] qr render failed:', err);
			qrError = true;
		}
	}

	function startCountdown(expSeconds: number): void {
		if (countdownTimer !== null) clearInterval(countdownTimer);
		const tick = (): void => {
			const remaining = expSeconds - Math.floor(Date.now() / 1000);
			secondsRemaining = remaining > 0 ? remaining : 0;
			if (remaining <= 0 && countdownTimer !== null) {
				clearInterval(countdownTimer);
				countdownTimer = null;
			}
		};
		tick();
		countdownTimer = setInterval(tick, 1000);
	}

	async function startSession(): Promise<void> {
		// Reset transient UI state.
		qrSvg = null;
		qrError = false;
		secondsRemaining = 0;
		capturedPairingId = null;
		abortController?.abort();
		abortController = new AbortController();

		await startPairingSession({
			origin: window.location.origin,
			nowSeconds: Math.floor(Date.now() / 1000),
			signal: abortController.signal,
			onState: (s) => {
				pairingState = s;
				if (s.kind === 'awaiting_phone') {
					// Capture pid for stashing on the paired-readonly
					// session after a successful `received`.
					capturedPairingId = s.qr.pid;
					void renderQr(s.compactWire);
					startCountdown(s.expSeconds);
				}
			}
		});
	}

	function tryAgain(): void {
		void startSession();
	}

	onMount(() => {
		void startSession();
	});

	onDestroy(() => {
		abortController?.abort();
		if (countdownTimer !== null) clearInterval(countdownTimer);
	});

	// Boot a paired-readonly session as soon as the protocol verifier
	// reports `received` — see ADR-0022 §"Why this design".  The
	// pairing handshake's verifier has already proven the bundle was
	// signed by the account's on-chain posting key (chain RPC lookup
	// + signature recovery against the posting authority — see
	// pairingClient.defaultVerifier), so we can commit the verified
	// state to the identity store as a paired-readonly session.  No
	// signing material crosses the wire; the desktop becomes signed
	// in for READ but not WRITE.
	//
	// Defer the navigation slightly so the user sees the success card
	// (gives the verification a sense of weight before the page
	// changes).  Navigates to /orderbook — the canonical post-sign-in
	// landing, same destination as the posting-only import flow uses,
	// so the user lands in the same place regardless of which sign-in
	// method they chose.
	$effect(() => {
		if (pairingState.kind === 'received') {
			const account = pairingState.account;
			const chatPubkey = pairingState.chatPubkey;
			// Pull the pairingId off the active pairing state if it
			// was captured during awaiting_phone.  The PairingState
			// 'received' case doesn't include pairingId in the public
			// shape, so we keep our own reference.
			const pairingId = capturedPairingId;
			if (pairingId === null) {
				// Defensive — pairingId should always be captured by
				// the time we hit received.  If we somehow missed it,
				// fall back to a synthetic value rather than blocking
				// the session.  This is local-only state (not on chain,
				// not transmitted) so a synthetic id has no security
				// implication; it's just a cache key.
				console.warn(
					'[LoginQrInitiator] received without captured pairingId; using fallback'
				);
			}
			const session = {
				v: 1 as const,
				account,
				chatPubkey,
				pairingId: pairingId ?? `synthetic-${account}-${Math.floor(Date.now() / 1000)}`,
				pairedAt: Math.floor(Date.now() / 1000)
			};
			const booted = bootFromPairedSession(session);
			if (booted) {
				// Persist the account name so the rest of the app
				// (chat, profile, my-orders, etc.) recognises whose
				// session this is.  Same call the posting-only import
				// flow makes after a successful unlock.
				setUserBlurtAccount(account);
			}
			// Defer the nav slightly so the success card has a moment
			// to render.  Cleared on unmount so a fast page-leave
			// doesn't fire a navigation after we've gone.
			const t = setTimeout(() => {
				void goto(lp('/orderbook'));
			}, 1200);
			return () => clearTimeout(t);
		}
	});

	// Part 121 cp7 — per-locale internal-link wrapper.
	const currentLang = $derived(($page.data?.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const lp = $derived((path: string) => localePath(path, currentLang));
</script>

<section class="card mx-auto max-w-md">
	<header class="mb-4 text-center">
		<h1 class="font-display text-2xl font-extrabold leading-tight">
			{$_('login_qr.title')}
		</h1>
		<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
			{$_('login_qr.subtitle')}
		</p>
		<!--
			Read-only-mode hint (ADR-0022 read-only-desktop posture).
			QR pairing fully verifies the user's identity and establishes
			a paired-readonly session on this device — they can browse,
			read chat history, and view their profile.  Write ops (post
			order, send chat, leave feedback) still happen on the phone
			where the posting key lives.  Tell the user this up front so
			the experience matches expectation.
		-->
		<div
			class="mt-4 rounded-lg border border-morphit-emerald/30 bg-morphit-emerald/5 px-3 py-2 text-left text-xs text-morphit-teal dark:border-morphit-emerald/40 dark:text-morphit-emerald"
			role="note"
		>
			<p class="font-semibold">{$_('login_qr.readonly_heading')}</p>
			<p class="mt-1">{$_('login_qr.readonly_body')}</p>
		</div>
	</header>

	{#if pairingState.kind === 'starting'}
		<div class="py-8 text-center text-sm text-ink-500 dark:text-ink-400" aria-busy="true">
			{$_('login_qr.starting')}
		</div>
	{:else if pairingState.kind === 'awaiting_phone'}
		<div class="qr-frame mx-auto" aria-live="polite">
			{#if qrError}
				<p class="p-4 text-center text-sm text-red-700 dark:text-red-300">
					{$_('login_qr.qr_render_error')}
				</p>
			{:else if qrSvg !== null}
				<div class="qr-svg" aria-label={$_('login_qr.qr_aria') as string}>
					{@html qrSvg}
				</div>
			{:else}
				<div class="py-12 text-center text-sm text-ink-500 dark:text-ink-400">
					{$_('login_qr.qr_loading')}
				</div>
			{/if}
		</div>

		<p class="mt-4 text-center text-sm font-semibold text-ink-700 dark:text-ink-200">
			{$_('login_qr.scan_instruction')}
		</p>

		<p class="mt-2 text-center text-xs text-ink-500 dark:text-ink-400" aria-live="polite">
			{$_('login_qr.expires_in', { values: { seconds: secondsRemaining } })}
		</p>

		<div
			class="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-600 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-300"
		>
			<p class="font-semibold">{$_('login_qr.no_phone_scanner_heading')}</p>
			<p class="mt-1">{$_('login_qr.no_phone_scanner_body')}</p>
		</div>

		<div class="mt-4 text-center">
			<a
				href={lp('/login')}
				class="text-sm text-ink-500 underline hover:text-ink-700 dark:text-ink-400 dark:hover:text-ink-200"
			>
				{$_('login_qr.cancel')}
			</a>
		</div>
	{:else if pairingState.kind === 'received'}
		<div class="rounded-xl bg-morphit-emerald/10 p-4 text-center">
			<div class="text-3xl" aria-hidden="true">✓</div>
			<p class="mt-2 font-semibold text-morphit-emerald">
				{$_('login_qr.received_heading')}
			</p>
			<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
				{$_('login_qr.received_body', {
					values: { account: pairingState.account }
				})}
			</p>
		</div>
	{:else if pairingState.kind === 'expired'}
		<div class="rounded-xl bg-ink-50 p-4 text-center dark:bg-ink-800">
			<p class="font-semibold">{$_('login_qr.expired_heading')}</p>
			<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
				{$_('login_qr.expired_body')}
			</p>
			<button type="button" class="btn-primary mt-4" onclick={tryAgain}>
				{$_('login_qr.try_again')}
			</button>
		</div>
	{:else if pairingState.kind === 'rejected'}
		<div class="rounded-xl bg-red-50 p-4 text-center dark:bg-red-900/20">
			<p class="font-semibold text-red-700 dark:text-red-300">
				{$_('login_qr.rejected_heading')}
			</p>
			<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
				{$_('login_qr.rejected_body')}
			</p>
			<button type="button" class="btn-primary mt-4" onclick={tryAgain}>
				{$_('login_qr.try_again')}
			</button>
		</div>
	{:else if pairingState.kind === 'cancelled'}
		<div class="text-center text-sm text-ink-500 dark:text-ink-400">
			{$_('login_qr.cancelled')}
		</div>
	{/if}
</section>

<style>
	.qr-frame {
		background: white;
		padding: 1rem;
		border-radius: 0.75rem;
		max-width: 240px;
		aspect-ratio: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.qr-svg :global(svg) {
		width: 100%;
		height: 100%;
		display: block;
	}
</style>
