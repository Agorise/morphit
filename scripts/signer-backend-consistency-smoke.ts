#!/usr/bin/env tsx
/*
 * signer-backend-consistency — cp175 F-001 guard.
 *
 * cp174 wired the @noble signer into sign.ts behind SIGNER_BACKEND, but a
 * SECOND, independent signer in ops/comment.ts (the syndication/cross-post
 * path) was missed and kept calling dblurt's broadcast.sign unconditionally —
 * so flipping SIGNER_BACKEND to 'noble' would have left cross-posts signing via
 * elliptic. F-001 fixed comment.ts; this sentinel ensures the class can't
 * recur: EVERY module in apps/web that calls `broadcast.sign(` must also
 * reference `SIGNER_BACKEND` (i.e. branch on the backend), and every such
 * module must import the noble signer so the 'noble' arm actually exists.
 *
 * If someone adds a third signing path that calls broadcast.sign without
 * honoring the flag, this fails and names the file.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WEB_SRC = join(__dirname, '..', 'apps', 'web', 'src');

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

/** Recursively collect .ts/.svelte files under a dir. */
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

console.log('\n── signer-backend-consistency (cp175 F-001 guard) ──\n');

const files = walk(WEB_SRC);

// A "signer" = a file with a real broadcast.sign( INVOCATION (not a comment).
// We strip line comments and block-comment bodies cheaply: a broadcast.sign(
// occurrence is "real" if it is not preceded on its line by `*` or `//`.
const signerFiles: string[] = [];
for (const f of files) {
	const src = readFileSync(f, 'utf8');
	const lines = src.split('\n');
	let hasRealCall = false;
	for (const line of lines) {
		const idx = line.indexOf('broadcast.sign(');
		if (idx === -1) continue;
		const before = line.slice(0, idx);
		// skip comment lines (`*` jsdoc, `//` line comment, or string-doc)
		if (/^\s*[*]/.test(line) || before.includes('//')) continue;
		hasRealCall = true;
		break;
	}
	if (hasRealCall) signerFiles.push(f);
}

// Sanity: we expect at least the two known signers (sign.ts, comment.ts).
if (signerFiles.length < 2) {
	bad(
		'discovered signer files',
		`expected ≥2 files calling broadcast.sign, found ${signerFiles.length}. ` +
			'If signing was refactored, update this sentinel.'
	);
} else {
	ok(`discovered ${signerFiles.length} signer file(s) calling broadcast.sign`);
}

// Every signer must branch on SIGNER_BACKEND and import the noble signer.
for (const f of signerFiles) {
	const rel = f.slice(WEB_SRC.length + 1);
	const src = readFileSync(f, 'utf8');
	const referencesFlag = /\bSIGNER_BACKEND\b/.test(src);
	const importsNoble = /signDigestWithNoble/.test(src);
	if (referencesFlag && importsNoble) {
		ok(`${rel} honors SIGNER_BACKEND (branches + imports noble signer)`);
	} else {
		bad(
			`${rel} ignores SIGNER_BACKEND`,
			`this signer calls broadcast.sign but ${
				!referencesFlag ? 'does not reference SIGNER_BACKEND' : 'does not import signDigestWithNoble'
			} — flipping the backend would leave this path on elliptic. See cp175 F-001.`
		);
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
