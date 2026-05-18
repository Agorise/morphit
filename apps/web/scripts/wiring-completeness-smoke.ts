#!/usr/bin/env tsx
/**
 * wiring-completeness-smoke — the "claim ⇒ wired" enforcer.
 *
 * Standing rule (Ken, recurring): every claim made in
 * MORPHIT-BRAG-LIST.md and apps/web/src/lib/i18n/locales/en.json's
 * FAQ MUST be verifiable in code or honestly disclosed as backlog.
 * "Push notifications work" is a claim; if the code has no
 * pushManager.subscribe() anywhere, that claim violates the rule.
 *
 * Past pattern: claims drift ahead of implementation.  Design docs
 * announce a feature, FAQs describe it in present tense, code never
 * catches up.  The discipline survived inspection in some checkpoints
 * and broke in others; without mechanical enforcement, drift wins.
 *
 * This smoke is the mechanical enforcer.  For each substantive
 * feature claim, we record a CHECK: a phrase from the brag list / FAQ
 * and the code-anchor pattern that must exist for the claim to be
 * honest.  CI fails the build when a claim is on the surface but the
 * anchor is missing.
 *
 * Adding to the registry: when shipping a new claim, append a CHECK
 * row.  When intentionally deferring a feature, mark it `deferred`
 * with a one-line rationale — the smoke skips deferred rows but
 * REPORTS them, so Ken sees the deferral list every triple-pulse.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..', '..', '..');

interface Check {
	/** Short id used in failure messages */
	readonly id: string;
	/** Where the public-facing claim lives */
	readonly claim_source: 'brag_list' | 'faq';
	/** Substring that, if present in the source, triggers this check.
	 *  Match is case-insensitive and substring-based. */
	readonly claim_phrase: string;
	/** What code anchor must exist for the claim to be honest. */
	readonly anchor: AnchorSpec;
	/** If `deferred`, the claim is honestly disclosed as backlog and
	 *  the smoke reports but does not fail on it. */
	readonly status: 'live' | 'deferred';
	/** Reason — required for `deferred` rows. */
	readonly reason?: string;
}

type AnchorSpec =
	| { kind: 'grep'; pattern: string; paths: readonly string[] }
	| { kind: 'file_exists'; path: string }
	| { kind: 'any_of'; specs: readonly AnchorSpec[] };

const CHECKS: readonly Check[] = [
	// ─── Notifications system ─────────────────────────────────────
	{
		id: 'notifications-ambient-channel',
		claim_source: 'faq',
		claim_phrase: 'favicon',
		anchor: { kind: 'file_exists', path: 'apps/web/src/lib/notifications/ambient.ts' },
		status: 'live'
	},
	{
		id: 'notifications-os-native',
		claim_source: 'faq',
		claim_phrase: 'Notification API',
		anchor: { kind: 'file_exists', path: 'apps/web/src/lib/notifications/native.ts' },
		status: 'live'
	},
	{
		id: 'notifications-audio-cue',
		claim_source: 'faq',
		claim_phrase: 'two-tone chime',
		anchor: { kind: 'file_exists', path: 'apps/web/src/lib/notifications/audio.ts' },
		status: 'live'
	},
	{
		id: 'notifications-vibrate-cue',
		claim_source: 'faq',
		claim_phrase: 'navigator.vibrate',
		anchor: { kind: 'file_exists', path: 'apps/web/src/lib/notifications/vibrate.ts' },
		status: 'live'
	},
	{
		id: 'notifications-push-web-push',
		claim_source: 'faq',
		claim_phrase: 'Push notifications let Morphit alert you',
		anchor: {
			kind: 'any_of',
			specs: [
				{
					kind: 'grep',
					pattern: 'pushManager\\.subscribe',
					paths: ['apps/web/src']
				},
				{
					kind: 'grep',
					pattern: "addEventListener\\('push'",
					paths: ['apps/web/src/service-worker.ts']
				}
			]
		},
		status: 'live'
	},

	// ─── Chat inbox ─────────────────────────────────────────────
	{
		id: 'chat-inbox-messages-requests-tabs',
		claim_source: 'faq',
		claim_phrase: 'Messages',
		anchor: {
			kind: 'grep',
			pattern: 'Requests',
			paths: ['apps/web/src/routes/[lang]/chat']
		},
		status: 'live'
	},

	// ─── Operator alerts ──────────────────────────────────────────
	{
		id: 'operator-matrix-bot',
		claim_source: 'brag_list',
		claim_phrase: 'Operator alerts to a private Matrix DM',
		anchor: { kind: 'file_exists', path: 'apps/matrix-bot/src/main.ts' },
		status: 'live'
	},
	{
		id: 'operator-resource-monitor',
		claim_source: 'brag_list',
		claim_phrase: 'Resource alerts',
		anchor: {
			kind: 'grep',
			pattern: 'proc/meminfo',
			paths: ['ops/scripts']
		},
		status: 'live'
	},

	// ─── Federation / decentralization ────────────────────────────
	{
		id: 'federation-rss-orderbook',
		claim_source: 'faq',
		claim_phrase: '/rss/orderbook.xml',
		anchor: {
			kind: 'grep',
			pattern: 'rss/orderbook',
			paths: ['apps/indexer/src']
		},
		status: 'live'
	},
	{
		id: 'killswitch',
		claim_source: 'brag_list',
		claim_phrase: 'kill-switch',
		anchor: { kind: 'file_exists', path: 'apps/relay/src/policy/killSwitch.ts' },
		status: 'live'
	},

	// ─── Mediakit ──────────────────────────────────────────────
	{
		id: 'mediakit-zip',
		claim_source: 'brag_list',
		claim_phrase: '/morphit-mediakit.zip',
		anchor: { kind: 'file_exists', path: 'apps/web/static/morphit-mediakit.zip' },
		status: 'live'
	},
	{
		id: 'mediakit-build-script',
		claim_source: 'brag_list',
		claim_phrase: 'regenerated and re-committed every time its source files change',
		anchor: { kind: 'file_exists', path: 'scripts/build-mediakit.sh' },
		status: 'live'
	},

	// ─── Upgrade tooling ────────────────────────────────────────
	{
		id: 'upgrade-ops-cli',
		claim_source: 'brag_list',
		claim_phrase: 'morphit-ops upgrade',
		anchor: { kind: 'file_exists', path: 'apps/ops-cli/src/commands/upgrade.ts' },
		status: 'live'
	},
	{
		id: 'release-signers',
		claim_source: 'brag_list',
		claim_phrase: 'release-signers',
		anchor: { kind: 'file_exists', path: '.forgejo/release-signers/README.md' },
		status: 'live'
	},

	// ─── Crypto / privacy ──────────────────────────────────────────
	{
		id: 'chat-e2ee-x25519-chacha',
		claim_source: 'faq',
		claim_phrase: 'X25519 key agreement',
		anchor: {
			kind: 'grep',
			pattern: 'X25519|x25519|crypto_box',
			paths: ['apps/web/src']
		},
		status: 'live'
	},
	{
		id: 'monero-view-key-env-only',
		claim_source: 'brag_list',
		claim_phrase: 'XMR',
		anchor: {
			kind: 'grep',
			pattern: 'MORPHIT_INDEXER_XMR_FEE_VIEWKEY',
			paths: ['apps/indexer/src']
		},
		status: 'live'
	},
	{
		// cp16 — brag list #65 (sig-verify on push subscribe).
		// The claim cites three components: (a) a canonical
		// message format, (b) the cross-check smoke that defends
		// the contract, (c) the rejection-reason coverage.
		id: 'push-subscribe-sig-verify',
		claim_source: 'brag_list',
		claim_phrase: 'Push subscriptions are proof-of-ownership protected',
		anchor: {
			kind: 'any_of',
			specs: [
				{
					kind: 'file_exists',
					path: 'apps/relay/src/policy/pushSubscribeSig.ts'
				},
				{
					kind: 'file_exists',
					path: 'apps/relay/scripts/canonical-message-cross-check-smoke.ts'
				}
			]
		},
		status: 'live'
	},
	{
		// cp16 walkthrough surfaced this — operator following
		// the env-example file MUST see VAPID placeholders so
		// they know push notifications need setup.  Without
		// this, an operator who skips RUN-A-MORPHIT-NODE.md
		// would ship push-disabled silently.
		id: 'vapid-env-documented-in-example',
		claim_source: 'brag_list',
		claim_phrase: 'Push subscriptions are proof-of-ownership protected',
		anchor: {
			kind: 'grep',
			pattern: 'MORPHIT_RELAY_VAPID_PUBLIC_KEY',
			paths: ['ops/env/relay.env.example']
		},
		status: 'live'
	},
	{
		// cp17 — featured-slot auction refinements (bid history).
		// Phase A claim: users see their own recent bids with
		// visibility status above the bid form.
		id: 'featured-bid-history-endpoint',
		claim_source: 'brag_list',
		claim_phrase: 'Bidders see their own recent bids inline',
		anchor: {
			kind: 'any_of',
			specs: [
				{
					kind: 'file_exists',
					path: 'apps/indexer/src/api/featuredBids.ts'
				},
				{
					kind: 'file_exists',
					path: 'apps/web/src/lib/components/FeaturedBidHistory.svelte'
				}
			]
		},
		status: 'live'
	},
	{
		// cp17 — outbid push notifications.
		id: 'featured-bid-outbid-push',
		claim_source: 'brag_list',
		claim_phrase: 'displaced bidder gets a push notification',
		anchor: {
			kind: 'grep',
			pattern: 'outbid_notify_failed',
			paths: ['apps/indexer/src/indexer/handlers/featureBid.ts']
		},
		status: 'live'
	},
	{
		// cp18 — anti-snipe extension.  Soft-close auction rule:
		// late bids extend the deadline so snipers can be
		// countered.  Capped at MAX_EXTENSIONS to bound
		// auction-drag.
		id: 'featured-bid-anti-snipe',
		claim_source: 'brag_list',
		claim_phrase: 'minimum-hours floors prevent micro-bid sniping',
		anchor: {
			kind: 'grep',
			pattern: 'anti_snipe_extended',
			paths: ['apps/indexer/src/indexer/handlers/featureBid.ts']
		},
		status: 'live'
	},
	// ─── cp26 transparent-chain privacy framework ────────────────────
	// 5 CHECK rows for the 5 brag entries cp26 added (29 updated +
	// new 30/31/32/33/34).  Each pins the canonical code anchor
	// that proves the claim.  Per cp26 DD-8: the standing rule
	// (every brag-list claim must be wire-verifiable) was applied
	// to cp26's new claims as a follow-up audit step.
	{
		id: 'cp26-amount-jitter-generalized',
		claim_source: 'brag_list',
		claim_phrase: 'Amount-jitter on every transparent chain',
		anchor: {
			kind: 'grep',
			pattern: 'export function jitterUtxoAmount',
			paths: ['apps/web/src/lib/chat/payload.ts']
		},
		status: 'live'
	},
	{
		id: 'cp26-address-reuse-detection',
		claim_source: 'brag_list',
		claim_phrase: 'Client-side address-reuse warning',
		anchor: {
			kind: 'grep',
			pattern: 'export function findPriorShare',
			paths: ['apps/web/src/lib/privacy/addressHistory.ts']
		},
		status: 'live'
	},
	{
		id: 'cp26-payjoin-bip78',
		claim_source: 'brag_list',
		claim_phrase: 'PayJoin (BIP-78) support for BTC',
		anchor: {
			kind: 'grep',
			pattern: 'payjoin_endpoint',
			paths: ['apps/web/src/lib/chat/payload.ts']
		},
		status: 'live'
	},
	{
		id: 'cp26-privacy-guide-pages',
		claim_source: 'brag_list',
		claim_phrase: 'Per-asset privacy guide pages',
		anchor: {
			kind: 'file_exists',
			path: 'apps/web/src/routes/[lang]/privacy/[asset]/+page.svelte'
		},
		status: 'live'
	},
	{
		// "No wallet recommendations" is a POLICY claim, not a
		// feature claim.  The anchor here is the privacy-guide
		// content asserting the policy verbatim, since policy is
		// enforced through content discipline rather than code
		// gates.  This is the canonical pattern for cp26-style
		// policy claims.
		id: 'cp26-no-wallet-recommendation-policy',
		claim_source: 'brag_list',
		claim_phrase: 'No wallet recommendations',
		anchor: {
			kind: 'grep',
			pattern: 'no_wallet_recommendation',
			paths: ['apps/web/src/lib/i18n/locales/en.json']
		},
		status: 'live'
	},
	// ─── cp27 DASH P2P ────────────────────────────────────────────────
	// New brag entry #279 claims DASH is wired as a 4th Category-B
	// trade-only asset.  Anchor on the canonical registry entry —
	// if DASH ever loses its registry slot the brag claim drifts
	// into vaporware and this CHECK row fires.
	{
		id: 'cp27-dash-p2p',
		claim_source: 'brag_list',
		claim_phrase: 'Dash (DASH) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "ticker: 'DASH'",
			paths: ['packages/asset-registry/src/index.ts']
		},
		status: 'live'
	},
	// ─── cp30 USDC P2P ────────────────────────────────────────────────
	// New brag entry #280 claims USDC is wired as the 5th Category-B
	// trade-only asset (parallel to USDT — multi-network).  Anchor
	// on the canonical registry entry — if USDC ever loses its
	// registry slot the brag claim drifts into vaporware and this
	// CHECK row fires.  Brag #29 (amount-jitter) is also extended
	// in cp30 to claim stablecoin coverage; this CHECK row implicitly
	// covers that since #29 only makes sense if USDC is registered.
	{
		id: 'cp30-usdc-p2p',
		claim_source: 'brag_list',
		claim_phrase: 'USD Coin (USDC) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "ticker: 'USDC'",
			paths: ['packages/asset-registry/src/index.ts']
		},
		status: 'live'
	}
];

// ─── Verifier ──────────────────────────────────────────────────────
function bragText(): string {
	return readFileSync(join(REPO, 'MORPHIT-BRAG-LIST.md'), 'utf-8');
}

function faqText(): string {
	const json = readFileSync(
		join(REPO, 'apps/web/src/lib/i18n/locales/en.json'),
		'utf-8'
	);
	const d = JSON.parse(json);
	let out = '';
	for (const v of Object.values(d.faq?.entries ?? {})) {
		if (typeof v === 'object' && v !== null) {
			const e = v as { q?: string; a?: string };
			out += (e.q ?? '') + '\n' + (e.a ?? '') + '\n';
		}
	}
	return out;
}

function claimAppears(c: Check): boolean {
	const haystack = (c.claim_source === 'brag_list' ? bragText() : faqText()).toLowerCase();
	return haystack.includes(c.claim_phrase.toLowerCase());
}

function anchorSatisfied(a: AnchorSpec): boolean {
	if (a.kind === 'file_exists') {
		return existsSync(join(REPO, a.path));
	}
	if (a.kind === 'any_of') {
		return a.specs.some(anchorSatisfied);
	}
	// grep
	for (const p of a.paths) {
		const abs = join(REPO, p);
		if (!existsSync(abs)) continue;
		try {
			// rg if available; else fall back to grep -rE
			const cmd = `grep -rqE ${JSON.stringify(a.pattern)} ${JSON.stringify(abs)}`;
			execSync(cmd, { stdio: 'ignore' });
			return true;
		} catch {
			// no match in this path; keep trying
		}
	}
	return false;
}

// ─── Run ──────────────────────────────────────────────────────────
console.log(`wiring-completeness smoke: ${CHECKS.length} checks\n`);

let failed = 0;
let deferred = 0;
let okCount = 0;
const failures: string[] = [];
const deferrals: string[] = [];

for (const c of CHECKS) {
	const claimed = claimAppears(c);
	const wired = anchorSatisfied(c.anchor);

	if (c.status === 'deferred') {
		// Deferred rows: claim should still appear (it's a known
		// pre-launch state) but anchor is allowed to be missing.
		// We REPORT but do not fail.
		deferred++;
		const tag = wired ? '⚠ DEFERRED → now wired (promote!)' : '⚠ DEFERRED';
		console.log(`  ${tag}  ${c.id}`);
		console.log(`      claim: ${c.claim_source}/"${c.claim_phrase.slice(0, 60)}"`);
		console.log(`      reason: ${c.reason}`);
		deferrals.push(c.id);
		continue;
	}

	// Live rows: BOTH must hold.
	if (claimed && wired) {
		okCount++;
		console.log(`  ✓ ${c.id}`);
		continue;
	}

	failed++;
	console.log(`  ✗ ${c.id}`);
	if (!claimed) {
		console.log(
			`      MISSING CLAIM: phrase "${c.claim_phrase}" not found in ${c.claim_source}. ` +
				'Either the claim was removed and this check is stale, or the check phrase needs updating.'
		);
	}
	if (!wired) {
		console.log(`      MISSING WIRING: code anchor not found.  Spec: ${JSON.stringify(c.anchor)}`);
	}
	failures.push(c.id);
}

console.log('');
console.log(`Summary: ${okCount} live + ${deferred} deferred + ${failed} failed`);
if (deferred > 0) {
	console.log(`Deferred items (visible every run — promote when wired):`);
	for (const d of deferrals) console.log(`  · ${d}`);
}
if (failed === 0) {
	const total = okCount + deferred;
	console.log(`\n✓ all ${total} wiring-completeness checks hold (${okCount} live, ${deferred} deferred)`);
	process.exit(0);
} else {
	console.error(`\n✗ ${failed} wiring gaps`);
	process.exit(1);
}
