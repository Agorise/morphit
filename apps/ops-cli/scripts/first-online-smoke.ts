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
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

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
	'has per-step done-markers (tls / register / rpc / canary) for idempotency',
	/tls\.done/.test(src) && /register\.done/.test(src) && /rpc\.done/.test(src) && /canary\.done/.test(src)
);
check(
	'TLS step runs certbot only when there is no Let\u2019s Encrypt cert yet',
	/certbot certonly/.test(src) && /letsencrypt\/live\/\$\{MORPHIT_DOMAIN\}\/fullchain\.pem/.test(src)
);
check(
	'RPC step restarts the indexer + relay to connect promptly',
	/systemctl restart morphit-indexer\.service/.test(src) && /systemctl restart morphit-relay\.service/.test(src)
);
// v1.12.3 — an OFFLINE-installed box starts i2pd + tor with no network; they must
// be restarted on first-online or i2pd sits with an empty netDb forever.
check(
	'RPC step ALSO restarts i2pd + tor so the hidden transports reseed/bootstrap on first online',
	/systemctl restart i2pd\.service/.test(src) && /systemctl restart tor\.service/.test(src)
);
// v1.12.3 — the canary refresh script is bash (set -o pipefail); invoking it with
// sh (dash) aborts before publishing. This regressed once — lock it out for good.
check(
	'canary step invokes the refresh script with BASH, never sh (dash would abort on set -o pipefail)',
	/bash "\$\{_refresh\}"/.test(src) && !/[^a-z]sh "\$\{_refresh\}"/.test(src)
);
check(
	'canary step is idempotent (marks canary.done, keyed on a served canary.txt)',
	/DONE_CANARY/.test(src) && /canary\.txt/.test(src)
);
// v1.12.3 SECURITY — auto-register unlocks the ENCRYPTED key via the SAME host-bound
// sealed credential the relay uses.  The decrypted passphrase must live ONLY in a
// /run (tmpfs/RAM) file and be scrubbed — never a plaintext file on persistent disk.
check(
	'auto-register decrypts the sealed relay credential via systemd-creds (host-bound, not a plaintext passphrase file)',
	/systemd-creds decrypt/.test(src) && /relay_passphrase\.cred/.test(src)
);
check(
	'the decrypted passphrase lands in /run (tmpfs) only and is scrubbed with rm -f after the register call',
	/mktemp -p \/run/.test(src) && /rm -f "\$\{_passfile\}"/.test(src)
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

// ── Functional: a HIDDEN-ONLY node never probes clearnet (v1.18.0 deep-deep, H4) ──
// A tor-only install writes MORPHIT_INDEXER_RPC_ENDPOINTS= (present, EMPTY).  The
// script used to read that as "unconfigured" and probe six clearnet RPCs from the
// box's home IP, every five minutes while clearnet stayed firewalled.  Run the
// REAL script with stub curl / systemctl / logger / apt-get on PATH, record every
// curl, and assert: only hidden names through the local proxy, or loopback.
if (src.length > 0) {
	const ONION = `http://${'a'.repeat(56)}.onion`;
	const I2P = `http://${'b'.repeat(52)}.b32.i2p`;
	// Stub curl: logs argv (one JSON array per line).  STUB_CURL_OK is a regex of
	// argv-joined strings that should succeed; STUB_HEALTH is served for /v1/health.
	const STUB_CURL = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG_CURL, JSON.stringify(argv) + '\\n');
const url = argv.find((a) => /^https?:\\/\\//.test(a)) || '';
if (process.env.STUB_HEALTH && /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/v1\\/health$/.test(url)) { process.stdout.write(process.env.STUB_HEALTH); process.exit(0); }
if (process.env.STUB_CURL_OK && new RegExp(process.env.STUB_CURL_OK).test(argv.join(' '))) process.exit(0);
process.exit(7);
`;
	const runFo = (indexerEnv: string, extra: Record<string, string>): { exit: number; out: string; curls: string[][]; systemctl: string } => {
		const dir = mkdtempSync(join(tmpdir(), 'morphit-fo-hidden-'));
		try {
			const bin = join(dir, 'bin');
			mkdirSync(bin);
			writeFileSync(join(bin, 'curl'), STUB_CURL);
			for (const name of ['systemctl', 'logger', 'apt-get', 'certbot', 'docker']) {
				writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${join(dir, 'calls.log')}"\nexit 0\n`);
			}
			for (const f of readdirSync(bin)) chmodSync(join(bin, f), 0o755);
			writeFileSync(join(dir, 'calls.log'), '');
			writeFileSync(join(dir, 'curl.log'), '');
			writeFileSync(join(dir, 'indexer.env'), indexerEnv);
			// No domain (tor-only has none), no auto-register, a served canary so
			// step 4 is a no-op: this run is about the GATE.
			mkdirSync(join(dir, 'build'));
			writeFileSync(join(dir, 'build', 'canary.txt'), 'x');
			writeFileSync(join(dir, 'first-online.env'), `MORPHIT_DOMAIN=\nMORPHIT_AUTO_REGISTER=no\nMORPHIT_OPS_DIR=${dir}\nMORPHIT_CANARY_SERVE_DIR=${join(dir, 'build')}\n`);
			const r = spawnSync('sh', [SCRIPT], {
				encoding: 'utf-8',
				timeout: 120_000,
				env: {
					PATH: `${bin}:${process.env.PATH}`,
					HOME: dir,
					STUB_LOG_CURL: join(dir, 'curl.log'),
					MORPHIT_FIRST_ONLINE_STATE_DIR: join(dir, 'state'),
					MORPHIT_FIRST_ONLINE_ENV: join(dir, 'first-online.env'),
					MORPHIT_FIRST_ONLINE_INDEXER_ENV: join(dir, 'indexer.env'),
					MORPHIT_FIRST_ONLINE_RELAY_ENV: join(dir, 'relay.env'),
					...extra
				}
			});
			const curls = readFileSync(join(dir, 'curl.log'), 'utf-8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as string[]);
			return { exit: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, curls, systemctl: readFileSync(join(dir, 'calls.log'), 'utf-8') };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	const clearnet = (curls: string[][]): string[] =>
		curls.flatMap((argv) =>
			argv
				.filter((a) => /^https?:\/\//.test(a))
				.filter((u) => {
					const h = new URL(u).hostname;
					if (h === '127.0.0.1') return false;
					if (h.endsWith('.onion') && argv.includes('--socks5-hostname')) return false;
					if (h.endsWith('.i2p') && argv.includes('-x')) return false;
					return true;
				})
		);
	const hiddenEnv =
		'MORPHIT_INDEXER_RPC_ENDPOINTS=\n' +
		`MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=${ONION},${I2P}\n` +
		'MORPHIT_INDEXER_TOR_SOCKS=127.0.0.1:9050\nMORPHIT_INDEXER_I2P_HTTP_PROXY=127.0.0.1:4444\nMORPHIT_INDEXER_LISTEN_PORT=8081\n';

	let r = runFo(hiddenEnv, {});
	check('hidden-only, nothing reachable: exits 0 and waits (no internet yet)', r.exit === 0 && /no internet yet/.test(r.out), r.out.slice(0, 300));
	check('hidden-only, nothing reachable: NO clearnet curl (no fallback RPC list)', clearnet(r.curls).length === 0, clearnet(r.curls).join(' '));
	check('hidden-only: probes its .onion RPC through Tor SOCKS (remote DNS) and its .b32.i2p through the i2pd proxy',
		r.curls.some((a) => a.includes('--socks5-hostname') && a.includes(ONION)) && r.curls.some((a) => a.includes('-x') && a.includes(I2P)));

	r = runFo(hiddenEnv, { STUB_CURL_OK: '--socks5-hostname .*\\.onion' });
	check('hidden-only, .onion RPC answers over Tor: online → deferred steps run (indexer nudged), still no clearnet curl',
		r.exit === 0 && /reachable over a hidden service/.test(r.out) && /restart morphit-indexer/.test(r.systemctl) && clearnet(r.curls).length === 0,
		`${r.out.slice(0, 300)} | ${clearnet(r.curls).join(' ')}`);

	r = runFo(hiddenEnv, { STUB_HEALTH: '{"status":"ok","rpc_endpoints_healthy":2}' });
	check('hidden-only, hidden probes fail but the local indexer reaches the chain: online, no clearnet curl',
		r.exit === 0 && /local indexer reaches the chain/.test(r.out) && clearnet(r.curls).length === 0,
		`${r.out.slice(0, 300)} | ${clearnet(r.curls).join(' ')}`);

	// Control: the key ABSENT still means "unconfigured" → the clearnet fallback,
	// which also proves the recorder sees a clearnet probe when one happens.
	r = runFo('MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=\n', {});
	check('control: key ABSENT (clearnet install) still probes the baked clearnet fallback list', clearnet(r.curls).length >= 1, JSON.stringify(r.curls).slice(0, 200));
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

// The FOUR operator-editable instance-branding vars (name / origin / operator-tag
// / contact-url) live ONLY in morphit.config.env — indexer.env.j2 documents this
// and the indexer + `morphit-ops edit` both treat config.env as their home. A
// regression that reads ANY of them from indexer.env (which doesn't carry them)
// makes the register broadcast an EMPTY value: this is exactly how a real
// operator's contact_url silently never reached the chain (register op showed an
// empty contact_url even though it was set). Assert all four read from _conf_env,
// and that contact_url specifically is NOT read from INDEXER_ENV.
check(
	'first-online reads every instance-branding var (name/origin/tag/contact) from morphit.config.env — not indexer.env (a wrong-file read broadcasts EMPTY)',
	/_get_env MORPHIT_INSTANCE_NAME "\$\{_conf_env\}/.test(src) &&
		/_get_env MORPHIT_INSTANCE_ORIGIN "\$\{_conf_env\}/.test(src) &&
		/_get_env MORPHIT_INSTANCE_OPERATOR_TAG "\$\{_conf_env\}/.test(src) &&
		/_get_env MORPHIT_INSTANCE_CONTACT_URL "\$\{_conf_env\}/.test(src) &&
		!/_get_env MORPHIT_INSTANCE_CONTACT_URL "\$\{INDEXER_ENV\}/.test(src)
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
