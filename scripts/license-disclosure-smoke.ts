#!/usr/bin/env tsx
/**
 * license-disclosure-smoke — keep the third-party-license disclosure honest.
 *
 * Two jobs:
 *  1. THIRD-PARTY-LICENSES.md exists and still discloses the one known
 *     non-permissive runtime dependency (`@beblurt/dblurt`, its no-military
 *     clause) + Morphit's own AGPL-3.0-or-later license.
 *  2. DRIFT GUARD: walk the installed dependency tree and flag any package
 *     whose license matches a "needs disclosure / review" pattern — non-free
 *     field-of-use clauses, source-available licenses (SSPL/BUSL/Commons
 *     Clause), the "good, not evil" JSON license, or explicitly UNLICENSED
 *     packages.  The ONLY allowed match is the already-disclosed
 *     `@beblurt/dblurt`.  If a NEW such dependency enters the tree this smoke
 *     fails, forcing a review + a disclosure update (so the AGPL-3.0 license
 *     posture can't silently drift).
 *
 * Deliberately a denylist of genuinely-concerning patterns, NOT an allowlist
 * of permissive licenses — that stays robust as benign MIT/ISC/Apache/BSD
 * transitive deps come and go without churning this smoke.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The smoke runner cd's into the workspace dir before running; for a `.:`
// smoke that means cwd === repo root.
const REPO_ROOT = process.cwd();
const NODE_MODULES = join(REPO_ROOT, 'node_modules');
const DISCLOSURE = join(REPO_ROOT, 'THIRD-PARTY-LICENSES.md');

let failures = 0;
let n = 0;
function check(name: string, cond: boolean, detail = ''): void {
	n++;
	if (cond) {
		console.log(`  \u2713 ${name}`);
	} else {
		failures++;
		console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
	}
}

/** Licenses that are NOT plain permissive/standard-FOSS and warrant an
 *  explicit disclosure / compatibility review before shipping under AGPL. */
const PROBLEM_PATTERNS: Array<{ re: RegExp; why: string }> = [
	{ re: /No-Military/i, why: 'no-military field-of-use restriction (non-free)' },
	{ re: /Commons-Clause/i, why: 'Commons Clause (source-available, non-free)' },
	{ re: /\bSSPL\b/i, why: 'Server Side Public License (non-free)' },
	{ re: /\bBUSL\b|Business Source/i, why: 'Business Source License (source-available)' },
	{ re: /good,? not evil/i, why: 'JSON "good, not evil" license (non-free field-of-use)' },
	{ re: /non-?commercial|\bNC\b/i, why: 'non-commercial restriction (non-free)' },
	{ re: /\bUNLICENSED\b/, why: 'explicitly UNLICENSED / proprietary' }
];

/** The single dependency whose problem-license is already disclosed. */
const DISCLOSED = new Set(['@beblurt/dblurt']);

function licenseString(pkg: Record<string, unknown>): string {
	const l = pkg.license ?? pkg.licenses;
	if (typeof l === 'string') return l;
	if (Array.isArray(l)) {
		return l.map((x) => (typeof x === 'string' ? x : ((x as { type?: string }).type ?? ''))).join('/');
	}
	if (l && typeof l === 'object') return (l as { type?: string }).type ?? JSON.stringify(l);
	return '';
}

/** Walk node_modules collecting { name, license } for every package.json.
 *  Bounded depth keeps pathological nesting in check (npm hoists, so real
 *  depth is shallow). */
function collectLicenses(root: string): Array<{ name: string; license: string }> {
	const out: Array<{ name: string; license: string }> = [];
	function walk(dir: string, depth: number): void {
		if (depth > 8) return;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			if (e === '.bin') continue;
			const p = join(dir, e);
			let st;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (!st.isDirectory()) continue;
			const pj = join(p, 'package.json');
			if (existsSync(pj)) {
				try {
					const pkg = JSON.parse(readFileSync(pj, 'utf8')) as Record<string, unknown>;
					if (typeof pkg.name === 'string') {
						out.push({ name: pkg.name, license: licenseString(pkg) });
					}
				} catch {
					/* unreadable package.json — skip */
				}
			}
			// Recurse into nested node_modules + scope dirs.
			if (e === 'node_modules' || e.startsWith('@')) {
				walk(p, depth + 1);
			} else {
				const nested = join(p, 'node_modules');
				if (existsSync(nested)) walk(nested, depth + 1);
			}
		}
	}
	walk(root, 0);
	return out;
}

function main(): void {
	console.log('license-disclosure-smoke');

	// ─── Disclosure-doc content ─────────────────────────────────────────
	check('THIRD-PARTY-LICENSES.md exists', existsSync(DISCLOSURE));
	const doc = existsSync(DISCLOSURE) ? readFileSync(DISCLOSURE, 'utf8') : '';
	check('discloses @beblurt/dblurt', doc.includes('@beblurt/dblurt'));
	check('names the no-military license', /No-Military/i.test(doc));
	check('states Morphit is AGPL-3.0-or-later', /AGPL-3\.0-or-later/.test(doc));
	check(
		'notes dblurt is a runtime dep of indexer/relay/web',
		/runtime/i.test(doc) && /indexer/.test(doc) && /relay/.test(doc) && /web/.test(doc)
	);

	// ─── dblurt's installed license is still the disclosed one ──────────
	const dblurtPj = join(NODE_MODULES, '@beblurt/dblurt/package.json');
	if (existsSync(dblurtPj)) {
		const lic = licenseString(JSON.parse(readFileSync(dblurtPj, 'utf8')));
		check(
			'@beblurt/dblurt still BSD-3-Clause-No-Military-License (else update the disclosure)',
			lic === 'BSD-3-Clause-No-Military-License',
			`installed license = ${JSON.stringify(lic)}`
		);
	} else {
		// If dblurt is gone entirely, the disclosure's exception can be revisited.
		check('@beblurt/dblurt present (skipped license check — not installed)', true);
	}

	// ─── DRIFT GUARD: no UNDISCLOSED problem-licensed dependency ────────
	const pkgs = collectLicenses(NODE_MODULES);
	check('scanned a non-trivial dependency tree', pkgs.length > 100, `found ${pkgs.length}`);
	const offenders: string[] = [];
	for (const { name, license } of pkgs) {
		if (DISCLOSED.has(name)) continue;
		for (const { re, why } of PROBLEM_PATTERNS) {
			if (re.test(license)) {
				offenders.push(`${name} [${license}] — ${why}`);
				break;
			}
		}
	}
	check(
		'no UNDISCLOSED non-free / source-available dependency licenses',
		offenders.length === 0,
		offenders.length ? `review + disclose: ${offenders.slice(0, 8).join('; ')}` : ''
	);

	if (failures > 0) {
		console.error(`\nlicense-disclosure-smoke: ${failures} failure(s) across ${n} checks`);
		process.exit(1);
	}
	console.log(`\n\u2713 all ${n} license-disclosure-smoke checks passed`);
}

main();
