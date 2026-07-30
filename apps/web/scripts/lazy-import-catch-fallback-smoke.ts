#!/usr/bin/env tsx
/**
 * lazy-import-catch-fallback-smoke (cp418).
 *
 * The interactive lazily-imported UI ({#await loadXxx() then Comp}) — forms,
 * pickers, modals, key-backup panels — MUST have a {:catch} fallback so a
 * failed dynamic import (e.g. a stale chunk on a session left open across a
 * deploy) shows the user something actionable (LazyLoadError → Refresh) rather
 * than silently rendering nothing after they clicked to open it.
 *
 * Passive display widgets (FeaturedOrders, CoinCarousel, MyBalanceCard, the
 * feedback-reminder banner, …) are deliberately EXEMPT — silent non-render is
 * acceptable for a non-interactive enhancement, and an error box there would be
 * more disruptive than the missing widget.
 *
 * Usage: tsx apps/web/scripts/lazy-import-catch-fallback-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
let failures = 0;
let scenarios = 0;
function check(name: string, cond: boolean, detail = ''): void {
	scenarios++;
	if (cond) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

// (route file relative to src/routes/[lang], interactive loader names that must have a catch)
const TARGETS: ReadonlyArray<readonly [string, readonly string[]]> = [
	['my/orders/+page.svelte', ['loadFeatureBidForm', 'loadLeaveFeedbackForm']],
	['[x+40][account=account]/+page.svelte', ['loadRespondToFeedbackForm']],
	[
		'post/+page.svelte',
		[
			'loadUsdtNetworkPicker',
			'loadUsdcNetworkPicker',
			'loadDaiNetworkPicker',
			'loadFiatCurrencySelect',
			'loadPaymentMethodsPicker',
			'loadListingFeeAddressPanel',
			'loadPrivateKeyWarningModal'
		]
	],
	['post/edit/[permlink]/+page.svelte', ['loadPrivateKeyWarningModal']],
	['settings/+page.svelte', ['loadHardwareKeyCard']],
	['onboarding/+page.svelte', ['loadKeyBackupPanel', 'loadSeedBackupPrint', 'loadConfirmModal']],
	['onboarding/register-name/+page.svelte', ['loadConfirmModal']]
];

console.log('lazy-import-catch-fallback-smoke:\n');

// 1. The shared fallback component is present and actionable.
const comp = readFileSync(resolve(WEB, 'src/lib/components/LazyLoadError.svelte'), 'utf8');
check('LazyLoadError exists with role="alert"', /role="alert"/.test(comp));
check('LazyLoadError shows the localized failure message', comp.includes("common.lazy_load_failed"));
check('LazyLoadError offers a page refresh (location.reload)', /location\.reload\(\)/.test(comp));

// 2. Every interactive lazy-import block has a {:catch} before its {/await}.
for (const [rel, loaders] of TARGETS) {
	const src = readFileSync(resolve(WEB, 'src/routes/[lang]', rel), 'utf8');
	const lines = src.split('\n');
	check(`${rel} imports LazyLoadError`, /import LazyLoadError from '\$components\/LazyLoadError\.svelte'/.test(src));
	for (const loader of loaders) {
		// find each {#await loader() then X} and confirm a {:catch} precedes its matching {/await}
		let ok = true;
		let found = 0;
		for (let i = 0; i < lines.length; i++) {
			const m = /^(\t*)\{#await (load\w+)\(\) then \w+\}\s*$/.exec(lines[i]!);
			if (!m || m[2] !== loader) continue;
			found++;
			const indent = m[1]!;
			let hasCatch = false;
			for (let j = i + 1; j < lines.length; j++) {
				const t = lines[j]!.trimEnd();
				if (t === `${indent}{/await}`) break;
				if (t === `${indent}{:catch}`) hasCatch = true;
			}
			if (!hasCatch) ok = false;
		}
		check(`${rel} · ${loader} has a {:catch} fallback`, ok && found > 0, found === 0 ? 'block not found' : 'missing {:catch}');
	}
}

console.log(`\nlazy-import-catch-fallback-smoke: ${scenarios - failures}/${scenarios} passed`);
if (failures > 0) {
	console.log(`lazy-import-catch-fallback-smoke: ${failures} FAILED`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} lazy-import-catch-fallback scenarios passed`);
