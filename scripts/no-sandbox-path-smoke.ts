#!/usr/bin/env tsx
/**
 * no-sandbox-path-smoke
 *
 * Shipped scripts must not hardcode the build environment's absolute home
 * path. Four scripts had leaked one (Claude's sandbox lives at /home/claude/…),
 * which (a) broke them on every other machine — the chunked smoke runner's
 * doubled "/home/claude/morphit/morphit/…/tsx" path failed outright — and
 * (b) leaked the build layout into a privacy-first, operator-distributed
 * repo. They were repaired this checkpoint; this guard stops the 5th.
 *
 * Rule: no shipped script (.sh/.js/.mjs/.cjs/.ts/.py) may contain a
 * "/home/claude" path. Other /home/<user> paths are NOT flagged: /home/morphit
 * is the documented service-user home, and smokes legitimately use invented
 * fixture users (/home/tester, /home/op) to exercise path-substitution logic.
 *
 * Markdown ledgers (TARBALL.md, REVISIT-LIST*, AUDIT-*) are append-only
 * historical records and are intentionally NOT scanned — they describe past
 * sandbox sessions; rewriting them would be revisionism.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');
const thisFile = fileURLToPath(import.meta.url);

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = ''): void {
	checks++;
	if (cond) console.log(`  ✓ ${name}`);
	else { failures++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const SCRIPT_EXT = /\.(sh|js|mjs|cjs|ts|py)$/;
const SKIP_DIR = new Set(['node_modules', '.svelte-kit', '.git', 'dist', 'build', '.bin']);
const SCAN_ROOTS = ['scripts', 'ops', 'apps', 'packages'];

// The build-environment user. Built via concat so this guard never trips itself.
const SANDBOX_HOME = '/home/' + 'claude';
const LEAK_RE = new RegExp(SANDBOX_HOME.replace(/[/]/g, '\\/') + '\\b');

function walk(dir: string, acc: string[]): void {
	let entries: string[];
	try { entries = readdirSync(dir); } catch { return; }
	for (const name of entries) {
		if (SKIP_DIR.has(name)) continue;
		const full = join(dir, name);
		let st;
		try { st = statSync(full); } catch { continue; }
		if (st.isDirectory()) walk(full, acc);
		else if (SCRIPT_EXT.test(name)) acc.push(full);
	}
}

console.log('\n── leak detector self-tests ───────────────────────────');
const H = '/home/';
check('flags the sandbox home path', LEAK_RE.test(H + 'claude/morphit/x'));
check('flags doubled sandbox path', LEAK_RE.test(H + 'claude/morphit/morphit/node_modules/.bin/tsx'));
check('allows /home/morphit (service user)', !LEAK_RE.test(H + 'morphit/backups'));
check('allows /home/morphit/morphit (clone path)', !LEAK_RE.test(H + 'morphit/morphit/apps'));
check('allows invented fixture users', !LEAK_RE.test(H + 'tester/x') && !LEAK_RE.test(H + 'op/morphit'));

console.log('\n── shipped-script scan ────────────────────────────────');
const files: string[] = [];
for (const root of SCAN_ROOTS) walk(resolve(repo, root), files);
check('found a non-trivial set of scripts to scan', files.length > 200, `got ${files.length}`);

let offenders = 0;
for (const f of files) {
	if (f === thisFile) continue;
	let text: string;
	try { text = readFileSync(f, 'utf-8'); } catch { continue; }
	const m = text.match(LEAK_RE);
	if (m) {
		offenders++;
		console.log(`  ✗ ${relative(repo, f)} — hardcoded sandbox home path`);
	}
}
check('no shipped script hardcodes the sandbox home path', offenders === 0, `${offenders} offender(s)`);

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} no-sandbox-path scenarios passed (${files.length} scripts scanned)`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
