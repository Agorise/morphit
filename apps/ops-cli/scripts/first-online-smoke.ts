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
		writeFileSync(idxEnv, 'MORPHIT_INDEXER_BLURT_RPC_ENDPOINTS=https://rpc.nonexistent.invalid\n');
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
