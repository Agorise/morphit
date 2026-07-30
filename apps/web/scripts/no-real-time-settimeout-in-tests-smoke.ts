#!/usr/bin/env tsx
/**
 * no-real-time-setTimeout-in-tests smoke — Part 122 cp76 (LL #76 / O-25).
 *
 * Closes the cp76-D16 class: real-time setTimeout waits inside test
 * files create CI flakes whose margin can vanish under CPU contention.
 *
 * cp76-D16 fixed the symptom: `apps/relay/test/killSwitch.test.ts`
 * was using `await new Promise((r) => setTimeout(r, 1500))` with only
 * 500 ms margin on a 1000 ms `setInterval` poll inside the production
 * `KillSwitch` class.  Under CI contention the margin vanished; pulse
 * 1 of the cp74 battery would intermittently fail.  cp76's fix
 * replaced the real-time wait with `vi.useFakeTimers()` +
 * `vi.advanceTimersByTime(1100)` — deterministic, no real-time
 * sensitivity, 30/30 clean over a 30-run reproduction.
 *
 * This smoke prevents the next variant of the same class: a test
 * author reaches for `setTimeout` instead of fake timers because
 * it's "simpler", and the suite gains a new flake source that takes
 * months to surface and longer to root-cause.
 *
 * Rule:
 *   No `setTimeout(*, N)` with N > 10 ms inside any *.test.ts or
 *   *.spec.ts file under apps/ or packages/.
 *
 * Why 10 ms tolerance:
 *   - `setTimeout(resolve, 0)` is a microtask-drain / event-loop yield
 *     used in async-orchestration tests (apps/web/src/lib/chat/
 *     chatService.test.ts + apps/web/src/lib/stores/identityPaired.
 *     test.ts).  Not a real-time wait; legitimate pattern.
 *   - 1-10 ms zero-effective-wait values would be similar.
 *   - 11+ ms is unambiguously a real-time wait, which is what we're
 *     banning.
 *
 * Comments don't count:
 *   Lines with `setTimeout` inside a `//` comment or a `*` JSDoc
 *   line are ignored.  Historical commentary (e.g. "Previously: real
 *   setTimeout(150)") in cp76-D16's own header and in
 *   altcha/ratelimit comments is legitimate.
 *
 * Fix pattern: replace
 *   await new Promise((r) => setTimeout(r, 1500));
 * with
 *   // In beforeEach: vi.useFakeTimers();
 *   vi.advanceTimersByTime(1100);
 * and ensure afterEach calls vi.useRealTimers().
 *
 * Recurring class scope progression (test-reliability defenses):
 *   cp71-O19: vitest-must-pass (every workspace's tests must pass)
 *   cp71-O20: untrusted-parseint-safety
 *   cp71-O21: fetch-must-have-timeout
 *   cp75-O23: brag-list-trailer-invariants
 *   cp75-O24: per-asset-mandatory-family-i18n-parity
 *   cp76-O25: no-real-time-setTimeout-in-tests (THIS smoke)
 *
 * Mutation test M-148:
 *   - Reintroduce `await new Promise((r) => setTimeout(r, 1500))` in
 *     any test file → smoke fires naming file + line + the offending
 *     numeric argument.
 *   - Remove it → smoke passes.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── no-real-time-setTimeout-in-tests smoke (cp76 LL #76 / O-25) ──\n');

/** Hard tolerance — values 0..10 ms are zero-effective-wait
 *  microtask drains, allowed.  11+ ms is banned. */
const MAX_ALLOWED_MS = 10;

/** Roots to walk for test files. */
const ROOTS = ['apps', 'packages'];

interface TestFile {
	readonly path: string;
}

function isTestFile(name: string): boolean {
	return /\.(test|spec)\.ts$/.test(name);
}

function walk(dir: string, acc: TestFile[]): void {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		// Skip node_modules and build outputs.
		if (name === 'node_modules' || name === 'dist' || name === '.svelte-kit' || name === 'build') continue;
		const full = join(dir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			walk(full, acc);
		} else if (st.isFile() && isTestFile(name)) {
			acc.push({ path: full });
		}
	}
}

const testFiles: TestFile[] = [];
for (const root of ROOTS) {
	walk(join(REPO_ROOT, root), testFiles);
}
console.log(`▸ Found ${testFiles.length} test files to scan\n`);

interface Violation {
	readonly file: string;
	readonly line: number;
	readonly ms: number;
	readonly snippet: string;
}
const violations: Violation[] = [];

/** Return true if a line is INSIDE a comment context.
 *  Cheap heuristic: strip the line's leading whitespace, then check
 *  if it begins with `//`, `/*`, `*`, `*\/`, or has `setTimeout` only
 *  appearing AFTER a `//` mid-line.  Doesn't handle multi-line block
 *  comments rigorously but covers the >95% case.  Test files don't
 *  embed setTimeout in block-comment bodies often enough to matter;
 *  if a real false-positive emerges, this is easy to extend with a
 *  block-comment state machine. */
function setTimeoutIsInComment(line: string): boolean {
	const trimmed = line.trimStart();
	if (trimmed.startsWith('//')) return true;
	if (trimmed.startsWith('/*')) return true;
	if (trimmed.startsWith('*')) return true; // JSDoc continuation
	// Mid-line `//` comment that comes before `setTimeout`.
	const commentIdx = line.indexOf('//');
	const setTimeoutIdx = line.indexOf('setTimeout');
	if (commentIdx !== -1 && setTimeoutIdx !== -1 && commentIdx < setTimeoutIdx) return true;
	return false;
}

// Match `setTimeout(IDENT_OR_PAREN_EXPR, NUM)`.  Captures the
// numeric literal argument so we can compare against the threshold.
// Allows whitespace and inline arrow-fn bodies.
const setTimeoutRe = /\bsetTimeout\s*\(\s*[^,]*,\s*(\d+)\s*\)/;

for (const tf of testFiles) {
	const src = readFileSync(tf.path, 'utf-8');
	const lines = src.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.includes('setTimeout')) continue;
		if (setTimeoutIsInComment(line)) continue;
		const m = line.match(setTimeoutRe);
		if (!m) continue;
		const ms = parseInt(m[1]!, 10);
		if (!Number.isFinite(ms)) continue;
		if (ms > MAX_ALLOWED_MS) {
			violations.push({
				file: relative(REPO_ROOT, tf.path),
				line: i + 1,
				ms,
				snippet: line.trim().slice(0, 120)
			});
		}
	}
}

if (violations.length === 0) {
	pass(`no test file uses setTimeout with a real-time wait (> ${MAX_ALLOWED_MS} ms)`);
} else {
	// Group by file for readable output.
	const byFile = new Map<string, Violation[]>();
	for (const v of violations) {
		const list = byFile.get(v.file) ?? [];
		list.push(v);
		byFile.set(v.file, list);
	}
	for (const [file, vs] of byFile.entries()) {
		const detail = vs
			.map((v) => `line ${v.line} (${v.ms} ms): ${v.snippet}`)
			.join('\n      ');
		fail(
			`${file} has no real-time setTimeout waits`,
			`${vs.length} violation(s):\n      ${detail}\n\n` +
				`      Fix: replace \`await new Promise((r) => setTimeout(r, N))\` with\n` +
				`        vi.useFakeTimers();          // in beforeEach\n` +
				`        vi.advanceTimersByTime(N);   // where you would have awaited\n` +
				`        vi.useRealTimers();          // in afterEach`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nno-real-time-setTimeout-in-tests smoke FAILED');
	console.error('cp76-D16 lesson: real-time setTimeout waits inside tests are a CI-flake class. Use fake timers instead.');
	process.exit(1);
}
console.log(`✓ all ${total} no-real-time-setTimeout-in-tests scenarios passed`);
