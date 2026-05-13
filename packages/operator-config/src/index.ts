/**
 * @morphit/operator-config — operator-friendly config layer.
 *
 * Reads `morphit.config.env` (a key=value file with comments)
 * from the repo root and projects each line into `process.env`
 * IF the corresponding env var isn't already set by the OS
 * environment.
 *
 * Why this exists:
 *   The indexer and relay are configured by ~80 environment
 *   variables. SystemD units, Docker compose, CI pipelines all
 *   set these directly — that machinery works and isn't going
 *   away. But an operator running a Morphit instance who just
 *   wants to nudge "the BLURT price fallback" or "should
 *   registration be enabled right now" doesn't need to know
 *   the env-var system. They want one file with the few knobs
 *   they actually care about, with comments explaining each.
 *
 *   This package provides that file (morphit.config.env at
 *   repo root) and loads it at boot time, BEFORE the indexer
 *   or relay parse their own env vars. OS env wins — anything
 *   set in the actual environment takes precedence over the
 *   file. So a SystemD unit that hardcodes a value continues
 *   to work; the file is only consulted for keys the env
 *   doesn't already have.
 *
 * What's NOT in the allowlist:
 *   Spam-economic constants — STRANGER_FEE_BASE_BLURT,
 *   STRANGER_FEE_MAX_DOUBLINGS, STRANGER_FEE_WINDOW_MINUTES,
 *   chat layer-3 caps. These are deliberately uniform across
 *   the federation; making them per-operator-tunable would
 *   let a generous operator undercut the anti-spam economics
 *   for everyone. Operators who want them changed should
 *   upstream the proposal, not local-patch their instance.
 *
 *   Critical infrastructure — DATABASE_URL, RPC_ENDPOINTS,
 *   CHAIN_ID, OFFICIAL_POSTING_PUBKEY, FEE_RECIPIENT account
 *   names, log destinations. Wrong values cause data
 *   corruption or full outages; these stay in the
 *   environment so deployment automation (which gets these
 *   right) is the only path that sets them.
 *
 *   Keys not in the allowlist that appear in the file cause
 *   a hard error at boot — better to fail loud than apply
 *   some and silently drop others.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

/** Operator-tunable env vars. The keys here can be set via
 *  morphit.config.env. Everything else is rejected with a
 *  clear error pointing at the file. */
const ALLOWLIST: ReadonlySet<string> = new Set([
	// ─── Registration kill-switch ─────────────────────────────
	// Flip false to immediately stop new account onboarding
	// (e.g., during an active spam attack you want to triage).
	// Existing users are unaffected.
	'MORPHIT_RELAY_SIGNUP_ENABLED',

	// ─── Listing fee — BLURT ──────────────────────────────────
	// Base BLURT fee per listing.  Default 60.  Sybil-tier
	// escalation kicks in past the 3rd order in any 24-hour
	// window.  Fees are denominated directly in BLURT, no live-
	// USD conversion at verification time — so this number is
	// what the indexer actually checks against.
	'MORPHIT_INDEXER_FEE_BASE_BLURT',

	// ─── Listing fee — BTC ────────────────────────────────────
	// Operator-set satoshi amount targeting roughly the same
	// USD value as the BLURT fee.  Default 416 satoshis (~$0.25
	// at $60K BTC).  Run apps/indexer/scripts/recommend-fee-
	// amounts.ts to recompute against current prices.
	'MORPHIT_INDEXER_BTC_FEE_SATOSHIS',

	// ─── Listing fee — XMR ────────────────────────────────────
	// Operator-set piconero amount (1 XMR = 1e12 piconero).
	// Default 781,250,000 piconero (~$0.25 at $320 XMR).
	'MORPHIT_INDEXER_XMR_FEE_PICONERO',

	// ─── Featured-slot bid floor ──────────────────────────────
	// BLURT cost per hour of featured-slot time. Raise to keep
	// featured slots exclusive; lower to encourage more bidding.
	'MORPHIT_INDEXER_FEATURE_FEE_BLURT_PER_HOUR',

	// ─── Optional BLURT/USD price feed ────────────────────────
	// Off by default.  Enable to surface optional USD echoes on
	// /v1/listing-fee for frontend display.  Fee verification
	// itself doesn't depend on the feed.
	'MORPHIT_INDEXER_PRICE_FEED_ENABLED',

	// ─── Verbose health endpoint ──────────────────────────────
	// Off by default in production. Useful for operator
	// troubleshooting; exposes more detail in /v1/health.
	'MORPHIT_INDEXER_VERBOSE_HEALTH',

	// ─── Operator-account low-balance thresholds ──────────────
	// Alert thresholds for the operator's own service accounts
	// (relay and fees). 0 disables monitoring for that account.
	'MORPHIT_INDEXER_OPERATOR_BALANCE_RELAY_THRESHOLD_BLURT',
	'MORPHIT_INDEXER_OPERATOR_BALANCE_FEES_THRESHOLD_BLURT',

	// ─── Blurt account creation fee ───────────────────────────
	// The chain fee, in BLURT, that the relay includes with each
	// account-creation broadcast.  Set by Blurt witness consensus;
	// currently 100 BLURT.  Witnesses CAN change it, so this is
	// operator-tunable.  When witnesses raise or lower the fee,
	// operators update this value here; no Morphit release is
	// required.
	//
	// At runtime, the relay reads the chain's current fee
	// dynamically via condenser_api.get_chain_properties at each
	// signup attempt.  This config value serves three purposes:
	//   1. Source of truth when chain RPC is unavailable (the
	//      relay still needs SOME fee value to stamp on the op).
	//   2. Operator sanity-check: the relay refuses to broadcast
	//      if the chain's fee is more than 10% higher than this
	//      value — protects against a witness emergency raise
	//      draining the relay before the operator notices.
	//   3. Wizard / dashboard display: ops-cli and the setup
	//      wizard show this value to operators planning balances.
	//
	// Daily-spend math, for planning your relay's BLURT balance:
	//   max_daily_spend = MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT
	//                     × MORPHIT_RELAY_SIGNUP_DAILY_CEILING
	// At 100 BLURT × default ceiling 50 = up to 5,000 BLURT/day
	// maximum spend.  Operators with smaller balances should set
	// a smaller ceiling.
	'MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT',

	// ─── Per-instance branding (Phase D) ──────────────────────
	// These are written by `morphit-ops init` and read by the
	// indexer's /v1/instance endpoint, which the frontend hits
	// at page load to populate title bar, footer, and contact
	// links.
	//
	// All are optional — the indexer falls back to "Morphit" /
	// "A Morphit instance" / no contact, so a fresh instance
	// without branding configured still works.
	//
	// MORPHIT_INSTANCE_NAME: short identifier shown in title
	//   bar and footer (e.g., "alice-morphit", "morphit.berlin")
	//
	// MORPHIT_INSTANCE_TAGLINE: one-line subtitle on homepage
	//
	// MORPHIT_INSTANCE_CONTACT_URL: where users reach the
	//   operator (Matrix room, mastodon, mailto:, etc.) —
	//   appears in footer
	//
	// MORPHIT_INSTANCE_TOR_ADDRESS / _LOKINET_ADDRESS /
	// _I2P_ADDRESS / _NOSTR_PUBKEY: alt-network reachability
	//   data, displayed in the footer "Alt-network access"
	//   block.
	'MORPHIT_INSTANCE_NAME',
	'MORPHIT_INSTANCE_TAGLINE',
	'MORPHIT_INSTANCE_CONTACT_URL',
	'MORPHIT_INSTANCE_TOR_ADDRESS',
	'MORPHIT_INSTANCE_LOKINET_ADDRESS',
	'MORPHIT_INSTANCE_I2P_ADDRESS',
	'MORPHIT_INSTANCE_NOSTR_PUBKEY',

	// MORPHIT_INSTANCE_OPERATOR_TAG: the operator's registered
	// tag (matching their `morphit_operator_register_v1` op).
	// Surfaced via /v1/instance → frontend instance store →
	// included in `operator_tag` on every order op posted from
	// this instance.  When set, this instance attributes orders
	// to the named operator, who earns 90% of BLURT-paid listing
	// fees (REVISIT-LIST item 5 — operator earnings).  When
	// unset (e.g. a new instance still in setup), orders go
	// out without an operator_tag and the treasury keeps 100%.
	'MORPHIT_INSTANCE_OPERATOR_TAG',

	// ─── Per-instance SEO override (Phase G prep / task #4) ───
	// Each operator may want their own homepage SEO copy.  These
	// override the bundled svelte-i18n values for `seo.home.title`,
	// `seo.home.description`, `seo.home.keywords` when set.  Empty
	// or unset = use bundled defaults.  Surfaced via /v1/instance
	// → frontend instance store → Head.svelte.
	'MORPHIT_INSTANCE_SEO_TITLE',
	'MORPHIT_INSTANCE_SEO_DESCRIPTION',
	'MORPHIT_INSTANCE_SEO_KEYWORDS',

	// MORPHIT_INSTANCE_ORIGIN: the operator's public HTTPS origin
	// (e.g. https://alice-morphit.example).  Phase D.5 — federation
	// discovery.  Read by `morphit-ops register` to know what to
	// publish on-chain.  Typo here is recoverable (the instance
	// just doesn't appear in the directory until corrected); not
	// critical infra.
	'MORPHIT_INSTANCE_ORIGIN'
]);

export interface LoadResult {
	/** Path that was read, or null if no file existed. */
	readonly file: string | null;
	/** Number of keys that were applied (i.e., set in
	 *  process.env because the OS env had no value). */
	readonly applied: number;
	/** Keys that were present in the file but skipped because
	 *  the OS environment already had a value. */
	readonly skipped: readonly string[];
}

/** Read morphit.config.env (or a custom path) and project
 *  whitelisted keys into process.env. OS env wins.
 *
 *  Search order:
 *    1. MORPHIT_OPERATOR_CONFIG_FILE env var (absolute or
 *       relative path). If set, this is the only path checked.
 *    2. Each entry in `opts.searchPaths`, in order. The first
 *       directory that contains `morphit.config.env` wins.
 *    3. If `searchPaths` is omitted, default is `[process.cwd()]`.
 *
 *  Throws if:
 *    - the file path is set explicitly via env var but the
 *      file doesn't exist (operator clearly intended a file
 *      to apply; surface the typo),
 *    - the file exists but can't be read,
 *    - the file contains keys not in the allowlist.
 *
 *  No-op (and returns `applied: 0`, `file: null`) if no file
 *  is found in the search paths AND the override env var is
 *  unset. Pure env-var deployments are fully supported. */
export function loadOperatorConfig(
	opts: { searchPaths?: readonly string[] } = {}
): LoadResult {
	const overridePath = process.env.MORPHIT_OPERATOR_CONFIG_FILE;
	let path: string | null = null;

	if (overridePath !== undefined && overridePath !== '') {
		const resolved = resolve(overridePath);
		if (!existsSync(resolved)) {
			throw new Error(
				`[operator-config] MORPHIT_OPERATOR_CONFIG_FILE points to ${resolved}, ` +
					`but no file exists there. Either create the file or unset the env var.`
			);
		}
		path = resolved;
	} else {
		const searchPaths = opts.searchPaths ?? [process.cwd()];
		for (const dir of searchPaths) {
			const candidate = resolve(dir, 'morphit.config.env');
			if (existsSync(candidate)) {
				path = candidate;
				break;
			}
		}
	}

	if (path === null) {
		// Genuinely optional. Operators who only use env vars
		// see no behavior change.
		console.log(
			`[operator-config] no morphit.config.env found — using OS environment only`
		);
		return { file: null, applied: 0, skipped: [] };
	}

	let text: string;
	try {
		text = readFileSync(path, 'utf-8');
	} catch (err) {
		// File exists but can't be read — most likely a
		// permission error. Operator clearly intended this
		// file to apply; surface the error rather than
		// silently degrading to env-only.
		throw new Error(
			`[operator-config] failed to read ${path}: ${
				err instanceof Error ? err.message : String(err)
			}`
		);
	}

	// Node's parseEnv returns NodeJS.Dict<string>, i.e. values
	// may technically be undefined. In practice every parsed
	// line produces a defined value, but we still check before
	// assignment to keep TypeScript happy.
	const parsed: NodeJS.Dict<string> = parseEnv(text);

	// Validate every key is whitelisted. This protects against
	// (a) operator typos that would silently no-op, and
	// (b) operator pastes a wrong file that would otherwise
	// re-key infrastructure under their feet.
	const offenders = Object.keys(parsed).filter(
		(k) => !ALLOWLIST.has(k)
	);
	if (offenders.length > 0) {
		const list = offenders.map((k) => `  - ${k}`).join('\n');
		throw new Error(
			`[operator-config] ${path} contains keys not in the operator allowlist:\n${list}\n` +
				`If you want to set these, use the OS environment directly (SystemD, Docker, etc.). ` +
				`The morphit.config.env file is intentionally restricted to a small set of operator-tunable values.`
		);
	}

	// Apply: OS env wins. Skipped keys are reported so the
	// operator can see why their edit "didn't take effect."
	const skipped: string[] = [];
	let applied = 0;
	for (const [key, value] of Object.entries(parsed)) {
		// Defensive — parseEnv shouldn't produce undefined values
		// for successfully-parsed lines, but NodeJS.Dict allows
		// them.
		if (value === undefined) continue;
		if (process.env[key] !== undefined && process.env[key] !== '') {
			skipped.push(key);
			continue;
		}
		process.env[key] = value;
		applied++;
	}

	console.log(
		`[operator-config] loaded ${path} (${applied} applied, ${skipped.length} skipped — env wins)`
	);
	if (skipped.length > 0) {
		console.log(
			`[operator-config] skipped (already in env): ${skipped.join(', ')}`
		);
	}

	return { file: path, applied, skipped };
}

/** The set of allowlisted keys, exposed for tests + docs. */
export function getAllowlist(): ReadonlySet<string> {
	return ALLOWLIST;
}
