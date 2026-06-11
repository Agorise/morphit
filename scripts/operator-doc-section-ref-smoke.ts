#!/usr/bin/env tsx
/**
 * operator-doc-section-ref-smoke — every `OPERATIONS.md §N` / `RUN-A-MORPHIT-
 * NODE.md §N` reference IN CODE must resolve to a real section heading in the
 * target doc.
 *
 * Why this exists: these refs are operator-FACING — they surface in `ops-cli`
 * wizard/command output, indexer/relay error messages, and matrix-bot replies
 * (e.g. "see OPERATIONS.md §46 for the reset steps"). When OPERATIONS.md is
 * reorganized (it's edited in place, sections renumbered/merged), a code ref
 * can silently point at a section that no longer exists, sending the operator
 * to a dead pointer. This is exactly what cp242 found: `systemCheck.ts` cited
 * "OPERATIONS.md §14.6" for the hardening checks, but §14 had been reorganized
 * to unnumbered subsections and the unattended-upgrades content moved to §37.2
 * — so §14.6 didn't exist. No guard caught it.
 *
 * Scope: CODE only (`apps/<ws>/src`, `packages/<ws>/src`, excluding tests).
 * The docs/ ledgers (TARBALL, REVISIT, AUDIT-*) intentionally contain
 * point-in-time §-refs that may be historical; this guard does not police
 * them. It captures a doc name immediately followed by one or more `§N`
 * tokens (including `, §M` / `/ §M` / `and §M` continuations, e.g.
 * "OPERATIONS.md §34, §35, §37"). Section numbers up to three dotted levels
 * (N, N.M, N.M.P) are validated against `##`–`####` headings.
 *
 * Usage:
 *   tsx scripts/operator-doc-section-ref-smoke.ts
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** Docs whose §-refs in code are validated, by the name(s) used to cite them. */
const DOCS: ReadonlyArray<{ readonly cite: string; readonly file: string }> = [
	{ cite: 'OPERATIONS', file: 'docs/OPERATIONS.md' },
	{ cite: 'RUN-A-MORPHIT-NODE', file: 'docs/RUN-A-MORPHIT-NODE.md' }
];

/** Specific (file, doc, section) refs that are deliberately allowed to not
 *  resolve. Empty today — every code §-ref resolves. */
const REF_ALLOWLIST: ReadonlySet<string> = new Set<string>([
	// e.g. 'apps/foo/src/bar.ts|OPERATIONS|99'  (with a reason)
]);

interface R {
	readonly name: string;
	readonly ok: boolean;
	readonly detail?: string;
}
const results: R[] = [];
function check(name: string, ok: boolean, detail?: string): void {
	results.push({ name, ok, detail });
}

/** All section numbers (N, N.M, N.M.P) from `##`–`####` headings in a doc. */
function headingSections(file: string): Set<string> {
	const s = new Set<string>();
	const txt = readFileSync(join(ROOT, file), 'utf-8');
	const re = /^#{2,4}\s+(?:§)?(\d+(?:\.\d+){0,2})[.\s]/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(txt)) !== null) s.add(m[1]!);
	return s;
}

/** Recursively collect non-test `.ts` files under a directory. */
function collectTs(dir: string, out: string[]): void {
	if (!existsSync(dir)) return;
	for (const ent of readdirSync(dir)) {
		if (ent === 'node_modules') continue;
		const p = join(dir, ent);
		const st = statSync(p);
		if (st.isDirectory()) collectTs(p, out);
		else if (ent.endsWith('.ts') && !ent.endsWith('.test.ts') && !ent.endsWith('.spec.ts')) out.push(p);
	}
}

function codeFiles(): string[] {
	const out: string[] = [];
	for (const group of ['apps', 'packages']) {
		const groupDir = join(ROOT, group);
		if (!existsSync(groupDir)) continue;
		for (const ws of readdirSync(groupDir)) {
			collectTs(join(groupDir, ws, 'src'), out);
		}
	}
	return out;
}

function main(): void {
	const sections = new Map<string, Set<string>>();
	for (const d of DOCS) {
		const set = headingSections(d.file);
		sections.set(d.cite, set);
		check(`${d.cite.toLowerCase()}_headings_parsed`, set.size > 10, `${set.size} sections`);
	}

	// `DOCNAME[.md]` then a run of `§N` tokens (comma/slash/"and"-separated).
	const citeAlt = DOCS.map((d) => d.cite).join('|');
	const blockRe = new RegExp(
		`(${citeAlt})(?:\\.md)?((?:\\s*(?:and|,|/)?\\s*§\\s*\\d+(?:\\.\\d+){0,2})+)`,
		'g'
	);
	const secRe = /§\s*(\d+(?:\.\d+){0,2})/g;

	const files = codeFiles();
	const perDoc = new Map<string, { checked: number; bad: string[] }>();
	for (const d of DOCS) perDoc.set(d.cite, { checked: 0, bad: [] });

	for (const f of files) {
		const rel = f.slice(ROOT.length + 1);
		const txt = readFileSync(f, 'utf-8');
		let bm: RegExpExecArray | null;
		blockRe.lastIndex = 0;
		while ((bm = blockRe.exec(txt)) !== null) {
			const cite = bm[1]!;
			const known = sections.get(cite)!;
			const acc = perDoc.get(cite)!;
			secRe.lastIndex = 0;
			let sm: RegExpExecArray | null;
			while ((sm = secRe.exec(bm[2]!)) !== null) {
				const n = sm[1]!;
				acc.checked += 1;
				if (!known.has(n) && !REF_ALLOWLIST.has(`${rel}|${cite}|${n}`)) {
					acc.bad.push(`${rel}: ${cite} §${n}`);
				}
			}
		}
	}

	for (const d of DOCS) {
		const acc = perDoc.get(d.cite)!;
		check(
			`all_${d.cite.toLowerCase()}_code_section_refs_resolve`,
			acc.bad.length === 0,
			acc.bad.length
				? `${acc.bad.length} broken: ${acc.bad.join('; ')}`
				: `${acc.checked} refs across code all resolve`
		);
	}

	let pass = 0;
	let fail = 0;
	console.log('');
	console.log('──────────────────────────────────────────────────────');
	for (const r of results) {
		if (r.ok) {
			pass += 1;
			console.log(`  ✓ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
		} else {
			fail += 1;
			console.error(`  ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
		}
	}
	if (fail > 0) {
		console.error(`\noperator-doc-section-ref: ${pass} pass / ${fail} fail`);
		process.exit(1);
	}
	console.log(`\n✓ all ${pass} operator-doc-section-ref scenarios passed`);
}

main();
