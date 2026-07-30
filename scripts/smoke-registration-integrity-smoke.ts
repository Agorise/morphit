#!/usr/bin/env tsx
/**
 * smoke-registration-integrity-smoke — keep `scripts/run-smokes.sh` and the
 * on-disk smoke files in lockstep.
 *
 * Two failure modes this guards, both seen in practice:
 *   1. A registered entry points at a file that doesn't exist (typo / file
 *      renamed-or-removed without updating the runner). The runner already
 *      fails loudly on this at run time; this catches it statically too.
 *   2. A `*-smoke.ts` file exists on disk but is NOT registered — so it never
 *      runs in the battery or CI and silently rots. This is exactly what
 *      happened to `forbidden-char-consistency-smoke` (cp232 created it as the
 *      forbidden-character drift guard but never wired it into the runner, so
 *      the guard was dead until cp242 found it). A guard that doesn't run is
 *      worse than no guard — it gives false confidence.
 *
 * NOTE on the canonical `✓ all N …` tally line: it is NOT checked statically
 * here. Many smokes construct that line dynamically (a shared print helper or
 * a template with the count interpolated between `✓` and `all`), so a literal
 * grep produces false positives. The runner enforces the tally line at run
 * time (it treats "exited 0 but emitted no `^✓ all N` line" as a failure — the
 * J-1/J-2 guard), which is the correct place for a runtime property.
 *
 * Allowlist: smoke-shaped files that intentionally do NOT belong in the
 * battery (helpers, fixtures named `*-smoke.ts`, etc.). Empty today — every
 * `*-smoke.ts` is a real battery entry. Add here (with a reason) only if a
 * genuinely-non-battery file ever needs the `-smoke` name.
 *
 * Usage:
 *   tsx scripts/smoke-registration-integrity-smoke.ts
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** `*-smoke.ts` files that are deliberately NOT in run-smokes.sh. */
const ORPHAN_ALLOWLIST: ReadonlySet<string> = new Set<string>([
	// (none currently)
]);

interface R {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}
const results: R[] = [];
function check(name: string, ok: boolean, detail?: string): void {
	results.push({ name, ok, detail });
}

/** Parse the SMOKES=( "ws:name" … ) array out of run-smokes.sh. */
function parseRegistered(): string[] {
	const sh = readFileSync(join(ROOT, 'scripts', 'run-smokes.sh'), 'utf-8');
	const start = sh.indexOf('SMOKES=(');
	if (start < 0) throw new Error('run-smokes.sh: SMOKES=( … ) array not found');
	const end = sh.indexOf('\n)', start);
	if (end < 0) throw new Error('run-smokes.sh: unterminated SMOKES array');
	const block = sh.slice(start, end);
	const entries: string[] = [];
	const re = /"([^"]+:[^"]+)"/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(block)) !== null) entries.push(m[1]);
	return entries;
}

/** workspace-relative path of a `ws:name` entry's smoke file. */
function entryPath(entry: string): string {
	const idx = entry.lastIndexOf(':');
	const ws = entry.slice(0, idx);
	const name = entry.slice(idx + 1);
	return ws === '.' ? join('scripts', `${name}.ts`) : join(ws, 'scripts', `${name}.ts`);
}

/** Every `<ws>/scripts/*-smoke.ts` on disk, as `ws:name`. */
function onDiskSmokes(): string[] {
	const out: string[] = [];
	const scriptDirs: Array<[string, string]> = [['.', join(ROOT, 'scripts')]];
	for (const group of ['apps', 'packages']) {
		const groupDir = join(ROOT, group);
		if (!existsSync(groupDir)) continue;
		for (const ws of readdirSync(groupDir)) {
			const sd = join(groupDir, ws, 'scripts');
			if (existsSync(sd) && statSync(sd).isDirectory()) scriptDirs.push([`${group}/${ws}`, sd]);
		}
	}
	for (const [ws, dir] of scriptDirs) {
		for (const f of readdirSync(dir)) {
			if (f.endsWith('-smoke.ts')) out.push(`${ws}:${f.slice(0, -3)}`);
		}
	}
	return out;
}

function main(): void {
	const registered = parseRegistered();
	const registeredSet = new Set(registered);

	check('registered_entries_parsed', registered.length > 200, `${registered.length} entries`);

	// 1) Every registered entry resolves to a real file.
	const missing = registered.filter((e) => !existsSync(join(ROOT, entryPath(e))));
	check(
		'no_registered_entry_missing_its_file',
		missing.length === 0,
		missing.length ? `missing: ${missing.join(', ')}` : `all ${registered.length} resolve`
	);

	// 2) No duplicate registrations.
	const dupes = registered.filter((e, i) => registered.indexOf(e) !== i);
	check('no_duplicate_registrations', dupes.length === 0, dupes.length ? `dupes: ${[...new Set(dupes)].join(', ')}` : 'none');

	// 3) Every on-disk *-smoke.ts is registered (or explicitly allowlisted).
	const disk = onDiskSmokes();
	const orphans = disk.filter((e) => !registeredSet.has(e) && !ORPHAN_ALLOWLIST.has(e));
	check(
		'no_orphaned_smoke_files',
		orphans.length === 0,
		orphans.length ? `orphans (exist but unregistered): ${orphans.join(', ')}` : `all ${disk.length} *-smoke.ts files registered`
	);

	let pass = 0;
	let fail = 0;
	console.log('');
	console.log('──────────────────────────────────────────────────────');
	for (const r of results) {
		if (r.ok) {
			pass += 1;
			console.log(`  ✓ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
		} else {
			fail += 1;
			console.error(`  ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
		}
	}
	if (fail > 0) {
		console.error(`\nsmoke-registration-integrity: ${pass} pass / ${fail} fail`);
		process.exit(1);
	}
	console.log(`\n✓ all ${pass} smoke-registration-integrity scenarios passed`);
}

main();
