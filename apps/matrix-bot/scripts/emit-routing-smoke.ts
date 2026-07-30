#!/usr/bin/env tsx
/**
 * emit-routing-smoke — emit.sh must route LogRecords to the journal in a way
 * that lands them with _SYSTEMD_UNIT, because matrix-bot tails
 * `journalctl -u <unit>` and matches on _SYSTEMD_UNIT.
 *
 * Background (live-test finding): emit.sh used to pipe UNCONDITIONALLY to
 * `systemd-cat`. On at least some systemd/journald builds those entries
 * arrive with NO _SYSTEMD_UNIT at all — the journal stream is opened by the
 * short-lived systemd-cat process, whose cgroup journald can't reliably
 * resolve — so the bot's `-u` filter SILENTLY dropped every shell-sidecar
 * alert (host/dmesg/smartctl/fail2ban/mdadm/trivy/postfix/certbot/apt/
 * compose/systemd/journald monitors). The bot looked healthy but would never
 * have delivered a real alert.
 *
 * The fix: under a systemd service with StandardOutput=journal, systemd sets
 * $JOURNAL_STREAM and OWNS the stdout stream, so anything emit() prints to
 * stdout lands in the journal tagged with _SYSTEMD_UNIT=<unit>.service — the
 * exact thing the bot filters on. So emit() writes to STDOUT under a service
 * and only falls back to `systemd-cat` when NOT under a journal-connected
 * service (manual run / cron).
 *
 * This smoke runs emit() under controlled env + a stub `systemd-cat` and
 * asserts:
 *   1. JOURNAL_STREAM set   -> LogRecord JSON on STDOUT; systemd-cat NOT
 *      invoked (proves the service path doesn't depend on it).
 *   2. JOURNAL_STREAM unset  -> nothing on stdout; systemd-cat IS invoked
 *      (fallback still reaches journald).
 *   3. The emitted line parses as the LogRecord envelope.
 *
 * Hard-fails if emit() ever regresses to unconditionally piping to
 * systemd-cat (which is what silently broke alerting in the first place).
 */

import { spawnSync } from 'node:child_process';
import {
	mkdtempSync,
	writeFileSync,
	chmodSync,
	rmSync,
	readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const EMIT_SH = join(REPO_ROOT, 'ops', 'scripts', 'lib', 'emit.sh');

let failures = 0;
let scenarios = 0;
function check(name: string, cond: boolean, detail = ''): void {
	scenarios++;
	if (cond) {
		console.log(`  \u2713 ${name}`);
	} else {
		failures++;
		console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
	}
}

// Temp dir holding a stub `systemd-cat` that records each invocation (so we
// can detect whether emit() routed through it).
const dir = mkdtempSync(join(tmpdir(), 'emit-routing-'));
const marker = join(dir, 'systemd-cat-called');
const stub = join(dir, 'systemd-cat');
writeFileSync(
	stub,
	`#!/bin/sh\necho called >> "${marker}"\ncat > /dev/null\n`,
	'utf8',
);
chmodSync(stub, 0o755);

interface EmitResult {
	stdout: string;
	stderr: string;
	catCalled: boolean;
}

function runEmit(journalStream: string | null): EmitResult {
	try {
		rmSync(marker);
	} catch {
		/* marker may not exist yet */
	}
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		PATH: `${dir}:${process.env.PATH ?? ''}`,
	};
	if (journalStream === null) {
		delete env.JOURNAL_STREAM;
	} else {
		env.JOURNAL_STREAM = journalStream;
	}
	const script =
		`. "${EMIT_SH}"; ` +
		`export MORPHIT_EMIT_MODULE=tamper MORPHIT_EMIT_TAG=morphit-host-monitor; ` +
		`emit info bundle_hash_mismatch '{"note":"routing-smoke"}'`;
	const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
	let catCalled = false;
	try {
		readFileSync(marker);
		catCalled = true;
	} catch {
		catCalled = false;
	}
	return {
		stdout: (r.stdout ?? '').trim(),
		stderr: (r.stderr ?? '').trim(),
		catCalled,
	};
}

console.log('emit-routing-smoke');

// ─── Scenario 1: under a journal-connected service ──────────────────────
const svc = runEmit('8:99999');
check(
	'service path (JOURNAL_STREAM set): LogRecord written to stdout',
	svc.stdout.startsWith('{') && svc.stdout.endsWith('}'),
	`stdout=[${svc.stdout}]`,
);
check(
	'service path: systemd-cat NOT invoked (would strip _SYSTEMD_UNIT)',
	svc.catCalled === false,
	'stub systemd-cat was called',
);

let parsed: Record<string, unknown> | null = null;
try {
	parsed = JSON.parse(svc.stdout) as Record<string, unknown>;
} catch {
	parsed = null;
}
check('service path: stdout is valid JSON', parsed !== null);
if (parsed) {
	check('envelope: ts is a string', typeof parsed.ts === 'string');
	check('envelope: level === "info"', parsed.level === 'info');
	check('envelope: module === "tamper"', parsed.module === 'tamper');
	check(
		'envelope: event === "bundle_hash_mismatch"',
		parsed.event === 'bundle_hash_mismatch',
	);
	check(
		'envelope: context is an object',
		typeof parsed.context === 'object' && parsed.context !== null,
	);
}

// ─── Scenario 2: NOT under a journal-connected service (fallback) ───────
const fb = runEmit(null);
check(
	'fallback path (no JOURNAL_STREAM): nothing on stdout (routed to systemd-cat)',
	fb.stdout === '',
	`stdout=[${fb.stdout}]`,
);
check(
	'fallback path: systemd-cat WAS invoked (still reaches journald)',
	fb.catCalled === true,
	'stub systemd-cat was not called',
);

rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
	console.error(
		`\nemit-routing-smoke: ${failures} failure(s) across ${scenarios} checks`,
	);
	process.exit(1);
}
console.log(`\n\u2713 all ${scenarios} emit-routing-smoke checks passed`);
