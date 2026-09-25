/**
 * `morphit-ops doctor` (cp194)
 *
 * A READ-ONLY preflight: tells the operator, in plain English,
 * whether the indexer and relay will start with the config that is
 * currently on disk — BEFORE they run `npm start` and watch it crash.
 *
 * It exists because the first real operator hit four consecutive
 * boot failures (operator-allowlist, an ESM/require bug, and two
 * missing required indexer vars), each surfaced only by starting the
 * service and reading a stack trace. doctor turns that loop into a
 * single self-service check.
 *
 * SAFETY (this is the whole point of the command):
 *   - It MUTATES NOTHING. No files written, no services started, and the
 *     database is only ever READ. The ONLY network calls are READ-ONLY,
 *     side-effect-free RPC probes (condenser_api.get_dynamic_global_properties)
 *     to check whether the configured Blurt endpoints are reachable —
 *     each with a hard timeout. Worst case for a probe is that it times
 *     out and doctor reports the endpoint as unreachable. Pass
 *     `--no-rpc` to skip the probes for a purely-local check.
 *   - It also runs the indexer's `--check-schema` (a single READ-ONLY
 *     SELECT against information_schema) to flag a database whose schema
 *     predates an in-place schema.sql change shipped in this version —
 *     the pre-launch upgrade hazard. This reads the DB but never writes
 *     it, and is advisory (it does not change the exit code). Pass
 *     `--no-db` to skip it.
 *   - It validates by running each service's REAL config loader via
 *     `--check-config`, which loads config and exits. That means the
 *     checks can never drift from what the services actually require
 *     (a hand-maintained list would — and that drift is exactly what
 *     caused two of the four bugs).
 *   - The relay's `--check-config` runs BEFORE its passphrase prompt,
 *     so doctor never hangs waiting for input, even with an encrypted
 *     key. (It reports whether the key is encrypted instead.)
 *   - Worst case for a doctor bug is a wrong message, never a broken
 *     box — unlike service-install/start, which is why THAT stays a
 *     VM-validated checkpoint and is deliberately not done here.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRepoRoot, safeCwd } from '../lib/repoRoot.ts';
import {
	probeRpcEndpoints,
	formatRpcProbeLines,
	type RpcProbeSummary
} from '../init/chainCheck.ts';

export interface DoctorCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

interface ServiceResult {
	readonly name: 'indexer' | 'relay';
	readonly ok: boolean;
	/** stdout+stderr from the --check-config run, trimmed. */
	readonly detail: string;
}

/** Run one service's `--check-config`, sourcing morphit.env the EXACT
 *  way the operator (and the docs) do — `set -a; . morphit.env; set +a`
 *  — so doctor's environment matches the real boot byte-for-byte
 *  rather than relying on a reimplemented env parser. morphit.config.env
 *  is found by the service's own loader (we point MORPHIT_OPERATOR_CONFIG_FILE
 *  at it). Returns ok + the combined output. Never throws. */
async function checkService(
	name: 'indexer' | 'relay',
	installDir: string,
	envPath: string,
	configEnvPath: string | null,
	checkFlag: '--check-config' | '--check-schema' = '--check-config'
): Promise<ServiceResult> {
	const { spawnSync } = await import('node:child_process');
	const appDir = join(installDir, 'apps', name);
	if (!existsSync(appDir)) {
		return {
			name,
			ok: false,
			detail: `apps/${name} not found under ${installDir} — are you running this from your install directory?`
		};
	}
	// Build the same shell line the operator runs (RUN-A-MORPHIT-NODE.md):
	// source morphit.env into the environment, then start the service
	// with --check-config. Using the shell's own sourcing guarantees
	// quoting/escaping is interpreted identically to a real start.
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	if (configEnvPath) childEnv.MORPHIT_OPERATOR_CONFIG_FILE = configEnvPath;
	const sourcePart = existsSync(envPath) ? `set -a; . ${shq(envPath)}; set +a; ` : '';
	const script = `${sourcePart}cd ${shq(appDir)} && npm start -- ${checkFlag}`;
	const r = spawnSync('bash', ['-c', script], {
		env: childEnv,
		encoding: 'utf8',
		timeout: 20_000,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
	if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
		return {
			name,
			ok: false,
			detail: 'could not run the check (bash not found). Try starting the service manually to see config errors.'
		};
	}
	if (r.status === 0) {
		return { name, ok: true, detail: combined };
	}
	if (r.signal === 'SIGTERM') {
		return {
			name,
			ok: false,
			detail: 'config check timed out (the service did not exit within 20s).'
		};
	}
	return { name, ok: false, detail: combined };
}

/** Single-quote a string for safe use in a bash command. */
function shq(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Pull the most useful lines out of a failed --check-config run:
 *  the "config validation failed" block and the bullet lines, or the
 *  operator-allowlist line, or the first Error line. Keeps doctor's
 *  output focused instead of dumping a stack trace. */
function summarizeFailure(detail: string): string[] {
	const lines = detail.split('\n').map((l) => l.trimEnd());
	const picked: string[] = [];
	for (const l of lines) {
		const t = l.trim();
		if (t === '') continue;
		if (
			/config validation failed/i.test(t) ||
			/operator allowlist/i.test(t) ||
			/^-\s/.test(t) ||
			/Required$/.test(t) ||
			/must (be|start|contain|list)/i.test(t) ||
			/is empty$/.test(t) ||
			/^Error:/.test(t)
		) {
			picked.push(t);
		}
		// Stop once we have the validation block + a few bullets; we
		// don't want the JS stack frames.
		if (picked.length >= 12 || /at <anonymous>|ModuleJob|node:internal/.test(t)) break;
	}
	if (picked.length === 0) {
		// Fall back to the first non-empty line so we never show nothing.
		const first = lines.find((l) => l.trim() !== '');
		if (first) picked.push(first.trim());
	}
	return picked;
}

export async function runDoctor(ctx: DoctorCtx): Promise<number> {
	const c = makeColor(ctx.colorEnabled);
	const installDir = safeCwd() ?? defaultRepoRoot();
	const json = ctx.flags.json === 'true';

	if (!json) {
		console.log('');
		console.log('━'.repeat(60));
		console.log('  Morphit — doctor (read-only config check)');
		console.log('━'.repeat(60));
		console.log('');
		console.log('  Checks whether your indexer and relay will start with');
		console.log('  the config currently on disk. This changes nothing — it');
		console.log('  only reads and reports.');
		console.log('');
		console.log(`  Install directory: ${installDir}`);
		console.log('');
	}

	// ─── Locate the config files ────────────────────────────────
	const envPath = join(installDir, 'morphit.env');
	const configEnvPath = join(installDir, 'morphit.config.env');

	if (!existsSync(envPath) && !existsSync(join(installDir, 'apps', 'indexer'))) {
		const msg =
			'This does not look like a Morphit install directory (no morphit.env, no apps/indexer). ' +
			'Run `morphit-ops doctor` from your install directory (e.g. /opt/morphit), and run ' +
			'`morphit-ops init` first if you have not configured this node yet.';
		if (json) {
			console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
		} else {
			console.log(`  ${c.red('✗')} ${msg}`);
			console.log('');
		}
		return 2;
	}

	// ─── Run the two service config checks ──────────────────────
	// Each check sources morphit.env via the shell (exactly the
	// operator's documented start) and points the service at
	// morphit.config.env, so doctor's environment matches a real boot.
	const cfgPath = existsSync(configEnvPath) ? configEnvPath : null;
	const results: ServiceResult[] = [];
	for (const svc of ['indexer', 'relay'] as const) {
		if (!json) console.log(`  checking ${svc}…`);
		results.push(await checkService(svc, installDir, envPath, cfgPath));
	}

	const allOk = results.every((r) => r.ok);

	// Security audit (read-only, advisory — does not change the exit
	// code, which reflects boot-readiness).
	const security = await securityAudit(installDir, envPath, configEnvPath);

	// RPC reachability (read-only probes, advisory). Skipped with
	// --no-rpc for a purely-local check. Catches the all-endpoints-dead
	// case that froze a real node's sync before it ever stalls.
	const skipRpc = ctx.flags['no-rpc'] === 'true';

	// Can a peer actually hand us a batch? Advisory like the rest of the audit,
	// and grouped with --no-rpc because it is the one check in that block which
	// leaves the machine. See checkFederationBodyCap for why it must go through
	// the public origin rather than loopback.
	if (!skipRpc) security.push(await checkFederationBodyCap(envPath, cfgPath));
	const rpc = skipRpc ? null : await probeConfiguredEndpoints(envPath, cfgPath);

	// Database schema drift (read-only, advisory). Skipped with --no-db.
	// Delegates to the indexer's own `--check-schema` (so the expectation
	// can't drift from the code) — catches the pre-launch case where an
	// existing DB didn't pick up an in-place schema.sql change shipped in a
	// newer version. Advisory: never changes the boot-readiness exit code.
	const skipDb = ctx.flags['no-db'] === 'true';
	const schema = skipDb
		? null
		: await checkService('indexer', installDir, envPath, cfgPath, '--check-schema');
	const schemaLines = (detail: string): string =>
		detail
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.includes('[check-schema]'))
			.map((l) => l.replace('[check-schema]', '').trim())
			.join(' ');

	if (json) {
		console.log(
			JSON.stringify(
				{
					ok: allOk,
					install_dir: installDir,
					services: results.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail })),
					security: security.map((s) => ({ level: s.level, label: s.label, detail: s.detail })),
					rpc:
						rpc === null
							? { checked: false }
							: {
									checked: true,
									healthy: rpc.healthy,
									total: rpc.total,
									head_block: rpc.headBlock,
									endpoints: rpc.results.map((r) => ({
										url: r.url,
										ok: r.ok,
										latency_ms: r.latencyMs,
										head_block: r.headBlock,
										error: r.error
									}))
								},
					schema:
						schema === null
							? { checked: false }
							: { checked: true, drift: !schema.ok, detail: schemaLines(schema.detail) }
				},
				null,
				2
			)
		);
		return allOk ? 0 : 1;
	}

	// ─── Human report ───────────────────────────────────────────
	console.log('');
	console.log('━'.repeat(60));
	for (const r of results) {
		if (r.ok) {
			// The service prints a one-line OK (and, for the relay, the
			// key type). Echo that line so the operator sees the detail.
			const note = r.detail
				.split('\n')
				.map((l) => l.trim())
				.find((l) => l.includes('[check-config]'));
			console.log(`  ${c.green('✓')} ${r.name}: will start`);
			if (note) console.log(`      ${c.dim(note.replace('[check-config]', '').trim())}`);
		} else {
			console.log(`  ${c.red('✗')} ${r.name}: will NOT start`);
			for (const line of summarizeFailure(r.detail)) {
				console.log(`      ${line}`);
			}
		}
	}
	console.log('━'.repeat(60));
	console.log('');

	// ─── Security audit (advisory) ──────────────────────────────
	const warns = security.filter((s) => s.level === 'warn');
	console.log(`  Security ${warns.length === 0 ? c.green('(all clear)') : c.yellow(`(${warns.length} to review)`)}`);
	for (const s of security) {
		if (s.level === 'ok') {
			console.log(`    ${c.green('✓')} ${s.label}: ${c.dim(s.detail)}`);
		} else {
			console.log(`    ${c.yellow('⚠')} ${s.label}: ${s.detail}`);
		}
	}
	console.log('');
	console.log('━'.repeat(60));
	console.log('');

	// ─── RPC reachability (advisory) ────────────────────────────
	if (skipRpc) {
		console.log(`  RPC endpoints ${c.dim('(skipped — --no-rpc)')}`);
		console.log('');
		console.log('━'.repeat(60));
		console.log('');
	} else if (rpc === null) {
		console.log(`  RPC endpoints ${c.yellow('(none configured to probe)')}`);
		console.log(
			`    ${c.dim('MORPHIT_INDEXER_RPC_ENDPOINTS is required — if this is blank, run `morphit-ops init`.')}`
		);
		console.log('');
		console.log('━'.repeat(60));
		console.log('');
	} else {
		const verdictColor =
			rpc.healthy === 0 ? c.red : rpc.healthy < rpc.total ? c.yellow : c.green;
		console.log(
			`  RPC endpoints ${verdictColor(`(${rpc.healthy} of ${rpc.total} reachable)`)}`
		);
		const lines = formatRpcProbeLines(rpc);
		// Last line is the verdict; the rest are per-endpoint.
		for (const line of lines.slice(0, -1)) {
			const tagged = line.includes('DEAD') ? c.red(line) : c.green(line);
			console.log(`  ${tagged}`);
		}
		console.log(`    ${verdictColor(lines[lines.length - 1]!)}`);
		console.log('');
		console.log('━'.repeat(60));
		console.log('');
	}

	// ─── Database schema (advisory) ─────────────────────────────
	if (skipDb) {
		console.log(`  Database schema ${c.dim('(skipped — --no-db)')}`);
	} else if (schema !== null && schema.ok) {
		const detail = schemaLines(schema.detail);
		if (detail.toLowerCase().includes('could not reach')) {
			console.log(`  Database schema ${c.yellow('(could not check — database not reachable)')}`);
		} else {
			console.log(`  Database schema ${c.green('(matches this version)')}`);
		}
	} else if (schema !== null) {
		console.log(`  Database schema ${c.yellow('(drift detected)')}`);
		for (const l of schema.detail
			.split('\n')
			.map((x) => x.trim())
			.filter((x) => x.includes('[check-schema]'))) {
			console.log(`    ${c.yellow('\u26a0')} ${l.replace('[check-schema]', '').trim()}`);
		}
	}
	console.log('');
	console.log('━'.repeat(60));
	console.log('');

	if (allOk) {
		console.log(`  ${c.green('Looks good.')} Both services validate. To start them:`);
		console.log('');
		console.log('    cd apps/indexer && npm start      # in one terminal');
		console.log('    cd apps/relay   && npm start      # in another');
		console.log('');
		console.log('  (A fresh indexer reports "degraded" until it finishes');
		console.log('  catching up to the chain — that is normal.)');
	} else {
		console.log(`  ${c.red('Not ready yet.')} Fix the items above, then run`);
		console.log('  `morphit-ops doctor` again. Common fixes:');
		console.log('');
		console.log('    • "… not in the operator allowlist" → that key belongs in');
		console.log('      morphit.env, not morphit.config.env. Move it.');
		console.log('    • "MORPHIT_INDEXER_… : Required" → add the missing line to');
		console.log('      morphit.env (see ops/env/indexer.env.example), or re-run');
		console.log('      `morphit-ops init` to regenerate a complete config.');
	}
	console.log('');
	return allOk ? 0 : 1;
}

interface SecurityFinding {
	readonly level: 'ok' | 'warn';
	readonly label: string;
	/** Plain-English detail / remediation. */
	readonly detail: string;
}

/** Resolve MORPHIT_RELAY_ACTIVE_KEY_FILE by sourcing morphit.env the
 *  same faithful way the services do, so we read the exact path the
 *  relay would. Returns null if unset/unreadable. */
async function resolveKeyPath(envPath: string): Promise<string | null> {
	if (!existsSync(envPath)) return null;
	const { spawnSync } = await import('node:child_process');
	const r = spawnSync(
		'bash',
		['-c', `set -a; . ${shq(envPath)}; set +a; printf '%s' "$MORPHIT_RELAY_ACTIVE_KEY_FILE"`],
		{ encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }
	);
	const p = (r.stdout ?? '').trim();
	return p === '' ? null : p;
}

/** Read one env var by sourcing morphit.env (+ morphit.config.env if
 *  present) the same faithful way the services do. Returns '' if unset. */
async function readEnvVar(
	envPath: string,
	configEnvPath: string | null,
	name: string
): Promise<string> {
	if (!existsSync(envPath)) return '';
	const { spawnSync } = await import('node:child_process');
	const cfgPart =
		configEnvPath !== null && existsSync(configEnvPath) ? `. ${shq(configEnvPath)}; ` : '';
	const r = spawnSync(
		'bash',
		['-c', `set -a; . ${shq(envPath)}; ${cfgPart}set +a; printf '%s' "$${name}"`],
		{ encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }
	);
	return (r.stdout ?? '').trim();
}

/** Gather the union of the indexer's and relay's configured Blurt RPC
 *  endpoints, then probe each. Returns null when no endpoints are
 *  configured (so the caller can skip the section cleanly). */
async function probeConfiguredEndpoints(
	envPath: string,
	configEnvPath: string | null
): Promise<RpcProbeSummary | null> {
	const raw = [
		await readEnvVar(envPath, configEnvPath, 'MORPHIT_INDEXER_RPC_ENDPOINTS'),
		await readEnvVar(envPath, configEnvPath, 'MORPHIT_RELAY_BLURT_RPC')
	];
	const urls = Array.from(
		new Set(
			raw
				.flatMap((v) => v.split(','))
				.map((u) => u.trim())
				.filter((u) => u !== '')
		)
	);
	if (urls.length === 0) return null;
	return probeRpcEndpoints(urls);
}

/**
 * Can a peer instance actually hand us a BATCH of chat messages?
 *
 * WHY THIS IS A CHECK AND NOT A LINE IN A DOCUMENT
 *
 * The fast chat path groups messages when a peer is already busy, because one
 * connection over Tor or I2P completes one round trip at a time and grouping is
 * the only thing that makes a federation affordable. A full group is a couple of
 * hundred kilobytes, and every other endpoint on this service takes a few
 * kilobytes — so a reverse proxy configured for the rest of the API rejects the
 * group before the indexer ever sees it.
 *
 * That failure is invisible in every way that matters. Nothing errors. Single
 * messages keep working, so chat looks fine. It only bites when an instance is
 * BUSY, which is when nobody is reading logs — and the symptom is "chat got slow
 * again", which points at the network rather than at a proxy setting. An
 * operator upgrading from an older release keeps their existing proxy config by
 * definition, so this is the default state of every upgrade rather than an
 * unlucky one.
 *
 * So it is worth actually trying it.
 *
 * THROUGH THE PUBLIC ORIGIN, NEVER LOOPBACK. Testing 127.0.0.1:8081 would skip
 * the proxy entirely and pass on a box that is misconfigured — a check that
 * cannot fail, which is worse than no check. If the public origin cannot be
 * determined or cannot be reached from here, this reports exactly that and
 * prints the command to run by hand, rather than guessing.
 *
 * WHAT IT SENDS: a JSON body of the right shape and the wrong contents, sized
 * above the small read default and far below the federation cap. The indexer
 * refuses it structurally — nothing is delivered, nothing is stored, no
 * signature is checked — so the only thing under test is whether the bytes
 * arrived. A 413 means they did not.
 */
/**
 * POST a batch-shaped body to one origin's federation endpoint.
 *
 * One definition, used for both the public origin and the hidden-service front
 * end, so the two checks cannot drift into asking subtly different questions of
 * subtly different things — which is how a check ends up reporting on a path
 * nobody runs.
 */
/** Does this origin name a hidden service — `.onion`, `.i2p`, `.loki`? Such a
 *  name must never reach the system resolver. */
export function isHiddenHostOrigin(origin: string): boolean {
	let host: string;
	try {
		host = new URL(origin).hostname.toLowerCase();
	} catch {
		return /\.(onion|i2p|loki)(:\d+)?(\/|$)/i.test(origin);
	}
	return host.endsWith('.onion') || host.endsWith('.i2p') || host.endsWith('.loki');
}

async function probeFederationBody(
	origin: string,
	body: string
): Promise<{ status: number; error: string }> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 20_000);
	try {
		const res = await fetch(`${origin}/v1/federation/chat-fast`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			signal: ctrl.signal
		});
		return { status: res.status, error: '' };
	} catch (e) {
		return { status: 0, error: e instanceof Error ? e.message : String(e) };
	} finally {
		clearTimeout(timer);
	}
}

export async function checkFederationBodyCap(
	envPath: string,
	configEnvPath: string | null
): Promise<SecurityFinding> {
	const label = 'federation batch size';

	// The SITE origin, which is what a peer pushes to. Same derivation the
	// indexer itself uses for recognising its own directory row.
	const instanceOrigin = await readEnvVar(envPath, configEnvPath, 'MORPHIT_INSTANCE_ORIGIN');
	const publicOrigin = await readEnvVar(envPath, configEnvPath, 'MORPHIT_INDEXER_PUBLIC_ORIGIN');
	const origin = (instanceOrigin || publicOrigin.replace(/\/\/indexer\./, '//')).replace(/\/+$/, '');

	const manual =
		'Send a large body to /v1/federation/chat-fast through your PUBLIC origin (not ' +
		'127.0.0.1 — that skips the proxy) and check you do not get 413. Anything but 413 ' +
		'means the bytes arrived, which is all this is testing.';

	/**
	 * The port Tor and i2pd forward a hidden-service request to.
	 *
	 * This is NOT loopback-as-a-shortcut. The warning above — that 127.0.0.1
	 * skips the proxy and reports all-clear on exactly the box that has the
	 * problem — is about bypassing the front end. Here the front end IS what
	 * answers on this port: `HiddenServicePort 80 127.0.0.1:8090` and i2pd's
	 * tunnel both point at it, so a request to it traverses the same server
	 * block, the same location matching and the same `client_max_body_size` a
	 * real peer's push does. It is the only honest way to check the path a
	 * privacy-only instance actually uses.
	 */
	const hiddenFrontendPort =
		(await readEnvVar(envPath, configEnvPath, 'MORPHIT_ONION_FRONTEND_PORT')) || '8090';

	if (origin === '') {
		return {
			level: 'warn',
			label,
			detail:
				'Could not determine this instance’s public origin, so the batch size was not ' +
				`verified. ${manual}`
		};
	}

	// ~8 KB: above the 4 KB default that every other read endpoint uses, far
	// below the 256 KB the federation endpoint should allow. Large enough to be
	// refused by a proxy that was not updated, small enough to be harmless.
	const filler = '0'.repeat(8_000);
	const body = JSON.stringify({ trxs: [{ not: 'a transaction', filler }] });

	// A HIDDEN origin is never fetched directly (v1.18.0 review, O1). A plain
	// fetch of `http://<onion>` asks the SYSTEM resolver for the onion name —
	// on a tor-only home server that is its ISP's resolver, tying the home
	// address to the onion, the one link tor-only mode exists to hide. There is
	// nothing to learn from that attempt anyway: it can only fail. Such an
	// instance is checked where Tor and i2pd actually deliver, below.
	const first = isHiddenHostOrigin(origin)
		? { status: 0, error: 'a hidden-service origin, checked through the local front end instead' }
		: await probeFederationBody(origin, body);
	const status = first.status;
	const transportError = first.error;

	if (transportError !== '') {
		// A privacy-only instance cannot resolve its own address from the host,
		// which is normal and used to end the check here — leaving the operators
		// who depend on federated chat MOST with the one configuration nobody
		// verified. Tor and i2pd hand their traffic to a local front end, so
		// that front end can be asked directly.
		const hidden = await probeFederationBody(
			`http://127.0.0.1:${hiddenFrontendPort}`,
			body
		);
		if (hidden.status === 413) {
			return {
				level: 'warn',
				label,
				detail:
					`Your hidden-service front end (127.0.0.1:${hiddenFrontendPort}, where Tor and ` +
					'i2pd deliver) answered 413 to an 8 KB batch, so it is rejecting federated chat ' +
					'batches before the indexer sees them. Chat still works — it falls back to the ' +
					'blockchain — but it gets SLOW under load, which is exactly when you will not ' +
					'notice. Add a /v1/federation location with `client_max_body_size 256k;` ' +
					'(ops/bunkerweb/frontend/nginx.conf ships it), reload the proxy, and re-run.'
			};
		}
		if (hidden.status > 0) {
			return {
				level: 'ok',
				label,
				detail:
					`${origin} is not resolvable from this host, which is normal for a privacy-only ` +
					`instance. Checked the hidden-service front end instead (127.0.0.1:` +
					`${hiddenFrontendPort}, where Tor and i2pd deliver): it accepted an 8 KB batch ` +
					`(answered ${hidden.status}), so federated chat can group messages over your ` +
					'onion and I2P addresses.'
			};
		}
		return {
			level: 'warn',
			label,
			detail:
				`Could not reach ${origin} from this machine (${transportError}), and nothing ` +
				`answered on the hidden-service front end either (127.0.0.1:${hiddenFrontendPort}` +
				`${hidden.error === '' ? '' : `, ${hidden.error}`}), so the batch size was not ` +
				`verified. If your front end listens elsewhere, set MORPHIT_ONION_FRONTEND_PORT. ` +
				`${manual}`
		};
	}

	if (status === 413) {
		return {
			level: 'warn',
			label,
			detail:
				`${origin} answered 413 to an 8 KB batch, so your reverse proxy is rejecting ` +
				'federated chat batches before the indexer sees them. Chat still works — it ' +
				'falls back to the blockchain — but it gets SLOW under load, which is exactly ' +
				'when you will not notice. Add a /v1/federation location with ' +
				'`client_max_body_size 256k;` (ops/nginx/web.conf and indexer.conf ship it), ' +
				'reload the proxy, and re-run this check.'
		};
	}

	if (status === 0) {
		return { level: 'warn', label, detail: `No response from ${origin}. ${manual}` };
	}

	// 400 is the expected answer: the body arrived and was refused on its
	// contents, which is the whole point — the bytes got through.
	return {
		level: 'ok',
		label,
		detail: `${origin} accepted an 8 KB batch (answered ${status}), so federated chat can group messages.`
	};
}

/** Read-only security audit. Inspects the active-key file (encryption
 *  + permissions) and the secret config files' permissions. Reads at
 *  most the first byte of the key file (to detect an envelope) and
 *  NEVER prints key material. Findings are advisory — they do not
 *  change doctor's boot-readiness exit code. */
async function securityAudit(
	installDir: string,
	envPath: string,
	configEnvPath: string
): Promise<SecurityFinding[]> {
	const { statSync, openSync, readSync, closeSync } = await import('node:fs');
	const findings: SecurityFinding[] = [];
	const onWin = process.platform === 'win32';

	// ── Active key: encrypted vs plaintext ─────────────────────
	const keyPath = await resolveKeyPath(envPath);
	if (keyPath === null) {
		findings.push({
			level: 'warn',
			label: 'active key',
			detail:
				'MORPHIT_RELAY_ACTIVE_KEY_FILE is not set in morphit.env, so the key could not be inspected.'
		});
	} else if (!existsSync(keyPath)) {
		findings.push({
			level: 'warn',
			label: 'active key',
			detail: `key file ${keyPath} does not exist (the relay will not start without it).`
		});
	} else {
		// Detect envelope (encrypted) the way the relay does: first
		// non-whitespace char is '{'. Read just a small head; never log it.
		let head = '';
		try {
			const fd = openSync(keyPath, 'r');
			const buf = Buffer.alloc(64);
			const n = readSync(fd, buf, 0, 64, 0);
			closeSync(fd);
			head = buf.subarray(0, n).toString('utf8').trimStart();
		} catch {
			/* unreadable — fall through to a generic note below */
		}
		if (head.startsWith('{')) {
			findings.push({
				level: 'ok',
				label: 'active key encryption',
				detail: 'the relay active key is an encrypted envelope (good).'
			});
		} else if (head !== '') {
			findings.push({
				level: 'warn',
				label: 'active key encryption',
				detail:
					'the relay active key is stored in PLAINTEXT. Anyone who can read the file has your relay key. ' +
					'Encrypt it with `morphit-ops edit-active-key` (you will set a passphrase). ' +
					'Trade-off: an encrypted key must be unlocked by hand each time the relay starts — there is no auto-unlock.'
			});
		}
		// Key-file permissions (the relay also enforces this at boot;
		// surfacing it here makes the audit complete).
		if (!onWin) {
			try {
				const mode = statSync(keyPath).mode & 0o777;
				if ((mode & 0o077) !== 0) {
					findings.push({
						level: 'warn',
						label: 'active key permissions',
						detail: `key file is mode 0${mode.toString(8)}; tighten it: chmod 0600 ${keyPath}`
					});
				} else {
					findings.push({
						level: 'ok',
						label: 'active key permissions',
						detail: 'key file is not group/other-readable (good).'
					});
				}
			} catch {
				/* ignore */
			}
		}
	}

	// ── Secret config files: permissions ───────────────────────
	// morphit.env holds the database password and other infra secrets;
	// it is NOT permission-enforced at boot, so a world-readable file is
	// a real leak doctor can catch. morphit.config.env is operator-tunable
	// but still worth keeping private.
	if (!onWin) {
		for (const [name, p] of [
			['morphit.env', envPath],
			['morphit.config.env', configEnvPath]
		] as const) {
			if (!existsSync(p)) continue;
			try {
				const mode = statSync(p).mode & 0o777;
				if ((mode & 0o077) !== 0) {
					findings.push({
						level: 'warn',
						label: `${name} permissions`,
						detail: `${name} is mode 0${mode.toString(8)} (group/other can read it; it holds secrets). Tighten: chmod 0600 ${p}`
					});
				} else {
					findings.push({
						level: 'ok',
						label: `${name} permissions`,
						detail: 'not group/other-readable (good).'
					});
				}
			} catch {
				/* ignore */
			}
		}
	}

	return findings;
}



/** Minimal ANSI helper, matching the rest of the CLI's color gating. */
function makeColor(enabled: boolean) {
	const wrap = (code: string) => (s: string) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : s);
	return {
		green: wrap('32'),
		red: wrap('31'),
		yellow: wrap('33'),
		dim: wrap('2')
	};
}
