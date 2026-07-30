<!--
	Morphit — tamper-alert banner (Batch J).

	CRITICAL surface: the running bundle's bytes don't match the
	chain-signed manifest, OR the trust-anchor pubkey on chain
	doesn't match our pin.

	Either condition means the user CANNOT trust what's running.
	Possibilities:
	  • A CDN or hosting provider serving a tampered build.
	  • DNS hijack / mirror substitution.
	  • Trust anchor rotated upstream and our pin is stale (legit
	    if @morphit voluntarily rotated; SUSPICIOUS otherwise).

	Tone: red, urgent, NOT dismissible.  We deliberately do NOT
	auto-reload, do NOT auto-fix.  The user needs to know
	something is wrong and decide what to do.

	Recommended user actions surfaced:
	  • Sign out before doing anything else (don't authorize ops
	    on a possibly-tampered page).
	  • Compare the running bundle's signed source on GitHub.
	  • Try a known-good Morphit instance.

	The banner is NOT shown when:
	  • The hash check is still loading.
	  • The hash check encountered a fetch failure (network
	    flake — surfaces a separate, milder banner instead).
	  • All hashes matched.
	  • Trust-anchor fetch errored with 'rpc_failed' or
	    'no_release' (we don't have positive evidence of tamper).

	The banner IS shown when:
	  • assetCheck.kind === 'mismatch' with non-empty mismatches.
	  • release.kind === 'error' && release.error.kind ===
	    'pubkey_mismatch'.
	  • release.kind === 'error' && release.error.kind ===
	    'invalid_payload'.
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';
	import { release, assetCheck, staleBuild } from '$stores/release';
	import { swUpdatePending, tamperGraceElapsed } from '$lib/updates/tamperBannerGate';

	const showPubkeyMismatch = $derived.by(() => {
		const r = $release;
		return r.kind === 'error' && r.error.kind === 'pubkey_mismatch';
	});

	const showInvalidPayload = $derived.by(() => {
		const r = $release;
		return r.kind === 'error' && r.error.kind === 'invalid_payload';
	});

	const tamperedPaths = $derived.by(() => {
		const a = $assetCheck;
		return a.kind === 'mismatch' ? a.mismatches.map((m) => m.path) : [];
	});

	// An asset mismatch is EXPECTED (and harmless) while the running bundle is
	// simply OLDER than a newly-announced, chain-SIGNED release: the tamper check
	// compares the running bundle's bytes against the NEW manifest, so every
	// routine upgrade would otherwise flash this red alert. Suppress the asset-
	// mismatch case during a stale build — the "Load it now" snackbar
	// (UpdateBanner) handles the reload. Genuine tampering is same-version-
	// different-bytes, which still fires here once the running version matches
	// the announced one. staleBuild requires a valid chain-signed newer release,
	// so an attacker can't fabricate it to hide a tampered same-version bundle.
	//
	// cp514 (t.txt A) — ALSO suppress while a service-worker update is pending
	// (a new build is landing → the "Load it now" snackbar owns that window) and
	// for a short grace window after boot (the async update poll / reg.update()
	// can resolve just after the byte check, so the banner would otherwise flash
	// before the snackbar appears). Genuine same-version tamper on a fully-
	// settled bundle still fires once both gates clear. Only the asset-hash case
	// is gated — pubkey/invalid-payload are on-chain-signature alarms, unrelated
	// to a frontend byte swap, and are never suppressed.
	const assetTamper = $derived(
		tamperedPaths.length > 0 &&
			$staleBuild !== true &&
			!$swUpdatePending &&
			$tamperGraceElapsed
	);

	const show = $derived(showPubkeyMismatch || showInvalidPayload || assetTamper);

	let expanded = $state(false);
</script>

{#if show}
	<aside
		role="alert"
		aria-live="assertive"
		class="border-b-4 border-red-500 bg-red-100 px-4 py-3 text-red-900 dark:border-red-600 dark:bg-red-950 dark:text-red-100"
	>
		<div class="mx-auto max-w-4xl">
			<h2 class="font-display text-base font-bold">
				⚠ {$_('release.tamper_alert.title')}
			</h2>

			<!-- Specific diagnostic line — which condition fired. -->
			{#if showPubkeyMismatch}
				<p class="mt-1 text-sm">
					{$_('release.tamper_alert.pubkey_mismatch_body')}
				</p>
			{:else if showInvalidPayload}
				<p class="mt-1 text-sm">
					{$_('release.tamper_alert.invalid_payload_body')}
				</p>
			{:else if tamperedPaths.length > 0}
				<p class="mt-1 text-sm">
					{$_('release.tamper_alert.asset_mismatch_body', {
						values: { count: tamperedPaths.length }
					})}
				</p>
				{#if expanded}
					<ul class="mt-2 list-disc pl-6 font-mono text-xs">
						{#each tamperedPaths as p}
							<li>{p}</li>
						{/each}
					</ul>
				{/if}
				<button
					type="button"
					onclick={() => (expanded = !expanded)}
					class="mt-1 text-sm font-semibold underline-offset-2 hover:underline"
				>
					{expanded ? $_('release.tamper_alert.hide_files') : $_('release.tamper_alert.show_files')}
				</button>
			{/if}

			<!-- What to do — same recommendations regardless of which
			     condition fired. -->
			<details class="mt-2">
				<summary class="cursor-pointer text-sm font-semibold">
					{$_('release.tamper_alert.what_to_do')}
				</summary>
				<ul class="mt-2 list-disc pl-6 text-sm">
					<li>{$_('release.tamper_alert.action_sign_out')}</li>
					<li>{$_('release.tamper_alert.action_compare_source')}</li>
					<li>{$_('release.tamper_alert.action_try_other_instance')}</li>
				</ul>
			</details>
		</div>
	</aside>
{/if}
