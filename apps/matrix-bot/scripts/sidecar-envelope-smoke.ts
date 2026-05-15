#!/usr/bin/env tsx
/**
 * sidecar-envelope-smoke — every bash sidecar must emit JSON
 * matching the canonical LogRecord envelope shape.
 *
 * Why this exists: bash sidecars are written by hand, and the
 * emit() helper format can silently drift from what classifier
 * + parseJournalLine expect.  The cp9 codebase had this exact
 * bug at the start of cp10 (uppercase event names + made-up
 * payload keys).  The cp10 fix rewrote classifier.ts to use
 * real event names + payload keys verified by grep across emit
 * sites.  This smoke is the regression test that locks it down.
 *
 * Each scenario:
 *   1. Run the bash sidecar with PATH-injected mock systemd-cat
 *      so the output goes to stdout instead of journald.
 *   2. Capture every emitted line.
 *   3. Parse each as JSON.
 *   4. Validate against the LogRecord zod schema.
 *
 * Hard-fails if any sidecar emits a malformed envelope.
 * Soft-skips a sidecar if it produces no output (which itself
 * is acceptable behavior — many sidecars emit nothing when the
 * thing they monitor is healthy).
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const SCRIPTS_DIR = join(REPO_ROOT, 'ops', 'scripts');

// ─── Canonical LogRecord schema ────────────────────────────────
// This MUST match the LogRecord interface in
// apps/{indexer,relay}/src/log/index.ts.  If those types change,
// this schema needs to change too — failing this smoke is the
// right way to find that out.
const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

const LogRecordSchema = z.object({
	ts: z.string().regex(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/,
		'ts must be ISO 8601 UTC ("Z" suffix)'
	),
	level: LogLevelSchema,
	// Module names use lowercase-kebab convention in this codebase
	// (e.g. "host-resource", "smartctl", "mdadm").  Single hyphen
	// separator allowed; underscore allowed too; no uppercase.
	module: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/, 'module must be lowercase (kebab or snake)'),
	// Event names are stricter: lowercase_snake.  This is the
	// convention parseJournalLine and the classifier expect.
	event: z.string().min(1).regex(/^[a-z][a-z0-9_]*$/, 'event must be lowercase_snake'),
	context: z.record(z.string(), z.unknown()),
	error: z
		.object({
			name: z.string(),
			message: z.string(),
			stack: z.string().optional()
		})
		.optional()
});

type LogRecord = z.infer<typeof LogRecordSchema>;

// ─── Sidecars to exercise ──────────────────────────────────────
// Each entry is a sidecar script + the module name it should
// emit + any env overrides needed to force a specific code path.
//
// We use the *_unavailable INFO event as the universal exerciser
// because every sidecar emits one when its external tool is
// missing — and on the CI runner, most external tools (smartctl,
// trivy, postqueue, fail2ban-client, docker, openssl-with-letsencrypt)
// are missing.  This means every sidecar is exercised even on
// a minimal Ubuntu runner.
interface SidecarSpec {
	readonly script: string;
	readonly module: string;
	/** Env vars to set, in addition to the PATH override. */
	readonly env?: Record<string, string>;
}

const SIDECARS: SidecarSpec[] = [
	{ script: 'morphit-host-monitor.sh', module: 'host-resource' },
	{ script: 'morphit-smartctl-monitor.sh', module: 'smartctl' },
	{ script: 'morphit-fail2ban-monitor.sh', module: 'fail2ban' },
	{ script: 'morphit-mdadm-monitor.sh', module: 'mdadm' },
	{ script: 'morphit-dmesg-monitor.sh', module: 'dmesg' },
	{ script: 'morphit-trivy-monitor.sh', module: 'trivy' },
	{ script: 'morphit-postfix-monitor.sh', module: 'postfix' },
	{ script: 'morphit-certbot-monitor.sh', module: 'certbot' },
	{ script: 'morphit-apt-monitor.sh', module: 'apt' },
	{ script: 'morphit-compose-monitor.sh', module: 'compose' },
	{ script: 'morphit-systemd-monitor.sh', module: 'systemd' },
	{ script: 'morphit-journald-monitor.sh', module: 'journald' }
];

// ─── Test harness ──────────────────────────────────────────────
function makeMockBin(dir: string): void {
	// Mock systemd-cat that just dumps stdin to stdout.
	const path = join(dir, 'systemd-cat');
	writeFileSync(
		path,
		'#!/bin/sh\n# Test mock — emits stdin to stdout so the smoke can capture it.\ncat\n',
		'utf-8'
	);
	chmodSync(path, 0o755);
}

interface RunResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly status: number | null;
	/** Set when the sidecar was killed by a signal (e.g.
	 *  spawnSync's timeout fires SIGTERM).  Surfaced in error
	 *  detail so smoke-output makes the failure mode visible
	 *  instead of just `exited null`. */
	readonly signal: NodeJS.Signals | null;
}

function runSidecar(spec: SidecarSpec, mockBinDir: string): RunResult {
	const scriptPath = join(SCRIPTS_DIR, spec.script);
	if (!existsSync(scriptPath)) {
		return { stdout: '', stderr: `script not found: ${scriptPath}`, status: 1, signal: null };
	}
	const env = {
		...process.env,
		PATH: `${mockBinDir}:${process.env.PATH ?? ''}`,
		// State dirs may be touched; redirect each stateful sidecar's
		// dir env var to the mock bin dir (which we clean up).
		// Without this, host-monitor + fail2ban-monitor + dmesg-monitor
		// would write to /var/lib/morphit-*/, sometimes succeeding and
		// sometimes failing depending on filesystem state, causing
		// intermittent flake when the envelope smoke runs alongside
		// other smokes that mutate shared state.
		MORPHIT_HOST_STATE_DIR: mockBinDir,
		MORPHIT_FAIL2BAN_STATE_DIR: mockBinDir,
		MORPHIT_DMESG_STATE_DIR: mockBinDir,
		...spec.env
	};
	const r: SpawnSyncReturns<string> = spawnSync('sh', [scriptPath], {
		env,
		encoding: 'utf-8',
		// Per-sidecar wall-clock budget.  Bumped 30s → 60s in cp22
		// after the cp21 disclosure that ~1 in 7 pulses flaked at
		// 2,881 scenarios (smoke total -24, matching this smoke's
		// scenario count).  Root cause was apt-monitor.sh's
		// `apt-get update` occasionally stalling past 30s under
		// slow-mirror conditions; apt-monitor was patched to wrap
		// the apt call in its own `timeout 20`, but a 60s
		// smoke-level cap is the belt-and-braces for every other
		// sidecar that might develop similar issues.
		timeout: 60_000
	});
	return {
		stdout: r.stdout ?? '',
		stderr: r.stderr ?? '',
		status: r.status,
		signal: r.signal
	};
}

// ─── Build scenarios ───────────────────────────────────────────
interface Scenario {
	readonly name: string;
	readonly run: () => { ok: boolean; detail?: string };
}

const mockBinDir = mkdtempSync(join(tmpdir(), 'morphit-envelope-smoke-'));
makeMockBin(mockBinDir);

const scenarios: Scenario[] = [];

for (const spec of SIDECARS) {
	scenarios.push({
		name: `${spec.script} emits envelopes matching LogRecord schema`,
		run: () => {
			const r = runSidecar(spec, mockBinDir);
			if (r.status !== 0) {
				// Surface the signal explicitly when set — spawnSync's
				// timeout fires SIGTERM, and `exited null` alone is
				// hard to debug.  Per Part 121 cp22 disclosure post-
				// mortem.
				const sigSuffix = r.signal ? ` (signal=${r.signal})` : '';
				return {
					ok: false,
					detail: `sidecar exited ${r.status}${sigSuffix}; stderr: ${r.stderr.slice(0, 200)}`
				};
			}
			const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
			if (lines.length === 0) {
				// No emissions — that's acceptable behavior (the
				// sidecar saw nothing worth alerting on).  Still
				// counts as a pass since we exercised the script
				// path and got no malformed output.
				return { ok: true };
			}
			for (const [i, line] of lines.entries()) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch (e) {
					return {
						ok: false,
						detail: `line ${i + 1} is not JSON: "${line.slice(0, 200)}"`
					};
				}
				const result = LogRecordSchema.safeParse(parsed);
				if (!result.success) {
					const issues = result.error.issues
						.map((iss) => `${iss.path.join('.')}: ${iss.message}`)
						.join('; ');
					return {
						ok: false,
						detail: `line ${i + 1} fails schema: ${issues} (data: ${line.slice(0, 200)})`
					};
				}
				const rec = result.data as LogRecord;
				if (rec.module !== spec.module) {
					return {
						ok: false,
						detail: `line ${i + 1} has module="${rec.module}", expected "${spec.module}"`
					};
				}
			}
			return { ok: true };
		}
	});
}

// ─── Extra coverage scenario: every sidecar's *_unavailable
// event uses the snake_case naming convention ───────────────
//
// This catches the most common bash-side typo: emitting events
// like "smartUnavailable" or "SMARTCTL_UNAVAILABLE" instead of
// the canonical "smartctl_unavailable".  We don't need to run
// the sidecars for this — we grep the script source.
import { readFileSync } from 'node:fs';
for (const spec of SIDECARS) {
	const scriptPath = join(SCRIPTS_DIR, spec.script);
	if (!existsSync(scriptPath)) continue;
	const src = readFileSync(scriptPath, 'utf-8');
	// Find all `emit <level> <event_name>` calls in the script.
	// Bash emit "$1" "$2" "$3" pattern means we grep for emit
	// followed by a level word + an event name.
	const eventNameMatches = src.matchAll(/emit\s+(?:info|warn|error|debug)\s+([A-Za-z_][A-Za-z0-9_]*)/g);
	const eventNames = new Set<string>();
	for (const m of eventNameMatches) {
		eventNames.add(m[1]);
	}
	scenarios.push({
		name: `${spec.script} event names follow lowercase_snake convention`,
		run: () => {
			const offenders: string[] = [];
			for (const e of eventNames) {
				if (!/^[a-z][a-z0-9_]*$/.test(e)) {
					offenders.push(e);
				}
			}
			if (offenders.length > 0) {
				return {
					ok: false,
					detail: `non-snake_case event names: ${offenders.join(', ')}`
				};
			}
			return { ok: true };
		}
	});
}

// ─── cp22 regression sentinel: timeout discipline ──────────────
//
// Per Part 121 cp21 disclosure, this smoke flaked ~1 pulse in
// ~7 with a 24-scenario drop matching this smoke's size.  Root
// cause was apt-monitor.sh's `apt-get update` occasionally
// exceeding the 30s spawnSync budget.  Two-layer fix (cp22):
//   (a) apt-monitor.sh wraps `apt-get update` in `timeout 20`
//       so a slow mirror can't blow the smoke budget
//   (b) this smoke's spawnSync timeout is now 60_000ms
// This sentinel locks both fixes against regression — if a
// future edit reverts either layer, this scenario fails loudly.
scenarios.push({
	name: 'apt-monitor.sh wraps apt-get update in `timeout` (cp22)',
	run: () => {
		const aptMonitorPath = join(SCRIPTS_DIR, 'morphit-apt-monitor.sh');
		if (!existsSync(aptMonitorPath)) {
			return { ok: false, detail: 'morphit-apt-monitor.sh not found' };
		}
		const src = readFileSync(aptMonitorPath, 'utf-8');
		// Allow `timeout N apt-get update` where N is any positive integer.
		// The tight regex defends against drift (e.g. someone removing the
		// timeout entirely or wrapping a different command).
		if (!/timeout\s+\d+\s+apt-get\s+update/.test(src)) {
			return {
				ok: false,
				detail:
					'apt-get update is not wrapped in `timeout N` — slow mirrors could stall the sidecar past the smoke budget (Part 121 cp22 regression)'
			};
		}
		return { ok: true };
	}
});

scenarios.push({
	name: 'sidecar-envelope-smoke spawnSync timeout is at least 60_000ms (cp22)',
	run: () => {
		// Self-grep against this smoke file itself.  Locks the
		// per-sidecar wall-clock budget against accidental
		// downgrade.
		const selfPath = new URL(import.meta.url).pathname;
		const src = readFileSync(selfPath, 'utf-8');
		// The active `timeout: N` literal in the spawnSync options.
		const m = src.match(/timeout:\s*(\d[\d_]*)/);
		if (!m) {
			return {
				ok: false,
				detail: 'could not locate spawnSync `timeout:` option in this smoke source'
			};
		}
		const ms = Number(m[1].replaceAll('_', ''));
		if (!Number.isFinite(ms) || ms < 60_000) {
			return {
				ok: false,
				detail: `spawnSync timeout is ${ms}ms; must be ≥ 60_000ms after Part 121 cp22 (flake fix)`
			};
		}
		return { ok: true };
	}
});

// ─── Run all scenarios ─────────────────────────────────────────
console.log(`sidecar envelope smoke: ${scenarios.length} scenarios\n`);
let failed = 0;
for (const s of scenarios) {
	const r = s.run();
	if (r.ok) {
		console.log(`  ✓ ${s.name}`);
	} else {
		console.log(`  ✗ ${s.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}
try {
	rmSync(mockBinDir, { recursive: true, force: true });
} catch {
	// best-effort cleanup
}

console.log('');
if (failed === 0) {
	console.log(`✓ all ${scenarios.length} envelope checks hold`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} failed, ${scenarios.length - failed} passed`);
	process.exit(1);
}
