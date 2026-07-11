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
		id: 'chat-inbox-folders',
		claim_source: 'faq',
		claim_phrase: 'Archived',
		anchor: {
			kind: 'grep',
			pattern: 'tab_archived',
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
	},
	// ─── cp30-DD-11 USDT per-network explorer override actually works
	// Anchor on the indexer-side body construction that DD-11 added.
	// Before cp30-DD, the indexer-client declared this field but the
	// indexer body never populated it — frontend defensive-fallback
	// hid the bug.  Sentinel pins the new body-construction line.
	{
		id: 'cp30-dd-11-usdt-per-network-override-wired',
		claim_source: 'brag_list',
		claim_phrase: 'USDT (Tether) peer-to-peer across four networks',
		anchor: {
			kind: 'grep',
			pattern: 'frontendUsdtErc20ChatLinkUrl',
			paths: ['apps/indexer/src/api/instance.ts']
		},
		status: 'live'
	},
	// ─── cp30-DD-10 USDC per-network explorer override actually works
	// Same pattern as DD-11 above; anchor on the body-construction.
	{
		id: 'cp30-dd-10-usdc-per-network-override-wired',
		claim_source: 'brag_list',
		claim_phrase: 'USD Coin (USDC) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: 'frontendUsdcErc20ChatLinkUrl',
			paths: ['apps/indexer/src/api/instance.ts']
		},
		status: 'live'
	},
	// ─── cp31 DAI P2P ─────────────────────────────────────────────────
	// cp31 brag entry claims DAI is wired as the 6th Category-B
	// trade-only asset (parallel to USDT and USDC — multi-network).
	// Anchor on the canonical registry entry; if DAI ever loses its
	// registry slot the brag claim drifts into vaporware and this
	// CHECK row fires.
	{
		id: 'cp31-dai-p2p',
		claim_source: 'brag_list',
		claim_phrase: 'Dai (DAI) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "ticker: 'DAI'",
			paths: ['packages/asset-registry/src/index.ts']
		},
		status: 'live'
	},
	// ─── cp31 DAI per-network explorer override actually works
	// Same pattern as cp30-DD-10/11 — anchor on indexer-side body
	// construction.  Catches the same "interface declared, body
	// missing" class of bug DD-10 closed for USDC at cp30-DD.
	{
		id: 'cp31-dai-per-network-override-wired',
		claim_source: 'brag_list',
		claim_phrase: 'Dai (DAI) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: 'frontendDaiErc20ChatLinkUrl',
			paths: ['apps/indexer/src/api/instance.ts']
		},
		status: 'live'
	},
	// ─── cp31 DAI distinct privacy-warning class (not lumped with
	// USDT/USDC).  Brag claims DAI gets the more-nuanced
	// `dai_partly_centralized` warning rather than the
	// freeze-power-implying `*_centralized` class.  Anchor on the
	// ─── cp33 DOGE P2P ────────────────────────────────────────────────
	// New brag entry #282 claims DOGE is wired as a 7th Category-B
	// trade-only asset.  Anchor on the canonical registry entry —
	// if DOGE ever loses its registry slot the brag claim drifts
	// into vaporware and this CHECK row fires.
	{
		id: 'cp33-doge-p2p',
		claim_source: 'brag_list',
		claim_phrase: 'Dogecoin (DOGE) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "ticker: 'DOGE'",
			paths: ['packages/asset-registry/src/index.ts']
		},
		status: 'live'
	},
	// ─── cp33 DOGE payment-rail wired (cp32 LL #36) ───────────────────
	// Cp32 LL #36: every tradable asset must also be wired as a
	// payment rail.  Cp31 missed this for DAI (closed in cp32
	// CODE-1); cp33 ships DOGE with both axes same-turn.  Anchor:
	// payments/registry.ts must contain pay_doge.
	{
		id: 'cp33-doge-payment-rail-wired',
		claim_source: 'brag_list',
		claim_phrase: 'Dogecoin (DOGE) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "key: 'pay_doge'",
			paths: ['apps/web/src/lib/payments/registry.ts']
		},
		status: 'live'
	},
	// ─── cp33 DOGE explorer URL bundled default ───────────────────────
	// blockchair.com/dogecoin chosen from Ken's 9-explorer survey.
	// Anchor on the constant; a renamed/removed constant means the
	// frontend has lost its fallback default and operators see a
	// broken explorer link when no override is configured.
	{
		id: 'cp33-doge-explorer-bundled-default',
		claim_source: 'brag_list',
		claim_phrase: 'Dogecoin (DOGE) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: 'BUNDLED_DOGE_CHAT_LINK_URL',
			paths: ['apps/web/src/lib/explorer/urlsCore.ts']
		},
		status: 'live'
	},
	// ─── cp39 ZEC P2P trading wired ───────────────────────────────────
	// Zcash addition (cp39 — Part 122).  Eleventh tradable asset.
	// Brag list (entry #283) advertises ZEC peer-to-peer trading.
	// Anchor: canonical registry must contain a ticker entry for ZEC.
	// If ZEC ever loses its registry slot the brag claim drifts
	// into vaporware and this CHECK row fires.
	{
		id: 'cp39-zec-p2p',
		claim_source: 'brag_list',
		claim_phrase: 'Zcash (ZEC) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "ticker: 'ZEC'",
			paths: ['packages/asset-registry/src/index.ts']
		},
		status: 'live'
	},
	// ─── cp39 ZEC payment-rail wired (cp32 LL #36) ────────────────────
	// Cp32 LL #36: every tradable asset must also be wired as a
	// payment rail.  Cp39 ships ZEC with both axes same-turn per
	// the pattern established in cp33 for DOGE.  Anchor:
	// payments/registry.ts must contain pay_zec.
	{
		id: 'cp39-zec-payment-rail-wired',
		claim_source: 'brag_list',
		claim_phrase: 'Zcash (ZEC) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "key: 'pay_zec'",
			paths: ['apps/web/src/lib/payments/registry.ts']
		},
		status: 'live'
	},
	// ─── cp39 ZEC explorer URL bundled default ────────────────────────
	// mainnet.zcashexplorer.app chosen from Ken's 7-explorer survey
	// as the community-run, project-aligned default.  Anchor on the
	// constant; a renamed/removed constant means the frontend has
	// lost its fallback default and operators see a broken explorer
	// link when no override is configured.
	{
		id: 'cp39-zec-explorer-bundled-default',
		claim_source: 'brag_list',
		claim_phrase: 'Zcash (ZEC) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: 'BUNDLED_ZEC_CHAT_LINK_URL',
			paths: ['apps/web/src/lib/explorer/urlsCore.ts']
		},
		status: 'live'
	},
	// ─── cp41 ARRR P2P trading wired ─────────────────────────────────
	// Pirate Chain addition (cp41 — Part 122).  Twelfth tradable asset.
	// Brag list (new entry) advertises ARRR peer-to-peer trading.
	// Anchor: canonical registry must contain a ticker entry for ARRR.
	// If ARRR ever loses its registry slot the brag claim drifts
	// into vaporware and this CHECK row fires.
	{
		id: 'cp41-arrr-p2p',
		claim_source: 'brag_list',
		claim_phrase: 'Pirate Chain (ARRR) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "ticker: 'ARRR'",
			paths: ['packages/asset-registry/src/index.ts']
		},
		status: 'live'
	},
	// ─── cp41 ARRR payment-rail wired (cp32 LL #36) ──────────────────
	// Cp32 LL #36: every tradable asset must also be wired as a
	// payment rail.  Cp41 ships ARRR with both axes same-turn per
	// the pattern established for DOGE at cp33 and ZEC at cp39.
	// Anchor: payments/registry.ts must contain pay_arrr.
	{
		id: 'cp41-arrr-payment-rail-wired',
		claim_source: 'brag_list',
		claim_phrase: 'Pirate Chain (ARRR) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "key: 'pay_arrr'",
			paths: ['apps/web/src/lib/payments/registry.ts']
		},
		status: 'live'
	},
	// ─── cp41 ARRR explorer URL bundled default ──────────────────────
	// explorer.piratechain.com chosen from Ken's 3-explorer survey
	// as the official project pointer, project-aligned, free of
	// third-party tracking.  Anchor on the constant; a renamed/
	// removed constant means the frontend has lost its fallback
	// default and operators see a broken explorer link when no
	// override is configured.
	{
		id: 'cp41-arrr-explorer-bundled-default',
		claim_source: 'brag_list',
		claim_phrase: 'Pirate Chain (ARRR) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: 'BUNDLED_ARRR_CHAT_LINK_URL',
			paths: ['apps/web/src/lib/explorer/urlsCore.ts']
		},
		status: 'live'
	},
	// ─── cp43 DCR P2P trading wired ──────────────────────────────────
	// Decred addition (cp43 — Part 122).  Thirteenth tradable asset.
	// Brag list (new entry #285) advertises DCR peer-to-peer trading.
	// Anchor: canonical registry must contain a ticker entry for DCR.
	{
		id: 'cp43-dcr-p2p',
		claim_source: 'brag_list',
		claim_phrase: 'Decred (DCR) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "ticker: 'DCR'",
			paths: ['packages/asset-registry/src/index.ts']
		},
		status: 'live'
	},
	// ─── cp43 DCR payment-rail wired (cp32 LL #36) ───────────────────
	// Cp32 LL #36: every tradable asset must also be wired as a
	// payment rail.  Cp43 ships DCR with both axes same-turn per the
	// pattern established for DOGE/cp33, ZEC/cp39, and ARRR/cp41.
	{
		id: 'cp43-dcr-payment-rail-wired',
		claim_source: 'brag_list',
		claim_phrase: 'Decred (DCR) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "key: 'pay_dcr'",
			paths: ['apps/web/src/lib/payments/registry.ts']
		},
		status: 'live'
	},
	// ─── cp43 DCR explorer URL bundled default ───────────────────────
	// dcrdata.decred.org chosen from Ken's 4-explorer survey as the
	// official project explorer.  Anchor on the constant; a renamed
	// or removed constant means the frontend has lost its fallback
	// default.
	{
		id: 'cp43-dcr-explorer-bundled-default',
		claim_source: 'brag_list',
		claim_phrase: 'Decred (DCR) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: 'BUNDLED_DCR_CHAT_LINK_URL',
			paths: ['apps/web/src/lib/explorer/urlsCore.ts']
		},
		status: 'live'
	},
	// ─── cp45 SOL P2P trading wired ──────────────────────────────────
	// Solana addition (cp45 — Part 122).  Fourteenth tradable asset.
	// Brag entry #286 advertises SOL peer-to-peer trading.  Anchor on
	// canonical registry SOL ticker entry.
	{
		id: 'cp45-sol-p2p',
		claim_source: 'brag_list',
		claim_phrase: 'Solana (SOL) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "ticker: 'SOL'",
			paths: ['packages/asset-registry/src/index.ts']
		},
		status: 'live'
	},
	// ─── cp45 SOL payment-rail wired (cp32 LL #36) ──────────────────
	// Every tradable asset MUST also be wired as a payment rail.  Cp45
	// ships SOL with both axes same-turn per the pattern established
	// for DOGE/cp33, ZEC/cp39, ARRR/cp41, DCR/cp43.
	{
		id: 'cp45-sol-payment-rail-wired',
		claim_source: 'brag_list',
		claim_phrase: 'Solana (SOL) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "key: 'pay_sol'",
			paths: ['apps/web/src/lib/payments/registry.ts']
		},
		status: 'live'
	},
	// ─── cp45 SOL explorer URL bundled default ──────────────────────
	// explorer.solana.com chosen from Ken's 5-explorer survey as the
	// official project explorer.  Anchor on the constant; renamed or
	// removed means the frontend has lost its fallback default.
	{
		id: 'cp45-sol-explorer-bundled-default',
		claim_source: 'brag_list',
		claim_phrase: 'Solana (SOL) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: 'BUNDLED_SOL_CHAT_LINK_URL',
			paths: ['apps/web/src/lib/explorer/urlsCore.ts']
		},
		status: 'live'
	},
	// ─── cp47 ETH P2P trading wired ──────────────────────────────────
	// Ethereum addition (cp47 — Part 122).  Fifteenth tradable asset.
	// Brag entry #287 advertises ETH peer-to-peer trading.
	{
		id: 'cp47-eth-p2p',
		claim_source: 'brag_list',
		claim_phrase: 'Ethereum (ETH) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "ticker: 'ETH'",
			paths: ['packages/asset-registry/src/index.ts']
		},
		status: 'live'
	},
	// ─── cp47 ETH payment-rail wired (cp32 LL #36) ──────────────────
	{
		id: 'cp47-eth-payment-rail-wired',
		claim_source: 'brag_list',
		claim_phrase: 'Ethereum (ETH) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "key: 'pay_eth'",
			paths: ['apps/web/src/lib/payments/registry.ts']
		},
		status: 'live'
	},
	// ─── cp47 ETH explorer URL bundled default ──────────────────────
	{
		id: 'cp47-eth-explorer-bundled-default',
		claim_source: 'brag_list',
		claim_phrase: 'Ethereum (ETH) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: 'BUNDLED_ETH_CHAT_LINK_URL',
			paths: ['apps/web/src/lib/explorer/urlsCore.ts']
		},
		status: 'live'
	},
	// ─── cp49 XRP P2P trading wired ──────────────────────────────────
	// Ripple addition (cp49 — Part 122).  Sixteenth tradable asset.
	// Brag entry #288 advertises XRP peer-to-peer trading.
	{
		id: 'cp49-xrp-p2p',
		claim_source: 'brag_list',
		claim_phrase: 'Ripple (XRP) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "ticker: 'XRP'",
			paths: ['packages/asset-registry/src/index.ts']
		},
		status: 'live'
	},
	// ─── cp49 XRP payment-rail wired (cp32 LL #36) ──────────────────
	{
		id: 'cp49-xrp-payment-rail-wired',
		claim_source: 'brag_list',
		claim_phrase: 'Ripple (XRP) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: "key: 'pay_xrp'",
			paths: ['apps/web/src/lib/payments/registry.ts']
		},
		status: 'live'
	},
	// ─── cp49 XRP explorer URL bundled default ──────────────────────
	{
		id: 'cp49-xrp-explorer-bundled-default',
		claim_source: 'brag_list',
		claim_phrase: 'Ripple (XRP) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: 'BUNDLED_XRP_CHAT_LINK_URL',
			paths: ['apps/web/src/lib/explorer/urlsCore.ts']
		},
		status: 'live'
	},
	// ─── cp34 I-1 closure — DAI post-page wired ───────────────────────
	// Cp31 added DAI to the canonical registry + chat surfaces but
	// MISSED the post page's DaiNetworkPicker mount + daiNetwork
	// state.  DAI orders silently failed cp31→cp34 because the
	// indexer requires asset_network for DAI and the form never
	// supplied one.  This CHECK pins that DaiNetworkPicker is
	// actually mounted in the post page; removing it again would
	// reproduce the I-1 bug.
	{
		id: 'cp34-i1-dai-post-page-wired',
		claim_source: 'brag_list',
		claim_phrase: 'Dai (DAI) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: '<DaiNetworkPicker',
			paths: ['apps/web/src/routes/[lang]/post/+page.svelte']
		},
		status: 'live'
	},
	// ─── cp34 I-3 closure — orderbook DAI network chip rendered ───────
	// Cp30 (USDC) + cp31 (DAI) added the canonical registry entry +
	// per-network address shapes but the orderbook page never
	// rendered a network chip for non-USDT multi-network rows.  A
	// USDC-ERC-20 order looked identical to USDC-Solana on the list;
	// a DAI-ERC-20 looked identical to DAI-Arbitrum.  CP34 closure
	// adds the chips with matching i18n keys.  This CHECK pins that
	// the DAI chip is in place.
	{
		id: 'cp34-i3-orderbook-dai-chip-rendered',
		claim_source: 'brag_list',
		claim_phrase: 'Dai (DAI) peer-to-peer',
		// cp442 — the per-row ternary (`daiRowNetwork`) was extracted into the
		// shared `networkChipFor` helper so the featured cards get the chip too.
		anchor: {
			kind: 'grep',
			pattern: "isDaiNetwork",
			paths: ['apps/web/src/lib/orders/networkChip.ts']
		},
		status: 'live'
	},
	// ─── cp34 H-1 closure — cheat-sheet DAI + DOGE rows rendered ──────
	// Cp31 (DAI) + cp33 (DOGE) added per-asset i18n strings under
	// cheat_sheet.section_assets but the cheat-sheet page never
	// rendered <dd> for those new assets.  Strings existed in 10
	// locales but were orphaned.  CP34 closure adds both rows.
	{
		id: 'cp34-h1-cheat-sheet-doge-rendered',
		claim_source: 'brag_list',
		claim_phrase: 'Dogecoin (DOGE) peer-to-peer',
		anchor: {
			kind: 'grep',
			pattern: 'cheat_sheet.section_assets.doge',
			paths: ['apps/web/src/routes/[lang]/cheat-sheet/+page.svelte']
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
