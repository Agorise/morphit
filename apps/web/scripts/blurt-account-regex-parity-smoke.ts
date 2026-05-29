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
 * (no dots, alnum-end) while every other site used the canonical
 * /^[a-z][a-z0-9.-]{2,15}$/. A name valid on one validator could be
 * rejected by another — not a security hole (chain is the authority)
 * but an inconsistent UX. F-007 aligned registry.ts to the canonical
 * form; this sentinel asserts every Blurt-account-name regex literal
 * in the frontend is byte-identical so the divergence can't recur.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(HERE, '..', 'src');

const CANONICAL = '/^[a-z][a-z0-9.-]{2,15}$/';

// Match a `const NAME = /regex/;` where NAME ends in ACCOUNT_RE /
// ACCOUNT_NAME_RE / BROADCAST_ACCOUNT_RE and the regex anchors an
// account-name-shaped pattern (starts with ^[a-z]). We compare the
// raw literal text.
const DEF_RE =
	/\b(?:const|let)\s+([A-Z_]*ACCOUNT(?:_NAME)?_RE|BROADCAST_ACCOUNT_RE)\s*=\s*(\/\^\[a-z\][^;\n]*\/)/g;

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
for (const f of walk(WEB_SRC)) {
	const src = readFileSync(f, 'utf8');
	let m: RegExpExecArray | null;
	DEF_RE.lastIndex = 0;
	while ((m = DEF_RE.exec(src)) !== null) {
		found.push({ file: relative(WEB_SRC, f), name: m[1] ?? '?', literal: (m[2] ?? '').trim() });
	}
}

if (found.length < 8) {
	bad('discovery', `expected ≥8 account-name regex definitions, found ${found.length}. If validators were refactored to a shared module, update/retire this sentinel.`);
} else {
	ok(`discovered ${found.length} Blurt account-name regex definition(s) across the frontend`);
}

// Every literal must equal the canonical form.
const divergent = found.filter((d) => d.literal !== CANONICAL);
if (divergent.length === 0) {
	ok(`all ${found.length} account-name regexes are byte-identical to the canonical ${CANONICAL}`);
} else {
	for (const d of divergent) {
		bad(`${d.file} (${d.name})`, `is ${d.literal}, expected canonical ${CANONICAL} — see cp175 F-007`);
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
