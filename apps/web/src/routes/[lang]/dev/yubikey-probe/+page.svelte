<!--
	Morphit — WebHID YubiKey transport probe (DEV ONLY).

	Purpose: validate the byte-level USB feature-report frame layout
	in `apps/web/src/lib/crypto/yubikey/transport.ts` against a real
	YubiKey, WITHOUT risking the user's keystore.

	This page does NOT:
	  - Read or modify the persisted keystore.
	  - Decrypt anything.
	  - Persist anything to localStorage.

	This page DOES:
	  - Open a YubiKey via WebHID.
	  - Send a 64-byte HMAC-SHA1 challenge to the chosen slot.
	  - Display every byte sent and every byte received.
	  - Optionally: accept the slot's HMAC secret hex (entered live,
	    held only in memory, wiped on close), compute the expected
	    HMAC-SHA1 in software via the Web Crypto API, and show a
	    side-by-side comparison.

	Validation procedure for the maintainer:

	1. Configure your YubiKey's HMAC-SHA1 slot via the official
	    Yubico Authenticator desktop app, choosing a hex secret you
	    save somewhere ephemeral (you'll paste it here once for
	    verification).
	2. Open this page in Chrome / Edge / Brave.
	3. Pick the slot, enter the secret you configured, click Run.
	4. Observe: device → HMAC bytes match the software-computed HMAC
	    bytes? If yes, transport.ts is correct. If no, the byte log
	    above shows exactly which frame is wrong.
	5. Compare against `ykman otp calculate -H <challenge_hex>` from
	    a terminal for a third independent reference if needed.

	After validation passes, this route can stay (it's harmless) or
	be removed — the keystore flow uses the same transport code path,
	so once this works the production path works.
-->

<script lang="ts">
	import {
		isWebHidSupported,
		requestYubikey,
		type YubikeyDevice,
		type TransportLogEntry
	} from '$crypto/yubikey/transport';
	import { DEFAULT_YUBIKEY_SLOT, type YubikeySlot } from '$crypto/yubikey/protocol';

	let slot = $state<YubikeySlot>(DEFAULT_YUBIKEY_SLOT);
	let challengeHex = $state(
		// Default: a fixed all-zeroes challenge (16 hex chars repeated to 128 = 64 bytes).
		// Easy to compute the expected HMAC against in any reference tool.
		'0'.repeat(128)
	);
	let secretHex = $state('');
	let busy = $state(false);
	let phase = $state('');
	let errorMsg = $state('');
	let deviceLabel = $state('');

	// Outputs
	let yubikeyOutputHex = $state('');
	let softwareOutputHex = $state('');
	let comparisonResult = $state<'match' | 'mismatch' | null>(null);
	let logEntries = $state<TransportLogEntry[]>([]);

	const supported = $derived(isWebHidSupported());

	function hexToBytes(hex: string): Uint8Array {
		const clean = hex.replace(/\s+/g, '').toLowerCase();
		if (!/^[0-9a-f]*$/.test(clean)) throw new Error('hex contains non-hex characters');
		if (clean.length % 2 !== 0) throw new Error('hex has odd length');
		const out = new Uint8Array(clean.length / 2);
		for (let i = 0; i < out.length; i++) {
			out[i] = parseInt(clean.substr(i * 2, 2), 16);
		}
		return out;
	}

	function bytesToHex(bytes: Uint8Array): string {
		return Array.from(bytes)
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	}

	async function softwareHmacSha1(secret: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
		const cryptoKey = await crypto.subtle.importKey(
			'raw',
			secret as BufferSource,
			{ name: 'HMAC', hash: 'SHA-1' },
			false,
			['sign']
		);
		const sig = await crypto.subtle.sign('HMAC', cryptoKey, message as BufferSource);
		return new Uint8Array(sig);
	}

	async function runProbe(): Promise<void> {
		if (busy) return;
		busy = true;
		errorMsg = '';
		yubikeyOutputHex = '';
		softwareOutputHex = '';
		comparisonResult = null;
		logEntries = [];
		deviceLabel = '';

		let challenge: Uint8Array;
		try {
			challenge = hexToBytes(challengeHex);
			if (challenge.length !== 64) {
				throw new Error(`challenge must decode to exactly 64 bytes; got ${challenge.length}`);
			}
		} catch (err) {
			errorMsg = `Bad challenge hex: ${err instanceof Error ? err.message : String(err)}`;
			busy = false;
			return;
		}

		let secret: Uint8Array | null = null;
		if (secretHex.trim().length > 0) {
			try {
				secret = hexToBytes(secretHex);
				if (secret.length === 0 || secret.length > 64) {
					throw new Error(
						`secret should be 1–64 bytes; got ${secret.length} bytes (HMAC-SHA1 keys are typically 20 bytes)`
					);
				}
			} catch (err) {
				errorMsg = `Bad secret hex: ${err instanceof Error ? err.message : String(err)}`;
				busy = false;
				return;
			}
		}

		let device: YubikeyDevice | null = null;
		const logger = (entry: TransportLogEntry) => {
			logEntries = [...logEntries, entry];
		};

		try {
			phase = 'requesting device';
			device = await requestYubikey(slot, logger);
			deviceLabel = device.productName;
			phase = 'sending challenge — tap your YubiKey if it asks';
			const ykOutput = await device.hmac(challenge);
			yubikeyOutputHex = bytesToHex(ykOutput);

			if (secret) {
				phase = 'computing software HMAC';
				const swOutput = await softwareHmacSha1(secret, challenge);
				softwareOutputHex = bytesToHex(swOutput);
				comparisonResult =
					ykOutput.length === swOutput.length && ykOutput.every((b, i) => b === swOutput[i])
						? 'match'
						: 'mismatch';
			}
			phase = 'done';
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : String(err);
			phase = 'failed';
		} finally {
			// Wipe the binary form of the secret unconditionally —
			// even on the error path.  The string in the input field
			// is still in the DOM (user-visible by design); only the
			// derived binary form is wiped here.  Pre-Part-76 this
			// wipe was inside the success branch only, so an error
			// during requestYubikey/device.hmac/softwareHmacSha1 left
			// the bytes in the heap until GC.
			if (secret) {
				secret.fill(0);
			}
			if (device) {
				try {
					await device.close();
				} catch {
					// device.close() can fail if already removed.
				}
			}
			busy = false;
		}
	}

	function clearSecret(): void {
		secretHex = '';
	}

	function formatTimestamp(ts: number): string {
		const d = new Date(ts);
		return `${d.toLocaleTimeString()}.${String(d.getMilliseconds()).padStart(3, '0')}`;
	}
</script>

<svelte:head>
	<title>WebHID YubiKey probe — DEV ONLY</title>
	<meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="mx-auto max-w-4xl px-4 py-8">
	<header class="mb-6">
		<h1 class="font-display text-2xl font-bold">WebHID YubiKey transport probe</h1>
		<p class="mt-2 text-sm text-amber-700 dark:text-amber-400">
			⚠ Dev tool. This page does not touch your keystore. Use it to validate that the production
			transport speaks the right USB protocol to your YubiKey before binding a real keystore.
		</p>
	</header>

	{#if !supported}
		<div class="card text-ink-700 dark:text-ink-300">
			<p>
				Your browser doesn't support WebHID. Try Chrome, Edge, Brave, or another Chromium browser.
			</p>
		</div>
	{:else}
		<div class="card space-y-4">
			<fieldset>
				<legend class="text-sm font-semibold">Slot</legend>
				<div class="mt-2 flex gap-3">
					<label class="flex items-center gap-2 text-sm">
						<input type="radio" bind:group={slot} value={1} />
						<span>Slot 1</span>
					</label>
					<label class="flex items-center gap-2 text-sm">
						<input type="radio" bind:group={slot} value={2} />
						<span>Slot 2 (default for HMAC-SHA1)</span>
					</label>
				</div>
			</fieldset>

			<label class="block">
				<span class="block text-sm font-semibold">
					Challenge (hex, must decode to exactly 64 bytes — 128 hex chars)
				</span>
				<textarea
					bind:value={challengeHex}
					rows="2"
					class="mt-1 w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
				></textarea>
				<span class="text-xs text-ink-500 dark:text-ink-400">
					Default is 64 zero bytes. You can compare the YubiKey's output for this against `ykman otp
					calculate -H 0...` from your terminal.
				</span>
			</label>

			<label class="block">
				<span class="block text-sm font-semibold">
					Slot HMAC secret (hex, optional — typed live, NEVER persisted)
				</span>
				<input
					type="password"
					bind:value={secretHex}
					autocomplete="off"
					class="mt-1 w-full rounded-xl border-2 border-ink-200 bg-white px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-morphit-emerald dark:border-ink-700 dark:bg-ink-900"
					placeholder="Optional — paste the HMAC-SHA1 key you programmed into the slot"
				/>
				<span class="text-xs text-ink-500 dark:text-ink-400">
					When provided, this page computes HMAC-SHA1(secret, challenge) in software and compares it
					to the YubiKey's response. Without it, you'll see the YubiKey's output but won't have
					ground truth to compare against in this page (use `ykman` for that comparison separately).
				</span>
				{#if secretHex.length > 0}
					<button
						type="button"
						onclick={clearSecret}
						class="mt-2 text-xs text-red-600 hover:underline dark:text-red-400"
					>
						Clear secret field
					</button>
				{/if}
			</label>

			<div class="pt-2">
				<button
					type="button"
					onclick={runProbe}
					disabled={busy}
					class="hover:bg-morphit-emerald-dark rounded-xl bg-morphit-emerald px-5 py-2.5 font-semibold text-white active:scale-95 disabled:opacity-50"
				>
					{busy ? 'Running…' : 'Run probe'}
				</button>
				{#if phase}
					<span class="ml-3 text-sm text-ink-600 dark:text-ink-400">{phase}</span>
				{/if}
			</div>

			{#if errorMsg}
				<div
					class="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
					role="alert"
				>
					{errorMsg}
				</div>
			{/if}
		</div>

		<!-- Results -->
		{#if yubikeyOutputHex || softwareOutputHex || logEntries.length > 0}
			<div class="card mt-6 space-y-4">
				<h2 class="font-display text-lg font-bold">Results</h2>

				{#if deviceLabel}
					<p class="text-sm text-ink-500 dark:text-ink-400">
						Device: <code>{deviceLabel}</code>
					</p>
				{/if}

				{#if yubikeyOutputHex}
					<div>
						<p class="text-sm font-semibold">YubiKey HMAC-SHA1 output (hex):</p>
						<pre
							class="mt-1 overflow-x-auto rounded-lg bg-ink-100 p-3 font-mono text-xs dark:bg-ink-900">{yubikeyOutputHex}</pre>
					</div>
				{/if}

				{#if softwareOutputHex}
					<div>
						<p class="text-sm font-semibold">Software HMAC-SHA1 output (hex):</p>
						<pre
							class="mt-1 overflow-x-auto rounded-lg bg-ink-100 p-3 font-mono text-xs dark:bg-ink-900">{softwareOutputHex}</pre>
					</div>

					{#if comparisonResult === 'match'}
						<div
							class="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 font-semibold text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200"
						>
							✓ MATCH — transport.ts speaks the right protocol.
						</div>
					{:else if comparisonResult === 'mismatch'}
						<div
							class="rounded-lg border border-red-300 bg-red-50 px-3 py-2 font-semibold text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-200"
						>
							✗ MISMATCH — bytes diverge. Inspect the log below to find which frame is wrong.
						</div>
					{/if}
				{/if}

				{#if logEntries.length > 0}
					<details class="rounded-lg border border-ink-200 dark:border-ink-700">
						<summary class="cursor-pointer px-3 py-2 text-sm font-semibold">
							USB transaction log ({logEntries.length} entries)
						</summary>
						<div class="border-t border-ink-200 dark:border-ink-700">
							<table class="w-full font-mono text-xs">
								<thead class="bg-ink-100 text-left dark:bg-ink-900">
									<tr>
										<th class="px-2 py-1">time</th>
										<th class="px-2 py-1">dir</th>
										<th class="px-2 py-1">bytes (hex)</th>
										<th class="px-2 py-1">status</th>
										<th class="px-2 py-1">note</th>
									</tr>
								</thead>
								<tbody>
									{#each logEntries as entry, i (i)}
										<tr class="border-t border-ink-100 dark:border-ink-800">
											<td class="px-2 py-1 text-ink-500 dark:text-ink-400">
												{formatTimestamp(entry.timestamp)}
											</td>
											<td class="px-2 py-1 font-semibold">{entry.direction}</td>
											<td class="px-2 py-1">
												{entry.bytes ? bytesToHex(entry.bytes) : ''}
											</td>
											<td class="px-2 py-1">
												{entry.status !== undefined
													? '0x' + entry.status.toString(16).padStart(2, '0')
													: ''}
											</td>
											<td class="px-2 py-1 text-ink-600 dark:text-ink-300">
												{entry.note ?? ''}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</details>
				{/if}
			</div>
		{/if}
	{/if}

	<footer class="mt-8 text-xs text-ink-500 dark:text-ink-400">
		<p>
			Source: <code>apps/web/src/routes/dev/yubikey-probe/+page.svelte</code>. Calls into
			<code>$crypto/yubikey/transport</code> with a logger callback. No data leaves your browser.
		</p>
	</footer>
</section>
