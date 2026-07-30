#!/usr/bin/env tsx
/**
 * systemd-js-runtime-af-unix-smoke — every shipped systemd unit whose
 * ExecStart launches a JavaScript runtime (tsx / node / npm) and that
 * also declares a `RestrictAddressFamilies=` sandbox MUST include
 * `AF_UNIX` in that list.
 *
 * Why: tsx's module loader (and Node's worker/IPC plumbing) communicate
 * over an AF_UNIX domain socket — e.g. `/tmp/tsx-0/<pid>.pipe`. A unit
 * that restricts address families to only `AF_INET AF_INET6` makes that
 * `listen()` fail with `EAFNOSUPPORT`, and the service crash-loops at
 * startup. This is exactly what bit the relay on the systemd migration:
 * `morphit-relay.service` shipped `RestrictAddressFamilies=AF_INET
 * AF_INET6` (no AF_UNIX) and the relay never came up. The indexer unit
 * was correct; relay, mcp, and relay-mint-acts were not. beta.13 fixed
 * all three — this smoke prevents the class from recurring as units are
 * added or edited.
 *
 * A JS-runtime unit with NO `RestrictAddressFamilies=` at all is fine —
 * with no restriction every family (including AF_UNIX) is permitted, so
 * there's nothing to crash. The check only fires when a restriction
 * exists but omits AF_UNIX.
 *
 * Shell-script units (the `*-monitor.sh`, backup, etc.) are not JS
 * runtimes and are intentionally out of scope.
 *
 * Scenarios:
 *   1. For every JS-runtime unit (ExecStart invokes tsx/node/npm) that
 *      declares RestrictAddressFamilies=, the value includes AF_UNIX.
 *   2. Sanity meta-check: at least one JS-runtime unit was discovered
 *      (catches a future restructure that moves the app units out of
 *      ops/systemd/, which would otherwise make scenario 1 vacuously
 *      pass).
 *
 * Usage:
 *   tsx apps/ops-cli/scripts/systemd-js-runtime-af-unix-smoke.ts
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const SYSTEMD_DIR = join(REPO_ROOT, 'ops', 'systemd');

interface ScenarioResult {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}
const results: ScenarioResult[] = [];

/** Reassemble a possibly line-continued directive value.
 *  systemd allows `\` at end-of-line to continue onto the next line;
 *  ExecStart= for the matrix-bot unit uses this. We join the physical
 *  lines into one logical value so substring checks see the whole
 *  command. */
function readDirectiveValue(lines: readonly string[], directive: string): string | null {
	const prefix = `${directive}=`;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		if (!line.startsWith(prefix)) continue;
		let value = line.slice(prefix.length);
		// Follow `\` continuations.
		let j = i;
		while (value.endsWith('\\')) {
			value = value.slice(0, -1);
			j += 1;
			const cont = lines[j];
			if (cont === undefined) break;
			value += ` ${cont.trim()}`;
		}
		return value;
	}
	return null;
}

/** True if the ExecStart command launches a JS runtime: a bare/abs
 *  `tsx` or `node` invocation, or an `npm start|run|exec`. The word
 *  boundaries avoid matching e.g. a script path that merely contains
 *  the substring "node". */
function isJsRuntimeExec(execStart: string): boolean {
	return (
		/(^|[\s/])tsx(\s|$)/.test(execStart) ||
		/(^|[\s/])node(\s|$)/.test(execStart) ||
		/(^|[\s])npm\s+(start|run|exec)(\s|$)/.test(execStart)
	);
}

function main(): void {
	if (!existsSync(SYSTEMD_DIR)) {
		results.push({
			name: 'systemd_dir_exists',
			ok: false,
			detail: `ops/systemd not found at ${SYSTEMD_DIR}`
		});
		report();
		return;
	}

	const unitFiles = readdirSync(SYSTEMD_DIR).filter((f) => f.endsWith('.service'));

	let jsRuntimeUnitsScanned = 0;
	const violations: string[] = [];

	for (const file of unitFiles) {
		const text = readFileSync(join(SYSTEMD_DIR, file), 'utf8');
		const lines = text.split('\n');

		const execStart = readDirectiveValue(lines, 'ExecStart');
		if (execStart === null) continue; // oneshot wrappers etc. — skip
		if (!isJsRuntimeExec(execStart)) continue; // shell-script unit — out of scope

		jsRuntimeUnitsScanned += 1;

		const raf = readDirectiveValue(lines, 'RestrictAddressFamilies');
		// No restriction → every family allowed → nothing to fail.
		if (raf === null) continue;

		// A restriction exists — it MUST include AF_UNIX, or tsx/node IPC
		// over its domain socket fails with EAFNOSUPPORT at startup.
		const families = raf.trim().split(/\s+/);
		if (!families.includes('AF_UNIX')) {
			violations.push(`${basename(file)} — RestrictAddressFamilies="${raf.trim()}" omits AF_UNIX`);
		}
	}

	results.push({
		name: 'js_runtime_units_include_af_unix',
		ok: violations.length === 0,
		detail:
			violations.length === 0
				? `all ${jsRuntimeUnitsScanned} JS-runtime unit(s) with a family restriction include AF_UNIX`
				: `${violations.length} unit(s) restrict address families without AF_UNIX:\n    - ${violations.join('\n    - ')}`
	});

	results.push({
		name: 'meta_found_js_runtime_units',
		ok: jsRuntimeUnitsScanned >= 1,
		detail:
			jsRuntimeUnitsScanned >= 1
				? `scanned ${jsRuntimeUnitsScanned} JS-runtime unit(s)`
				: 'no JS-runtime units found — did ops/systemd/ get restructured?'
	});

	report();
}

function report(): void {
	let pass = 0;
	let fail = 0;
	for (const r of results) {
		if (r.ok) {
			pass += 1;
			console.log(`  PASS  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
		} else {
			fail += 1;
			console.error(`  FAIL  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
		}
	}
	if (fail > 0) {
		console.error(`\nsystemd-js-runtime-af-unix-smoke: ${pass} pass / ${fail} fail`);
		process.exit(1);
	}
	console.log(`\n✓ all ${pass} systemd-js-runtime-af-unix scenarios passed`);
}

main();
