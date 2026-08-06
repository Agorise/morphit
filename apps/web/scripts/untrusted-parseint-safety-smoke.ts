#!/usr/bin/env tsx
/**
 * untrusted-parseint-safety smoke — Part 122 cp71 (LL #72 / O-20).
 *
 * `parseInt('999000abc', 10) = 999000` silently accepts trailing
 * garbage.  Number.isFinite(parseInt(s,10)) returns true for any
 * input starting with a digit.  When `s` comes from an untrusted
 * source (HTTP header, query param, request body, env var from
 * operator), this is a footgun: a malicious or malformed value
 * passes the validity check and the rest of the code trusts a
 * partially-parsed number.
 *
 * cp70-D1 found a real instance of this in bodyCap middleware
 * where `parseInt(c.req.header('content-length'), 10)` would
 * accept "999000abc".  The fix: require `/^\d+$/.test(s)` BEFORE
 * parsing, and prefer `Number()` to `parseInt()` for stricter
 * semantics.
 *
 * This smoke walks all .ts source files and flags `parseInt(` and
 * `parseFloat(` calls whose first argument is plausibly an
 * untrusted string.  The heuristics:
 *
 *   • The argument contains `req.header(`, `query.`, `c.req.`,
 *     `req.param`, `params.`, `searchParams.`, or `process.env.`
 *   • The argument is a plain variable named like a request
 *     extracted field (e.g. `header`, `lengthHeader`, `xForwardedFor`)
 *
 * Allow-listed call sites: those that have `/^\d+$/.test(...)` or
 * an equivalent regex check on the same value BEFORE the parseInt
 * call, OR are operating on DB-row data (rows from a SELECT) where
 * Postgres's type system guarantees the format.
 *
 * Mutation test M-143:  introduce `parseInt(c.req.header('foo'), 10)`
 * to any API file → smoke fires.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

interface Finding {
	readonly file: string;
	readonly line: number;
	readonly context: string;
	readonly reason: string;
}

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── untrusted-parseint-safety smoke (cp71 LL #72 / O-20) ──\n');

function walkTs(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			// Skip node_modules, .svelte-kit, dist, test, .vite
			if (entry === 'node_modules' || entry === '.svelte-kit' || entry === 'dist' || entry === 'test' || entry === '.vite' || entry === 'historical') continue;
			walkTs(full, out);
		} else if (entry.endsWith('.ts')) {
			out.push(full);
		}
	}
}

const ALLOW_LIST = new Set<string>([
	// File + line + reason.  Format: `${relpath}:${lineHint}:${needle}`
	// where needle is the immediate context (matched as substring).
	// Example to allow a legitimate use after this smoke catches it:
	//   'apps/X/src/Y.ts:NN:parseInt(N)',
]);

const UNTRUSTED_NEEDLES: ReadonlyArray<RegExp> = [
	/c\.req\.header\(/,
	/c\.req\.query\(/,
	/c\.req\.param\(/,
	/req\.headers\b/,
	/req\.query\b/,
	/searchParams\.get\(/,
	/process\.env\./,
	/url\.searchParams/,
];

const SAFE_PRE_CHECKS: ReadonlyArray<RegExp> = [
	/\/\^\\d\+\$\/\.test\(/,
	/\/\^\[0-9\]\+\$\/\.test\(/,
	/Number\.isInteger\(/,
];

const tsFiles: string[] = [];
for (const root of [
	'apps/indexer/src',
	'apps/relay/src',
	'apps/web/src',
	'apps/ops-cli/src',
	'apps/matrix-bot/src',
	'packages'
]) {
	try {
		walkTs(join(REPO_ROOT, root), tsFiles);
	} catch {
		// missing dir; skip
	}
}

const findings: Finding[] = [];
let totalParseInt = 0;

for (const file of tsFiles) {
	const src = readFileSync(file, 'utf-8');
	const lines = src.split('\n');
	// Look for parseInt( or parseFloat( occurrences
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!/\b(parseInt|parseFloat)\s*\(/.test(line)) continue;
		totalParseInt++;
		// Extract the argument: everything between the first ( and the next ,
		// (parseInt/parseFloat take radix or coerce — first arg is the value)
		const m = line.match(/\b(?:parseInt|parseFloat)\s*\(([^,)]+)/);
		if (!m) continue;
		const argText = m[1]!.trim();

		// Heuristic 1: is the arg untrusted-looking?
		// Either the arg itself contains a needle, OR the surrounding
		// few lines define the value via a needle (we check the previous
		// 3 lines as a window for `const X = c.req.header(...); ...
		// parseInt(X, 10)` patterns).
		const window = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
		const untrusted = UNTRUSTED_NEEDLES.some((re) => re.test(window));
		if (!untrusted) continue;

		// Heuristic 2: is there a safe pre-check nearby (same line or
		// previous 5 lines)?
		const checkWindow = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
		const guarded = SAFE_PRE_CHECKS.some((re) => re.test(checkWindow));
		if (guarded) continue;

		const relPath = file.replace(REPO_ROOT + '/', '');
		const allowKey = `${relPath}:${i + 1}:${argText}`;
		if (ALLOW_LIST.has(allowKey)) continue;
		// Looser match for allow-list — file + line match suffices
		const fileLineKey = `${relPath}:${i + 1}`;
		let allowMatched = false;
		for (const entry of ALLOW_LIST) {
			if (entry.startsWith(fileLineKey + ':')) {
				allowMatched = true;
				break;
			}
		}
		if (allowMatched) continue;

		findings.push({
			file: relPath,
			line: i + 1,
			context: line.trim().slice(0, 200),
			reason: `Untrusted-input parse without /^\\d+$/ pre-check.  Use Number(s) only after \`/^\\d+$/.test(s)\`, or document why this input is trusted via the smoke's ALLOW_LIST.`
		});
	}
}

console.log(`▸ scanned ${tsFiles.length} .ts files; found ${totalParseInt} parseInt/parseFloat call(s)`);
console.log(`  ${findings.length} appear to operate on untrusted input WITHOUT a /^\\d+$/ pre-check.\n`);

for (const f of findings) {
	fail(
		`${f.file}:${f.line} parseInt has /^\\d+$/ pre-check`,
		`${f.context}\n      ${f.reason}`
	);
}

if (findings.length === 0) {
	pass(`all ${totalParseInt} parseInt/parseFloat sites either operate on trusted input or have a /^\\d+$/ pre-check`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nuntrusted-parseint-safety smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} untrusted-parseint-safety scenarios passed`);
