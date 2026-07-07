#!/usr/bin/env tsx
/**
 * scripts/now-in-handler-sql-smoke.ts
 *
 * Structural Defense #37 — NOW()-in-handler-SQL sentinel
 * (cp85 Lesson #1 candidate, promoted in same cp).
 *
 * Catches the cp85-A1 bug class: indexer handler SQL using
 * `NOW()` (Postgres CURRENT_TIMESTAMP at execution) instead of
 * `ctx.blockTime` (chain-deterministic block time).
 *
 * Why this is a bug: handlers are run twice — once in real time
 * as ops arrive on the Blurt chain, once on replay when a
 * fresh-DB indexer catches up from chain history.  `NOW()` at
 * replay time evaluates to the replay machine's wall-clock, not
 * the original block time.  Comparisons like
 * `expires_at > NOW()` or `effective_at <= NOW()` produce
 * different result sets at replay vs real-time, leading to
 * divergent DB state between operators replaying the same
 * chain history.
 *
 * The cp85-A1 fix replaced 6 `NOW()` references in
 * `featureBid.ts` with `$N` parameters bound to `ctx.blockTime`.
 * `strangerFee.ts:148` carries an explicit prior-art comment
 * on the same anti-pattern.
 *
 * What this smoke catches:
 *
 *   Any line in any handler file (`apps/indexer/src/indexer/handlers/*.ts`)
 *   that contains `NOW()` inside what appears to be SQL — namely,
 *   inside backtick-delimited template strings.
 *
 * Exemption marker:
 *
 *   A line containing `// now-in-handler-sql: SAFE <reason>`
 *   exempts the line.  Use sparingly and only when the SQL is
 *   explicitly NOT part of chain-deterministic state (e.g., a
 *   one-off operator query, a non-replayed maintenance query).
 *
 * Each handler file = one scenario; each violating line = one
 * failure entry.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const HANDLERS_DIR = join(REPO, 'apps/indexer/src/indexer/handlers');

console.log('\n── NOW()-in-handler-SQL sentinel-grep smoke ────────────\n');

interface Violation {
	file: string;
	line: number;
	text: string;
}

const violations: Violation[] = [];

const handlerFiles = readdirSync(HANDLERS_DIR)
	.filter((f) => f.endsWith('.ts'))
	.sort();

console.log(`  handlers scanned: ${handlerFiles.length}`);

// State machine: track whether we're inside a backtick template
// literal as we walk each line.  A backtick toggles the
// "inside-template" state.  We only flag NOW() that appears
// while inside-template (i.e., in SQL).
for (const filename of handlerFiles) {
	const path = join(HANDLERS_DIR, filename);
	const text = readFileSync(path, 'utf8');
	const lines = text.split('\n');

	let inTemplate = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		// Strip line comments before backtick-counting — a `//` comment
		// containing a backtick should not toggle the template state.
		// (Block comments are not handled; they're rare on the same
		// line as backtick toggling and producing false positives
		// would be worse than missing them.)
		const commentStart = line.indexOf('//');
		const codeLine = commentStart >= 0 ? line.slice(0, commentStart) : line;

		// Count unescaped backticks in the codeLine.
		// An odd count means the template state flips at end of line.
		let backtickCount = 0;
		for (let j = 0; j < codeLine.length; j++) {
			if (codeLine[j] === '`' && codeLine[j - 1] !== '\\') {
				backtickCount++;
			}
		}

		// Now scan codeLine for NOW(): if we're inside a template
		// at any point on this line, flag it.  More precise: NOW()
		// on a line where we ARE in a template (either entered
		// earlier or started here) is a hit.
		const hasNowCall = /\bNOW\s*\(\s*\)/.test(codeLine);

		if (hasNowCall) {
			// Determine if NOW() position is inside-template:
			// Walk through codeLine char-by-char, track local template
			// state from the line-start state, and check whether the
			// NOW() match position is reached while inside.
			let localInTemplate = inTemplate;
			const nowMatch = /\bNOW\s*\(\s*\)/.exec(codeLine);
			if (nowMatch === null) continue;
			const nowPos = nowMatch.index;
			for (let j = 0; j < nowPos; j++) {
				if (codeLine[j] === '`' && codeLine[j - 1] !== '\\') {
					localInTemplate = !localInTemplate;
				}
			}
			if (localInTemplate) {
				// Check for exemption marker on the same line.
				if (/\/\/\s*now-in-handler-sql:\s*SAFE\b/.test(line)) {
					// Exempted.  Skip.
				} else {
					violations.push({
						file: filename,
						line: i + 1,
						text: line.trim()
					});
				}
			}
		}

		// Update line-end template state for next iteration.
		if (backtickCount % 2 === 1) {
			inTemplate = !inTemplate;
		}
	}
}

if (violations.length > 0) {
	console.log(`\n  ✗ ${violations.length} NOW()-in-handler-SQL violation(s):`);
	for (const v of violations) {
		console.log(`    - apps/indexer/src/indexer/handlers/${v.file}:${v.line}`);
		console.log(`        ${v.text.slice(0, 100)}`);
	}
	console.log(
		`\n  Why this fails: handler SQL must be replay-deterministic.` +
			`\n  NOW() evaluates to the replay machine's wall-clock at` +
			`\n  replay time, producing divergent state between operators.` +
			`\n  See cp85-A1 (featureBid.ts) and strangerFee.ts:148 for` +
			`\n  prior incidents.` +
			`\n\n  Fix: replace NOW() with $N parameter bound to ctx.blockTime.` +
			`\n  Example:` +
			`\n      // Before:` +
			`\n      \`WHERE expires_at > NOW()\`,` +
			`\n      [otherParam]` +
			`\n      // After:` +
			`\n      \`WHERE expires_at > $1\`,` +
			`\n      [ctx.blockTime, otherParam]` +
			`\n\n  Exempt: append \`// now-in-handler-sql: SAFE <reason>\` on the same line` +
			`\n  when the SQL is genuinely non-chain-state (one-off operator query, etc).`
	);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${violations.length}/${handlerFiles.length} scenarios failed`);
	process.exit(1);
}

console.log(`  ✓ no NOW() inside SQL in any of ${handlerFiles.length} handler file(s)`);
console.log('\n──────────────────────────────────────────────────────');
console.log(`✓ all ${handlerFiles.length} scenarios passed`);
