#!/usr/bin/env tsx
/**
 * scripts/sidecar-envelope-error-path-smoke.ts
 *
 * Structural Defense #34 — sidecar envelope error-path verifier
 * (cp83-O30 candidate, shipped cp84).
 *
 * Complements Defense #33 (sidecar-shell-quoting static smoke)
 * by approaching the cp83-D23a bug class from a different angle:
 * actually RUN each sidecar with a mocked external tool that
 * returns a multi-token error, then verify every emitted line
 * parses as valid JSON.
 *
 * Why both #33 and #34: #33 catches the syntactic anti-pattern
 * (`'$(` outside variable-assignment context) before the bug
 * ships.  #34 catches the runtime symptom regardless of how the
 * sidecar constructs its payload — so a future emit pattern that
 * doesn't trip the syntactic detector but still produces
 * malformed JSON under error conditions is caught here.
 *
 * Existing sidecar-envelope-smoke covers the happy / unavailable
 * paths (every sidecar emits its `*_unavailable` envelope when
 * its external tool is missing from PATH).  This smoke is the
 * companion: each fixture installs a working-binary mock that
 * exits non-zero with whitespace-laden multi-token error output,
 * forcing the sidecar down its error-handling branch.  That's
 * where cp83-D23a lived.
 *
 * Scope: one fixture per high-leverage sidecar — every sidecar
 * whose error path captures external-command output into an
 * emitted payload.  Each (sidecar, fixture) pair = one scenario.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SCRIPTS_DIR = join(REPO, 'ops/scripts');

// ─── Sidecar+fixture scenarios ──────────────────────────────────
//
// For each scenario:
//
//   - `sidecar`: filename under ops/scripts/ to run
//   - `mocks`: map of binary-name → shell-script body for the
//     mock binary placed in $PATH first
//   - `env`: extra env vars
//   - `description`: human-readable summary
//   - `mustEmitEvent`: at least one emitted envelope must have
//     this event name (sanity that the error branch fired).
//     Leaving `null` skips this assertion — useful when the
//     sidecar's error behavior is to exit silently.

interface MockBin {
	readonly name: string;
	readonly body: string;
}

interface Scenario {
	readonly sidecar: string;
	readonly description: string;
	readonly mocks: MockBin[];
	readonly env?: Record<string, string>;
	readonly mustEmitEvent: string | null;
}

const FAIL2BAN_DOWN_FIXTURE = `#!/bin/sh
# Mock fail2ban-client that simulates a downed daemon.
# Multi-token stderr is the exact cp83-D23a repro.
echo "2026-05-21 18:17:23,235 fail2ban [12345]: ERROR Failed to access socket" >&2
echo "ERROR: Unable to contact server.  Is it running?" >&2
exit 255
`;

const DOCKER_ERROR_FIXTURE = `#!/bin/sh
# Mock docker that returns a multi-token error.
echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2
exit 1
`;

const SYSTEMD_CAT_PASSTHROUGH = `#!/bin/sh
cat
`;

// State-dir redirects used by the existing envelope smoke; we
// reuse the same envs so sidecars that touch persistent state
// don't clobber the runner's filesystem.
function buildStateEnv(dir: string): Record<string, string> {
	return {
		MORPHIT_HOST_STATE_DIR: dir,
		MORPHIT_FAIL2BAN_STATE_DIR: dir,
		MORPHIT_DMESG_STATE_DIR: dir
	};
}

const SCENARIOS: Scenario[] = [
	{
		sidecar: 'morphit-fail2ban-monitor.sh',
		description: 'fail2ban-client returns multi-token error (cp83-D23a exact repro)',
		mocks: [
			{ name: 'fail2ban-client', body: FAIL2BAN_DOWN_FIXTURE },
			{ name: 'systemd-cat', body: SYSTEMD_CAT_PASSTHROUGH }
		],
		mustEmitEvent: 'daemon_unreachable'
	},
	{
		sidecar: 'morphit-compose-monitor.sh',
		description: 'docker returns connection-refused error',
		mocks: [
			{ name: 'docker', body: DOCKER_ERROR_FIXTURE },
			{ name: 'systemd-cat', body: SYSTEMD_CAT_PASSTHROUGH }
		],
		// docker-monitor's error path may emit nothing if it
		// detects compose isn't configured; we just want the JSON
		// to be valid IF anything is emitted.
		mustEmitEvent: null
	}
];

// ─── LogRecord shape (matches sidecar-envelope-smoke schema) ─────
// Lighter-weight than the zod version — we just verify each
// line is parseable JSON with the expected top-level keys.

function isValidLogRecord(obj: unknown): obj is {
	ts: string;
	level: string;
	module: string;
	event: string;
	context: unknown;
} {
	if (!obj || typeof obj !== 'object') return false;
	const o = obj as Record<string, unknown>;
	if (typeof o.ts !== 'string') return false;
	if (typeof o.level !== 'string') return false;
	if (typeof o.module !== 'string') return false;
	if (typeof o.event !== 'string') return false;
	if (!o.context || typeof o.context !== 'object') return false;
	return true;
}

interface RunResult {
	stdout: string;
	stderr: string;
	status: number | null;
	signal: NodeJS.Signals | null;
}

function runScenario(scenario: Scenario): RunResult {
	const mockDir = mkdtempSync(join(tmpdir(), 'morphit-error-path-'));
	try {
		for (const m of scenario.mocks) {
			const p = join(mockDir, m.name);
			writeFileSync(p, m.body, 'utf-8');
			chmodSync(p, 0o755);
		}
		const r: SpawnSyncReturns<string> = spawnSync(
			'sh',
			[join(SCRIPTS_DIR, scenario.sidecar)],
			{
				env: {
					...process.env,
					PATH: `${mockDir}:${process.env.PATH ?? ''}`,
					...buildStateEnv(mockDir),
					...(scenario.env ?? {})
				},
				encoding: 'utf-8',
				timeout: 30_000
			}
		);
		return {
			stdout: r.stdout ?? '',
			stderr: r.stderr ?? '',
			status: r.status,
			signal: r.signal
		};
	} finally {
		rmSync(mockDir, { recursive: true, force: true });
	}
}

console.log('\n── sidecar envelope error-path smoke ───────────────────\n');
console.log(`  scenarios: ${SCENARIOS.length}`);

const failures: string[] = [];
let passed = 0;

for (const sc of SCENARIOS) {
	if (!existsSync(join(SCRIPTS_DIR, sc.sidecar))) {
		failures.push(`${sc.sidecar}: not found in ${SCRIPTS_DIR}`);
		continue;
	}
	const r = runScenario(sc);
	const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);

	// Sidecars are expected to exit non-zero when their tool
	// fails — that's the error path.  We don't enforce a status
	// code; we only check the emitted envelopes.

	let scenarioOk = true;
	let sawMust = false;

	for (const [i, line] of lines.entries()) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (e) {
			failures.push(
				`${sc.sidecar} [${sc.description}]: line ${i + 1} is not JSON: ` +
					`${JSON.stringify(line.slice(0, 200))}`
			);
			scenarioOk = false;
			continue;
		}
		if (!isValidLogRecord(parsed)) {
			failures.push(
				`${sc.sidecar} [${sc.description}]: line ${i + 1} is JSON but ` +
					`missing required LogRecord fields (ts/level/module/event/context)`
			);
			scenarioOk = false;
			continue;
		}
		if (sc.mustEmitEvent && parsed.event === sc.mustEmitEvent) {
			sawMust = true;
		}
	}

	if (sc.mustEmitEvent && !sawMust && scenarioOk) {
		failures.push(
			`${sc.sidecar} [${sc.description}]: did not emit expected event ` +
				`\`${sc.mustEmitEvent}\` — fixture may not be triggering the error branch`
		);
		scenarioOk = false;
	}

	if (scenarioOk) passed++;
}

if (failures.length > 0) {
	console.log(`\n  ✗ ${failures.length} failure(s):`);
	for (const f of failures) console.log(`    - ${f}`);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${failures.length}/${SCENARIOS.length} scenarios failed`);
	process.exit(1);
}

console.log(`  ✓ all ${SCENARIOS.length} sidecar error-path emissions parse as LogRecord`);
console.log('\n──────────────────────────────────────────────────────');
console.log(`✓ all ${SCENARIOS.length} scenarios passed`);
