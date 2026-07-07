/**
 * i18n-html-injection smoke — defends against XSS via translator-
 * controlled HTML in keys rendered with `{@html $_('key')}`.
 *
 * The {@html} directive bypasses Svelte's auto-escaping.  A few
 * Morphit i18n keys legitimately contain inline HTML markup (e.g.,
 * `<strong>` tags inside the welcome-flow bullets) and need to
 * render as HTML rather than escaped text.  This is fine when
 * translators are trusted and the markup is reviewed.  The risk:
 *
 *   - Dictionary file gets edited (PR slips through review,
 *     malicious translator, supply-chain compromise of the i18n
 *     pipeline) to put `<script>fetch(...)</script>` in a key.
 *   - User loads page → `{@html $_('key')}` injects the script →
 *     it executes in user's session with full access to unlocked
 *     keystore live identity.
 *
 * Defense: this smoke walks every `{@html $_(...)}` callsite,
 * collects the i18n key, then scans EVERY locale's value for that
 * key for dangerous patterns (script tags, javascript: protocol,
 * inline event handlers).  Any hit fails the smoke.
 *
 * Allowed inline HTML: `<strong>`, `<em>`, `<br>`, `<a>`, `<code>`,
 * plus whitespace.  Anything else (especially `<script>`,
 * `<iframe>`, `<img>`, `<link>`, `<style>`) is flagged.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

const SCAN_DIRS = [
	path.join(REPO_ROOT, 'apps/web/src/routes'),
	path.join(REPO_ROOT, 'apps/web/src/lib/components')
];

const LOCDIR = path.join(REPO_ROOT, 'apps/web/src/lib/i18n/locales');

const EXCLUDE_PATH_PATTERNS: readonly RegExp[] = [/\/dev\//, /__tests__\//, /\.test\./];

/** Allowed inline HTML tags in @html-rendered i18n values.
 *  Anything else (including `<script>`, `<iframe>`, `<img>`,
 *  `<link>`, `<style>`, `<svg>`, `<object>`, `<embed>`, etc.)
 *  is flagged.
 *
 *  Closed brackets (`</strong>`) get the same treatment via the
 *  regex below.  Self-closing (`<br/>`) too. */
const ALLOWED_INLINE_TAGS = new Set(['strong', 'em', 'b', 'i', 'br', 'a', 'code', 'span']);

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

function* walkSvelte(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			yield* walkSvelte(full);
		} else if (stat.isFile() && full.endsWith('.svelte')) {
			yield full;
		}
	}
}

function findHtmlKeys(): Set<string> {
	const keys = new Set<string>();
	const KEY_RE = /@html\s+\$_\(['"`]([\w.]+)['"`]/g;
	for (const dir of SCAN_DIRS) {
		for (const file of walkSvelte(dir)) {
			const rel = path.relative(REPO_ROOT, file);
			if (EXCLUDE_PATH_PATTERNS.some((rx) => rx.test(rel))) continue;
			const src = readFileSync(file, 'utf8');
			let m: RegExpExecArray | null;
			while ((m = KEY_RE.exec(src)) !== null) {
				keys.add(m[1]);
			}
		}
	}
	return keys;
}

function getNested(obj: unknown, dottedKey: string): string | null {
	const parts = dottedKey.split('.');
	let cur: unknown = obj;
	for (const p of parts) {
		if (typeof cur !== 'object' || cur === null) return null;
		cur = (cur as Record<string, unknown>)[p];
	}
	return typeof cur === 'string' ? cur : null;
}

interface Hit {
	readonly locale: string;
	readonly key: string;
	readonly issue: string;
}

function scanValue(locale: string, key: string, value: string): Hit[] {
	const hits: Hit[] = [];

	// Hard-block: any of these patterns are dangerous regardless
	// of context.
	if (/javascript:/i.test(value)) {
		hits.push({ locale, key, issue: 'contains javascript: protocol' });
	}
	if (/\bon\w+\s*=/i.test(value)) {
		hits.push({ locale, key, issue: 'contains inline event handler (onclick=, onerror=, etc.)' });
	}

	// Walk every <tag> and verify it's in the allowlist.
	// Match opening tags `<tag` (with optional attrs/whitespace).
	const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)/g;
	let m: RegExpExecArray | null;
	while ((m = TAG_RE.exec(value)) !== null) {
		const tag = m[1].toLowerCase();
		if (!ALLOWED_INLINE_TAGS.has(tag)) {
			hits.push({ locale, key, issue: `disallowed tag <${tag}>` });
		}
	}
	return hits;
}

console.log('\n── i18n-html-injection smoke ────────────────────────────\n');

scenario('every @html i18n key is safe across all locales', () => {
	const htmlKeys = findHtmlKeys();
	if (htmlKeys.size === 0) {
		// No @html sites means no surface — trivially safe.
		return;
	}
	const allHits: Hit[] = [];
	const localeFiles = readdirSync(LOCDIR).filter((f) => f.endsWith('.json'));
	for (const lf of localeFiles) {
		const locale = lf.replace(/\.json$/, '');
		const data = JSON.parse(readFileSync(path.join(LOCDIR, lf), 'utf8'));
		for (const key of htmlKeys) {
			const value = getNested(data, key);
			if (value === null) continue; // not present in this locale
			allHits.push(...scanValue(locale, key, value));
		}
	}
	if (allHits.length > 0) {
		const sample = allHits.map((h) => `\n    ${h.locale}: ${h.key} — ${h.issue}`).join('');
		throw new Error(
			`found ${allHits.length} dangerous pattern(s) in @html-rendered i18n keys.  ` +
				'These would XSS users when their locale renders the value. ' +
				'Either remove the dangerous markup OR change the calling Svelte ' +
				'component to use plain `{$_(...)}` instead of `{@html $_(...)}`. ' +
				`Hits:${sample}`
		);
	}
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
