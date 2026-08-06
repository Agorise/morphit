#!/usr/bin/env tsx
/**
 * apps/web/scripts/canary-template-smoke.ts
 *
 * Verifies apps/web/static/canary.txt.template is structurally
 * sound — every placeholder the generator expects to substitute
 * actually appears in the template, and every placeholder in
 * the template is in the generator's known list.
 *
 * Why this matters: the generator (scripts/canary/generate.sh)
 * uses awk to substitute placeholders by literal name.  If a new
 * placeholder is added to the template without updating the
 * generator, that placeholder remains unfilled in the published
 * canary.  Conversely, if the generator adds a substitution but
 * the template doesn't have the placeholder, the generator's
 * work is silently dropped.
 *
 * This smoke surfaces both kinds of drift at CI time.
 *
 * Run via `bash scripts/run-smokes.sh` or directly:
 *   cd apps/web && npx tsx scripts/canary-template-smoke.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');
const TEMPLATE = join(REPO, 'apps/web/static/canary.txt.template');
const GENERATOR = join(REPO, 'scripts/canary/generate.sh');

console.log('\n── canary-template smoke ───────────────────────────────\n');

const failures: string[] = [];

if (!existsSync(TEMPLATE)) {
	failures.push(`canary template missing: ${TEMPLATE}`);
}
if (!existsSync(GENERATOR)) {
	failures.push(`canary generator missing: ${GENERATOR}`);
}

if (failures.length === 0) {
	const tpl = readFileSync(TEMPLATE, 'utf8');
	const gen = readFileSync(GENERATOR, 'utf8');

	// Find all {{NAME}} placeholders in the template.
	// Names may contain digits — match
	// `[A-Z0-9_]+`, NOT `[A-Z_]+`, or the smoke silently misses
	// any placeholder that has a digit in its name.
	const tplPlaceholders = new Set<string>();
	for (const m of tpl.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) {
		tplPlaceholders.add(m[1]!);
	}

	// Find all gsub(/\{\{NAME\}\}/, …) substitutions in the generator.
	const genSubs = new Set<string>();
	for (const m of gen.matchAll(/gsub\(\/\\\{\\\{([A-Z0-9_]+)\\\}\\\}\/,\s*([a-z0-9_]+)\)/g)) {
		genSubs.add(m[1]!);
	}

	console.log(`  template: ${tplPlaceholders.size} placeholder(s)`);
	console.log(`  generator: ${genSubs.size} substitution(s)`);

	// Sanity: parser must find at least one of each, otherwise the
	// regex is broken and we'd silently report "all good."
	if (tplPlaceholders.size === 0) {
		failures.push(
			'template parser found 0 placeholders — has the {{NAME}} ' +
				'syntax been changed?  Update this smoke regex.'
		);
	}
	if (genSubs.size === 0) {
		failures.push(
			'generator parser found 0 substitutions — has the awk ' +
				'gsub() pattern changed?  Update this smoke regex.'
		);
	}

	// Every template placeholder must be substituted — EXCEPT
	// PGP_SIGNATURE, which is intentionally NOT substituted by
	// awk.  The generator deletes the BEGIN PGP SIGNATURE block
	// (and the placeholder inside it) with `sed` before invoking
	// `gpg --clearsign`, which appends a real signature block.
	// The placeholder is documentation-only — it shows readers
	// of the template what the final structure looks like.
	const PLACEHOLDERS_NOT_SUBSTITUTED = new Set(['PGP_SIGNATURE']);
	for (const ph of tplPlaceholders) {
		if (PLACEHOLDERS_NOT_SUBSTITUTED.has(ph)) continue;
		if (!genSubs.has(ph)) {
			failures.push(
				`template has {{${ph}}} but generate.sh has no gsub() for it ` +
					`— published canary will contain the literal {{${ph}}}.`
			);
		}
	}
	// Every generator substitution must have a placeholder.
	for (const sub of genSubs) {
		if (!tplPlaceholders.has(sub)) {
			failures.push(
				`generate.sh substitutes {{${sub}}} but template has no such ` +
					`placeholder — substitution is silently dropped.`
			);
		}
	}

	// Required sections must be present in the template.
	const required = [
		'=== MORPHIT CANARY ===',
		'DECLARATION',
		'FRESHNESS PROOFS',
		'HOW TO VERIFY',
		"IF THIS CANARY DOESN'T UPDATE",
		'-----BEGIN PGP SIGNATURE-----',
		'-----END PGP SIGNATURE-----'
	];
	for (const r of required) {
		if (!tpl.includes(r)) {
			failures.push(`template missing required section marker: ${r}`);
		}
	}

	// Confirm the generator deletes the PGP block before signing.
	// If this sed line ever disappears, the template's PGP placeholder
	// would leak through into the signed output.
	if (!gen.includes('/-----BEGIN PGP SIGNATURE-----/,$d')) {
		failures.push(
			'generator no longer strips the PGP placeholder block before ' +
				'signing — the literal placeholder will appear in the canary.'
		);
	}
}

if (failures.length > 0) {
	console.log(`\n  ✗ ${failures.length} issue(s):`);
	for (const f of failures) console.log(`    - ${f}`);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${failures.length}/${failures.length} scenarios failed`);
	process.exit(1);
} else {
	console.log('  ✓ canary template is structurally valid');
	console.log('  ✓ generator and template substitutions are in sync');
	console.log('\n──────────────────────────────────────────────────────');
	console.log('✓ all 1 scenarios passed');
}
