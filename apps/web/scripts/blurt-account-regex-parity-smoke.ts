#!/usr/bin/env tsx
/*
 * blurt-account-regex-parity — cp175 F-007 guard.
 *
 * The Blurt account-name shape validator (BLURT_ACCOUNT_RE /
 * ACCOUNT_NAME_RE / BROADCAST_ACCOUNT_RE) is inlined in ~12 frontend
 * files (params, explorer, ops/*, sign.ts, crypto, chat/payload, the
 * asset registry). These are client-side UX shape checks; the
 * authoritative account check is the chain + indexer extractSigner.
 *
 * F-007: registry.ts had DIVERGED to /^[a-z][a-z0-9-]{1,14}[a-z0-9]$/
 * (no dots) while every other site used /^[a-z][a-z0-9.-]{2,15}$/.
 * A name valid on one validator could be rejected by another — not a
 * security hole (chain is the authority) but an inconsistent UX, so
 * F-007 aligned every copy to one canonical form.
 *
 * cp176: that canonical form had a latent flaw — its final character
 * class still admitted a trailing dash or dot, but real Blurt account
 * names must end alphanumeric (the indexer asset-registry smoke caught
 * `addressValidator('trailing-')` returning true).  The canonical was
 * tightened to /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/: same 3–16 length
 * window, dotted multi-segment names still accepted, but a trailing
 * '-' or '.' is now rejected.  Every frontend copy was updated in
 * lockstep.  This sentinel asserts every Blurt-account-name regex
 * literal in the frontend is byte-identical to that canonical so the
 * divergence can't recur.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

// cp176: the guard now spans EVERY workspace that inlines the Blurt
// account-name shape — not just apps/web/src.  The cp175 divergence
// (registry.ts) slipped through because the old guard walked only
// apps/web AND matched only NAMED `*_RE` consts, so it never saw the
// indexer/relay/mcp-server copies nor the inline `.test()`/`.regex()`
// uses.  (A repo-wide audit confirmed the only OTHER `/^[a-z][a-z0-9…`
// literals — KEY_RE `[a-z0-9_]+`, NUMERIC_SUFFIX_RE, a URI-scheme
// matcher — share neither the `*ACCOUNT*_RE` name nor the dot-dash
// `[a-z0-9.-]{` class signature, so neither matcher below trips them.)
const SRC_ROOTS = [
	'apps/web/src',
	'apps/indexer/src',
	'apps/relay/src',
	'apps/mcp-server/src',
	'apps/ops-cli/src',
	'apps/matrix-bot/src'
]
	.map((p) => resolve(REPO, p))
	.filter((p) => existsSync(p));

const CANONICAL = '/^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/';

// Two complementary matchers, run over comment-stripped source:
//  (1) NAMED — `const NAME_RE = /…/` where NAME is *ACCOUNT*_RE /
//      *ACCOUNT_NAME_RE / BROADCAST_ACCOUNT_RE.  Name-gated, so it
//      stays robust even if a copy diverged to a different CHARACTER
//      CLASS (e.g. dropped the dot) — the cp175-style regression.
//  (2) INLINE — any account-shaped literal carrying the dot-dash
//      class+quantifier signature `[a-z0-9.-]{`, confirmed UNIQUE to
//      the account regex.  Catches the nameless `/…/.test(x)` and
//      `.regex(/…/)` forms.
const NAMED_RE =
	/\b(?:const|let)\s+([A-Z_]*ACCOUNT(?:_NAME)?_RE|BROADCAST_ACCOUNT_RE)\s*=\s*(\/\^\[a-z\][^;\n]*?\/)/g;
const INLINE_RE = /(\/\^\[a-z\]\[a-z0-9\.-\]\{[^/\n]*\/)/g;

function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '') // block comments
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (preserve `://`)
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		const st = statSync(p);
		if (st.isDirectory()) {
			if (entry === 'node_modules' || entry.startsWith('.')) continue;
			out.push(...walk(p));
		} else if (entry.endsWith('.ts') || entry.endsWith('.svelte')) {
			out.push(p);
		}
	}
	return out;
}

let pass = 0;
let fail = 0;
function ok(name: string): void {
	console.log(`  ✓ ${name}`);
	pass++;
}
function bad(name: string, detail: string): void {
	console.log(`  ✗ ${name}: ${detail}`);
	fail++;
}

console.log('\n── blurt-account-regex-parity (cp175 F-007 guard) ──\n');

const found: Array<{ file: string; name: string; literal: string }> = [];
const seen = new Set<string>(); // dedup by file + literal's byte offset
for (const root of SRC_ROOTS) {
	for (const f of walk(root)) {
		const code = stripComments(readFileSync(f, 'utf8'));
		const rel = relative(REPO, f);
		let m: RegExpExecArray | null;
		NAMED_RE.lastIndex = 0;
		while ((m = NAMED_RE.exec(code)) !== null) {
			const lit = (m[2] ?? '').trim();
			const pos = m.index + m[0].indexOf(m[2] ?? '');
			const key = `${rel}::${pos}`;
			if (seen.has(key)) continue;
			seen.add(key);
			found.push({ file: rel, name: m[1] ?? '?', literal: lit });
		}
		INLINE_RE.lastIndex = 0;
		while ((m = INLINE_RE.exec(code)) !== null) {
			const key = `${rel}::${m.index}`;
			if (seen.has(key)) continue;
			seen.add(key);
			found.push({ file: rel, name: '(inline)', literal: (m[1] ?? '').trim() });
		}
	}
}

if (found.length < 25) {
	bad('discovery', `expected ≥25 account-name regex literals across web/indexer/relay/mcp-server, found ${found.length}. If validators were refactored to a shared module, update/retire this sentinel.`);
} else {
	ok(`discovered ${found.length} Blurt account-name regex literal(s) across web/indexer/relay/mcp-server`);
}

// Every literal must equal the canonical form.
const divergent = found.filter((d) => d.literal !== CANONICAL);
if (divergent.length === 0) {
	ok(`all ${found.length} account-name regexes are byte-identical to the canonical ${CANONICAL}`);
} else {
	for (const d of divergent) {
		bad(`${d.file} (${d.name})`, `is ${d.literal}, expected canonical ${CANONICAL} — see cp175 F-007 / cp176`);
	}
}

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
