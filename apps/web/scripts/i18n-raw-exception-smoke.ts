/**
 * Morphit smoke — raw exception message → UI anti-pattern detector.
 *
 * Closes C-28 from Audit Part 31(R3).  The bug pattern:
 *
 *   } catch (err) {
 *       errorMsg = err instanceof Error ? err.message : String(err);
 *       //       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *       //       raw English exception text → renders in UI
 *   }
 *
 * Sally in a non-English locale sees "Seed must be 12 or 24
 * words" or "fetch failed" mixed in with otherwise-localized UI.
 * This pattern was found at 11 sites during Part 31(R3) and
 * fixed; this smoke prevents regression.
 *
 * The fix pattern (see Part 31(R3) commits):
 *
 *   } catch (err) {
 *       console.warn('[component] thing failed:', err);
 *       errorMsg = $_('component.error.specific_localized_key');
 *   }
 *
 * What this smoke flags:
 *
 *   Any line in apps/web/src/routes or apps/web/src/lib/components
 *   that assigns `err instanceof Error ? err.message : ...` (or
 *   close variants) to anything OTHER than:
 *     - a `const`/`let` local (debug, used for further analysis)
 *     - a console.* call argument
 *
 *   I.e., any assignment to a `let $state` variable — which is
 *   the Svelte 5 pattern for UI-bound state.
 *
 * Heuristic:
 *
 *   For each .svelte file, find lines that:
 *     1. Contain `err instanceof Error ? err.message : ...`
 *     2. Are an assignment (have `=` before `err instanceof`)
 *     3. The LHS is NOT a `const ` or `let ` declaration with a
 *        local-scope name (those are debug intermediates)
 *
 *   Catches the pattern; misses the case where the raw err.message
 *   is assigned to a local that's later assigned to state.  That's
 *   acceptable because the fix in that case is the same — convert
 *   the local to a localized key at the point where it crosses
 *   the local→state boundary.
 *
 * Allowlist:
 *
 *   /dev/* routes (developer-only, not user-facing)
 *
 *   Specific file:line sites can be allowlisted with a one-line
 *   justification when raw text is intentional (e.g. a fallback
 *   rendered only inside a <code> debug block that's hidden in
 *   production).
 *
 * Run via the standard smoke runner:
 *   bash scripts/run-smokes.sh
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── raw-exception-to-ui smoke ─────────────────────────────\n');

// ─── Resolve repo root ────────────────────────────────────────────
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

// ─── Files to scan ────────────────────────────────────────────────
const SCAN_DIRS = [
	path.join(REPO_ROOT, 'apps/web/src/routes'),
	path.join(REPO_ROOT, 'apps/web/src/lib/components')
];

const EXCLUDE_PATH_PATTERNS = [/\/dev\//, /__tests__/, /\.test\./];

// ─── Allowlisted file:line pairs ──────────────────────────────────
//
// Add `relative/path/to/file.svelte:LINE` here ONLY when raw text
// is intentional and never reaches user-facing UI.  Each entry
// MUST have a one-line justification comment above it.
const ALLOWLIST_LOCATIONS = new Set<string>([
	// Allowlist entries can be keyed by either:
	//   - `path:lineNumber`  (brittle — shifts when imports are
	//     added; tolerated for unique sites)
	//   - `path:varname`     (stable across line-number drift;
	//     preferred for sites where the variable is unique
	//     within the file)
	// The detector tries both keys for every candidate.

	// `error` here is bound only to a `title=` attribute (debug
	// tooltip on hover); the visible text is i18n'd separately.
	// Raw exception text in the tooltip is desirable — it's the
	// debug detail an operator looks at when investigating.
	'apps/web/src/routes/[lang]/instances/+page.svelte:error',
	// `feeError` here is bound only to a `title=` attribute
	// (debug tooltip on hover at /post); the visible text uses
	// $_('post_order.fee.error_friendly').  Same rationale as
	// /instances:error.
	'apps/web/src/routes/[lang]/post/+page.svelte:feeError'
]);

// ─── Walk directories ─────────────────────────────────────────────
function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			yield* walk(full);
		} else if (stat.isFile() && full.endsWith('.svelte')) {
			yield full;
		}
	}
}

// ─── Detector ─────────────────────────────────────────────────────
//
// The pattern we're looking for:
//
//   <something> = err instanceof Error ? err.message : ...
//
// where <something> is anything OTHER than a `const`/`let`
// declaration of a local variable.
//
// Real bugs (FLAGGED):
//   errorMsg = err instanceof Error ? err.message : String(err);
//   broadcastError = err instanceof Error ? err.message : 'fallback';
//   loadError = err instanceof Error ? err.message : 'snapshot parse failed';
//   pwError =
//       err instanceof Error
//           ? err.message
//           : $_('something');                     // multi-line variant
//
// Legitimate uses (NOT flagged):
//   const msg = err instanceof Error ? err.message : String(err);
//   const raw = err instanceof Error ? err.message : String(err);
//   console.warn('failed:', err instanceof Error ? err.message : err);
//
// Approach: scan the file as a single string.  For each occurrence of
// `err instanceof Error ? err.message`, walk BACKWARDS through any
// whitespace/newlines until we hit the most recent `=` token, then
// look at what's before that `=`.  If the LHS is `const`/`let`/`var`
// (local), skip.  If it's inside a `console.*(...)` call, skip.
// Otherwise it's a real hit.

interface Hit {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

function detectRawException(absPath: string): readonly Hit[] {
	const src = readFileSync(absPath, 'utf8');
	const hits: Hit[] = [];
	// Whitespace-tolerant patterns covering the four common raw-
	// exception leak shapes:
	//
	//   1. `err instanceof Error ? err.message : ...`  (the "main"
	//      pattern; survives multi-line splits)
	//   2. `err.message`  bare (no instanceof check; less common
	//      but seen in some legacy code paths)
	//   3. `String(err)`  (toString fallback; also leaks raw text)
	//   4. `err.toString()`  (rare but possible)
	//
	// Each pattern's match is then checked against the same
	// "is this an assignment to a non-local var?" gate.
	const PATTERNS: RegExp[] = [
		/err\s+instanceof\s+Error\s*\?\s*err\.message/g,
		/\bString\(\s*err\s*\)/g,
		/\berr\.toString\(\s*\)/g,
		/\berr\.message\b/g
	];
	const newlinePositions: number[] = [-1];
	for (let i = 0; i < src.length; i++) {
		if (src[i] === '\n') newlinePositions.push(i);
	}
	function lineOf(offset: number): number {
		// Binary-search for the largest newline position < offset.
		let lo = 0,
			hi = newlinePositions.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (newlinePositions[mid] < offset) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1; // newline 0 means "we're on line 1"
	}

	const seen = new Set<string>();
	for (const PATTERN of PATTERNS) {
		PATTERN.lastIndex = 0; // reset since we reuse the literal regex
		let m: RegExpExecArray | null;
		while ((m = PATTERN.exec(src)) !== null) {
			const errStart = m.index;

			// Walk backwards from errStart looking for the most recent
			// `=` that isn't `==`, `===`, `!=`, `<=`, `>=`.  Skip past
			// whitespace and newlines.  Stop if we hit a `;` or `{` or
			// `(` first (means the err... isn't on the RHS of an
			// assignment — e.g., it's an argument inside console.warn).
			let j = errStart - 1;
			let foundEq = -1;
			while (j >= 0) {
				const c = src[j];
				if (c === '=') {
					// Disambiguate.  Look at neighbors.
					const prev = j > 0 ? src[j - 1] : '';
					const next = j + 1 < src.length ? src[j + 1] : '';
					if (prev === '!' || prev === '<' || prev === '>' || prev === '=') {
						j--;
						continue;
					}
					if (next === '=') {
						j--;
						continue;
					}
					foundEq = j;
					break;
				}
				if (c === ';' || c === '{' || c === ',') break;
				// `(` would mean we're inside a call; skip pattern.
				if (c === '(') break;
				j--;
			}
			if (foundEq === -1) continue;

			// Look at the chunk before `=`.  If it contains `const`/`let`/
			// `var` declaration of a local OR is inside a console.* call,
			// skip.  Bound the look-back to the start-of-statement: walk
			// back from `=` until we hit `;`, `{`, or start-of-file.
			let stmtStart = foundEq - 1;
			while (stmtStart >= 0) {
				const c = src[stmtStart];
				if (c === ';' || c === '{' || c === '\n') {
					stmtStart++;
					break;
				}
				stmtStart--;
			}
			if (stmtStart < 0) stmtStart = 0;
			const beforeEq = src.slice(stmtStart, foundEq);
			// Local declaration?
			if (/\b(?:const|let|var)\s+\w/.test(beforeEq)) continue;
			// Inside a console.*(...) call? (a console call wouldn't have
			// `=` before err inside its arg list, so this is mostly
			// belt-and-suspenders.)
			if (/\bconsole\.\w+\s*\(/.test(beforeEq)) continue;

			const lineNum = lineOf(errStart);
			const relPath = path.relative(REPO_ROOT, absPath);
			const locationKey = `${relPath}:${lineNum}`;
			// Extract the LHS identifier (the variable being
			// assigned) so the allowlist can also be keyed by
			// `path:varname` — robust to line-number shifts when
			// imports get added at the top of the file.  The LHS
			// is the trailing identifier in beforeEq.
			const lhsMatch = /(\w+)\s*$/.exec(beforeEq.trim());
			const lhsName = lhsMatch?.[1] ?? '';
			const lhsKey = lhsName ? `${relPath}:${lhsName}` : '';
			if (ALLOWLIST_LOCATIONS.has(locationKey) || (lhsKey && ALLOWLIST_LOCATIONS.has(lhsKey))) {
				continue;
			}
			// Multiple patterns can match the same line (e.g., a
			// line containing both `err.message` and the larger
			// `err instanceof Error ? err.message` superpattern).
			// Dedupe so each site reports once.
			if (seen.has(locationKey)) continue;
			seen.add(locationKey);

			// Build a one-line preview for the error message.  Take the
			// stmtStart..end-of-pattern slice, collapse whitespace.
			const previewEnd = m.index + m[0].length;
			const preview = src.slice(stmtStart, previewEnd).replace(/\s+/g, ' ').trim().slice(0, 100);
			hits.push({ file: relPath, line: lineNum, text: preview });
		}
	}
	return hits;
}

/** Second detector — catches the indirection pattern:
 *
 *     } catch (err) {
 *         const raw = err.message;        // ← flag this declaration
 *         uiState = raw.slice(0, 200);    // (uiState use happens here,
 *                                         //  but the smoke can't easily
 *                                         //  prove uiState is non-local)
 *     }
 *
 * Heuristic: if a `const`/`let` LHS RHS contains one of the raw-err
 * tokens (err.message / String(err) / err.toString()), AND the
 * variable is referenced LATER within the same enclosing block, AND
 * at least one reference is NOT inside a `console.*(...)` call, flag
 * the DECLARATION line.
 *
 * Trade-offs:
 *  - True positives: the MyBalanceCard / explorer-route pattern.
 *  - False positives: a local `const raw = err.message` used only
 *    to call `console.warn('...', raw)` — that's safe but flagged.
 *    Annotate those sites with a `// smoke-ok-raw-local` comment
 *    and the smoke will skip them.
 *
 * The trade-off is acceptable because legitimate uses of err.message
 * (console + log + telemetry) almost always pass `err` itself rather
 * than an intermediate variable.  When they do, the comment annotation
 * is a one-line cost.
 */
function detectRawExceptionViaLocal(absPath: string): readonly Hit[] {
	const src = readFileSync(absPath, 'utf8');
	const hits: Hit[] = [];
	const newlinePositions: number[] = [-1];
	for (let i = 0; i < src.length; i++) {
		if (src[i] === '\n') newlinePositions.push(i);
	}
	function lineOf(offset: number): number {
		let lo = 0,
			hi = newlinePositions.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (newlinePositions[mid] < offset) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	}

	// Match: `const|let|var IDENT = <something with err...>`.
	// The RHS may span multiple lines (terminated by `;`); we
	// don't actually care about the RHS shape past finding one
	// of the err tokens.
	const DECL_RE =
		/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;]*?(?:err\.message|String\(\s*err\s*\)|err\.toString\(\s*\))[^;]*?);/g;

	let m: RegExpExecArray | null;
	while ((m = DECL_RE.exec(src)) !== null) {
		const varName = m[1];
		const declStart = m.index;
		const declEnd = declStart + m[0].length;

		// Skip explicit allowlist annotations.
		const declLine = src.slice(Math.max(0, declStart - 80), Math.min(src.length, declEnd + 80));
		if (/smoke-ok-raw-local/.test(declLine)) continue;

		// Find the enclosing block.  Walk forward from declEnd until
		// we hit either matching `}` or end of file.  Track brace
		// depth.
		let depth = 1;
		let scanEnd = declEnd;
		for (let i = declEnd; i < src.length; i++) {
			if (src[i] === '{') depth++;
			else if (src[i] === '}') {
				depth--;
				if (depth <= 0) {
					scanEnd = i;
					break;
				}
			}
		}

		// Look for references to varName in [declEnd, scanEnd).
		const region = src.slice(declEnd, scanEnd);
		const refRe = new RegExp(`\\b${varName}\\b`, 'g');
		let refM: RegExpExecArray | null;
		let nonConsoleUse = false;
		while ((refM = refRe.exec(region)) !== null) {
			// Look back ~80 chars for the start of the call/statement
			const lookBack = region.slice(Math.max(0, refM.index - 80), refM.index);
			// If the most recent `console.<word>(` is unclosed (open
			// paren not followed by close before our position), we're
			// inside a console call.  Cheap approximation: check if
			// the lookback contains console.* and no `;`/`}` between.
			const mc = lookBack.match(/\bconsole\.\w+\s*\(([^)]*)$/);
			if (mc) continue; // inside a console call
			nonConsoleUse = true;
			break;
		}
		if (!nonConsoleUse) continue;

		const lineNum = lineOf(declStart);
		const relPath = path.relative(REPO_ROOT, absPath);
		const locationKey = `${relPath}:${lineNum}`;
		if (ALLOWLIST_LOCATIONS.has(locationKey)) continue;

		const preview = m[0].replace(/\s+/g, ' ').trim().slice(0, 120);
		hits.push({ file: relPath, line: lineNum, text: preview });
	}
	return hits;
}

// ─── Run ──────────────────────────────────────────────────────────
scenario('apps/web/src/routes + lib/components: no raw err.message → UI state', () => {
	const allHits: Hit[] = [];
	for (const dir of SCAN_DIRS) {
		for (const file of walk(dir)) {
			const rel = path.relative(REPO_ROOT, file);
			if (EXCLUDE_PATH_PATTERNS.some((rx) => rx.test(rel))) continue;
			allHits.push(...detectRawException(file));
		}
	}
	if (allHits.length > 0) {
		const sample = allHits
			.map((h) => `\n    ${h.file}:${h.line}: ${JSON.stringify(h.text)}`)
			.join('');
		throw new Error(
			`found ${allHits.length} raw-exception-to-UI site(s).  ` +
				'Replace with: ' +
				'`console.warn("[where] failed:", err); errorMsg = $_("specific.localized.key");`. ' +
				`Hits:${sample}`
		);
	}
});

scenario('apps/web/src/routes + lib/components: no raw err.message via local var', () => {
	const allHits: Hit[] = [];
	for (const dir of SCAN_DIRS) {
		for (const file of walk(dir)) {
			const rel = path.relative(REPO_ROOT, file);
			if (EXCLUDE_PATH_PATTERNS.some((rx) => rx.test(rel))) continue;
			allHits.push(...detectRawExceptionViaLocal(file));
		}
	}
	if (allHits.length > 0) {
		const sample = allHits
			.map((h) => `\n    ${h.file}:${h.line}: ${JSON.stringify(h.text)}`)
			.join('');
		throw new Error(
			`found ${allHits.length} raw-exception-via-local site(s).  ` +
				'Pattern: `const raw = err.message; uiState = raw...`. ' +
				'Replace with: ' +
				'`console.warn("[where] failed:", err); errorMsg = $_("specific.localized.key");`. ' +
				'If a local var holding raw err text is used ONLY in console.* ' +
				'calls, annotate the declaration line with a `// smoke-ok-raw-local` comment. ' +
				`Hits:${sample}`
		);
	}
});

/** Third detector — catches the indexer-result raw-message leak:
 *
 *     const r = await getOrderbook(...);
 *     if (!r.ok) {
 *         errorMessage = r.message;   // ← raw English from indexer-client
 *     }
 *
 * Heuristic: any assignment of the shape `\w+ = (\w+)\.message;` where
 * the RHS variable is one of the conventional indexer-result names
 * (`r`, `res`, `result`).  Skips local `const`/`let` declarations.
 *
 * Trade-offs:
 *  - True positives: the orderbook/listing-detail/profile/operators
 *    pattern.
 *  - False positives: legitimate uses where `result.message` IS
 *    pre-localized — flag with `// smoke-ok-result-message` comment
 *    on the line.
 */
function detectRawResultMessage(absPath: string): readonly Hit[] {
	const src = readFileSync(absPath, 'utf8');
	const hits: Hit[] = [];
	const newlinePositions: number[] = [-1];
	for (let i = 0; i < src.length; i++) {
		if (src[i] === '\n') newlinePositions.push(i);
	}
	function lineOf(offset: number): number {
		let lo = 0,
			hi = newlinePositions.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (newlinePositions[mid] < offset) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	}

	// Match: `(\w+)\s*=\s*(r|res|result)\.message`
	// Excludes:
	//  - declarations: `const X = result.message`
	//  - the property setter: `result.message = ...`
	const PAT = /\b(\w+)\s*=\s*(r|res|result|be|err)\b\s*\.\s*message\b/g;

	let m: RegExpExecArray | null;
	while ((m = PAT.exec(src)) !== null) {
		// Skip if RHS rooted in a property access like `foo.bar.message`
		// (need to look back for the dot).  We handle by checking the
		// char immediately before the matched root identifier.
		const rootStart = m.index + m[0].indexOf(m[2]);
		const charBefore = rootStart > 0 ? src[rootStart - 1] : '';
		if (charBefore === '.') continue;

		// Find the LHS name (m[1]); look back to the start of statement
		// to see if it's a `const`/`let`/`var` declaration.
		let stmtStart = m.index;
		while (stmtStart > 0) {
			const c = src[stmtStart - 1];
			if (c === ';' || c === '{' || c === '\n') break;
			stmtStart--;
		}
		const lhsContext = src.slice(stmtStart, m.index);
		if (/\b(?:const|let|var)\s+\w*$/.test(lhsContext.trimEnd())) continue;
		// Skip object-literal context: `{ message: r.message, ...}`
		// — these are usually wire-payload constructions, not UI leaks.
		// Heuristic: the LHS identifier in lhsContext ends with `:`
		// rather than `=` indicates an object-literal property.
		// (Our PAT matches `=`, but be defensive about indented styles.)
		// Skip if lhsContext contains a `{` without a closing `}`.
		const opens = (lhsContext.match(/\{/g) ?? []).length;
		const closes = (lhsContext.match(/\}/g) ?? []).length;
		if (opens > closes) continue;
		// Skip if lhsContext clearly is inside a function call args
		// (open `(` not closed yet).
		const opens2 = (lhsContext.match(/\(/g) ?? []).length;
		const closes2 = (lhsContext.match(/\)/g) ?? []).length;
		if (opens2 > closes2) continue;

		// Skip explicit allowlist annotation.
		const lineStartIdx = src.lastIndexOf('\n', m.index) + 1;
		const lineEndIdx = src.indexOf('\n', m.index);
		const fullLine = src.slice(lineStartIdx, lineEndIdx === -1 ? src.length : lineEndIdx);
		if (/smoke-ok-result-message/.test(fullLine)) continue;

		const lineNum = lineOf(m.index);
		const relPath = path.relative(REPO_ROOT, absPath);
		const locationKey = `${relPath}:${lineNum}`;
		// Robust allowlist: also try varname (m[1] is the LHS).
		const lhsName = m[1] ?? '';
		const lhsKey = lhsName ? `${relPath}:${lhsName}` : '';
		if (ALLOWLIST_LOCATIONS.has(locationKey) || (lhsKey && ALLOWLIST_LOCATIONS.has(lhsKey))) {
			continue;
		}

		hits.push({ file: relPath, line: lineNum, text: fullLine.trim().slice(0, 120) });
	}
	return hits;
}

scenario('apps/web/src/routes + lib/components: no raw r.message → UI state', () => {
	const allHits: Hit[] = [];
	for (const dir of SCAN_DIRS) {
		for (const file of walk(dir)) {
			const rel = path.relative(REPO_ROOT, file);
			if (EXCLUDE_PATH_PATTERNS.some((rx) => rx.test(rel))) continue;
			allHits.push(...detectRawResultMessage(file));
		}
	}
	if (allHits.length > 0) {
		const sample = allHits
			.map((h) => `\n    ${h.file}:${h.line}: ${JSON.stringify(h.text)}`)
			.join('');
		throw new Error(
			`found ${allHits.length} raw-result-message-to-UI site(s).  ` +
				'Pattern: `errorMessage = r.message` where `r` is an ' +
				'indexer-client result.  These leak raw English text. ' +
				'Replace with: ' +
				'`console.warn("[where]", r.message); errorMessage = $_("specific.localized.key");`. ' +
				'For pre-localized result.message values, annotate with ' +
				'`// smoke-ok-result-message`. ' +
				`Hits:${sample}`
		);
	}
});

// ─── Summary ──────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
