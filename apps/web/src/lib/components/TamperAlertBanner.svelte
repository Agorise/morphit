<!--
	Morphit — tamper-alert banner.

	CRITICAL surface: files this site served don't match the
	chain-signed manifest, OR the newest release op on chain (named
	alike by two RPC operators' nodes) is signed by a key other than our pin.

	Possibilities:
	  • A server or proxy serving changed files (accident, break-in,
	    or the operator on purpose — the check cannot stop a hostile
	    operator, who serves the check too).
	  • @morphit rotated its key and our pin is stale, or the
	    @morphit account was taken over.

	Tone: red, urgent, NOT dismissible.  We deliberately do NOT
	auto-reload, do NOT auto-fix.  The user needs to know
	something is wrong and decide what to do.

	Recommended user actions surfaced:
	  • Sign out before doing anything else (don't authorize ops
	    on a possibly-tampered page).
	  • Compare with the published source.
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
	import { _, locale } from 'svelte-i18n';
	import { localePath } from '$i18n/path';
	import { matchSupported } from '$i18n/locales';
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
	// ALSO suppress while a service-worker update is pending
	// (a new build is landing → the "Load it now" snackbar owns that window) and
	// for a short grace window after boot (the async update poll / reg.update()
	// can resolve just after the byte check, so the banner would otherwise flash
	// before the snackbar appears). Genuine same-version tamper on a fully-
	// settled bundle still fires once both gates clear. Only the asset-hash case
	// is gated — pubkey/invalid-payload are on-chain-signature alarms, unrelated
	// to a frontend byte swap, and are never suppressed.
	const assetTamper = $derived(
		tamperedPaths.length > 0 && $staleBuild !== true && !$swUpdatePending && $tamperGraceElapsed
	);

	const show = $derived(showPubkeyMismatch || showInvalidPayload || assetTamper);

	let expanded = $state(false);

	const lang = $derived(matchSupported($locale ?? '') ?? undefined);
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
					<li>
						<a
							href="https://git.agorise.net/agorise/morphit/releases"
							target="_blank"
							rel="noopener noreferrer external"
							class="underline">{$_('release.tamper_alert.action_compare_source')}</a
						>
					</li>
					<li>
						<a href={localePath('/instances', lang)} class="underline"
							>{$_('release.tamper_alert.action_try_other_instance')}</a
						>
					</li>
				</ul>
			</details>
		</div>
	</aside>
{/if}
