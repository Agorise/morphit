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
 *   P121-CP12 Four sentinels pinning the cp12 quality-gates +
 *             extended-extended sidecars work.  Two new
 *             tsx-based smokes (ansible-structural-smoke +
 *             ansible-lint-smoke) registered in run-smokes.sh
 *             catch playbook drift on every CI run.  Three new
 *             POSIX-sh sidecars at ops/scripts/morphit-{dmesg,
 *             trivy,postfix}-monitor.sh emit structured JSON
 *             via systemd-cat: dmesg-monitor scans the kernel
 *             ring buffer for OOM/oops/panic/MCE/segfaults
 *             using a cursor-based state file so successive
 *             runs don't re-alert; trivy-monitor daily-scans
 *             running Docker images for CRITICAL+HIGH CVEs;
 *             postfix-monitor checks mail queue depth + age
 *             so silent alerting failures (smarthost down,
 *             credentials rotated) become alerts of their
 *             own.  Classifier extended with 17 new events
 *             (8 CRITICAL, 5 WARN, 5 INFO) + ALERT_COPY
 *             entries with ELI5 advice including the exact
 *             debug commands an operator should run.  Bot's
 *             default JOURNALCTL_UNITS now covers ALL EIGHT
 *             sidecar units (indexer + relay + 6 monitors)
 *             with zero operator-side wiring needed.
 *
 *   P121-CP13 Five sentinels pinning the cp13 CI workflow +
 *             three more sidecars + matrix-bot deps-pin check.
 *             Forgejo Actions workflow at .forgejo/workflows/
 *             ci.yml runs three gate jobs on every push and PR
 *             (typecheck-sweep, ansible-lint, smokes triple-
 *             pulse) — the same discipline manually applied at
 *             every tarball seal now runs automatically.  Three
 *             new POSIX-sh sidecars: certbot-monitor catches
 *             the killer "renewal silently broke months ago"
 *             pattern by checking cert expiry AGAINST recent
 *             successful renewal age (not just expiry alone);
 *             apt-monitor surfaces pending security update
 *             counts that operators stop reading off the motd
 *             after the first month; compose-monitor watches
 *             Docker Compose service health + restart loops.
 *             matrix-bot-deps-pin-check smoke catches the
 *             "tested against 0.7.1, deployed against 0.8.0"
 *             class of bug by comparing declared semver ranges
 *             in apps/matrix-bot/package.json against what's
 *             actually installed in node_modules.  Bot's
 *             default JOURNALCTL_UNITS now covers ALL ELEVEN
 *             sidecar units (indexer + relay + 9 monitors).
 *
 *   P121-CP14 Five sentinels pinning the cross-language drift
 *             gap close + systemd/journald sidecars + cross-
 *             workspace deps-pin + tag-push release workflow.
 *             sidecar-envelope-smoke.ts captures the output of
 *             every bash sidecar with mocked systemd-cat and
 *             validates each emission against a zod schema
 *             matching the canonical LogRecord interface — the
 *             missing regression test that locks down the
 *             bash-emits-JSON / TS-classifier-consumes-JSON
 *             contract.  Additionally validates that every
 *             event name in every sidecar follows the
 *             lowercase_snake convention (catches the cp9 bug
 *             class at source).  workspace-deps-pin-check.ts
 *             generalizes the cp13 matrix-bot-only check to
 *             ALL workspaces (apps/ + packages/), catching
 *             version drift across the monorepo not just one
 *             corner.  Two new POSIX-sh sidecars: systemd-
 *             monitor watches morphit-* unit health + restart
 *             counts — fills the gap journalctl-alerting can't
 *             cover (a unit that fails to start emits no
 *             journal output); journald-monitor watches the
 *             journal's own disk usage + rotation health,
 *             catching the "journal silently grew to 8 GB
 *             over 6 months" pattern.  Forgejo release.yml
 *             workflow fires on tag push to build a signed
 *             release tarball after running the full
 *             validation gate again.  Bot's default
 *             JOURNALCTL_UNITS now covers ALL FOURTEEN units.
 *
 *   P121-CP15 Five sentinels pinning the API-response zod
 *             smoke + shared emit() lib + host-monitor mount
 *             sweep + smartctl SCT thermal-log extension.
 *             api-response-shape-smoke.ts extends the
 *             envelope-smoke pattern from sidecars to HTTP
 *             API: zod schemas for 10 representative response
 *             shapes (HealthResponse, InstanceResponse,
 *             OrderRecord, etc.) with TS-type-cross-check via
 *             `satisfies` clauses on sample literals — drift
 *             between the schema and the canonical TS
 *             interface from @morphit/indexer-client fails
 *             typecheck at CI time, not at production-debug
 *             time.  ops/scripts/lib/emit.sh extracts iso_now()
 *             json_str() emit() helpers into a shared lib that
 *             all 12 sidecars source via `. "$(dirname "$0")/
 *             lib/emit.sh"` — removed ~180 lines of duplicate
 *             boilerplate across the sidecar fleet.  host-
 *             monitor extended with a bind-mount + tmpfs sweep
 *             via `df --output=target,pcent,fstype` that skips
 *             pseudo-filesystems (proc/sysfs/cgroup/squashfs)
 *             and emits mount_critical/warn/info for any non-
 *             root mount crossing thresholds — catches Docker
 *             volumes filling, runaway tmpfs, encrypted
 *             overlay mounts the operator forgot.  smartctl-
 *             monitor extended with SCT thermal-log scraping
 *             via `smartctl -l scttempsts` — surfaces
 *             temperature_sustained_high (drive hit WARN+
 *             range at some point in its lifetime) and
 *             temperature_overlimit_count (drive firmware
 *             itself flagged thermal stress) that the
 *             instantaneous-temp check can't see.
 *
 *   P121-CP16 Three sentinels pinning the SSE-stream shape
 *             smoke + expanded REST-API coverage.
 *             sse-stream-shape-smoke.ts ports cp15's contract-
 *             validation pattern to the three Server-Sent
 *             Events endpoints (/v1/orderbook/stream,
 *             /v1/instances/stream, /v1/chat/:a/:b/stream).
 *             Each event-type payload gets a zod schema and a
 *             `satisfies` cross-check against the canonical
 *             TS interface — drift between server emit and
 *             client parse fails CI rather than breaking
 *             every connected EventSource at once.  The
 *             api-response-shape smoke is also expanded from
 *             10 schemas to 27 — covering OrderViews,
 *             Orderbook (paged), Featured slots, Account
 *             orders, Profiles, Operator stats, Chat identity,
 *             Conversations, Blocks, Chat history, and
 *             Instance directory paged responses.  Together
 *             54 REST-shape + 18 SSE-shape contract checks
 *             on every CI run.
 *
 *   P121-CP17 Two sentinels pinning the final lower-traffic
 *             schema coverage.  api-response-shape smoke now
 *             covers ALL @morphit/indexer-client response
 *             types (76 checks across 38 interfaces): the
 *             cp16 set plus ClearingPricePoint, ClearingPrice-
 *             HistoryResponse, BatchProfilesResponse, Feedback-
 *             Record (with rating literal-union + nested
 *             responses array), FeedbackResponseRecord,
 *             AccountFeedback{,Given}Response, ChatReadState-
 *             Entry/Response, AttestorEligibilityResponse,
 *             StrangerFeeQuoteResponse.  Schema-as-contract
 *             coverage for the indexer is complete; relay-
 *             side ad-hoc JSON responses remain a separate
 *             follow-up since they don't yet share a types
 *             package the smoke can satisfies-check against.
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
	/** Optional positional check: `before` substring must appear at a smaller
	 *  byte offset than `after`.  Useful when ordering of two phrases matters
	 *  (e.g. a security warning must come before a free-text input field). */
	readonly assertOrdering?: {
		readonly before: string;
		readonly after: string;
	};
	/** Optional regex-based regression sentinels.  Fails if ANY match exists in
	 *  the file.  Use this for class-of-pattern checks where listing every
	 *  literal forbidden string would be incomplete (e.g. "no hardcoded
	 *  English ariaLabel anywhere", which would silently miss any new ticker
	 *  added without updating the literal list).  Each entry is a (pattern,
	 *  reason) pair so failure diagnostics can name the invariant being
	 *  defended.  Patterns must be `RegExp` (not string) so the smoke
	 *  surfaces flag-handling explicitly. */
	readonly assertNoRegexMatch?: readonly {
		readonly pattern: RegExp;
		readonly reason: string;
	}[];
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
		],
		// Part 122 cp6 F7: broaden coverage beyond the three literals
		// above.  Any future asset (USDT, LTC, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP, ...) added with a
		// hardcoded `ariaLabel="What is X?"` Tooltip prop pattern would
		// regress S-12 without firing the literal list.  The regex
		// catches every `ariaLabel="..."` Svelte prop with a literal
		// string value on this page, regardless of asset name.
		// Acceptable forms must derive from i18n via `effectiveAriaLabel`
		// (no ariaLabel prop set) or a `{$_("...")}` expression value
		// (which the regex doesn't match because `{` ≠ `"`).
		assertNoRegexMatch: [
			{
				pattern: /\bariaLabel="[^"]*"/,
				reason:
					'Tooltip ariaLabel must come from i18n (omit prop → effectiveAriaLabel default, OR pass {$_("...")} expression). Hardcoded literal blocks translation for the screen-reader label.'
			}
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
		name: 'D-4 — PRE-LAUNCH reflects collapsed schema with v33 features',
		file: 'docs/PRE-LAUNCH-CHECKLIST.md',
		rootRelative: true,
		// Originally pinned v31 (Part 119); bumped to v32 in Part 121
		// cp3 when orders.asset_network landed; bumped to v33 in Part
		// 122 cp13 when push_subscriptions + push_pending landed.
		// Part 122 cp82 refactored the wording to reflect the
		// collapsed-migration reality (MIGRATIONS[] stops at v1 which
		// subsumes v1-v27; v28-v33 features live inline in schema.sql)
		// — the anchor now pins both `schema_migrations.version = 1`
		// (the current MIGRATIONS[] head) AND the v33-feature
		// inventory phrase that any future v34 addition must update.
		// If a future part adds another migration, bump BOTH this
		// sentinel + the doc together.
		mustHave: [
			'`schema_migrations.version = 1`',
			'`push_subscriptions`',
			'`extension_count`'
		],
		mustNotHave: ['currently at v29 as of Part 108++', 'currently at v32 as of']
	},
	{
		// Part 122 cp2 — F5 finding from cp1 audit.
		//
		// The migration model collapsed v2-v27 into v1 (May 2026 audit).
		// v28-v32 changes live INLINE in schema.sql, but MIGRATIONS[]
		// in migrations.ts stops at v1.  This works pre-launch (fresh
		// deploys apply schema.sql which contains all v28-v32 DDL), but
		// has a latent foot-gun post-launch: if someone adds v33 DDL to
		// schema.sql without ALSO adding a MIGRATIONS[33] entry, an
		// upgrade-install would silently miss v33's changes (because
		// schema_migrations sees v1 already applied, and MIGRATIONS[]
		// has nothing after v1).  This sentinel catches the drift at
		// PR time: pinning the canonical head version in schema.sql
		// against this assertion means any v33 addition fails the
		// smoke until either (a) MIGRATIONS[33] is added too, or (b)
		// this sentinel is consciously bumped to v33 (which requires
		// thinking about whether the inline-without-MIGRATIONS pattern
		// is still right).  Belt-and-braces with the existing
		// validateMigrationsContract() runtime check.
		//
		// Maintenance: every schema version bump REQUIRES updating
		// THREE places in the same work unit:
		//   1. apps/indexer/src/db/schema.sql (the actual DDL)
		//   2. docs/PRE-LAUNCH-CHECKLIST.md (D-4 above)
		//   3. this sentinel
		// If post-launch you also add MIGRATIONS[vN], that's a fourth
		// site.  Three drift-anchors all pulling the same direction.
		name: 'P122-CP2-F5 — schema.sql canonical head version pinned (cp1 F5 fix)',
		file: 'apps/indexer/src/db/schema.sql',
		rootRelative: true,
		// The canonical head is v33 (Part 122 cp13 — push_subscriptions
		// + push_pending tables, with cp14 adding the `locale` column).
		// This line is a late version-header comment in schema.sql; if
		// it changes the sentinel fails, forcing the maintainer to
		// either bump the sentinel (and check D-4 above) or revert
		// the schema change.  Part 122 cp82 audit bumped this anchor
		// from v32 (the original pin) to v33 — the sentinel was
		// passing on a stale anchor because schema.sql contained
		// BOTH `v32 / Part 121` AND `v33 / Part 122 cp13` headers
		// (the inline-without-MIGRATIONS pattern this sentinel was
		// designed to catch had already started to drift).  cp82
		// re-anchors at v33 to restore the load-bearing property.
		mustHave: ['v33 / Part 122 cp13 — Web Push subscription storage + delivery queue']
	},
	{
		// Part 122 cp3 — DNS-rebinding closure in federationProbe.
		//
		// Cp7 REVISIT §A documented the gap: the existing hostname
		// denylist catches `https://127.0.0.1/` etc., but a hostname
		// resolving to a private IP at fetch time would bypass the
		// check.  cp3 closes the gap with a three-layer defense:
		//   1. isPrivateHostname() — literal-string check (existing)
		//   2. resolveAndValidatePublicIp() — DNS lookup +
		//      per-IP validation against private-network deny list
		//   3. buildPinnedAgent() — undici dispatcher whose
		//      connect-time lookup is hard-coded to the pre-validated
		//      IP (closes the TOCTOU between our validation and
		//      undici's own resolution)
		//
		// Sentinel pins all three layers + the test-injection hook
		// that keeps smokes offline-deterministic.  If a future
		// refactor strips the dispatcher or skips the pre-validation,
		// the sentinel catches it at PR time.
		name: 'P122-CP3 — federationProbe has 3-layer DNS-rebinding defense (hostname denylist + DNS-resolved IP validation + pinned dispatcher)',
		file: 'apps/indexer/src/indexer/federationProbe.ts',
		rootRelative: true,
		mustHave: [
			'export function isPrivateHostname',
			'export function isPrivateIp',
			'resolveAndValidatePublicIp',
			'buildPinnedAgent',
			'dispatcher: pinnedAgent',
			"import { Agent } from 'undici'",
			"import { lookup as dnsLookup } from 'node:dns/promises'",
			// IPv4-mapped IPv6 unwrap is the subtle one — explicitly
			// pin its presence so a future refactor doesn't drop it.
			'::ffff:',
			// CGNAT range (RFC 6598) — added in cp3 because operators
			// sometimes have internal services in 100.64/10.
			'100\\.(6[4-9]'
		]
	},
	{
		// Part 122 cp4 — F9 (LOW) — paired-session "far past" check.
		//
		// pairedSession.ts docblock promised "Reject obviously-bogus
		// timestamps (negative, far past, far future)".  Pre-cp4 the
		// code only checked "negative" and "far future" — the "far
		// past" leg was missing.  Defense-contract drift surfaced
		// during cp4's Matrix/relay black-hat redux.  Cp4 closed it
		// with a `MAX_PAIRED_AGE_SECONDS` constant (365 days) +
		// matching test case.  Sentinel pins all three legs of the
		// contract against future drift.
		name: 'P122-CP4-F9 — pairedSession validator rejects far-past timestamps (matches docblock contract)',
		file: 'apps/web/src/lib/crypto/pairedSession.ts',
		rootRelative: true,
		mustHave: [
			'MAX_PAIRED_AGE_SECONDS',
			'365 * 86400',
			// All three legs of the docblock contract must be enforced.
			// Negative check:
			'r.pairedAt < 0',
			// Far-future check:
			'r.pairedAt > now + 86400',
			// Far-past check (the cp4 fix):
			'r.pairedAt < now - MAX_PAIRED_AGE_SECONDS'
		]
	},
	{
		// Part 122 cp5 — F10 (HIGH) — Jinja variable-name typo in
		// the Ansible npm-install task's changed_when expression.
		// Pre-cp5 the second clause referenced `npm_install_result`
		// which doesn't exist (registered name is
		// `morphit_npm_install_result`).  When npm produces output
		// without 'changed' (the typical first-install case), Jinja
		// evaluates the undefined variable and Ansible aborts the
		// playbook with `'npm_install_result' is undefined`.
		// Cp5 fixed by aligning both clauses on the registered name.
		// Sentinel pins the absence of the typo + the presence of
		// the correctly-named pair.
		name: 'P122-CP5-F10 — Ansible clone_and_build.yml npm-install changed_when references the actual registered name twice',
		file: 'ops/ansible/roles/morphit/tasks/clone_and_build.yml',
		rootRelative: true,
		mustHave: [
			"register: morphit_npm_install_result",
			"'changed' in morphit_npm_install_result.stdout or 'added' in morphit_npm_install_result.stdout"
		],
		mustNotHave: [
			// The pre-cp5 typo MUST NOT reappear.
			"'added' in npm_install_result.stdout"
		]
	},
	{
		// Part 122 cp5 — F11 (MEDIUM) — operator-doc chown
		// guidance must route /etc/morphit/relay.env to
		// `morphit-relay:morphit-relay`, not the dual-target
		// `morphit:morphit` that pre-cp5 had.  The shipped
		// morphit-relay.service runs as User=morphit-relay; an
		// operator following the pre-cp5 doc literally would chown
		// relay.env to a user the daemon doesn't run as, causing
		// "Permission denied" at relay boot.  Sentinel pins the
		// fixed chown line and the absence of the buggy combined-
		// chown.
		name: 'P122-CP5-F11 — RUN-A-MORPHIT-NODE chowns relay.env to morphit-relay (matching shipped systemd unit User=)',
		file: 'docs/RUN-A-MORPHIT-NODE.md',
		rootRelative: true,
		mustHave: [
			'sudo chown morphit-relay:morphit-relay /etc/morphit/relay.env'
		],
		mustNotHave: [
			// The pre-cp5 buggy combined-chown MUST NOT reappear.
			'sudo chown morphit:morphit /etc/morphit/indexer.env /etc/morphit/relay.env'
		]
	},
	{
		// Part 122 cp5 — F12 (HIGH) — Ansible base role must
		// create the `morphit-relay` system user BEFORE the
		// morphit role tries to enable the morphit-relay.service.
		// Pre-cp5 the playbook ran systemctl enable + start on
		// services that reference `User=morphit-relay` without
		// the user ever being created — a fresh-deploy hard fail.
		// Sentinel pins the user-creation task in the base role.
		name: 'P122-CP5-F12 — Ansible base role creates morphit-relay system user (referenced by shipped systemd unit User=morphit-relay)',
		file: 'ops/ansible/roles/base/tasks/main.yml',
		rootRelative: true,
		mustHave: [
			'Create morphit-relay system group',
			'Create morphit-relay system user',
			'name: morphit-relay',
			// Group membership: the relay user must be in the
			// morphit_service_group so it can read /etc/morphit/relay.env
			// (chowned root:morphit_service_group mode 0640 by the
			// morphit role).
			'groups: "{{ morphit_service_group }}"'
		]
	},
	{
		// Part 122 cp5 — F13 (LOW) — the relay.env.j2 template
		// must NOT carry a MORPHIT_RELAY_PASSPHRASE line.  No code
		// path consumes that env var (the relay unlocks via TTY
		// prompt or systemd LoadCredential); having it in the
		// template invites operators to leak their passphrase to
		// disk out of misplaced template-completionism.  Sentinel
		// pins the absence + the explanatory comment that
		// documents why.
		name: 'P122-CP5-F13 — relay.env.j2 has no dead MORPHIT_RELAY_PASSPHRASE env var (consumed by nothing; would leak passphrase to disk)',
		file: 'ops/ansible/roles/morphit/templates/relay.env.j2',
		rootRelative: true,
		mustHave: [
			'NO MORPHIT_RELAY_PASSPHRASE env var'
		],
		mustNotHave: [
			'MORPHIT_RELAY_PASSPHRASE={{'
		]
	},
	{
		// Part 122 cp5 — F14 (MEDIUM) — operator-doc wizard-step
		// number had drifted from the code.  OPERATIONS.md said
		// "morphit-ops init step 12 asks: Enable daily DB backup"
		// but in current code the backup prompt is step 15
		// (stepBackup at position 15 of 17 in
		// apps/ops-cli/src/commands/init.ts).  Pre-Part-109 backup
		// was step 12; Part 109 added stepFeeExplorers + stepChatLink
		// in front of it; subsequent steps were added too.  The doc
		// drifted three positions behind.
		//
		// Sentinel pins both legs of the contract:
		//   (a) TOTAL_STEPS = 18 in steps.ts (the canonical count)
		//   (b) OPERATIONS.md references "step 16" for backup
		//       (matching stepBackup's actual position)
		// If a future wizard restructure changes TOTAL_STEPS or
		// reorders stepBackup, this sentinel fails and forces
		// either the count or the doc to be updated.
		name: 'P122-CP5-F14 — wizard backup-step doc reference matches stepBackup position in code',
		file: 'docs/OPERATIONS.md',
		rootRelative: true,
		mustHave: [
			'`morphit-ops init` step 16 asks: "Enable daily DB backup automation?"'
		],
		mustNotHave: [
			'`morphit-ops init` step 12 asks: "Enable daily DB backup automation?"',
			'`morphit-ops init` step 15 asks: "Enable daily DB backup automation?"'
		]
	},
	{
		// Part 122 cp5 — F14 companion — TOTAL_STEPS pinned in
		// steps.ts.  If the wizard ever grows or shrinks the step
		// count, this sentinel fails so the OPERATIONS.md doc
		// references can be re-audited at the same turn.
		name: 'P122-CP5-F14b — wizard TOTAL_STEPS pinned (must update F14 doc reference if this changes)',
		file: 'apps/ops-cli/src/init/steps.ts',
		rootRelative: true,
		mustHave: [
			'const TOTAL_STEPS = 18;'
		]
	},
	{
		// Part 122 cp6 — schema-as-contract first layer.
		//
		// The signupClient module must import RelayErrorCode from
		// the shared @morphit/relay-client package, not duplicate
		// the literal union inline.  Pre-cp6 signupClient.ts had
		// its own copy of the ~25 relay error codes; if the relay
		// added a new code (e.g. 'name_reserved_for_operator') and
		// the client didn't add it too, the client would fall
		// through to 'broadcast_failed' for the new case — a
		// real-world drift class.  The shared package is the
		// single source of truth; this sentinel pins that the
		// import survives.
		name: 'P122-CP6 — signupClient imports RelayErrorCode from @morphit/relay-client (schema-as-contract)',
		file: 'apps/web/src/lib/auth/signupClient.ts',
		rootRelative: true,
		mustHave: [
			"import('@morphit/relay-client').RelayErrorCode"
		],
		// Pre-cp6 the codes were duplicated inline.  This sentinel
		// rejects the inline duplication pattern.  The mustNotHave
		// targets the two most distinctive relay-only codes; if
		// either reappears as a string literal in signupClient,
		// someone reinlined the union and broke the contract.
		mustNotHave: [
			"| 'invite_rate_limited'",
			"| 'spacing_cooldown'"
		]
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
		mustHave: ['~18 prompts', 'steps.ts'],
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
	// several smoke runners fail with `ERR_MODULE_NOT_FOUND`
	// referencing a `@morphit/*` package (count drifts across releases
	// as smokes are added or refactored; cp1 saw 13, cp22 saw 6, the
	// number itself is not load-bearing — the symptom + fix is what
	// matters).  These sentinels pin the doc claim against future
	// drift so an operator hitting the symptom finds the right
	// troubleshooting in three places.
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
			'MORPHIT_EMIT_MODULE="host-resource"',
			'MORPHIT_EMIT_TAG="morphit-host-monitor"',
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
			'MORPHIT_EMIT_MODULE="smartctl"',
			'MORPHIT_EMIT_TAG="morphit-smartctl-monitor"',
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
			'MORPHIT_EMIT_MODULE="fail2ban"',
			'MORPHIT_EMIT_TAG="morphit-fail2ban-monitor"',
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
			'MORPHIT_EMIT_MODULE="mdadm"',
			'MORPHIT_EMIT_TAG="morphit-mdadm-monitor"',
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
	},

	// ─── P121-CP12 — quality gates + further sidecars ────────────
	//
	// Four sentinels pinning: the Ansible quality gates
	// (ansible-lint + structural smoke), the three new sidecar
	// scripts (dmesg, trivy, postfix) emitting correct LogRecord
	// envelopes, classifier extension covering all cp12 events,
	// and bot's default JOURNALCTL_UNITS extending to all eight
	// monitoring sidecar units.

	{
		name: 'P121-CP12-1 — Ansible quality gates: ansible-lint + structural smoke registered in run-smokes.sh',
		file: 'scripts/run-smokes.sh',
		rootRelative: true,
		mustHave: [
			'apps/ops-cli:ansible-structural-smoke',
			'apps/ops-cli:ansible-lint-smoke'
		]
	},
	{
		name: 'P121-CP12-2 — dmesg monitor script + classifier matchers + ALERT_COPY for OOM/oops/panic/MCE/segfaults',
		file: 'apps/matrix-bot/src/classifier.ts',
		rootRelative: true,
		mustHave: [
			"'dmesg' && a.event === 'oom_kill'",
			"'dmesg' && a.event === 'kernel_oops'",
			"'dmesg' && a.event === 'kernel_panic'",
			"'dmesg' && a.event === 'hardware_error'",
			"'dmesg' && a.event === 'segfault_in_morphit'",
			"'dmesg' && a.event === 'segfault_other'",
			"'dmesg' && a.event === 'fd_exhausted'",
			"'dmesg:oom_kill'",
			"'dmesg:kernel_panic'",
			'OOM-killer activated',
			'Kernel panic detected'
		]
	},
	{
		name: 'P121-CP12-3 — trivy + postfix monitor scripts + classifier matchers + ALERT_COPY',
		file: 'apps/matrix-bot/src/classifier.ts',
		rootRelative: true,
		mustHave: [
			"'trivy' && a.event === 'image_critical_vulns'",
			"'trivy' && a.event === 'image_high_vulns'",
			"'postfix' && a.event === 'queue_critical'",
			"'postfix' && a.event === 'queue_warn'",
			"'trivy:image_critical_vulns'",
			"'postfix:queue_critical'",
			'CRITICAL severity CVEs',
			'alerting may be FAILING'
		]
	},
	{
		name: 'P121-CP12-4 — bot default JOURNALCTL_UNITS includes ALL eight sidecar units (indexer + relay + 6 monitor sidecars)',
		file: 'apps/matrix-bot/src/config.ts',
		rootRelative: true,
		mustHave: [
			'morphit-host-monitor.service',
			'morphit-smartctl-monitor.service',
			'morphit-fail2ban-monitor.service',
			'morphit-mdadm-monitor.service',
			'morphit-dmesg-monitor.service',
			'morphit-trivy-monitor.service',
			'morphit-postfix-monitor.service'
		]
	},

	// ─── P121-CP13 — CI workflow + 3 more sidecars + deps-pin ───
	//
	// Five sentinels pinning: the Forgejo CI workflow ships three
	// gate jobs (typecheck + ansible-lint + smokes triple-pulse);
	// the three new cp13 sidecars emit correct LogRecord envelopes
	// with their full event sets; classifier knows all cp13
	// events at every tier with ELI5 advice; the deps-pin-check
	// smoke catches matrix-bot-sdk drift; and the bot's default
	// JOURNALCTL_UNITS extends to all 11 sidecar units (indexer
	// + relay + 9 monitor sidecars).

	{
		name: 'P121-CP13-1 — Forgejo CI workflow ships three gate jobs (typecheck + ansible-lint + smokes)',
		file: '.forgejo/workflows/ci.yml',
		rootRelative: true,
		mustHave: [
			'name: morphit-ci',
			'job',
			'typecheck:',
			'ansible-lint:',
			'smokes:',
			'bash scripts/typecheck-sweep.sh',
			'bash scripts/run-smokes.sh',
			'ansible-lint --offline --strict',
			'for i in 1 2 3'
		]
	},
	{
		name: 'P121-CP13-2 — certbot monitor script + classifier matchers + renewal-stall detector',
		file: 'apps/matrix-bot/src/classifier.ts',
		rootRelative: true,
		mustHave: [
			"'certbot' && a.event === 'cert_expiry_critical'",
			"'certbot' && a.event === 'renewal_stalled'",
			"'certbot' && a.event === 'cert_expiry_warn'",
			"'certbot:renewal_stalled'",
			"'certbot:cert_expiry_critical'",
			'silently failing',
			'sudo certbot renew'
		]
	},
	{
		name: 'P121-CP13-3 — apt + compose monitor scripts + classifier matchers + ALERT_COPY',
		file: 'apps/matrix-bot/src/classifier.ts',
		rootRelative: true,
		mustHave: [
			"'apt' && a.event === 'security_updates_critical'",
			"'apt' && a.event === 'security_updates_warn'",
			"'compose' && a.event === 'service_unhealthy'",
			"'compose' && a.event === 'service_exited'",
			"'compose' && a.event === 'service_restart_loop'",
			"'apt:security_updates_critical'",
			"'compose:service_unhealthy'",
			'sudo apt update',
			'docker compose logs'
		]
	},
	{
		name: 'P121-CP13-4 — matrix-bot deps-pin-check smoke registered in run-smokes.sh + handles matrix-bot-sdk + better-sqlite3 + zod',
		file: 'apps/matrix-bot/scripts/deps-pin-check.ts',
		rootRelative: true,
		mustHave: [
			'TRACKED_DEPS',
			'matrix-bot-sdk',
			'better-sqlite3',
			'zod',
			'satisfies',
			'DRIFT'
		]
	},
	{
		name: 'P121-CP13-5 — bot default JOURNALCTL_UNITS covers ALL 11 sidecar units (indexer + relay + 9 monitor sidecars)',
		file: 'apps/matrix-bot/src/config.ts',
		rootRelative: true,
		mustHave: [
			'morphit-indexer.service',
			'morphit-relay.service',
			'morphit-host-monitor.service',
			'morphit-smartctl-monitor.service',
			'morphit-fail2ban-monitor.service',
			'morphit-mdadm-monitor.service',
			'morphit-dmesg-monitor.service',
			'morphit-trivy-monitor.service',
			'morphit-postfix-monitor.service',
			'morphit-certbot-monitor.service',
			'morphit-apt-monitor.service',
			'morphit-compose-monitor.service'
		]
	},

	// ─── P121-CP14 — envelope schema + cross-workspace deps-pin +
	// systemd-health + journald sidecars + release workflow
	{
		name: 'P121-CP14-1 — sidecar envelope smoke validates LogRecord schema across all sidecars',
		file: 'apps/matrix-bot/scripts/sidecar-envelope-smoke.ts',
		rootRelative: true,
		mustHave: [
			'LogRecordSchema',
			'morphit-host-monitor.sh',
			'morphit-dmesg-monitor.sh',
			'morphit-systemd-monitor.sh',
			'morphit-journald-monitor.sh',
			'lowercase_snake convention',
			'z.enum'
		]
	},
	{
		name: 'P121-CP14-2 — workspace-deps-pin-check covers every workspace, not just matrix-bot',
		file: 'apps/ops-cli/scripts/workspace-deps-pin-check.ts',
		rootRelative: true,
		mustHave: [
			'findWorkspaces',
			'apps',
			'packages',
			'satisfies',
			"'workspace:'",
			'workspace deps-pin-check'
		]
	},
	{
		name: 'P121-CP14-3 — systemd unit-health sidecar + classifier matchers + ALERT_COPY',
		file: 'apps/matrix-bot/src/classifier.ts',
		rootRelative: true,
		mustHave: [
			"'systemd' && a.event === 'unit_failed'",
			"'systemd' && a.event === 'unit_restart_loop'",
			"'systemd' && a.event === 'unit_missing'",
			"'systemd:unit_failed'",
			"'systemd:unit_restart_loop'",
			'reset-failed',
			'unit isnt running to emit'
		]
	},
	{
		name: 'P121-CP14-4 — journald disk-usage sidecar + classifier matchers + ALERT_COPY',
		file: 'apps/matrix-bot/src/classifier.ts',
		rootRelative: true,
		mustHave: [
			"'journald' && a.event === 'journal_size_critical'",
			"'journald' && a.event === 'journal_size_warn'",
			"'journald' && a.event === 'journal_rotation_stale'",
			"'journald:journal_size_critical'",
			'SystemMaxUse',
			'journalctl --vacuum'
		]
	},
	{
		name: 'P121-CP14-5 — Forgejo release workflow + bot default JOURNALCTL_UNITS covers ALL 14 units',
		file: 'apps/matrix-bot/src/config.ts',
		rootRelative: true,
		mustHave: [
			'morphit-systemd-monitor.service',
			'morphit-journald-monitor.service'
		]
	},

	// ─── P121-CP15 — API-shape zod smoke + emit.sh lib refactor
	// + host-monitor mount sweep + smartctl SCT thermal log
	{
		name: 'P121-CP15-1 — API-response-shape smoke extends envelope-smoke pattern to HTTP API with TS-type-cross-check',
		file: 'apps/matrix-bot/scripts/api-response-shape-smoke.ts',
		rootRelative: true,
		mustHave: [
			'HealthSchema',
			'InstanceResponseSchema',
			'OrderRecordSchema',
			'satisfies HealthResponse',
			'satisfies InstanceResponse',
			'@morphit/indexer-client',
			'invalidate',
			'safeParse'
		]
	},
	{
		name: 'P121-CP15-2 — shared emit() helper lib at ops/scripts/lib/emit.sh',
		file: 'ops/scripts/lib/emit.sh',
		rootRelative: true,
		mustHave: [
			'iso_now()',
			'json_str()',
			'emit()',
			'MORPHIT_EMIT_MODULE',
			'MORPHIT_EMIT_TAG',
			'systemd-cat -t'
		]
	},
	{
		name: 'P121-CP15-3 — host-monitor sources lib/emit.sh AND has mount-sweep section for bind-mounts + tmpfs',
		file: 'ops/scripts/morphit-host-monitor.sh',
		rootRelative: true,
		mustHave: [
			'. "$(dirname "$0")/lib/emit.sh"',
			'MORPHIT_EMIT_MODULE="host-resource"',
			'MORPHIT_EMIT_TAG="morphit-host-monitor"',
			'MORPHIT_HOST_SCAN_MOUNTS',
			'--output=target,pcent,fstype',
			'mount_critical',
			'mount_warn',
			'mount_info',
			'squashfs'
		]
	},
	{
		name: 'P121-CP15-4 — smartctl-monitor SCT thermal-log extension + classifier matchers + ALERT_COPY',
		file: 'apps/matrix-bot/src/classifier.ts',
		rootRelative: true,
		mustHave: [
			"'smartctl' && a.event === 'temperature_sustained_high'",
			"'smartctl' && a.event === 'temperature_overlimit_count'",
			"'smartctl:temperature_sustained_high'",
			"'smartctl:temperature_overlimit_count'",
			'scttempsts',
			'over-temperature'
		]
	},
	{
		name: 'P121-CP15-5 — host-resource mount_* classifier matchers + ALERT_COPY across CRITICAL/WARN/INFO tiers',
		file: 'apps/matrix-bot/src/classifier.ts',
		rootRelative: true,
		mustHave: [
			"'host-resource' && a.event === 'mount_critical'",
			"'host-resource' && a.event === 'mount_warn'",
			"'host-resource:mount_critical'",
			"'host-resource:mount_warn'",
			"'host-resource:mount_info'",
			'bind-mount'
		]
	},

	// ─── P121-CP16 — SSE stream shapes + expanded REST coverage
	{
		name: 'P121-CP16-1 — SSE-stream-shape smoke validates all three streams (orderbook, instances, chat)',
		file: 'apps/matrix-bot/scripts/sse-stream-shape-smoke.ts',
		rootRelative: true,
		mustHave: [
			'OrderbookSnapshotSchema',
			'OrderbookOrderUpsertedSchema',
			'OrderbookOrderRemovedSchema',
			'InstancesSnapshotSchema',
			'InstancesRemovedSchema',
			'ChatSnapshotSchema',
			'ChatMessageAppendedSchema',
			'satisfies OrderRecord',
			'satisfies InstanceDirectoryEntry',
			'satisfies ChatMessageRecord'
		]
	},
	{
		name: 'P121-CP16-2 — api-response-shape smoke expanded to cover 27 interfaces (was 10 at cp15)',
		file: 'apps/matrix-bot/scripts/api-response-shape-smoke.ts',
		rootRelative: true,
		mustHave: [
			'OrderViewsResponseSchema',
			'OrderbookResponseSchema',
			'FeaturedOrderbookResponseSchema',
			'AccountOrdersResponseSchema',
			'ProfileResponseSchema',
			'OperatorsResponseSchema',
			'ChatIdentityResponseSchema',
			'ConversationsResponseSchema',
			'BlocksResponseSchema',
			'ChatHistoryResponseSchema',
			'InstanceDirectoryResponseSchema'
		]
	},
	{
		name: 'P121-CP16-3 — every cp16 schema is anchored by a satisfies-clause cross-check against the TS interface',
		file: 'apps/matrix-bot/scripts/api-response-shape-smoke.ts',
		rootRelative: true,
		mustHave: [
			'satisfies OrderViewsResponse',
			'satisfies OrderbookResponse',
			'satisfies FeaturedOrderbookResponse',
			'satisfies ProfileResponse',
			'satisfies OperatorsResponse',
			'satisfies ChatIdentityResponse',
			'satisfies ConversationsResponse',
			'satisfies BlocksResponse',
			'satisfies InstanceDirectoryResponse'
		]
	},

	// ─── P121-CP17 — final lower-traffic schema coverage ──────
	{
		name: 'P121-CP17-1 — api-response-shape smoke now covers ALL @morphit/indexer-client response types',
		file: 'apps/matrix-bot/scripts/api-response-shape-smoke.ts',
		rootRelative: true,
		mustHave: [
			'ClearingPricePointSchema',
			'ClearingPriceHistoryResponseSchema',
			'BatchProfilesResponseSchema',
			'FeedbackRecordSchema',
			'FeedbackResponseRecordSchema',
			'AccountFeedbackResponseSchema',
			'AccountFeedbackGivenResponseSchema',
			'ChatReadStateEntrySchema',
			'ChatReadStateResponseSchema',
			'AttestorEligibilityResponseSchema',
			'StrangerFeeQuoteResponseSchema'
		]
	},
	{
		name: 'P121-CP17-2 — every cp17 schema is anchored by a satisfies-clause cross-check against the TS interface',
		file: 'apps/matrix-bot/scripts/api-response-shape-smoke.ts',
		rootRelative: true,
		mustHave: [
			'satisfies ClearingPricePoint',
			'satisfies ClearingPriceHistoryResponse',
			'satisfies BatchProfilesResponse',
			'satisfies FeedbackRecord',
			'satisfies FeedbackResponseRecord',
			'satisfies AccountFeedbackResponse',
			'satisfies AccountFeedbackGivenResponse',
			'satisfies ChatReadStateResponse',
			'satisfies AttestorEligibilityResponse',
			'satisfies StrangerFeeQuoteResponse'
		]
	},

	// ─── P121-CP18 — deep-deep security audit fixes ───────────
	{
		name: 'P121-CP18-1 — AUDIT-1 fix: json_str() encodes ALL C0 control chars (0x00-0x1F) per RFC 8259',
		file: 'ops/scripts/lib/emit.sh',
		rootRelative: true,
		mustHave: [
			'AUDIT-1',
			'sed -z',
			'\\u0000',
			'\\u001b',
			'\\u001f',
			'LC_ALL=C'
		]
	},
	{
		name: 'P121-CP18-2 — AUDIT-1 regression smoke covers the dmesg-comm-injection attack vector',
		file: 'apps/matrix-bot/scripts/json-str-injection-smoke.ts',
		rootRelative: true,
		mustHave: [
			'AUDIT-1',
			'embedded newline (THE primary attack vector',
			'all C0 control chars',
			'invalid UTF-8',
			'callJsonStr',
			'JSON.parse'
		]
	},
	{
		name: 'P121-CP18-3 — AUDIT-CI-7 fix: release.yml validates tag format strictly + passes via env, not ${{}} interpolation',
		file: '.forgejo/workflows/release.yml',
		rootRelative: true,
		mustHave: [
			'AUDIT-CI-7',
			'v[0-9]*.[0-9]*.[0-9]*',
			'TARBALL: ${{ steps.ver.outputs.tarball }}',
			'tar --exclude',
			'$TARBALL'
		]
	},

	// ─── P121-CP19 — MEDIUM/LOW audit-finding cleanup ──────────
	{
		name: 'P121-CP19-1 — AUDIT-ANSIBLE-1 fix: nodejs.yml uses apt-repo + GPG pattern, NO setup-script-as-root',
		file: 'ops/ansible/roles/morphit/tasks/nodejs.yml',
		rootRelative: true,
		mustHave: [
			'AUDIT-ANSIBLE-1',
			'/etc/apt/keyrings/nodesource.asc',
			'signed-by=/etc/apt/keyrings/nodesource.asc',
			'morphit_node_version'
		],
		mustNotHave: [
			'setup_{{ morphit_node_version }}',
			'bash /tmp/nodesource_setup.sh'
		]
	},
	{
		name: 'P121-CP19-2 — AUDIT-NUMERIC fix: emit.sh exports json_num() helper; host-monitor + fail2ban + compose-monitor use it',
		file: 'ops/scripts/lib/emit.sh',
		rootRelative: true,
		mustHave: [
			'AUDIT-NUMERIC',
			'json_num()',
			'*[!0-9.-]*'
		]
	},
	{
		name: 'P121-CP19-3 — AUDIT-2/3/4 fixes: matrix-bot renderAlertBody sanitizes payload (control-char strip + mxid defang + size cap)',
		file: 'apps/matrix-bot/src/classifier.ts',
		rootRelative: true,
		mustHave: [
			'AUDIT-2',
			'AUDIT-3',
			'AUDIT-4',
			'function sanitize',
			'MAX_FIELD_BYTES',
			'MAX_PAYLOAD_BYTES',
			'\\u200d'
		]
	},
	{
		name: 'P121-CP19-4 — render-alert-hardening smoke validates the AUDIT-2/3/4 defenses',
		file: 'apps/matrix-bot/scripts/render-alert-hardening-smoke.ts',
		rootRelative: true,
		mustHave: [
			'AUDIT-2',
			'AUDIT-3',
			'AUDIT-4',
			'ESC char',
			'mxid is defanged',
			'truncated'
		]
	},
	{
		name: 'P121-CP19-5 — AUDIT-CI-2 fix: third-party actions SHA-pinned with version-comment annotations',
		file: '.forgejo/workflows/ci.yml',
		rootRelative: true,
		mustHave: [
			'AUDIT-CI-2',
			'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
			'actions/setup-node@1e60f620b9541d16bece96c5465dc8ee9832be0b',
			'# v4.2.2',
			'# v4.0.3'
		]
	},

	// ─── P121-CP20 — beta-tester intake form wired into Forgejo
	{
		name: 'P121-CP20-1 — Forgejo issue template ships at .forgejo/issue_template/bug_report.md with auto-load frontmatter',
		file: '.forgejo/issue_template/bug_report.md',
		rootRelative: true,
		mustHave: [
			'name: "Bug report"',
			'title: "[bug] "',
			'needs-triage',
			'## 1. One-line summary',
			'## 17. Anything else?',
			'@agorise:matrix.org'
		]
	},
	{
		name: 'P121-CP20-2 — Forgejo issue-picker config disables blank issues + surfaces public community Matrix room (NOT security DM)',
		file: '.forgejo/issue_template/config.yml',
		rootRelative: true,
		mustHave: [
			'blank_issues_enabled: false',
			'contact_links',
			'Community chat',
			'matrix.to/#/#agorise:matrix.org'
		],
		mustNotHave: [
			// The picker UI must NOT surface the operator's personal
			// DM mxid; security disclosures route via §16 of the
			// bug-report template, not the picker.
			'matrix.to/#/@agorise:matrix.org',
			'Security disclosure (private)'
		]
	},

	// ─── P122-CP1 F1 fix — STOP banner above §1
	//
	// Beta-tester intake form (cp20) put the security-disclosure
	// warning at §16, fifteen sections below §1 ("one-line
	// summary").  A tester reporting a security vuln would have
	// typed it into §1 before scrolling to §16.  Cp1 prepended a
	// STOP banner BEFORE §1 so the warning fires before any
	// field is filled in.  Sentinel locks the placement: the
	// banner phrase MUST appear in the file AND it MUST appear
	// at a byte offset BEFORE the §1 header.
	{
		name: 'P122-CP1-F1 — Forgejo template has STOP banner before §1 (security warning placement)',
		file: '.forgejo/issue_template/bug_report.md',
		rootRelative: true,
		mustHave: [
			'STOP — read this first if your bug involves security',
			'DO NOT POST IT HERE',
			'`@agorise:matrix.org`'
		],
		// Custom assertion not expressible via mustHave: the banner
		// substring must appear at a smaller file-offset than the
		// `## 1. One-line summary` header.  We piggyback on the
		// existing readFileSync body + a downstream check below;
		// see the post-loop assertion for the ordering check.
		assertOrdering: {
			before: 'STOP — read this first',
			after: '## 1. One-line summary'
		}
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

	// Optional positional check.  Both substrings must appear,
	// AND `before` must precede `after` in the file.
	let orderingError: string | null = null;
	if (sc.assertOrdering) {
		const beforeIdx = body.indexOf(sc.assertOrdering.before);
		const afterIdx = body.indexOf(sc.assertOrdering.after);
		if (beforeIdx === -1) {
			orderingError = `ordering: "before" substring not found: ${JSON.stringify(sc.assertOrdering.before.slice(0, 60))}`;
		} else if (afterIdx === -1) {
			orderingError = `ordering: "after" substring not found: ${JSON.stringify(sc.assertOrdering.after.slice(0, 60))}`;
		} else if (beforeIdx >= afterIdx) {
			orderingError = `ordering: "${sc.assertOrdering.before.slice(0, 40)}..." at byte ${beforeIdx} but "${sc.assertOrdering.after.slice(0, 40)}..." at byte ${afterIdx}; first must precede second`;
		}
	}

	// Optional regex-based forbidden-pattern checks.  Each pattern that
	// matches contributes an entry to regexMatches with the first match
	// span shown to the operator for diagnosis.
	const regexMatches: Array<{ pattern: RegExp; reason: string; match: string }> = [];
	if (sc.assertNoRegexMatch) {
		for (const { pattern, reason } of sc.assertNoRegexMatch) {
			// Force a fresh scan each time — patterns may have the /g flag
			// from the scenario author.
			const localRe = new RegExp(pattern.source, pattern.flags.replace('g', ''));
			const m = localRe.exec(body);
			if (m !== null) {
				regexMatches.push({ pattern, reason, match: m[0] });
			}
		}
	}

	if (
		missing.length === 0 &&
		present.length === 0 &&
		orderingError === null &&
		regexMatches.length === 0
	) {
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
		if (orderingError) {
			console.error(`      ${orderingError}`);
		}
		for (const { pattern, reason, match } of regexMatches) {
			console.error(
				`      REGEX MATCH (forbidden pattern fired): ${pattern.toString()} — ${reason}`
			);
			console.error(`        first hit: ${JSON.stringify(match.slice(0, 100))}`);
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
