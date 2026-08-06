/**
 * first-online-smoke.ts
 *
 * Guards morphit-first-online.sh — the deferred-completion script that finishes
 * the network-dependent tail of the install (real TLS cert, Blurt RPC connect,
 * opt-in on-chain registration) the first time an offline-installed box sees the
 * internet.  This is load-bearing for the "install in a bunker, finish itself
 * when a link appears" behavior, so we check both its structure AND that its
 * OFFLINE path actually no-ops cleanly (no partial work, retries later).
 *
 * The script cannot be fully exercised in CI (it drives certbot / systemctl /
 * docker), but its overridable state/env paths let us run the real offline
 * branch here: point it at a scratch dir with no reachable RPC and confirm it
 * exits 0 having done nothing irreversible.
 */
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'ops', 'first-online', 'morphit-first-online.sh');

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

interface ScenarioResult {
	name: string;
	ok: boolean;
	detail?: string;
}
const results: ScenarioResult[] = [];
const check = (name: string, ok: boolean, detail?: string): void => {
	results.push({ name, ok, detail });
};

const src = existsSync(SCRIPT) ? readFileSync(SCRIPT, 'utf-8') : '';

// ── Structure ──
check('script exists at ops/first-online/morphit-first-online.sh', src.length > 0);
check('is POSIX sh with set -eu', /^#!\/bin\/sh/.test(src) && /set -eu/.test(src));
check(
	'online GATE probes MULTIPLE RPC endpoints (never a single host / link-state)',
	/check_online\(\)/.test(src) && /for ep in \$\(rpc_endpoints\)/.test(src) && /FALLBACK_RPC=/.test(src)
);
check(
	'has per-step done-markers (tls / register / rpc) for idempotency',
	/tls\.done/.test(src) && /register\.done/.test(src) && /rpc\.done/.test(src)
);
check(
	'TLS step runs certbot only when there is no Let\u2019s Encrypt cert yet',
	/certbot certonly/.test(src) && /letsencrypt\/live\/\$\{MORPHIT_DOMAIN\}\/fullchain\.pem/.test(src)
);
check(
	'RPC step restarts the indexer + relay to connect promptly',
	/systemctl restart morphit-indexer\.service/.test(src) && /systemctl restart morphit-relay\.service/.test(src)
);
check(
	'registration is OPT-IN (gated on MORPHIT_AUTO_REGISTER=yes) and non-interactive',
	/MORPHIT_AUTO_REGISTER/.test(src) && /register --non-interactive/.test(src)
);
check(
	'retires its own timer once every deferred step is done',
	/all_done/.test(src) && /systemctl disable --now morphit-first-online\.timer/.test(src)
);
check('state dir + env file are overridable (so this can be exercised offline)', /MORPHIT_FIRST_ONLINE_STATE_DIR/.test(src) && /MORPHIT_FIRST_ONLINE_ENV/.test(src));

// ── Functional: the OFFLINE branch must no-op cleanly ──
// Run the real script pointed at a scratch state dir, with an indexer env whose
// only "RPC endpoint" is an unresolvable host → check_online fails → the script
// must exit 0 and create NO done-markers (nothing half-finished).
if (src.length > 0) {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-fo-'));
	try {
		const stateDir = join(dir, 'state');
		const envFile = join(dir, 'first-online.env');
		const idxEnv = join(dir, 'indexer.env');
		writeFileSync(
			envFile,
			'MORPHIT_DOMAIN=trade.example.invalid\nMORPHIT_ACME_EMAIL=op@example.invalid\nMORPHIT_AUTO_REGISTER=no\nMORPHIT_TLS_STAGING=no\nMORPHIT_OPS_DIR=' +
				dir +
				'\n'
		);
		// A single endpoint at an unresolvable TLD → curl fails fast → offline.
		// MUST be the SAME var the code reads (MORPHIT_INDEXER_RPC_ENDPOINTS) — a
		// mismatch here silently let first-online use its reachable fallback instead,
		// which both hid the real behaviour AND made this check flaky (online in CI).
		writeFileSync(idxEnv, 'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.nonexistent.invalid\n');
		let out = '';
		let exit = 0;
		try {
			out = execFileSync('sh', [SCRIPT], {
				env: {
					...process.env,
					MORPHIT_FIRST_ONLINE_STATE_DIR: stateDir,
					MORPHIT_FIRST_ONLINE_ENV: envFile,
					MORPHIT_FIRST_ONLINE_INDEXER_ENV: idxEnv,
					MORPHIT_FIRST_ONLINE_RELAY_ENV: join(dir, 'relay.env')
				},
				encoding: 'utf-8',
				timeout: 120_000
			});
		} catch (e) {
			const err = e as { status?: number; stdout?: string; stderr?: string };
			exit = err.status ?? 1;
			out = (err.stdout ?? '') + (err.stderr ?? '');
		}
		check('offline run exits 0 (clean, will retry later)', exit === 0, `exit=${exit}`);
		check('offline run reports no internet yet', /no internet yet/.test(out), out.slice(0, 200));
		const markers = existsSync(stateDir) ? readdirSync(stateDir).filter((f) => f.endsWith('.done')) : [];
		check('offline run created NO done-markers (nothing half-finished)', markers.length === 0, `markers: ${markers.join(', ')}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── RPC-endpoint var name must MATCH what the install writes (cp660) ──
// first-online silently ignored the operator's configured endpoints because it read
// MORPHIT_INDEXER_BLURT_RPC_ENDPOINTS while indexer.env.j2 (and the indexer itself)
// write/read MORPHIT_INDEXER_RPC_ENDPOINTS. This is a STATIC check (network-
// independent) so it catches the typo even in a sandbox where the fallback RPCs are
// unreachable and a behavioural test can't tell the difference.
const idxTemplate = existsSync(join(REPO_ROOT, 'ops', 'ansible', 'roles', 'morphit', 'templates', 'indexer.env.j2'))
	? readFileSync(join(REPO_ROOT, 'ops', 'ansible', 'roles', 'morphit', 'templates', 'indexer.env.j2'), 'utf-8')
	: '';
check(
	'first-online reads the SAME RPC-endpoint var the install writes (MORPHIT_INDEXER_RPC_ENDPOINTS, never \u2026BLURT_RPC\u2026)',
	/MORPHIT_INDEXER_RPC_ENDPOINTS\b/.test(src) &&
		!/MORPHIT_INDEXER_BLURT_RPC_ENDPOINTS/.test(src) &&
		/^MORPHIT_INDEXER_RPC_ENDPOINTS=/m.test(idxTemplate)
);
// cp661: first-online must NOT SOURCE indexer.env with `.` — sourcing RUNS it as a
// shell script, so an unquoted value with spaces (valid for systemd's EnvironmentFile,
// e.g. a marketplace name) returns non-zero and, under this script's `set -e`, aborts
// $(rpc_endpoints) before the fallback → check_online got ZERO endpoints and reported
// "no internet" forever even when fully online. It must read the value INERTLY (sed).
check(
	'first-online does NOT source indexer.env with `.` (set -e abort risk); reads the endpoint value inertly with sed',
	!/\.[ \t]+["']?\$\{INDEXER_ENV\}/.test(src) &&
		/sed -n [^\n]*MORPHIT_INDEXER_RPC_ENDPOINTS=/.test(src)
);
// cp661: the two env files first-online DOES need loaded whole (its own config +
// relay.env for the register step) must be sourced with errexit OFF — a single
// unquoted spaced value would otherwise EXECUTE under `.` and, with `set -e`, abort
// (killing the script at the config read, or silently skipping registration). Assert
// every `. "${…}"` source line carries a `set +e` on the same line.
{
	const srcLines = src
		.split('\n')
		.filter((l) => /(^|[^a-zA-Z0-9._])\.[ \t]+["']?\$\{[A-Z_]+\}/.test(l));
	check(
		`every env-file source in first-online is set +e-guarded (${srcLines.length} found; none may run under active errexit)`,
		srcLines.length >= 1 && srcLines.every((l) => /set \+e/.test(l))
	);
}
// cp661: the auto-register step must feed register the vars it reads from the
// ENVIRONMENT — including MORPHIT_INSTANCE_ORIGIN, which lives ONLY in
// morphit.config.env (relay.env doesn't carry it; the old code sourced relay.env and
// register failed on the missing var no matter the relay balance). Assert it reads the
// instance vars inertly from morphit.config.env and exports them.
check(
	'first-online auto-register reads MORPHIT_INSTANCE_ORIGIN inertly from morphit.config.env and exports the register inputs',
	/_conf_env="[^"\n]*morphit\.config\.env/.test(src) &&
		/MORPHIT_INSTANCE_ORIGIN="\$\(_get_env MORPHIT_INSTANCE_ORIGIN/.test(src) &&
		/export MORPHIT_RELAY_ACCOUNT MORPHIT_RELAY_ACTIVE_KEY_FILE/.test(src) &&
		!/\.[ \t]+["']?\$\{RELAY_ENV\}/.test(src)
);

// ── Wizard-side offline resilience (a connection dropping MID-WIZARD must never
//    hang or block — bounded + non-fatal, then first-online recovers on reconnect) ──
// The install already defers network work to first-online (checks above); the ONLY
// network touchpoint in the interactive guided wizard is the relay-account lookup,
// so lock in that (1) it can't HANG (AbortController + hard timeout per RPC) and
// (2) it can't BLOCK (a failure is caught → the operator proceeds).
const chainCheckSrc = existsSync(join(REPO_ROOT, 'apps', 'ops-cli', 'src', 'init', 'chainCheck.ts'))
	? readFileSync(join(REPO_ROOT, 'apps', 'ops-cli', 'src', 'init', 'chainCheck.ts'), 'utf-8')
	: '';
const stepsSrc = existsSync(join(REPO_ROOT, 'apps', 'ops-cli', 'src', 'init', 'steps.ts'))
	? readFileSync(join(REPO_ROOT, 'apps', 'ops-cli', 'src', 'init', 'steps.ts'), 'utf-8')
	: '';
check(
	'wizard RPC lookups are BOUNDED (AbortController + hard timeout) so a mid-wizard net drop can\u2019t hang',
	/new AbortController\(\)/.test(chainCheckSrc) &&
		/setTimeout\(\s*\(\)\s*=>\s*\w+\.abort\(\)/.test(chainCheckSrc) &&
		/timeoutMs\s*=\s*\d+/.test(chainCheckSrc)
);
check(
	'wizard account step CATCHES an RPC failure and PROCEEDS (chainLookupSucceeded: false), never blocks',
	/lookupBlurtAccount\([\s\S]{0,2500}catch[\s\S]{0,900}chainLookupSucceeded:\s*false/.test(stepsSrc)
);

// ── Report ──
let failed = 0;
console.log('\nfirst-online-smoke\n──────────────────────────────────────────────────────');
for (const r of results) {
	if (r.ok) {
		console.log(`  ${ANSI_GREEN}\u2713${ANSI_RESET} ${r.name}`);
	} else {
		console.log(`  ${ANSI_RED}\u2717${ANSI_RESET} ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}
console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log(`\u2717 ${failed} of ${results.length} scenarios failed`);
	process.exit(1);
} else {
	console.log(`\u2713 all ${results.length} scenarios passed`);
}
