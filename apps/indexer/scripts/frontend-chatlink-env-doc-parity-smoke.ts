#!/usr/bin/env tsx
/*
 * frontend-chatlink-env-doc-parity — cp175 F-008 guard.
 *
 * The per-asset / per-network explorer chat-link overrides
 * (MORPHIT_FRONTEND_<ASSET>[_<NETWORK>]_CHAT_LINK_URL) are read by the
 * indexer's zod env schema (apps/indexer/src/config/index.ts) and served
 * through /v1/instance.chat_link_urls. They are documented separately in the
 * operator docs (OPERATIONS.md / RUN-A-MORPHIT-NODE.md).
 *
 * F-008: the docs spelled the USDT multi-network vars with the network token
 * AFTER "CHAT_LINK_URL" (MORPHIT_FRONTEND_USDT_CHAT_LINK_URL_ERC20) while the
 * code reads it BEFORE (MORPHIT_FRONTEND_USDT_ERC20_CHAT_LINK_URL). An operator
 * copying the docs would set a var the indexer never reads → their self-hosted
 * explorer override silently does nothing.
 *
 * This sentinel asserts every MORPHIT_FRONTEND_*_CHAT_LINK_URL var NAMED in the
 * operator docs is actually present in the indexer config source, so the doc
 * can never again instruct operators to set a var the runtime ignores.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..'); // scripts/ -> apps/indexer -> repo root? resolved below

// Robustly locate the repo root by walking up until we find docs/OPERATIONS.md.
function findRepoRoot(start: string): string {
	let dir = start;
	for (let i = 0; i < 8; i++) {
		try {
			readFileSync(resolve(dir, 'docs', 'OPERATIONS.md'), 'utf8');
			return dir;
		} catch {
			dir = resolve(dir, '..');
		}
	}
	throw new Error('could not locate repo root (docs/OPERATIONS.md not found walking up)');
}

const repoRoot = findRepoRoot(HERE);

const CHATLINK_RE = /MORPHIT_FRONTEND_[A-Z0-9_]*CHAT_LINK_URL/g;

function varsIn(path: string): Set<string> {
	const src = readFileSync(resolve(repoRoot, path), 'utf8');
	return new Set(src.match(CHATLINK_RE) ?? []);
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

console.log('\n── frontend-chatlink-env-doc-parity (cp175 F-008 guard) ──\n');

const codeVars = new Set<string>([
	...varsIn('apps/indexer/src/config/index.ts')
]);
// urlsCore.ts documents the bundled-default single-network vars in comments;
// include it so single-asset overrides (BTC/XMR/etc.) named in docs also resolve.
for (const v of varsIn('apps/web/src/lib/explorer/urlsCore.ts')) codeVars.add(v);

if (codeVars.size < 12) {
	bad('code chat-link var discovery', `expected ≥12 chat-link vars in code, found ${codeVars.size}`);
} else {
	ok(`discovered ${codeVars.size} chat-link env var(s) referenced in code`);
}

const docFiles = ['docs/OPERATIONS.md', 'docs/RUN-A-MORPHIT-NODE.md'];
const docVars = new Set<string>();
for (const f of docFiles) {
	for (const v of varsIn(f)) docVars.add(v);
}
ok(`discovered ${docVars.size} chat-link env var(s) named in operator docs`);

// Every documented var must exist in code.
let allMatch = true;
for (const v of [...docVars].sort()) {
	if (!codeVars.has(v)) {
		allMatch = false;
		bad(`${v}`, 'named in operator docs but NOT read anywhere in code — operators setting it get a silent no-op (see cp175 F-008)');
	}
}
if (allMatch) {
	ok('every documented FRONTEND chat-link env var is read by code (no silent-no-op vars)');
}

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
