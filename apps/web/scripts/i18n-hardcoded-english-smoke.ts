/**
 * Morphit smoke — hardcoded-English-string detector.
 *
 * Closes C-26 from Audit Part 31(R3): the existing
 * `i18n-key-coverage-smoke` catches MISSING keys (code references
 * a key that doesn't exist) and `i18n-locale-parity-smoke` catches
 * translator drift.  Neither catches the case where a Svelte file
 * renders English text directly in the JSX without ever calling
 * `$_(...)`.
 *
 * What this smoke does:
 *
 *   For every .svelte file in apps/web/src/routes and
 *   apps/web/src/lib/components (excluding /dev routes which are
 *   developer-only, plus an explicit allowlist of files where
 *   English literals ARE intentional, e.g. brand names), check for
 *   text content between tags that looks like an English sentence
 *   that should have been wrapped in `$_(...)`.
 *
 * Heuristic:
 *
 *   1. Strip <script> blocks — those are code.
 *   2. Strip <!-- ... --> comments — those are dev notes.
 *   3. Strip class= and className= attribute values — long
 *      Tailwind utility lists look like English to the regex.
 *   4. Strip {expression} interpolations.
 *   5. Strip remaining < ... > tag bodies.
 *   6. What's left is text content.  Match lines that look like
 *      English sentences:
 *        - 4+ words
 *        - Starts with a capital letter (or sentence-cased word)
 *        - Restricted character set (basic Latin alphabet + common
 *          punctuation)
 *
 * Allowlist (intentional English literals, NOT bugs):
 *   - Brand names: "Bitcoin", "Monero", "Blurt", "Tor", "I2P",
 *     "Lokinet", "Nostr mirror"
 *   - Code-inline tokens: "morphit", "docs/SECURITY.md", etc.
 *
 * False-positive handling:
 *   - The smoke errs on the side of FLAGGING.  When it produces
 *     a false positive (e.g. a brand name in a card title), the
 *     fix is either (a) wrap it in $_(...) with a generic key, or
 *     (b) add the file:line to the in-source allowlist below
 *     with a one-line justification.
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

console.log('\n── hardcoded-english-jsx smoke ──────────────────────────\n');

// ─── Resolve repo root ────────────────────────────────────────────
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

// ─── Files to scan ────────────────────────────────────────────────
const SCAN_DIRS = [
	path.join(REPO_ROOT, 'apps/web/src/routes'),
	path.join(REPO_ROOT, 'apps/web/src/lib/components')
];

// ─── Excluded paths (dev-only or out-of-scope) ────────────────────
const EXCLUDE_PATH_PATTERNS = [/\/dev\//, /__tests__/, /\.test\./];

// ─── Allowlisted exact strings (brand names, code identifiers) ────
const ALLOWLIST_STRINGS = new Set<string>([
	'Bitcoin',
	'Monero',
	'Blurt',
	'Nostr mirror',
	'docs/PLAN.md',
	'docs/SECURITY.md',
	'docs/adr/0015-chat-crypto.md',
	'morphit',
	'BLURT',
	'BTC',
	'XMR'
]);

// ─── Allowlisted file:line pairs ──────────────────────────────────
// Use this when a specific occurrence is intentional English
// literal in a place where wrapping in $_() would be wrong (e.g.
// schema.org JSON-LD strings that must be in a fixed language for
// search engines, or code identifiers shown verbatim in <code>).
//
// Format: 'apps/web/src/path/to/file.svelte:LINE'
const ALLOWLIST_LOCATIONS = new Set<string>([
	// (none yet — populate as needed)
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

// ─── Strip helpers ────────────────────────────────────────────────
//
// Each strip preserves the line count so that hit line numbers
// match the original file.  A `<script>` block on lines 1–216 is
// replaced with 216 blank lines, not deleted.
function preserveLines(replaced: string): string {
	// Replace all non-newline chars with a space; keep \n.
	return replaced.replace(/[^\n]/g, ' ');
}

function stripScripts(src: string): string {
	return src.replace(/<script[^>]*>[\s\S]*?<\/script>/g, preserveLines);
}

function stripStyles(src: string): string {
	// <style> blocks contain CSS, not user-facing text.  Their
	// comments (/* ... */) often contain English prose that
	// looks like a hardcoded UI string but isn't.
	return src.replace(/<style[^>]*>[\s\S]*?<\/style>/g, preserveLines);
}

function stripComments(src: string): string {
	return src.replace(/<!--[\s\S]*?-->/g, preserveLines);
}

function stripClassAttrs(src: string): string {
	// Tailwind class strings can look like English to the
	// detector ("Skip to content" lives in JSX text, but also
	// "border border-amber-300 bg-amber-50 p-4 text-sm" can
	// trip up the heuristic).  Strip class="..." and
	// className="..." and class={"..."} forms.
	return src
		.replace(/\bclass(?:Name)?\s*=\s*"[^"]*"/g, preserveLines)
		.replace(/\bclass(?:Name)?\s*=\s*'[^']*'/g, preserveLines)
		.replace(/\bclass(?:Name)?\s*=\s*\{[^}]*\}/g, preserveLines);
}

function stripInterpolations(src: string): string {
	// {expression} blocks are code; strip them.  Use
	// preserveLines so multiline {#if ... } / {#each ... }
	// blocks don't collapse the line count.
	return src.replace(/\{[^}]*\}/g, preserveLines);
}

function stripTags(src: string): string {
	// Strip everything between < and >.  We've already stripped
	// scripts and comments; what remains is regular HTML/Svelte
	// markup.  Multi-line tag bodies (rare but possible) preserve
	// line count too.
	return src.replace(/<[^>]+>/g, preserveLines);
}

// ─── Detector ─────────────────────────────────────────────────────
interface Hit {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

function detectHardcoded(absPath: string): readonly Hit[] {
	const src = readFileSync(absPath, 'utf8');
	const stripped = stripTags(
		stripInterpolations(stripClassAttrs(stripComments(stripStyles(stripScripts(src)))))
	);
	// Walk line-by-line.  For each line, find sentence-shaped
	// English content >= 4 words.
	const hits: Hit[] = [];
	const lines = stripped.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const text = lines[i].trim();
		if (text.length < 15) continue;

		// Allowlist: exact match
		if (ALLOWLIST_STRINGS.has(text)) continue;

		// Match: starts with capital, English-looking chars only,
		// 4+ words.  Allow common sentence punctuation.
		if (!/^[A-Z][A-Za-z0-9 ,.\-—'":!?/&()…[\]]+$/.test(text)) continue;
		const words = text.split(/\s+/).filter((w) => w.length > 0);
		if (words.length < 4) continue;

		// Filter: this line came from text content (after stripping
		// tags/scripts/comments/classes/interpolations).  If it
		// passes the regex above, it's a real hardcoded sentence.
		const relPath = path.relative(REPO_ROOT, absPath);
		const locationKey = `${relPath}:${i + 1}`;
		if (ALLOWLIST_LOCATIONS.has(locationKey)) continue;

		hits.push({ file: relPath, line: i + 1, text });
	}
	return hits;
}

// ─── Run ──────────────────────────────────────────────────────────
scenario('apps/web/src/routes + lib/components: no hardcoded English in JSX', () => {
	const allHits: Hit[] = [];
	for (const dir of SCAN_DIRS) {
		for (const file of walk(dir)) {
			const rel = path.relative(REPO_ROOT, file);
			if (EXCLUDE_PATH_PATTERNS.some((rx) => rx.test(rel))) continue;
			allHits.push(...detectHardcoded(file));
		}
	}
	if (allHits.length > 0) {
		const sample = allHits
			.slice(0, 10)
			.map((h) => `\n    ${h.file}:${h.line}: ${JSON.stringify(h.text.slice(0, 80))}`)
			.join('');
		throw new Error(
			`found ${allHits.length} hardcoded English string(s) in JSX. ` +
				'Wrap in $_(...) or add to ALLOWLIST_LOCATIONS in this smoke ' +
				`with a justification comment. First ${Math.min(10, allHits.length)}:${sample}`
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
