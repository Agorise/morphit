#!/usr/bin/env tsx
/**
 * no-sandbox-path-smoke
 *
 * Shipped scripts must not hardcode a developer's or build machine's home
 * path. Four scripts once carried a build environment's absolute home path,
 * which (a) broke them on every other machine — the chunked smoke runner's
 * doubled "/home/<user>/morphit/morphit/…/tsx" path failed outright — and
 * (b) leaked the build layout into a privacy-first, operator-distributed
 * repo.
 *
 * Rule: a shipped script (.sh/.js/.mjs/.cjs/.ts/.py) may name a /home/<user>
 * path only for the documented service user (/home/morphit) or an invented
 * fixture user from the list below (smokes use them to exercise
 * path-substitution logic). Any other user's home is a leak.
 *
 * Markdown is not scanned; only shipped scripts are.
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
	else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
	}
}

const SCRIPT_EXT = /\.(sh|js|mjs|cjs|ts|py)$/;
const SKIP_DIR = new Set(['node_modules', '.svelte-kit', '.git', 'dist', 'build', '.bin']);
const SCAN_ROOTS = ['scripts', 'ops', 'apps', 'packages'];

/** The service user and the invented fixture users smokes and help texts use. */
const ALLOWED_HOME_USERS = new Set(['morphit', 'tester', 'op', 'you', 'alice', 'user']);
const HOME_RE = /\/home\/([A-Za-z0-9_][A-Za-z0-9_.-]*)/g;
/** The first /home/<user> path whose user is not on the list, if any. */
function leakedHome(text: string): string | undefined {
	for (const m of text.matchAll(HOME_RE)) if (!ALLOWED_HOME_USERS.has(m[1])) return m[0];
	return undefined;
}

function walk(dir: string, acc: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (SKIP_DIR.has(name)) continue;
		const full = join(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) walk(full, acc);
		else if (SCRIPT_EXT.test(name)) acc.push(full);
	}
}

console.log('\n── leak detector self-tests ───────────────────────────');
const H = '/home/';
check("flags a build user's home path", leakedHome(H + 'builder/morphit/x') !== undefined);
check(
	'flags a doubled build path',
	leakedHome(H + 'builder/morphit/morphit/node_modules/.bin/tsx') !== undefined
);
check('allows /home/morphit (service user)', leakedHome(H + 'morphit/backups') === undefined);
check(
	'allows /home/morphit/morphit (clone path)',
	leakedHome(H + 'morphit/morphit/apps') === undefined
);
check(
	'allows invented fixture users',
	leakedHome(H + 'tester/x') === undefined && leakedHome(H + 'op/morphit') === undefined
);
check('allows a placeholder', leakedHome(H + '<user>/Downloads') === undefined);

console.log('\n── shipped-script scan ────────────────────────────────');
const files: string[] = [];
for (const root of SCAN_ROOTS) walk(resolve(repo, root), files);
check('found a non-trivial set of scripts to scan', files.length > 200, `got ${files.length}`);

let offenders = 0;
for (const f of files) {
	if (f === thisFile) continue;
	let text: string;
	try {
		text = readFileSync(f, 'utf-8');
	} catch {
		continue;
	}
	const leak = leakedHome(text);
	if (leak) {
		offenders++;
		console.log(`  ✗ ${relative(repo, f)} — hardcoded home path ${leak}`);
	}
}
check(
	'no shipped script hardcodes a personal or build home path',
	offenders === 0,
	`${offenders} offender(s)`
);

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} no-sandbox-path scenarios passed (${files.length} scripts scanned)`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
