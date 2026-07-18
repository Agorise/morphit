<script lang="ts">
	/**
	 * RecipientQrScanner — cp424. A camera overlay that scans a QR code and
	 * returns a candidate Blurt recipient to the Send modal.
	 *
	 * Modeled on ScanLoginQr's camera handling: the camera is only started
	 * on an explicit user tap (mobile browsers surface the getUserMedia
	 * prompt only in response to a gesture, and starting the camera on a
	 * deliberate tap is the privacy-first default), and it is torn down on
	 * destroy.
	 *
	 * On decode the payload is UNTRUSTED: we extract only the account name
	 * (extractRecipientFromQr — never an amount or memo) and hand it back;
	 * the Send modal validates it (format + on-chain existence) exactly like
	 * a typed name. A QR that doesn't contain an account shows a retry, not
	 * a filled field.
	 */

	import { onDestroy, tick } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { extractRecipientFromQr } from '$blurt/qrRecipient';

	interface Props {
		/** A candidate recipient was decoded → the modal fills + validates it. */
		onScanned: (recipient: string) => void;
		/** Close the scanner without a result. */
		onClose: () => void;
	}

	let { onScanned, onClose }: Props = $props();

	type Phase = 'requesting_camera' | 'scanning' | 'camera_denied' | 'no_camera' | 'invalid';

	let phase = $state<Phase>('requesting_camera');
	let videoEl: HTMLVideoElement | null = $state(null);
	let scannerInstance = $state<unknown | null>(null);
	let cameraStarting = $state(false);

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
			phase = 'camera_denied';
			if (typeof console !== 'undefined') console.warn('recipient scanner init failed:', err);
		}
	}

	function stopScanner(): void {
		const inst = scannerInstance as { stop?: () => void; destroy?: () => void } | null;
		try {
			inst?.stop?.();
			inst?.destroy?.();
		} catch {
			// best-effort
		}
		scannerInstance = null;
	}

	function onDecode(data: string): void {
		// Stop first so we don't re-fire while transitioning.
		const inst = scannerInstance as { stop?: () => void } | null;
		inst?.stop?.();
		const candidate = extractRecipientFromQr(data);
		if (candidate.length === 0) {
			phase = 'invalid';
			return;
		}
		stopScanner();
		onScanned(candidate);
	}

	async function requestCamera(): Promise<void> {
		if (cameraStarting) return;
		cameraStarting = true;
		phase = 'scanning';
		await tick(); // let <video> bind before startScanner reads videoEl
		try {
			await startScanner();
		} finally {
			cameraStarting = false;
		}
	}

	function rescan(): void {
		void requestCamera();
	}

	function close(): void {
		stopScanner();
		onClose();
	}

	onDestroy(stopScanner);
</script>

<div
	class="fixed inset-0 z-[60] flex items-center justify-center bg-ink-950/85 p-4 backdrop-blur-sm"
	role="dialog"
	aria-modal="true"
	aria-labelledby="recipient-qr-heading"
	onclick={(e) => {
		if (e.target === e.currentTarget) close();
	}}
	onkeydown={(e) => {
		if (e.key === 'Escape') close();
	}}
	tabindex="-1"
>
	<div class="card max-h-[95dvh] overflow-y-auto overscroll-contain w-full max-w-md">
		<h2 id="recipient-qr-heading" class="font-display text-xl font-bold">
			{$_('profile.send.qr_heading')}
		</h2>

		{#if phase === 'requesting_camera'}
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">{$_('profile.send.qr_body')}</p>
			<div class="mt-5 flex justify-end gap-2">
				<button
					type="button"
					class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
					onclick={close}
				>
					{$_('common.cancel')}
				</button>
				<button
					type="button"
					class="rounded-lg bg-morphit-btn px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
					onclick={requestCamera}
					disabled={cameraStarting}
				>
					{$_('profile.send.qr_start_button')}
				</button>
			</div>
		{:else if phase === 'scanning'}
			<div class="mt-4 overflow-hidden rounded-xl bg-black">
				<!-- svelte-ignore a11y_media_has_caption -->
				<video bind:this={videoEl} class="w-full" playsinline muted></video>
			</div>
			<p class="mt-3 text-center text-xs text-ink-500 dark:text-ink-400">
				{$_('profile.send.qr_scanning_hint')}
			</p>
			<div class="mt-4 flex justify-end">
				<button
					type="button"
					class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
					onclick={close}
				>
					{$_('common.cancel')}
				</button>
			</div>
		{:else if phase === 'camera_denied'}
			<p class="mt-2 text-sm text-red-600 dark:text-red-400">{$_('profile.send.qr_camera_denied')}</p>
			<div class="mt-5 flex justify-end gap-2">
				<button
					type="button"
					class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
					onclick={close}
				>
					{$_('common.close')}
				</button>
				<button
					type="button"
					class="rounded-lg bg-morphit-btn px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
					onclick={rescan}
				>
					{$_('common.retry')}
				</button>
			</div>
		{:else if phase === 'no_camera'}
			<p class="mt-2 text-sm text-ink-600 dark:text-ink-300">{$_('profile.send.qr_no_camera')}</p>
			<div class="mt-5 flex justify-end">
				<button
					type="button"
					class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
					onclick={close}
				>
					{$_('common.close')}
				</button>
			</div>
		{:else if phase === 'invalid'}
			<p class="mt-2 text-sm text-red-600 dark:text-red-400">{$_('profile.send.qr_invalid')}</p>
			<div class="mt-5 flex justify-end gap-2">
				<button
					type="button"
					class="rounded-lg border border-ink-300 px-4 py-2 text-sm font-semibold hover:border-ink-400 dark:border-ink-700"
					onclick={close}
				>
					{$_('common.close')}
				</button>
				<button
					type="button"
					class="rounded-lg bg-morphit-btn px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
					onclick={rescan}
				>
					{$_('common.retry')}
				</button>
			</div>
		{/if}
	</div>
</div>
