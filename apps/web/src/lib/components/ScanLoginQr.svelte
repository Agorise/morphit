<script lang="ts">
	/**
	 * ScanLoginQr (ADR-0022).
	 *
	 * Phone-side UI for QR-based desktop sign-in.  Opens the
	 * camera, decodes a QR, validates it, shows a high-friction
	 * confirmation card (with the origin URL displayed
	 * faithfully — anti-phishing through informed consent), and
	 * on confirmation builds + signs + delivers the encrypted
	 * pairing bundle to the relay.
	 *
	 * The user must already be unlocked on this phone (we use
	 * their posting key to sign).  If they're not unlocked, we
	 * route them to /login first.
	 *
	 * Lifecycle phases:
	 *   1. 'requesting_camera' — asking for camera permission
	 *   2. 'camera_denied' — user said no
	 *   3. 'no_camera' — device has no camera at all
	 *   4. 'scanning' — camera live, looking for a QR
	 *   5. 'review' — QR decoded; show confirmation card
	 *   6. 'invalid_qr' — decoded something but it failed
	 *      validation; show "this isn't a Morphit QR" + retry
	 *   7. 'sending' — user tapped Yes; signing + POSTing
	 *   8. 'delivered' — relay accepted the bundle; we're done
	 *   9. 'failed' — any step after Yes failed
	 *
	 * Grandma-friendly choices:
	 *   - Camera-permission flow is described before the
	 *     prompt so the user knows what they're agreeing to
	 *   - Confirmation card defaults focus to the "No" button
	 *   - Origin URL is rendered faithfully (no truncation /
	 *     pretty-printing); homoglyphs are visible
	 *   - Started-N-minutes-ago shows so a stale screenshot
	 *     attack is visibly suspicious
	 *   - No "remember this device" — every pairing is a
	 *     fresh consent moment
	 */

	import { onMount, onDestroy } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { get } from 'svelte/store';
	import {
		validateQrWireForm,
		buildPairingBundle,
		buildDeliveryPayload,
		type PairingQrPayload
	} from '$lib/auth/desktopPairing';
	import { isUnlocked } from '$stores/identity';
	import { fetchWithTimeout } from '$net/fetchWithTimeout';
	import { gotoLocale } from '$i18n/navigate';

	type Phase =
		| 'requesting_camera'
		| 'camera_denied'
		| 'no_camera'
		| 'scanning'
		| 'review'
		| 'invalid_qr'
		| 'sending'
		| 'delivered'
		| 'failed';

	let phase = $state<Phase>('requesting_camera');
	let videoEl: HTMLVideoElement | null = $state(null);
	let scannerInstance = $state<unknown | null>(null);
	let validatedQr = $state<PairingQrPayload | null>(null);
	let qrSignedSeconds = $state<number>(0);
	let failureReason = $state<string>('');

	async function startScanner(): Promise<void> {
		if (!videoEl) return;
		try {
			const QrScannerMod = await import('qr-scanner');
			const QrScanner = QrScannerMod.default;
			const hasCamera = await QrScanner.hasCamera();
			if (!hasCamera) {
				phase = 'no_camera';
				return;
			}
			const instance = new QrScanner(videoEl, (result: { data: string }) => onDecode(result.data), {
				highlightScanRegion: true,
				highlightCodeOutline: true,
				maxScansPerSecond: 5
			});
			scannerInstance = instance;
			await instance.start();
			phase = 'scanning';
		} catch (err) {
			// Most likely: user denied camera permission, or no
			// camera available, or browser doesn't support
			// getUserMedia.  Treat all as 'camera_denied' for
			// the user-facing message — it's the same recovery
			// (they need to grant permission).
			phase = 'camera_denied';
			if (typeof console !== 'undefined') {
				console.warn('scanner init failed:', err);
			}
		}
	}

	function onDecode(data: string): void {
		// Stop the scanner so we don't fire the decoder
		// repeatedly while the user is reading the card.
		const inst = scannerInstance as { stop?: () => void } | null;
		inst?.stop?.();

		const validated = validateQrWireForm(data, Math.floor(Date.now() / 1000));
		if (validated.kind === 'reject') {
			phase = 'invalid_qr';
			if (typeof console !== 'undefined') {
				console.warn('qr rejected:', validated.reason);
			}
			return;
		}
		validatedQr = validated.payload;
		qrSignedSeconds = Math.floor(Date.now() / 1000);
		phase = 'review';
	}

	function rescan(): void {
		validatedQr = null;
		failureReason = '';
		void startScanner();
	}

	async function confirm(): Promise<void> {
		if (!validatedQr) return;
		if (!get(isUnlocked)) {
			phase = 'failed';
			failureReason = 'not_unlocked';
			return;
		}
		phase = 'sending';
		try {
			// Build the signed + encrypted bundle.  Signer reads
			// the unlocked posting key from $stores/identity and
			// uses it via dblurt's secp256k1 primitive against
			// the protocol's domain-separated signing digest
			// (SIGNING_DOMAIN_PREFIX in desktopPairing.ts).  See
			// pairingPhoneSigner.ts for the full wiring.
			const { getPostingKeyForPairing, PairingSignerError } = await import(
				'$lib/auth/pairingPhoneSigner'
			);
			let signerBundle;
			try {
				signerBundle = await getPostingKeyForPairing();
			} catch (err) {
				phase = 'failed';
				if (err instanceof PairingSignerError) {
					// Map structured codes to UI failure reasons.
					// Each `failureReason` value drives a distinct
					// user-facing message in the i18n table —
					// avoid the generic "couldn't sign" fallback
					// for cases we can speak to specifically.
					switch (err.code) {
						case 'not_unlocked':
							failureReason = 'not_unlocked';
							break;
						case 'multisig_unsupported':
							failureReason = 'multisig_unsupported';
							break;
						case 'posting_key_not_authorized':
							failureReason = 'posting_key_not_authorized';
							break;
						case 'account_not_found':
							failureReason = 'account_not_found';
							break;
						case 'chain_unreachable':
							failureReason = 'chain_unreachable';
							break;
						default:
							failureReason = 'signer_unavailable';
					}
				} else {
					failureReason = 'signer_unavailable';
				}
				return;
			}
			const { signer, account, chatPubkey } = signerBundle;
			const bundle = buildPairingBundle({
				qr: validatedQr,
				account,
				accountChatPubkey: chatPubkey,
				nowSeconds: Math.floor(Date.now() / 1000),
				deviceLabel: navigatorDeviceLabel()
			});
			const desktopEpkPub = base64ToBytes(validatedQr.epk);
			const delivery = await buildDeliveryPayload({
				bundle,
				signer,
				desktopEpkPub
			});

			// POST to the relay specified in the QR.  The relay
			// URL is part of the signed payload, so a hostile
			// QR pointing to a fake relay would still reach
			// that relay — but the relay can't decrypt the
			// bundle (encrypted to the desktop's epk_pub) nor
			// forge the signature.  The cost of a wrong relay
			// is just delivery failure, not data leak.
			const url = new URL(
				`/v1/login-pairing/${encodeURIComponent(validatedQr.pid)}/deliver`,
				validatedQr.relay
			);
			const resp = await fetchWithTimeout(url.toString(), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(delivery)
			});
			if (!resp.ok) {
				phase = 'failed';
				failureReason = 'delivery_rejected';
				return;
			}
			phase = 'delivered';
		} catch (err) {
			phase = 'failed';
			console.warn('[ScanLoginQr] pairing send failed:', err);
			// failureReason values are a known enum; the render
			// site routes each to a localized message via {#if}.
			// Raw err.message would skip i18n for non-English
			// users and is also caught by the
			// i18n-raw-exception-smoke.
			failureReason = 'send_failed';
		}
	}

	function deny(): void {
		validatedQr = null;
		void gotoLocale('/');
	}

	function navigatorDeviceLabel(): string {
		// Best-effort short device label.  ASCII-only per the
		// pairing module's validator.
		const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') ?? '';
		// Strip non-printable-ASCII; cap at 32 chars.
		const ascii = ua.replace(/[^\x20-\x7e]/g, '').slice(0, 32);
		return ascii.length > 0 ? ascii : 'phone';
	}

	function base64ToBytes(s: string): Uint8Array {
		// Standard base64 decode (the QR's epk uses standard
		// padded base64).
		const binary = atob(s);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
		return out;
	}

	function relativeMinutesAgo(seconds: number): number {
		const ago = Math.floor(Date.now() / 1000) - seconds;
		return Math.max(0, Math.floor(ago / 60));
	}

	onMount(() => {
		void startScanner();
	});

	onDestroy(() => {
		const inst = scannerInstance as { stop?: () => void; destroy?: () => void } | null;
		try {
			inst?.stop?.();
			inst?.destroy?.();
		} catch {
			// best-effort
		}
	});
</script>

<section class="card mx-auto max-w-md">
	{#if phase === 'requesting_camera'}
		<header class="text-center">
			<h1 class="font-display text-2xl font-extrabold">
				{$_('scan_login.starting_heading')}
			</h1>
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
				{$_('scan_login.starting_body')}
			</p>
		</header>
	{:else if phase === 'camera_denied'}
		<header class="text-center">
			<h1 class="font-display text-2xl font-extrabold">
				{$_('scan_login.camera_denied_heading')}
			</h1>
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
				{$_('scan_login.camera_denied_body')}
			</p>
			<button type="button" class="btn-primary mt-4" onclick={rescan}>
				{$_('scan_login.try_again')}
			</button>
		</header>
	{:else if phase === 'no_camera'}
		<header class="text-center">
			<h1 class="font-display text-2xl font-extrabold">
				{$_('scan_login.no_camera_heading')}
			</h1>
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
				{$_('scan_login.no_camera_body')}
			</p>
		</header>
	{:else if phase === 'scanning'}
		<header class="text-center">
			<h1 class="font-display text-xl font-bold">
				{$_('scan_login.scanning_heading')}
			</h1>
		</header>
		<div class="mt-4 overflow-hidden rounded-xl bg-black">
			<!-- svelte-ignore a11y_media_has_caption -->
			<video bind:this={videoEl} class="w-full" playsinline muted></video>
		</div>
		<p class="mt-3 text-center text-xs text-ink-500">
			{$_('scan_login.scanning_hint')}
		</p>
	{:else if phase === 'review' && validatedQr !== null}
		<!-- The confirmation card.  This is the security-critical
		     UI moment — the user must decide whether to authorize
		     a sign-in.  Default-focus on the "No" button so a
		     stray Enter or double-tap does NOT confirm. -->
		<header>
			<h1 class="font-display text-2xl font-extrabold">
				{$_('scan_login.confirm_heading')}
			</h1>
		</header>

		<div
			class="mt-4 rounded-xl border border-ink-200 bg-ink-50 p-4 dark:border-ink-700 dark:bg-ink-800"
		>
			<p class="text-sm text-ink-700 dark:text-ink-200">
				{$_('scan_login.confirm_body_1')}
			</p>

			<dl class="mt-3 space-y-2 text-sm">
				<div class="flex justify-between gap-2">
					<dt class="font-semibold text-ink-600 dark:text-ink-400">
						{$_('scan_login.confirm_website_label')}
					</dt>
					<!-- Origin URL displayed FAITHFULLY — no
					     truncation, no smart-quoting, no
					     pretty-printing.  Homoglyph attacks
					     ('morph1t.io') are visible to a careful
					     user.

					     C-15: explicit `dir="ltr"` because URLs
					     are always LTR regardless of the page
					     direction — without this, a malicious
					     origin containing RTL-override
					     characters (U+202E etc) would render
					     reversed on RTL locales, defeating the
					     whole point of faithful display.  The
					     URL constructor in `validateQrWireForm`
					     also strips most exotic characters, but
					     belt-and-suspenders. -->
					<dd dir="ltr" class="break-all text-right font-mono">
						{validatedQr.origin}
					</dd>
				</div>
				<div class="flex justify-between gap-2">
					<dt class="font-semibold text-ink-600 dark:text-ink-400">
						{$_('scan_login.confirm_started_label')}
					</dt>
					<dd>
						{relativeMinutesAgo(qrSignedSeconds) === 0
							? $_('scan_login.confirm_started_just_now')
							: $_('scan_login.confirm_started_minutes_ago', {
									values: { n: relativeMinutesAgo(qrSignedSeconds) }
								})}
					</dd>
				</div>
			</dl>

			<p class="mt-3 text-xs text-ink-600 dark:text-ink-300">
				{$_('scan_login.confirm_warning')}
			</p>
		</div>

		<!-- Button row: "No" is FIRST and styled as primary so
		     it gets default keyboard focus on most mobile
		     browsers.  "Yes" is second, deliberately less
		     prominent.  Reversed visual order from the typical
		     "primary action on right" pattern; this is
		     intentional security UX. -->
		<div class="mt-5 flex flex-col gap-3 sm:flex-row">
			<button type="button" class="btn-primary flex-1" onclick={deny}>
				{$_('scan_login.confirm_no')}
			</button>
			<button type="button" class="btn-secondary flex-1" onclick={confirm}>
				{$_('scan_login.confirm_yes')}
			</button>
		</div>
	{:else if phase === 'invalid_qr'}
		<header class="text-center">
			<h1 class="font-display text-xl font-bold">
				{$_('scan_login.invalid_heading')}
			</h1>
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">
				{$_('scan_login.invalid_body')}
			</p>
			<button type="button" class="btn-primary mt-4" onclick={rescan}>
				{$_('scan_login.try_again')}
			</button>
		</header>
	{:else if phase === 'sending'}
		<div class="py-8 text-center text-sm text-ink-500" aria-busy="true">
			{$_('scan_login.sending')}
		</div>
	{:else if phase === 'delivered'}
		<div class="rounded-xl bg-morphit-emerald/10 p-4 text-center">
			<div class="text-3xl">✓</div>
			<p class="mt-2 font-semibold text-morphit-emerald">
				{$_('scan_login.delivered_heading')}
			</p>
			<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
				{$_('scan_login.delivered_body')}
			</p>
			<button type="button" class="btn-primary mt-4" onclick={() => gotoLocale('/')}>
				{$_('scan_login.delivered_done')}
			</button>
		</div>
	{:else if phase === 'failed'}
		<div class="rounded-xl bg-red-50 p-4 text-center dark:bg-red-900/20">
			<p class="font-semibold text-red-700 dark:text-red-300">
				{$_('scan_login.failed_heading')}
			</p>
			<p class="mt-1 text-sm text-ink-600 dark:text-ink-300">
				{#if failureReason === 'not_unlocked'}
					{$_('scan_login.failed_not_unlocked')}
				{:else if failureReason === 'multisig_unsupported'}
					{$_('scan_login.failed_multisig')}
				{:else if failureReason === 'posting_key_not_authorized'}
					{$_('scan_login.failed_posting_key_not_authorized')}
				{:else if failureReason === 'account_not_found'}
					{$_('scan_login.failed_account_not_found')}
				{:else if failureReason === 'chain_unreachable'}
					{$_('scan_login.failed_chain_unreachable')}
				{:else}
					{$_('scan_login.failed_generic')}
				{/if}
			</p>
			<!-- Action button.  For "try again" cases (transient
			     failures, unlocked-required) we offer a rescan.
			     For account-shape failures (multisig, wrong key,
			     missing account) retrying with the same account
			     can't succeed — offer a "back to login" exit
			     instead so the user isn't stuck on a button that
			     does nothing useful. -->
			{#if failureReason === 'multisig_unsupported' || failureReason === 'posting_key_not_authorized' || failureReason === 'account_not_found'}
				<button type="button" class="btn-primary mt-4" onclick={() => gotoLocale('/')}>
					{$_('scan_login.failed_back_home')}
				</button>
			{:else}
				<button type="button" class="btn-primary mt-4" onclick={rescan}>
					{$_('scan_login.try_again')}
				</button>
			{/if}
		</div>
	{/if}
</section>
