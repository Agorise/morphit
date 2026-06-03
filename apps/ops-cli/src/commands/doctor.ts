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
 *   - It MUTATES NOTHING. No files written, no services started, no
 *     database touched, no network calls of our own.
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
	configEnvPath: string | null
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
	const script = `${sourcePart}cd ${shq(appDir)} && npm start -- --check-config`;
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
	const installDir = process.cwd();
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

	if (json) {
		console.log(
			JSON.stringify(
				{
					ok: allOk,
					install_dir: installDir,
					services: results.map((r) => ({ name: r.name, ok: r.ok, detail: r.detail })),
					security: security.map((s) => ({ level: s.level, label: s.label, detail: s.detail }))
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
