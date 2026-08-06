#!/usr/bin/env tsx
/**
 * scripts/last-char-tamper-anti-pattern-smoke.ts
 *
 * Structural Defense #35 — last-char-tamper anti-pattern grep
 * smoke (cp84 Lesson #4 #2, promoted from cp85+ candidate to
 * cp84 ship after the cp84-F1 finding made the urgency clear).
 *
 * Catches the Part 85 / cp84-F1 bug class at lint time, before
 * any test ever runs.
 *
 * THE BUG CLASS:
 *
 * A signature-tamper test wants to flip exactly one character
 * of a cryptographically-encoded signature and assert that
 * verification rejects the tampered value.  The naive approach
 * is to tamper the LAST character:
 *
 *     const tampered = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A');
 *
 * For base64url-encoded signatures (and other encodings with
 * padding-equivalent final positions), the last character may
 * encode only the high bits of a partial byte.  Two different
 * last-character values can decode to the SAME bytes — meaning
 * the "tampered" signature equals the original after decoding,
 * HMAC verification accepts, and the "rejects" assertion fails
 * with ~6% probability per test run.
 *
 * Hex encoding (4 bits per digit) and base58check (full checksum
 * coverage) are not vulnerable.  Base64 / base64url are.
 *
 * THE FIX:
 *
 * Tamper the FIRST character instead:
 *
 *     const tampered = (sig.at(0) === 'A' ? 'B' : 'A') + sig.slice(1);
 *
 * Position 0 always represents the high-order bits unambiguously
 * regardless of encoding.  No coincidence-collision exists.
 *
 * HOW THE SMOKE WORKS:
 *
 * Greps test files for the structural anti-pattern: a same-line
 * combination of `slice(0, -1)` and `at(-1)`.  If found, fails
 * with the file:line + suggested fix.  Exemption mechanism: a
 * trailing comment `// last-char-tamper-anti-pattern: SAFE
 * <reason>` on the same line as one of the matches whitelists
 * the line (use for hex / base58check where the encoding
 * guarantees no collision).
 *
 * Scope: all `*.test.ts` files under workspace `test/` and `src/`
 * directories.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

const TEST_ROOTS = [
	'apps/indexer/test',
	'apps/relay/test',
	'apps/web/test',
	'apps/web/src',
	'apps/matrix-bot/test',
	'apps/ops-cli/test',
	'packages/asset-registry/test',
	'scripts'
];

const SAFE_MARKER = 'last-char-tamper-anti-pattern: SAFE';

function* walkFiles(dir: string): Generator<string> {
	if (!isDirSafe(dir)) return;
	for (const entry of readdirSync(dir)) {
		if (entry === 'node_modules' || entry.startsWith('.')) continue;
		const abs = join(dir, entry);
		const st = statSync(abs);
		if (st.isDirectory()) {
			yield* walkFiles(abs);
		} else if (st.isFile() && (abs.endsWith('.ts') || abs.endsWith('.tsx'))) {
			yield abs;
		}
	}
}

function isDirSafe(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

interface Finding {
	file: string;
	line: number;
	excerpt: string;
}

const findings: Finding[] = [];
let filesScanned = 0;

console.log('\n── last-char-tamper anti-pattern grep smoke ────────────\n');

for (const root of TEST_ROOTS) {
	const rootAbs = join(REPO, root);
	if (!isDirSafe(rootAbs)) continue;
	for (const filePath of walkFiles(rootAbs)) {
		// Exclude the smoke's own file — it necessarily contains
		// the pattern as part of its detection logic, docstring
		// example, and fix-suggestion text.  Self-scanning would
		// create a false positive that cannot be eliminated
		// without crippling the smoke's own documentation.
		if (filePath.endsWith('/last-char-tamper-anti-pattern-smoke.ts')) {
			continue;
		}
		filesScanned++;
		const text = readFileSync(filePath, 'utf8');
		const lines = text.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			// Both halves on the same line — that's the canonical
			// anti-pattern shape.  Future variants where the two
			// halves are split across lines may slip through; we
			// can extend if cp85+ surfaces such a variant.
			if (line.includes('slice(0, -1)') && line.includes('at(-1)')) {
				// Exemption: explicit comment marker on same line
				if (line.includes(SAFE_MARKER)) continue;
				const rel = filePath.replace(REPO + '/', '');
				findings.push({
					file: rel,
					line: i + 1,
					excerpt: line.trim().slice(0, 120)
				});
			}
		}
	}
}

console.log(`  files scanned: ${filesScanned}`);

if (findings.length > 0) {
	console.log(`\n  ✗ ${findings.length} last-char-tamper anti-pattern site(s):`);
	for (const f of findings) {
		console.log(`    - ${f.file}:${f.line}`);
		console.log(`        ${f.excerpt}`);
	}
	console.log(
		`\n  Why this fails: tampering the LAST character of a base64url-encoded\n` +
			`  signature lands in padding-equivalent positions ~6% of the time,\n` +
			`  decoding to identical bytes.  See Part 85 (drain-defense-live-fire)\n` +
			`  and cp84-F1 (inviteToken.test.ts) for prior incidents.\n\n` +
			`  Fix: tamper the FIRST character instead.  Example:\n` +
			`      const tampered = (sig.at(0) === 'A' ? 'B' : 'A') + sig.slice(1);\n\n` +
			`  Exempt: append \`// ${SAFE_MARKER} <reason>\` on the same line\n` +
			`  when the encoding (hex, base58check) guarantees no collision.`
	);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${findings.length}/${filesScanned} scenarios failed`);
	process.exit(1);
}

console.log(`  ✓ no last-char-tamper anti-pattern in any of ${filesScanned} test/src file(s)`);
console.log('\n──────────────────────────────────────────────────────');
console.log(`✓ all ${filesScanned} scenarios passed`);
