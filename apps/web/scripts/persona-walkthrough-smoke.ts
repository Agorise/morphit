#!/usr/bin/env tsx
/**
 * persona-walkthrough-smoke.
 *
 * Structural sentinel-pins for the Part 119 persona-walkthrough
 * fixes (Bob, Sally, Sally-operator).  Each scenario greps the
 * source for the canonical phrase or call-site that proves the
 * fix is still wired.  If a later refactor removes the protection,
 * this smoke fails loudly and the maintainer is forced to update
 * either the fix or this file in the same commit.
 *
 * Sentinel-grep is the deliberate choice over runtime testing:
 *   - Most fixes touch operator-doc surfaces that have no runtime
 *     equivalent (no way to "render" a markdown file's accuracy).
 *   - The component-level fixes (Tooltip, FundsSentModal, backup-
 *     keys) touch reactive Svelte runes that would require the
 *     full svelte-kit harness to exercise; the sentinel-grep is
 *     proportionate.
 *   - Doc-vs-code drift is exactly the kind of regression that
 *     surfaces months later when nobody remembers the fix; this
 *     smoke catches it in CI immediately.
 *
 * Coverage:
 *   B-2   /backup-keys paired-readonly explanation card
 *   S-11  FundsSentModal txid help line
 *   S-12  Tooltip i18n-aware default ariaLabel + post page cleanup
 *   So-1  vps-bootstrap callout in RUN-A-MORPHIT-NODE + OPERATIONS
 *   So-2  ops-cli main.ts JSDoc lists all 14 subcommands
 *   So-3  verbose-health env-opt-in callouts (3 docs)
 *   So-4  init.ts JSDoc step-count disclaimer
 *   So-6  systemd path + user override callout (added Part 119)
 *
 * Plus several drift-catchers added during the Part 119 docs
 * audit pass that aren't tied to a persona but matter equally:
 *
 *   D-1   morphit-ops (binary name, NO space) in operator docs
 *   D-2   no MORPHIT_INDEXER_FEES_ACCOUNT ghost env var anywhere
 *   D-3   monorepo install paths consistent in OPERATIONS.md
 *   D-4   schema version in PRE-LAUNCH reflects v31
 *   D-5   --dry-run flag claim removed from PRE-LAUNCH
 *   D-6   Klingex curl URL canonical path
 *   D-7   POST-LAUNCH backup recipe uses real systemd timer
 *   D-8   /v1/health diagnostics field paths match real shape
 *   D-9   PRE-LAUNCH wizard step-count realistic ("~17"/disclaimer)
 *   D-10  Postgres-version doc claim not over-restrictive
 *   D-11  Operator-register CLI command matches real subcommand
 *   D-12  Indexer nginx path /api/indexer/ in §12 troubleshooting
 *   D-13  /v1/health field name "lag_blocks" not "head_lag_blocks"
 *
 * Part 120 additions:
 *
 *   P120-FAQ  public_api + qr_login FAQ entries wired in FAQ_KEYS
 *             (orphan-entry catch: translated in 10 locales but
 *              never rendered because not in the FAQ_KEYS array).
 *
 * Part 121 additions:
 *
 *   P121-DOC  Four operator/launch-doc sentinels pinning the
 *             `npm install` workspace-symlinks + smoke-suite
 *             ERR_MODULE_NOT_FOUND troubleshooting in RUN-A-NODE,
 *             OPERATIONS, and PRE-LAUNCH-CHECKLIST (P121-DOC 1-3),
 *             plus the Part 121 fee_method enum-freeze forward-
 *             note on ADR-0011 (P121-DOC-4).  The ADR-0011
 *             sentinel was added as a Part 121 cp2 catch-up after
 *             the discipline-correction memory edit (#24): when
 *             shipping a code-level invariant, the ADR that
 *             established the original wire format MUST gain a
 *             forward-note pointing at the freeze.
 *
 * Usage:
 *   cd apps/web && npx tsx scripts/persona-walkthrough-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_WEB = join(import.meta.dirname, '..');
const REPO_ROOT = join(REPO_WEB, '..', '..');

interface Scenario {
	readonly name: string;
	/** Path relative to repo root (web app paths get rebased onto REPO_WEB). */
	readonly file: string;
	/** Substrings that must ALL appear in the file. */
	readonly mustHave?: readonly string[];
	/** Substrings that must NOT appear (regression sentinels). */
	readonly mustNotHave?: readonly string[];
	/** When true, resolve `file` relative to REPO_ROOT instead of REPO_WEB. */
	readonly rootRelative?: boolean;
}

const SCENARIOS: readonly Scenario[] = [
	// ─── Bob ─────────────────────────────────────────────────────────────
	{
		name: 'B-2 — backup-keys paired-readonly explanation card wired',
		file: 'src/routes/backup-keys/+page.svelte',
		mustHave: [
			'isPairedReadOnly',
			'backup_keys.paired.heading',
			'backup_keys.paired.body',
			'backup_keys.paired.deeplink_hint',
			'backup_keys.paired.deeplink_cta',
			'web+morphit://backup-keys',
			'Bob finding B-2'
		]
	},
	{
		name: 'B-2 — paired locale strings present in all 10 locales',
		file: 'src/lib/i18n/locales/en.json',
		mustHave: [
			'"paired":',
			'"heading":',
			'"body":',
			'"deeplink_hint":',
			'"deeplink_cta":'
		]
	},

	// ─── Sally (user) ────────────────────────────────────────────────────
	{
		name: 'S-11 — FundsSentModal renders inline txid help line',
		file: 'src/lib/components/FundsSentModal.svelte',
		mustHave: ['chat.funds_sent.txid_help', 'Sally finding S-11']
	},
	{
		name: 'S-12 — Tooltip default ariaLabel reads from i18n',
		file: 'src/lib/components/Tooltip.svelte',
		mustHave: [
			'a11y.tooltip_more_info',
			'effectiveAriaLabel',
			'Sally finding S-12'
		],
		// Pre-fix the default was a hardcoded English string.  Verify
		// that hardcoded default is gone.
		mustNotHave: ["ariaLabel = 'More info'"]
	},
	{
		name: 'S-12 — /post asset-explainer Tooltips no longer pass hardcoded ariaLabel',
		file: 'src/routes/post/+page.svelte',
		mustHave: [
			'post_order.form.asset_explainer.blurt',
			'post_order.form.asset_explainer.btc',
			'post_order.form.asset_explainer.xmr'
		],
		mustNotHave: [
			'ariaLabel="What is BLURT?"',
			'ariaLabel="What is BTC?"',
			'ariaLabel="What is XMR?"'
		]
	},

	// ─── Sally (operator) ────────────────────────────────────────────────
	{
		name: 'So-1 — vps-bootstrap.sh fast-path callout in RUN-A-MORPHIT-NODE.md',
		file: 'docs/RUN-A-MORPHIT-NODE.md',
		rootRelative: true,
		mustHave: ['scripts/vps-bootstrap.sh', 'fast-path']
	},
	{
		name: 'So-1 — OPERATIONS.md preamble mirrors the vps-bootstrap callout',
		file: 'docs/OPERATIONS.md',
		rootRelative: true,
		mustHave: ['scripts/vps-bootstrap.sh', 'experienced operators']
	},
	{
		name: 'So-2 — ops-cli main.ts JSDoc lists all 14 subcommands',
		file: 'apps/ops-cli/src/main.ts',
		rootRelative: true,
		mustHave: [
			// Just check the ones most-recently-added are listed in
			// the JSDoc header (pre-fix the header had 8 only).
			'init [--check-only]',
			'edit [--out=PATH]',
			'import-altnet-key',
			'export-altnet-key',
			'register',
			'payment-method',
			'Sally-operator finding So-2'
		]
	},
	{
		name: 'So-3 — OPERATIONS.md §0a verbose-health env-opt-in callout',
		file: 'docs/OPERATIONS.md',
		rootRelative: true,
		mustHave: ['MORPHIT_INDEXER_VERBOSE_HEALTH=true', 'NEW-9-8']
	},
	{
		name: 'So-3 — LAUNCH-DAY.md verbose-health env-opt-in warning',
		file: 'docs/LAUNCH-DAY.md',
		rootRelative: true,
		mustHave: ['Sally-operator finding So-3', 'MORPHIT_INDEXER_VERBOSE_HEALTH']
	},
	{
		name: 'So-3 — POST-LAUNCH-WEEK-ONE.md verbose-health reminder',
		file: 'docs/POST-LAUNCH-WEEK-ONE.md',
		rootRelative: true,
		mustHave: ['Sally-operator finding So-3', 'MORPHIT_INDEXER_VERBOSE_HEALTH=true']
	},
	{
		name: 'So-4 — init.ts JSDoc has realistic step count + disclaimer',
		file: 'apps/ops-cli/src/commands/init.ts',
		rootRelative: true,
		mustHave: ['~17 ELI5', 'check steps.ts'],
		// Pre-fix said "Nine ELI5-style configuration prompts."
		mustNotHave: ['Nine ELI5-style configuration prompts']
	},
	{
		name: 'So-6 — RUN-A-MORPHIT-NODE.md systemd path + user override callout',
		file: 'docs/RUN-A-MORPHIT-NODE.md',
		rootRelative: true,
		mustHave: [
			'Sally-operator finding So-6',
			'systemctl edit morphit-indexer',
			'systemctl edit morphit-relay',
			'WorkingDirectory=/home/morphit/morphit/apps/indexer',
			'WorkingDirectory=/home/morphit/morphit/apps/relay'
		]
	},

	// ─── Drift-catchers from Part 119 docs audit ─────────────────────────
	{
		name: 'D-1 — no `morphit ops ` (space) typos in operator docs',
		file: 'docs/OPERATIONS.md',
		rootRelative: true,
		// Hyphenated binary name is the canonical form.  The space
		// form `morphit ops ` would imply a non-existent binary.
		mustNotHave: ['`morphit ops ', '"morphit ops ']
	},
	{
		name: 'D-1 — no `morphit ops ` typos in RUN-A-MORPHIT-NODE.md',
		file: 'docs/RUN-A-MORPHIT-NODE.md',
		rootRelative: true,
		mustNotHave: ['`morphit ops ', '"morphit ops ']
	},
	{
		name: 'D-2 — no ghost MORPHIT_INDEXER_FEES_ACCOUNT env var',
		file: 'docs/OPERATIONS.md',
		rootRelative: true,
		// The real env var is MORPHIT_INDEXER_FEE_RECIPIENT.
		mustNotHave: ['MORPHIT_INDEXER_FEES_ACCOUNT']
	},
	{
		name: 'D-2 — LAUNCH-DAY.md uses MORPHIT_INDEXER_FEE_RECIPIENT',
		file: 'docs/LAUNCH-DAY.md',
		rootRelative: true,
		mustHave: ['MORPHIT_INDEXER_FEE_RECIPIENT'],
		mustNotHave: ['MORPHIT_INDEXER_FEES_ACCOUNT']
	},
	{
		name: 'D-3 — OPERATIONS.md uses monorepo paths, not separate-dir',
		file: 'docs/OPERATIONS.md',
		rootRelative: true,
		// Stale paths from before the monorepo collapse.
		mustNotHave: ['cd /opt/morphit-relay', 'cd /opt/morphit-indexer']
	},
	{
		name: 'D-4 — PRE-LAUNCH reflects schema v31, not v29',
		file: 'docs/PRE-LAUNCH-CHECKLIST.md',
		rootRelative: true,
		mustHave: ['v31'],
		mustNotHave: ['currently at v29 as of Part 108++']
	},
	{
		name: 'D-5 — PRE-LAUNCH does not reference nonexistent --dry-run flag',
		file: 'docs/PRE-LAUNCH-CHECKLIST.md',
		rootRelative: true,
		// The indexer has no --dry-run flag; verify the bad
		// recommendation is gone.
		mustNotHave: ['npm run start -- --dry-run']
	},
	{
		name: 'D-6 — POST-LAUNCH-WEEK-ONE Klingex curl URL matches code',
		file: 'docs/POST-LAUNCH-WEEK-ONE.md',
		rootRelative: true,
		mustHave: ['klingex.io/api/v1/ticker/BLURT_USDT'],
		// Pre-fix URL was a fictitious public-api.klingex.com path.
		mustNotHave: ['public-api.klingex.com']
	},
	{
		name: 'D-7 — POST-LAUNCH backup recipe uses real systemd timer',
		file: 'docs/POST-LAUNCH-WEEK-ONE.md',
		rootRelative: true,
		mustHave: [
			'morphit-backup.timer',
			'/usr/local/lib/morphit/morphit-backup.sh'
		],
		// Pre-fix referenced a fictitious cron entry at this path.
		mustNotHave: ['/opt/morphit-indexer/scripts/backup.sh']
	},
	{
		name: 'D-8 — POST-LAUNCH monitoring uses real /v1/health fields',
		file: 'docs/POST-LAUNCH-WEEK-ONE.md',
		rootRelative: true,
		mustHave: [
			'.lag_blocks',
			'.diagnostics.operator_balances',
			'.diagnostics.price'
		],
		// Pre-fix referenced fields that don't exist in the
		// actual /v1/health response shape.
		mustNotHave: [
			'.diagnostics.indexer.blocks_behind',
			'.diagnostics.relay.balance_blurt',
			'.diagnostics.treasury.address_source'
		]
	},
	{
		name: 'D-8 — LAUNCH-DAY monitoring loop uses real /v1/health fields',
		file: 'docs/LAUNCH-DAY.md',
		rootRelative: true,
		mustHave: ['.lag_blocks', '.diagnostics.operator_balances'],
		mustNotHave: [
			'.diagnostics.indexer.blocks_behind',
			'.diagnostics.relay.balance_blurt',
			'.diagnostics.treasury.address_source'
		]
	},
	{
		name: 'D-9 — PRE-LAUNCH wizard step-count realistic',
		file: 'docs/PRE-LAUNCH-CHECKLIST.md',
		rootRelative: true,
		mustHave: ['~17 prompts', 'steps.ts'],
		mustNotHave: ['covers all 14 steps']
	},
	{
		name: 'D-10 — RUN-A-NODE Postgres version accepts 15+',
		file: 'docs/RUN-A-MORPHIT-NODE.md',
		rootRelative: true,
		// Pre-fix said "should show 15.x or 16.x" which rejects PG 17.
		mustHave: ['15.x or higher'],
		mustNotHave: ['should show 15.x or 16.x']
	},
	{
		name: 'D-11 — RUN-A-NODE §9.1 uses real `morphit-ops register` invocation',
		file: 'docs/RUN-A-MORPHIT-NODE.md',
		rootRelative: true,
		mustHave: ['npx morphit-ops register'],
		// Pre-fix referenced a fictitious flag-driven invocation
		// against a nonexistent dist/ path.
		mustNotHave: [
			'node apps/ops-cli/dist/index.js register-operator',
			'morphit_register_operator'
		]
	},
	{
		name: 'D-12 — RUN-A-NODE §12 troubleshooting curl uses nginx path /api/indexer/',
		file: 'docs/RUN-A-MORPHIT-NODE.md',
		rootRelative: true,
		mustHave: ['curl https://yourdomain.com/api/indexer/v1/health'],
		mustNotHave: ['curl https://yourdomain.com/indexer/v1/health']
	},
	{
		name: 'D-13 — RUN-A-NODE references real /v1/health field "lag_blocks"',
		file: 'docs/RUN-A-MORPHIT-NODE.md',
		rootRelative: true,
		mustHave: ['"lag_blocks":'],
		// "head_lag_blocks" is not a field name in the actual response.
		mustNotHave: ['"head_lag_blocks":']
	},

	// ─── Part 120 — FAQ orphan catch ─────────────────────────────────────
	// Two FAQ entries (public_api, qr_login) had been translated into
	// all 10 locales but never rendered because they weren't listed in
	// FAQ_KEYS.  Both are flagship-feature entries.  These sentinels
	// fail if a future refactor removes them from FAQ_KEYS, OR if a
	// translator deletes the locale entries without removing the keys.
	{
		name: 'P120-FAQ-1 — public_api FAQ key wired in FAQ_KEYS',
		file: 'src/lib/utils/faqIndex.ts',
		mustHave: ["'public_api'"]
	},
	{
		name: 'P120-FAQ-2 — qr_login FAQ key wired in FAQ_KEYS',
		file: 'src/lib/utils/faqIndex.ts',
		mustHave: ["'qr_login'"]
	},
	{
		name: 'P120-FAQ-3 — public_api FAQ entry present in en.json',
		file: 'src/lib/i18n/locales/en.json',
		mustHave: ['"public_api":']
	},
	{
		name: 'P120-FAQ-4 — qr_login FAQ entry present in en.json',
		file: 'src/lib/i18n/locales/en.json',
		mustHave: ['"qr_login":']
	},

	// ─── Part 121 — workspace symlink / smoke-failure note ──────────
	// New operators following RUN-A-MORPHIT-NODE.md need to know that
	// `npm install` creates the workspace symlinks under
	// `node_modules/@morphit/*` that the smoke suite depends on, and
	// that a fresh-clone snapshot without `npm install` yet will see
	// 13 smoke runners fail with `ERR_MODULE_NOT_FOUND` referencing
	// `@morphit/asset-registry`.  These sentinels pin the doc claim
	// against future drift so an operator hitting the symptom finds
	// the right troubleshooting in three places.
	{
		name: 'P121-DOC-1 — RUN-A-NODE mentions workspace symlinks + ERR_MODULE_NOT_FOUND',
		file: 'docs/RUN-A-MORPHIT-NODE.md',
		rootRelative: true,
		mustHave: ['workspace symlinks', 'ERR_MODULE_NOT_FOUND', '@morphit/asset-registry']
	},
	{
		name: 'P121-DOC-2 — OPERATIONS.md has Smoke-suite troubleshooting block',
		file: 'docs/OPERATIONS.md',
		rootRelative: true,
		mustHave: [
			'Smoke-suite troubleshooting',
			'ERR_MODULE_NOT_FOUND',
			'npm install --no-audit --no-fund'
		]
	},
	{
		name: 'P121-DOC-3 — PRE-LAUNCH-CHECKLIST §C has smoke-suite verification step',
		file: 'docs/PRE-LAUNCH-CHECKLIST.md',
		rootRelative: true,
		mustHave: [
			'bash scripts/run-smokes.sh',
			'ERR_MODULE_NOT_FOUND',
			'Part 121 audit'
		]
	},
	{
		name: 'P121-DOC-4 — ADR-0011 carries Part 121 fee_method enum-freeze forward-note',
		file: 'docs/adr/0011-dynamic-fee-model.md',
		rootRelative: true,
		mustHave: [
			'2026-05-13 forward note',
			'wire-format-frozen invariant',
			'memory #23',
			'fee-method-enum-frozen-smoke',
			'first-buy-waiver-payment-agnostic-smoke'
		]
	}
];

let failed = 0;
let passed = 0;

console.log('persona-walkthrough smoke:\n');

for (const sc of SCENARIOS) {
	const base = sc.rootRelative ? REPO_ROOT : REPO_WEB;
	const path = join(base, sc.file);
	let body: string;
	try {
		body = readFileSync(path, 'utf8');
	} catch (err) {
		console.error(`  ✗ ${sc.name}`);
		console.error(`      file not readable: ${sc.file}`);
		console.error(`      ${err}`);
		failed++;
		continue;
	}

	const missing = (sc.mustHave ?? []).filter((s) => !body.includes(s));
	const present = (sc.mustNotHave ?? []).filter((s) => body.includes(s));

	if (missing.length === 0 && present.length === 0) {
		console.log(`  ✓ ${sc.name}`);
		passed++;
	} else {
		console.error(`  ✗ ${sc.name}`);
		for (const s of missing) {
			console.error(`      MUST HAVE (not found): ${JSON.stringify(s.slice(0, 100))}`);
		}
		for (const s of present) {
			console.error(`      MUST NOT HAVE (found): ${JSON.stringify(s.slice(0, 100))}`);
		}
		failed++;
	}
}

console.log(`\n${passed} passed, ${failed} failed (${SCENARIOS.length} total)`);

if (failed > 0) {
	console.error('\npersona-walkthrough smoke FAILED');
	process.exit(1);
}
// Canonical success line — run-smokes.sh greps for `^✓ all` to tally
// scenarios.
console.log(`✓ all ${SCENARIOS.length} persona-walkthrough scenarios passed`);
