#!/usr/bin/env tsx
/**
 * cross-document-value-invariants-smoke.
 *
 * Part 122 cp66 STRUCTURAL DEFENSE (LL #67 / O-16).
 *
 * Generalizes cp61-O14's value-cross-reference parity class.
 *
 * cp61-O14 caught a specific real bug: the BunkerWeb Docker network
 * CIDR was pinned at 172.20.0.0/16 in the canonical compose but
 * 172.18.0.0/16 in the Ansible group_vars default for trusted_proxy_ips.
 * Default Ansible deploy → broken trusted-proxy chain → all signups
 * bucket into one rate-limit slot.  The structural pattern: ONE value
 * lives in N files; if one file drifts, deploy breaks silently.
 *
 * Other repo values exhibit the same pattern.  cp66 generalizes:
 * each invariant declares a SOURCE OF TRUTH (file + extraction regex)
 * and a list of CONSUMER files (each with its own regex/group).
 * Drift in any consumer fires the smoke.
 *
 * Registered invariants (cp69):
 *   1. postgres_db_name             (init.sql → env.examples → ansible/group_vars)
 *   2. postgres_user_name           (init.sql → env.examples → ansible/group_vars)
 *   3. postgres_port                (ansible/group_vars → env.examples DATABASE_URL)
 *   4. treasury_fee_account         (indexer config default → operator-facing docs
 *                                    that name the default by string)
 *   5. indexer_bind_port            (ansible group_vars → bunkerweb frontend nginx.conf /v1/)
 *   6. relay_bind_port              (ansible group_vars → bunkerweb frontend nginx.conf /relay/)
 *   7. bunkerweb_net_name           (canonical compose → ansible role template +
 *                                    ansible verification task)
 *   8. relay_listen_port_default    (relay config Zod default → env.example + nginx)
 *   9. indexer_listen_port_default  (indexer config Zod default → env.example + nginx)
 *  10. matrix_bot_healthcheck_port  (matrix-bot config Zod default → env.example +
 *                                    ansible role env template)  [cp69]
 *  11. bunkerweb_cidr               (canonical compose subnet → ansible default
 *                                    trusted_proxy_ips)  [cp69; slim cousin of
 *                                    cp61-O14, which also checks docs]
 *
 * NOTE: 5-6 are the BunkerWeb-fronted bind ports and 8-9 are the bare-metal
 * nginx-fronted listen ports.  As of cp224 both deploy modes are unified on
 * the code defaults (relay 8080 / indexer 8081), but they are still checked
 * independently — the ansible group_vars bind port and the frontend nginx.conf
 * proxy port must agree (5-6), and the Zod default and the bare-metal nginx
 * upstream must agree (8-9) — so a drift in either path gets a distinct
 * default depending on whether they `docker compose up` from ops/bunkerweb/
 * or `apt install nginx` from ops/nginx/.  Each set MUST be internally
 * consistent.
 *
 * NOTE on bunkerweb_cidr (#11): cp61-O14 (bunkerweb-cidr-cross-reference-smoke)
 * has richer doc-aware behavior — it checks PRE-LAUNCH-CHECKLIST, OPERATIONS,
 * RUN-A-MORPHIT-NODE, BRAG-LIST, and ansible role templates for the canonical
 * CIDR with proximity-to-keyword scoping.  We add a slim invariant here to
 * give the registry pattern uniform coverage; if drift happens, BOTH defenses
 * fire — cp61-O14 with the rich diagnostic, cp66-O16 with the registry-shaped
 * one.  Keeping both is intentional: cp61-O14 is doc-aware (catches drift in
 * operator-facing prose); cp66-O16 is config-aware (catches drift in ansible
 * default).  Different failure modes, complementary signals.
 *
 * Bug class this catches at pre-launch: an operator running a fresh
 * `ops-cli init` followed by importing values from operator docs OR
 * the Ansible default OR the env example finds them in tension —
 * the deploy fails in a confusing way because one document drifted
 * away from the others.  cp66's smoke catches that BEFORE first-launch.
 *
 * Adding new invariants: append to the INVARIANTS array.  Each entry
 * must point at a single source-of-truth file whose value is canonical,
 * and any number of consumer files that must agree.  The smoke is
 * registry-driven; new invariants slot in without changing the runner
 * logic.
 *
 * Mutation tests:
 *   M-130: change init.sql DATABASE name to `morphit_other` → smoke
 *          fires "ops/env/indexer.env.example mentions 'morphit_indexer'
 *          but canonical postgres_db_name is 'morphit_other'".
 *   M-131: change ansible postgres_port to 6432 → smoke fires
 *          "ops/env/indexer.env.example DATABASE_URL port '5432' ≠
 *          canonical '6432'".
 *   M-132: change indexer config default fee_recipient to 'morphit-pool'
 *          while leaving docs at 'morphit-fees' → smoke fires.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

let failed = 0;
let passed = 0;
function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── cross-document-value-invariants smoke (cp66 LL #67 / O-16) ──\n');

interface Extraction {
	/** File path relative to repo root. */
	file: string;
	/** Regex with at least one capture group; the captured value is what
	 *  this file declares for the invariant. */
	regex: RegExp;
	/** Capture group index (default 1). */
	group?: number;
	/** Optional context tag: e.g. "DATABASE_URL", "ansible default".  Used
	 *  in diagnostics so the operator knows which line drifted. */
	context?: string;
}

interface Invariant {
	name: string;
	description: string;
	source: Extraction;
	consumers: Extraction[];
}

const INVARIANTS: Invariant[] = [
	{
		name: 'postgres_db_name',
		description:
			'Postgres database name — defined by init.sql; consumed by both env.example DATABASE_URLs and ansible group_vars',
		source: {
			file: 'ops/postgres/init.sql',
			regex: /CREATE DATABASE\s+(\w+)/,
			context: 'init.sql CREATE DATABASE',
		},
		consumers: [
			{
				file: 'ops/env/indexer.env.example',
				regex: /MORPHIT_INDEXER_DATABASE_URL=postgresql:\/\/[^@]+@[^/]+\/(\w+)/,
				context: 'indexer env DATABASE_URL path',
			},
			{
				file: 'ops/env/relay.env.example',
				regex: /MORPHIT_RELAY_DATABASE_URL=postgresql:\/\/[^@]+@[^/]+\/(\w+)/,
				context: 'relay env DATABASE_URL path',
			},
			{
				file: 'ops/ansible/group_vars/all.yml',
				regex: /^postgres_indexer_db:\s*(\w+)/m,
				context: 'ansible postgres_indexer_db',
			},
		],
	},
	{
		name: 'postgres_user_name',
		description:
			'Postgres role/user name — defined by init.sql; consumed by env.example DATABASE_URLs and ansible group_vars',
		source: {
			file: 'ops/postgres/init.sql',
			regex: /CREATE ROLE\s+(\w+)\s+LOGIN/,
			context: 'init.sql CREATE ROLE',
		},
		consumers: [
			{
				file: 'ops/env/indexer.env.example',
				regex: /MORPHIT_INDEXER_DATABASE_URL=postgresql:\/\/(\w+):/,
				context: 'indexer env DATABASE_URL user',
			},
			{
				file: 'ops/env/relay.env.example',
				regex: /MORPHIT_RELAY_DATABASE_URL=postgresql:\/\/(\w+):/,
				context: 'relay env DATABASE_URL user',
			},
			{
				file: 'ops/ansible/group_vars/all.yml',
				regex: /^postgres_indexer_user:\s*(\w+)/m,
				context: 'ansible postgres_indexer_user',
			},
		],
	},
	{
		name: 'postgres_port',
		description:
			'Postgres listener port — defined by ansible/group_vars (the canonical operator default); consumed by env.example DATABASE_URLs',
		source: {
			file: 'ops/ansible/group_vars/all.yml',
			regex: /^postgres_port:\s*(\d+)/m,
			context: 'ansible postgres_port',
		},
		consumers: [
			{
				file: 'ops/env/indexer.env.example',
				regex: /MORPHIT_INDEXER_DATABASE_URL=postgresql:\/\/[^@]+@[^:]+:(\d+)\//,
				context: 'indexer env DATABASE_URL port',
			},
			{
				file: 'ops/env/relay.env.example',
				regex: /MORPHIT_RELAY_DATABASE_URL=postgresql:\/\/[^@]+@[^:]+:(\d+)\//,
				context: 'relay env DATABASE_URL port',
			},
		],
	},
	{
		name: 'treasury_fee_account',
		description:
			'Treasury fee-recipient account — defined by CANONICAL_TREASURY (apps/indexer/src/config/canonicalTreasury.ts), the cp315 single source of truth that the indexer config Zod default references; consumed by indexer code/docs that name the account by string',
		source: {
			file: 'apps/indexer/src/config/canonicalTreasury.ts',
			regex: /blurt:\s*'([^']+)'/,
			context: 'CANONICAL_TREASURY.blurt single source of truth',
		},
		// Docs that NAME the default account by string MUST match.  Docs
		// that talk about "the operator's fee account" abstractly (no
		// quoted name) don't appear here — they're not making a claim
		// about the canonical default.
		//
		// IMPORTANT: docs reference the account WITH the `@` prefix
		// (`@morphit-fees`) because that's how Blurt accounts are
		// written in prose, but the config default value is the raw
		// account name (`morphit-fees`).  The smoke uses a relaxed
		// pattern that matches either form.
		//
		// Both files contain multiple operator-account references
		// (e.g. `@morphit-relay` AND `@morphit-fees`).  Each consumer
		// regex picks out the TREASURY-specific mention by its semantic
		// context — "accumulates" for the balance-scanner doc, "to="
		// for the strangerFee transfer destination — so a rename of
		// the relay account doesn't falsely fire this invariant.
		consumers: [
			{
				file: 'apps/indexer/src/indexer/operatorAccountBalanceScanner.ts',
				// Treasury account is the one that "accumulates" (the
				// relay account "drains" as it funds welcome bonuses).
				regex: /@(morphit-\w+)\s+typically accumulates/,
				context: 'balance-scanner: treasury accumulates',
			},
			{
				file: 'apps/indexer/src/indexer/handlers/strangerFee.ts',
				// Stranger-fee transfers always have `to=@morphit-fees`
				// as the destination (the treasury); never the relay
				// account, which has no role in fee receipt.
				regex: /to=@(morphit-\w+),/,
				context: 'strangerFee transfer destination',
			},
		],
	},
	{
		name: 'indexer_bind_port',
		description:
			"Indexer HTTP bind port — defined by ansible/group_vars (unified to the code default 8081); consumed by ops/bunkerweb/frontend/nginx.conf's /v1/ proxy_pass (the frontend nginx reverse-proxies the indexer at this port behind BunkerWeb). If they drift, the frontend 502s the indexer service.",
		source: {
			file: 'ops/ansible/group_vars/all.yml',
			regex: /^morphit_indexer_bind_port:\s*(\d+)/m,
			context: 'ansible indexer bind_port default',
		},
		consumers: [
			{
				file: 'ops/bunkerweb/frontend/nginx.conf',
				regex: /location \/v1\/ \{[\s\S]*?proxy_pass http:\/\/host\.docker\.internal:(\d+)/,
				context: 'bunkerweb frontend nginx.conf /v1/ proxy_pass (indexer)',
			},
		],
	},
	{
		name: 'relay_bind_port',
		description:
			"Relay HTTP bind port — defined by ansible/group_vars (unified to the code default 8080); consumed by ops/bunkerweb/frontend/nginx.conf's /relay/ proxy_pass (the frontend nginx reverse-proxies the relay at this port behind BunkerWeb). If they drift, the frontend 502s the relay service.",
		source: {
			file: 'ops/ansible/group_vars/all.yml',
			regex: /^morphit_relay_bind_port:\s*(\d+)/m,
			context: 'ansible relay bind_port default',
		},
		consumers: [
			{
				file: 'ops/bunkerweb/frontend/nginx.conf',
				regex: /location \/relay\/ \{[\s\S]*?proxy_pass http:\/\/host\.docker\.internal:(\d+)/,
				context: 'bunkerweb frontend nginx.conf /relay/ proxy_pass (relay)',
			},
		],
	},
	{
		name: 'bunkerweb_net_name',
		description:
			"BunkerWeb Docker network name — defined by ops/bunkerweb/docker-compose.yml; consumed by ansible bunkerweb role's docker-compose template (same network must coexist) AND by ansible task that inspects the network by name (`docker network inspect <name>`). Drift class: rename the network in the canonical compose, forget the inspect task → ansible verification step fails with 'no such network'.",
		source: {
			file: 'ops/bunkerweb/docker-compose.yml',
			// The canonical compose pins the network with both an entry
			// key under `networks:` AND a `name:` line.  We use the
			// explicit `name:` so renames detected unambiguously.
			regex: /^networks:[\s\S]*?^\s+(\w+):\s*\n\s+name:\s+(\w+)/m,
			group: 2,
			context: 'canonical compose networks.<key>.name',
		},
		consumers: [
			{
				file: 'ops/ansible/roles/bunkerweb/templates/docker-compose.yml.j2',
				regex: /^networks:[\s\S]*?^\s+(\w+):\s*\n\s+name:\s+(\w+)/m,
				group: 2,
				context: 'ansible bunkerweb role compose template',
			},
			{
				file: 'ops/ansible/roles/bunkerweb/tasks/main.yml',
				regex: /docker network inspect (\w+)/,
				context: 'ansible bunkerweb verification task',
			},
		],
	},
	{
		name: 'relay_listen_port_default',
		description:
			"Relay HTTP listen port (bare-metal deploy default) — defined by apps/relay/src/config/index.ts Zod default; consumed by env.example default + nginx reverse-proxy upstream. If they drift, the bare-metal nginx deploy 502s. As of cp224 this equals relay_bind_port (the BunkerWeb-fronted path is unified on the same 8080 default), but the two are still checked independently against their own consumers.",
		source: {
			file: 'apps/relay/src/config/index.ts',
			regex: /MORPHIT_RELAY_LISTEN_PORT:[^,;\n]*\.default\((\d+)\)/,
			context: 'relay config Zod default',
		},
		consumers: [
			{
				file: 'ops/env/relay.env.example',
				regex: /^MORPHIT_RELAY_LISTEN_PORT=(\d+)/m,
				context: 'relay env.example default value',
			},
			{
				file: 'ops/nginx/relay.conf',
				regex: /proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+);/,
				context: 'nginx relay.conf proxy_pass port',
			},
		],
	},
	{
		name: 'indexer_listen_port_default',
		description:
			"Indexer HTTP listen port (bare-metal deploy default) — defined by apps/indexer/src/config/index.ts Zod default; consumed by env.example default + nginx upstream server. If they drift, the bare-metal nginx deploy 502s. As of cp224 this equals indexer_bind_port (the BunkerWeb-fronted path is unified on the same 8081 default), but the two are still checked independently against their own consumers.",
		source: {
			file: 'apps/indexer/src/config/index.ts',
			regex: /MORPHIT_INDEXER_LISTEN_PORT:[^,;\n]*\.default\((\d+)\)/,
			context: 'indexer config Zod default',
		},
		consumers: [
			{
				file: 'ops/env/indexer.env.example',
				regex: /^MORPHIT_INDEXER_LISTEN_PORT=(\d+)/m,
				context: 'indexer env.example default value',
			},
			{
				file: 'ops/nginx/indexer.conf',
				regex: /server\s+127\.0\.0\.1:(\d+);/,
				context: 'nginx indexer.conf upstream server port',
			},
		],
	},
	{
		name: 'matrix_bot_healthcheck_port',
		description:
			"matrix-bot systemd healthcheck loopback port — defined by apps/matrix-bot/src/config.ts Zod default; consumed by env.example default-value comments + ansible role env template. If they drift, the operator's healthcheck wrapper hits the wrong port → false-down alarms even though the bot is fine. Loopback-only; no security surface, but operator trust depends on the healthcheck being accurate.",
		source: {
			file: 'apps/matrix-bot/src/config.ts',
			regex: /MORPHIT_MATRIX_BOT_HEALTHCHECK_PORT:\s*z\.coerce[\s\S]*?\.default\((\d+)\)/,
			context: 'matrix-bot config Zod default',
		},
		consumers: [
			{
				// Env example references the default in TWO places: the inline
				// "Default: 9876." prose comment AND the commented-out
				// `# MORPHIT_MATRIX_BOT_HEALTHCHECK_PORT=9876` line. The
				// commented line is the canonical operator-facing value, so
				// that's what we match.
				file: 'ops/env/matrix-bot.env.example',
				regex: /^#\s*MORPHIT_MATRIX_BOT_HEALTHCHECK_PORT=(\d+)/m,
				context: 'matrix-bot env.example default value',
			},
			{
				// Ansible role template references the variable but its value
				// flows through `matrix_bot_healthcheck_port` in group_vars
				// (which is unset → defaults to whatever the Zod schema picks).
				// We assert the inline comment matches, since that's what an
				// operator reading the template sees as the "default the bot
				// uses today".
				file: 'ops/ansible/roles/matrix_bot/templates/matrix-bot.env.j2',
				regex: /Override the default healthcheck loopback port \((\d+)\)/,
				context: 'ansible matrix-bot role env template comment',
			},
		],
	},
	{
		name: 'bunkerweb_cidr',
		description:
			"BunkerWeb Docker network CIDR — defined by canonical compose's `subnet:` line; consumed by ansible group_vars's `morphit_relay_trusted_proxy_ips` (operator's default trusted-proxy chain). This is the SLIM cousin of cp61-O14 (bunkerweb-cidr-cross-reference-smoke), which ALSO checks docs + READMEs + PRE-LAUNCH-CHECKLIST. We keep both: cp61-O14 has doc-aware behavior with proximity-to-keyword scoping; cp66-O16 catches the same canonical→ansible-default mismatch with a registry-shaped diagnostic. If both fire on the same drift, the operator gets two helpful signals; if only the slim version fires (because doc references were sparse), cp61-O14's doc check still surfaces in cp66-O16.",
		source: {
			file: 'ops/bunkerweb/docker-compose.yml',
			regex: /subnet:\s*([\d./]+)/,
			context: 'canonical compose subnet',
		},
		consumers: [
			{
				file: 'ops/ansible/group_vars/all.yml',
				regex: /^morphit_relay_trusted_proxy_ips:\s*"([^"]+)"/m,
				context: 'ansible default trusted_proxy_ips',
			},
		],
	},
];

function extractValue(ex: Extraction): string | null {
	const path = join(REPO_ROOT, ex.file);
	let src: string;
	try {
		src = readFileSync(path, 'utf-8');
	} catch (e) {
		fail(
			`Read source file: ${ex.file}`,
			`Could not read: ${(e as Error).message}`
		);
		return null;
	}
	const m = src.match(ex.regex);
	if (!m) {
		fail(
			`Extract value from ${ex.file}`,
			`Regex ${ex.regex} did not match (context: ${ex.context ?? 'n/a'})`
		);
		return null;
	}
	const groupIdx = ex.group ?? 1;
	if (m[groupIdx] === undefined) {
		fail(
			`Extract value from ${ex.file}`,
			`Regex matched but group ${groupIdx} undefined (context: ${ex.context ?? 'n/a'})`
		);
		return null;
	}
	return m[groupIdx];
}

for (const inv of INVARIANTS) {
	console.log(`▸ ${inv.name}`);
	console.log(`  ${inv.description}`);
	const canonical = extractValue(inv.source);
	if (canonical === null) {
		// Source extraction failed — fail() was already called inside
		// extractValue, skip the consumers (we have no canonical to compare).
		continue;
	}
	console.log(`  SOURCE OF TRUTH: ${inv.source.file} → '${canonical}'`);
	for (const c of inv.consumers) {
		const consumed = extractValue(c);
		if (consumed === null) continue;
		if (consumed !== canonical) {
			fail(
				`${inv.name} consumer ${c.file} matches canonical`,
				`${c.context ?? c.file} declares '${consumed}' but canonical (${inv.source.file}) is '${canonical}'.  Both must agree or operators get a silently-broken deploy.`
			);
		} else {
			pass(`${inv.name}: ${c.context ?? c.file} = '${consumed}' ✓`);
		}
	}
	console.log('');
}

const total = passed + failed;
console.log(`${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\ncross-document-value-invariants smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} cross-document-value-invariants scenarios passed`);
