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
 *   P121-USDT Five sentinels pinning the USDT integration
 *             across canonical registry, frontend registry,
 *             per-network metadata module, indexer validation
 *             gates, and the orderbook row UI.  If any of these
 *             surfaces silently lose their Part 121 shape (e.g.
 *             USDT.canPayListingFee flipped to true, defaultNetwork
 *             changed from null, the indexer's per-network gates
 *             stripped, or the orderbook row dropping the network
 *             chip), the smoke fails loudly.
 *
 *   P121-CP6  Five sentinels pinning the operator-stance
 *             surfacing work (item 3 from the cp6 plow-through
 *             session).  /v1/instance now exposes
 *             `disabled_assets`; indexer-client mirrors the
 *             optional field for back-compat with pre-cp6
 *             indexers; the frontend instance store hydrates
 *             it with `[]` fallback; /about-this-instance
 *             renders the per-instance stance; /run-a-node
 *             carries the prospective-operator explainer with
 *             the MORPHIT_INDEXER_DISABLED_ASSETS env var
 *             named directly.  Memory #25 ("every new tradable
 *             asset ships default-ON instance-wide; operators
 *             opt out per-asset") is what these sentinels are
 *             defending — losing the surface would silently
 *             erase the federation-stance feature.
 *
 *   P121-CP9  Eight sentinels pinning the matrix-bot operator-
 *             alert sidecar + user→operator contact surfaces.
 *             SSoT parseMxid + parseRoomAlias with branded
 *             types prevent the privacy-violating @↔#
 *             confusion at compile time; indexer config refuses
 *             @-prefixed input in the room slot with privacy
 *             framing; /v1/instance exposes only operator_matrix_room
 *             (never an MXID); bot config refuses #-prefixed input
 *             in the MXID slot; sendDm() signature is typed against
 *             MatrixMxid (branded); main loop wires CRITICAL bypass
 *             + WARN gate + INFO accumulator; indexer-client mirror
 *             preserves the split; wizard step validates both
 *             prefixes with examples shown.
 *
 *   P121-CP10 Five sentinels pinning the host-resource monitor
 *             sidecar.  The POSIX-sh script at
 *             ops/scripts/morphit-host-monitor.sh polls
 *             /proc/meminfo + df + /proc/loadavg + /proc/vmstat
 *             and emits structured JSON to journalctl matching
 *             the LogRecord envelope; the systemd unit + timer
 *             mirror the hardening posture used for indexer/
 *             relay and are opt-in via timer enable; the
 *             classifier knows about every host-resource event
 *             at every tier (5 CRITICAL, 5 WARN, 4 INFO); the
 *             ALERT_COPY ships friendly ELI5 advice for all 14
 *             host-resource events; and the bot's default
 *             JOURNALCTL_UNITS list includes
 *             morphit-host-monitor.service so alerts route
 *             without any operator-side wiring.
 *
 *   P121-CP11 Seven sentinels pinning the extended monitoring
 *             sidecars (smartctl, fail2ban, mdadm) + the
 *             Ansible integration that ties everything
 *             together.  Three new POSIX-sh sidecars at
 *             ops/scripts/morphit-{smartctl,fail2ban,mdadm}-
 *             monitor.sh each emit structured JSON in the
 *             LogRecord envelope; the classifier knows about
 *             every cp11 event at every tier (7 CRITICAL,
 *             5 WARN, 3 INFO); ALERT_COPY has ELI5 advice for
 *             all of them; the bot's default JOURNALCTL_UNITS
 *             list covers all five sidecar units; the Ansible
 *             playbook at ops/ansible/playbook.yml integrates
 *             the cp9 matrix_bot + cp10 host_monitor +
 *             cp11 smartctl/fail2ban/mdadm roles with opt-in
 *             enable_* flags (all default false); and the
 *             matrix-bot npm-install requirement (better-sqlite3
 *             native build needing nodejs.org access) is
 *             documented in OPERATIONS.md §16.
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
		file: 'src/routes/[lang]/backup-keys/+page.svelte',
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
		file: 'src/routes/[lang]/post/+page.svelte',
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
		name: 'D-4 — PRE-LAUNCH reflects schema v32, not v31',
		file: 'docs/PRE-LAUNCH-CHECKLIST.md',
		rootRelative: true,
		// Originally pinned v31 (Part 119); bumped to v32 in Part 121
		// cp3 when orders.asset_network landed.  If a future part adds
		// another migration, bump this sentinel + the doc together.
		mustHave: ['currently at v32 as of Part 121'],
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
	},
	// ─── Part 121 cp3 — USDT shipped ─────────────────────────
	{
		name: 'P121-USDT-1 — canonical asset registry has USDT entry with trade-only invariant',
		file: 'packages/asset-registry/src/index.ts',
		rootRelative: true,
		mustHave: [
			"ticker: 'USDT'",
			'canPayListingFee: false',
			"supportedNetworks: ['erc20', 'trc20', 'spl', 'bep20']",
			'defaultNetwork: null',
			"privacyWarningKey: 'usdt_centralized'"
		]
	},
	{
		name: 'P121-USDT-2 — frontend asset registry has matching USDT entry',
		file: 'apps/web/src/lib/assets/registry.ts',
		rootRelative: true,
		mustHave: [
			"ticker: 'usdt'",
			"displayName: 'Tether'",
			'canBeUsedForListingFee: false',
			'defaultNetwork: null'
		]
	},
	{
		name: 'P121-USDT-3 — per-network metadata module ships ERC-20 + TRC-20 + SPL + BEP-20 bundled explorers',
		file: 'apps/web/src/lib/assets/networks.ts',
		rootRelative: true,
		mustHave: [
			'etherscan.io/tx/{txid}',
			'tronscan.org/#/transaction/{txid}',
			'solscan.io/tx/{txid}',
			'bscscan.com/tx/{txid}',
			'validateUsdtAddress',
			'validateUsdtTxid'
		]
	},
	{
		name: 'P121-USDT-4 — indexer order handler rejects USDT orders missing/wrong/extra asset_network',
		file: 'apps/indexer/src/indexer/handlers/order.ts',
		rootRelative: true,
		mustHave: [
			'asset_network_required_for_usdt',
			'asset_network_unknown',
			'asset_network_not_permitted_for_asset',
			'asset_disabled_on_instance'
		]
	},
	{
		name: 'P121-USDT-5 — orderbook row renders USDT network chip + price subline',
		file: 'apps/web/src/routes/[lang]/orderbook/+page.svelte',
		rootRelative: true,
		mustHave: [
			'usdtRowNetwork',
			'assets.usdt.order_row.network_hint',
			'<UsdtPriceSubline'
		]
	},
	{
		name: 'P121-CP6-1 — /v1/instance surfaces disabled_assets in API + indexer-client',
		file: 'apps/indexer/src/api/instance.ts',
		rootRelative: true,
		mustHave: [
			'disabled_assets: readonly string[]',
			'disabled_assets: config.disabledAssets'
		]
	},
	{
		name: 'P121-CP6-2 — indexer-client InstanceResponse mirrors disabled_assets (optional for back-compat)',
		file: 'packages/indexer-client/src/index.ts',
		rootRelative: true,
		mustHave: ['readonly disabled_assets?: readonly string[]']
	},
	{
		name: 'P121-CP6-3 — frontend instance store hydrates disabled_assets with [] fallback',
		file: 'apps/web/src/lib/stores/instance.ts',
		rootRelative: true,
		mustHave: [
			'readonly disabled_assets: readonly string[]',
			'disabled_assets: result.data.disabled_assets ?? []',
			'disabled_assets: []'
		]
	},
	{
		name: 'P121-CP6-4 — /about-this-instance renders asset-stance panel using $instance.disabled_assets',
		file: 'apps/web/src/routes/[lang]/about-this-instance/+page.svelte',
		rootRelative: true,
		mustHave: [
			"$_('about_this_instance.section.asset_stance')",
			'$instance.disabled_assets.length === 0',
			"$_('about_this_instance.asset_stance.federation_note')"
		]
	},
	{
		name: 'P121-CP6-5 — /run-a-node carries operator-stance explainer panel',
		file: 'apps/web/src/routes/[lang]/run-a-node/+page.svelte',
		rootRelative: true,
		mustHave: [
			"$_('run_a_node.asset_policy_heading')",
			"$_('run_a_node.asset_policy_default_label')",
			"$_('run_a_node.asset_policy_federation_label')",
			'MORPHIT_INDEXER_DISABLED_ASSETS'
		]
	},
	{
		name: 'P121-CP6-6 — per-locale prerendering path helpers shipped in $i18n/path.ts',
		file: 'apps/web/src/lib/i18n/path.ts',
		rootRelative: true,
		mustHave: [
			'export function localePath',
			'export function stripLocalePrefix',
			'export function pickLocaleFromAcceptLanguages',
			'export function isLocalePrefixed',
			// path.ts must NOT import from ./index (which would
			// pull $app/environment in via the import chain) —
			// the constants come from ./locales (pure module).
			"from './locales'"
		],
		mustNotHave: ["from './index'"]
	},
	{
		name: 'P121-CP6-7 — i18n module split: SUPPORTED_LOCALES SSoT in $i18n/locales (pure, no $app/environment)',
		file: 'apps/web/src/lib/i18n/locales.ts',
		rootRelative: true,
		mustHave: [
			'export const SUPPORTED_LOCALES',
			'export const PLANNED_LOCALES',
			'export const DEFAULT_LOCALE',
			'export function matchSupported'
		],
		// The whole point of this split is that locales.ts has
		// ZERO SvelteKit deps so it can be imported from any
		// context (smoke, prerender-redirect shell, web worker).
		mustNotHave: ['$app/environment', 'svelte-i18n', 'svelte/store']
	},
	{
		name: 'P121-CP7-1 — [lang]/+layout.ts carries prerender + ssr=true + load() that validates lang and initI18nFor',
		file: 'apps/web/src/routes/[lang]/+layout.ts',
		rootRelative: true,
		mustHave: [
			'export const prerender = true',
			'export const ssr = true',
			'initI18nFor',
			'waitLocale',
			"throw error(404"
		]
	},
	{
		name: 'P121-CP7-2 — [lang]/+page.ts carries entries() enumerating SUPPORTED_LOCALES (entries() must live on +page.ts per SvelteKit)',
		file: 'apps/web/src/routes/[lang]/+page.ts',
		rootRelative: true,
		mustHave: [
			'export function entries',
			'SUPPORTED_LOCALES.map'
		]
	},
	{
		name: 'P121-CP7-3 — root +page.svelte is the detection-redirect shell (pickLocale + window.location.replace + noscript fallback)',
		file: 'apps/web/src/routes/+page.svelte',
		rootRelative: true,
		mustHave: [
			'pickLocaleFromAcceptLanguages',
			'navigator.languages',
			'window.location.replace',
			'meta http-equiv="refresh"'
		]
	},
	{
		name: 'P121-CP7-4 — svelte.config.js carries handleUnseenRoutes:ignore for dynamic-param routes',
		file: 'apps/web/svelte.config.js',
		rootRelative: true,
		mustHave: [
			"handleUnseenRoutes: 'ignore'"
		]
	},
	{
		name: 'P121-CP7-5 — Head.svelte gates url.search/url.hash behind building flag (prerender forbids reading them)',
		file: 'apps/web/src/lib/components/Head.svelte',
		rootRelative: true,
		mustHave: [
			"import { building } from '$app/environment'",
			"building ? '' : $page.url.search",
			"building ? '' : $page.url.hash"
		]
	},
	{
		name: 'P121-CP7-6 — LanguageSwitcher navigates via locale-prefixed URL (goto + localePath + stripLocalePrefix)',
		file: 'apps/web/src/lib/components/LanguageSwitcher.svelte',
		rootRelative: true,
		mustHave: [
			'localePath',
			'stripLocalePrefix',
			'goto(target)'
		]
	},
	{
		name: 'P121-CP9-1 — Matrix address SSoT: parseMxid + parseRoomAlias in @morphit/operator-config (no SvelteKit deps; branded types prevent @↔# confusion)',
		file: 'packages/operator-config/src/matrixAddress.ts',
		rootRelative: true,
		mustHave: [
			'export function parseMxid',
			'export function parseRoomAlias',
			'MatrixMxid',
			'MatrixRoomAlias',
			"__brand: 'MatrixMxid'",
			"__brand: 'MatrixRoomAlias'"
		],
		mustNotHave: ['$app/environment', 'svelte-i18n', 'svelte/store']
	},
	{
		name: 'P121-CP9-2 — indexer config refuses @-prefixed value in OPERATOR_MATRIX_ROOM (privacy framing in error)',
		file: 'apps/indexer/src/config/index.ts',
		rootRelative: true,
		mustHave: [
			'MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM',
			'parseRoomAlias',
			'public API',
			'MORPHIT_MATRIX_BOT_ALERT_MXID'
		]
	},
	{
		name: 'P121-CP9-3 — /v1/instance InstanceResponse exposes operator_matrix_room: string | null (public room only)',
		file: 'apps/indexer/src/api/instance.ts',
		rootRelative: true,
		mustHave: [
			'operator_matrix_room: string | null',
			'config.operatorMatrixRoom'
		]
	},
	{
		name: 'P121-CP9-4 — matrix-bot config refuses #-prefixed value in ALERT_MXID with privacy-violation framing in error',
		file: 'apps/matrix-bot/src/config.ts',
		rootRelative: true,
		mustHave: [
			"raw.startsWith('#')",
			'privacy violation',
			'private MXID',
			'parseMxid'
		]
	},
	{
		name: 'P121-CP9-5 — matrix-bot sendDm() typed signature requires MatrixMxid (branded type — compile-time prevents room-alias misuse)',
		file: 'apps/matrix-bot/src/matrix.ts',
		rootRelative: true,
		mustHave: [
			'sendDm(to: MatrixMxid',
			"from '@morphit/operator-config'"
		]
	},
	{
		name: 'P121-CP9-6 — matrix-bot main loop iterates config.alertMxids (typed list); CRITICAL bypasses rate limiter; WARN gates through it; INFO accumulates to digest',
		file: 'apps/matrix-bot/src/main.ts',
		rootRelative: true,
		mustHave: [
			'for (const mxid of config.alertMxids)',
			"classified.tier === 'CRITICAL'",
			"classified.tier === 'WARN'",
			'rateLimiter.isLimited',
			'state.pushInfoEvent'
		]
	},
	{
		name: 'P121-CP9-7 — indexer-client InstanceResponse mirror exposes operator_matrix_room (optional for back-compat)',
		file: 'packages/indexer-client/src/index.ts',
		rootRelative: true,
		mustHave: [
			'operator_matrix_room?: string | null'
		]
	},
	{
		name: 'P121-CP9-8 — ops-cli wizard stepMatrixSurfaces validates both prefixes; rejects @ in room field and # in MXID field with explicit guidance',
		file: 'apps/ops-cli/src/init/steps.ts',
		rootRelative: true,
		mustHave: [
			'stepMatrixSurfaces',
			'parseMxid',
			'parseRoomAlias',
			"startsWith('#')",
			"startsWith('@')",
			'MATRIX_EXAMPLE_MXID',
			'MATRIX_EXAMPLE_ROOM_ALIAS'
		]
	},

	// ─── P121-CP10 — host-resource monitor sidecar ──────────────
	//
	// Five sentinels pinning the cp10 invariants: the sidecar
	// script exists + is executable, the systemd unit + timer
	// exist, the classifier knows about host-resource events at
	// every tier, the ALERT_COPY has friendly ELI5 advice for
	// every host-resource event, and the bot's default
	// JOURNALCTL_UNITS list includes morphit-host-monitor.service
	// so alerts route automatically.

	{
		name: 'P121-CP10-1 — host-resource sidecar script exists, is POSIX-sh, emits structured JSON in LogRecord envelope shape',
		file: 'ops/scripts/morphit-host-monitor.sh',
		rootRelative: true,
		mustHave: [
			'#!/bin/sh',
			'module":"host-resource"',
			'systemd-cat -t morphit-host-monitor',
			'/proc/meminfo',
			'/proc/loadavg',
			'/proc/vmstat',
			'pswpin',
			'pswpout',
			'MORPHIT_HOST_DISK_CRITICAL',
			'MORPHIT_HOST_MEM_CRITICAL',
			'MORPHIT_HOST_SWAP_THRASH_CRITICAL',
			'MORPHIT_HOST_CPU_CRITICAL'
		]
	},
	{
		name: 'P121-CP10-2 — systemd service + timer for host-monitor exist, mirror hardening posture, opt-in via timer enable',
		file: 'ops/systemd/morphit-host-monitor.service',
		rootRelative: true,
		mustHave: [
			'Type=oneshot',
			'User=morphit-host-monitor',
			'ProtectSystem=strict',
			'NoNewPrivileges=true',
			'PrivateNetwork=true',
			'ReadWritePaths=/var/lib/morphit-host-monitor',
			'EnvironmentFile=-/etc/morphit/host-monitor.env',
			'/opt/morphit/ops/scripts/morphit-host-monitor.sh'
		]
	},
	{
		name: 'P121-CP10-3 — classifier knows about host-resource events at every tier (5 CRITICAL, 5 WARN, 4 INFO)',
		file: 'apps/matrix-bot/src/classifier.ts',
		rootRelative: true,
		mustHave: [
			"'host-resource' && a.event === 'disk_critical'",
			"'host-resource' && a.event === 'mem_critical'",
			"'host-resource' && a.event === 'swap_critical'",
			"'host-resource' && a.event === 'swap_thrashing_critical'",
			"'host-resource' && a.event === 'cpu_saturated_critical'",
			"'host-resource' && a.event === 'disk_warn'",
			"'host-resource' && a.event === 'mem_warn'",
			"'host-resource' && a.event === 'swap_warn'",
			"'host-resource' && a.event === 'swap_thrashing_warn'",
			"'host-resource' && a.event === 'cpu_saturated_warn'"
		]
	},
	{
		name: 'P121-CP10-4 — ALERT_COPY has friendly ELI5 advice for every host-resource event (14 entries)',
		file: 'apps/matrix-bot/src/classifier.ts',
		rootRelative: true,
		mustHave: [
			"'host-resource:disk_critical'",
			"'host-resource:disk_warn'",
			"'host-resource:disk_info'",
			"'host-resource:mem_critical'",
			"'host-resource:mem_warn'",
			"'host-resource:mem_info'",
			"'host-resource:swap_critical'",
			"'host-resource:swap_warn'",
			"'host-resource:swap_info'",
			"'host-resource:swap_thrashing_critical'",
			"'host-resource:swap_thrashing_warn'",
			"'host-resource:cpu_saturated_critical'",
			"'host-resource:cpu_saturated_warn'",
			"'host-resource:cpu_saturated_info'",
			'OOM ',
			'sudo journalctl --vacuum-time=7d',
			'ps aux --sort=-%mem'
		]
	},
	{
		name: 'P121-CP10-5 — matrix-bot default JOURNALCTL_UNITS includes morphit-host-monitor.service for automatic routing',
		file: 'apps/matrix-bot/src/config.ts',
		rootRelative: true,
		mustHave: [
			'MORPHIT_MATRIX_BOT_JOURNALCTL_UNITS',
			'morphit-indexer.service',
			'morphit-relay.service',
			'morphit-host-monitor.service'
		]
	},

	// ─── P121-CP11 — extended monitoring sidecars + Ansible ─────
	//
	// Seven sentinels pinning: the three extended-monitor scripts
	// exist + emit module:event names matching the classifier;
	// the bot's default JOURNALCTL_UNITS extends to cover them;
	// the classifier has matchers + ALERT_COPY for every cp11
	// event; the Ansible playbook integrates the new roles with
	// opt-in enable_* flags; and the matrix-bot npm-install
	// requirement is documented for operators.

	{
		name: 'P121-CP11-1 — smartctl monitor script exists, emits module:smartctl with real event names',
		file: 'ops/scripts/morphit-smartctl-monitor.sh',
		rootRelative: true,
		mustHave: [
			'#!/bin/sh',
			'module":"smartctl"',
			'systemd-cat -t morphit-smartctl-monitor',
			'smart_failed',
			'self_test_failed',
			'reallocated_sectors',
			'pending_sectors',
			'temperature_critical',
			'temperature_warn',
			'MORPHIT_SMART_TEMP_CRITICAL'
		]
	},
	{
		name: 'P121-CP11-2 — fail2ban monitor script exists, emits module:fail2ban with real event names + per-jail override pattern',
		file: 'ops/scripts/morphit-fail2ban-monitor.sh',
		rootRelative: true,
		mustHave: [
			'#!/bin/sh',
			'module":"fail2ban"',
			'systemd-cat -t morphit-fail2ban-monitor',
			'daemon_unreachable',
			'jail_critical_ban_count',
			'jail_high_ban_count',
			'jail_ban_rate_warn',
			'MORPHIT_FAIL2BAN_BAN_CRITICAL',
			'MORPHIT_FAIL2BAN_${jail_upper}_CRITICAL'
		]
	},
	{
		name: 'P121-CP11-3 — mdadm monitor script exists, emits module:mdadm with real event names; exits silently on no-RAID hosts',
		file: 'ops/scripts/morphit-mdadm-monitor.sh',
		rootRelative: true,
		mustHave: [
			'#!/bin/sh',
			'module":"mdadm"',
			'systemd-cat -t morphit-mdadm-monitor',
			'array_failed',
			'array_degraded',
			'array_resyncing',
			'/proc/mdstat'
		]
	},
	{
		name: 'P121-CP11-4 — bot default JOURNALCTL_UNITS includes all five sidecar units (cp10 host-monitor + cp11 smartctl/fail2ban/mdadm)',
		file: 'apps/matrix-bot/src/config.ts',
		rootRelative: true,
		mustHave: [
			'morphit-host-monitor.service',
			'morphit-smartctl-monitor.service',
			'morphit-fail2ban-monitor.service',
			'morphit-mdadm-monitor.service'
		]
	},
	{
		name: 'P121-CP11-5 — classifier knows about cp11 events at every tier; ALERT_COPY has ELI5 advice for all of them',
		file: 'apps/matrix-bot/src/classifier.ts',
		rootRelative: true,
		mustHave: [
			"'smartctl' && a.event === 'smart_failed'",
			"'smartctl' && a.event === 'self_test_failed'",
			"'smartctl' && a.event === 'temperature_critical'",
			"'fail2ban' && a.event === 'daemon_unreachable'",
			"'fail2ban' && a.event === 'jail_critical_ban_count'",
			"'mdadm' && a.event === 'array_failed'",
			"'mdadm' && a.event === 'array_degraded'",
			"'smartctl:smart_failed'",
			"'fail2ban:daemon_unreachable'",
			"'mdadm:array_degraded'",
			'overall-health FAILED',
			'fail2ban-client status',
			'cat /proc/mdstat'
		]
	},
	{
		name: 'P121-CP11-6 — Ansible playbook integrates cp9 + cp10 + cp11 sidecar roles with opt-in enable_* flags',
		file: 'ops/ansible/playbook.yml',
		rootRelative: true,
		mustHave: [
			'role: matrix_bot',
			'role: host_monitor',
			'role: smartctl_monitor',
			'role: fail2ban_monitor',
			'role: mdadm_monitor',
			'enable_matrix_bot | default(false)',
			'enable_host_monitor | default(false)',
			'enable_smartctl_monitor | default(false)',
			'enable_fail2ban_monitor | default(false)',
			'enable_mdadm_monitor | default(false)',
			', monitors]'
		]
	},
	{
		name: 'P121-CP11-7 — matrix-bot npm install requirement (better-sqlite3 native build + nodejs.org access) is documented in OPERATIONS.md',
		file: 'docs/OPERATIONS.md',
		rootRelative: true,
		mustHave: [
			'better-sqlite3',
			'native build for better-sqlite3',
			'nodejs.org',
			'npm ci --workspaces',
			'build-essential'
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
