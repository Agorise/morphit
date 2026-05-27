/**
 * Voucher-path placeholder-integrity smoke.
 *
 * The daily-ceiling voucher UI in
 * apps/web/src/routes/[lang]/onboarding/register-name/+page.svelte
 * relies on {matrix_open}…{matrix_close} and
 * {plugin_open}…{plugin_close} placeholder pairs in two
 * specific i18n keys:
 *
 *   onboarding.register_name.errors.daily_ceiling_voucher_step_1
 *   onboarding.register_name.errors.daily_ceiling_voucher_step_2
 *
 * If a translator drops one half of a pair, splitOnPlaceholder
 * gracefully degrades and renders plain text — but the user
 * loses the clickable link to Matrix or blurtplugin.online.
 * That's a soft failure: the UI doesn't crash, but the user
 * can't tap through.
 *
 * This smoke catches that at CI time across all 10 shipped
 * locales, so a translation mistake is loud rather than
 * silently degrading the voucher UX in (say) just Polish.
 *
 * Coverage:
 *   1. Each locale has all 5 daily_ceiling_voucher_* keys.
 *   2. step_1 contains both {matrix_open} and {matrix_close},
 *      with the close after the open.
 *   3. step_2 contains both {plugin_open} and {plugin_close},
 *      with the close after the open.
 *   4. heading, intro, and step_3 are non-empty strings (so
 *      the panel never renders empty cards).
 *
 * Usage:
 *   tsx apps/web/scripts/voucher-locale-parity-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

// Hardcoded list — these are the locales we ship.  If a
// future locale is added, this smoke fails until it's added
// here too, which is correct: a new locale that doesn't
// support the voucher path is a UX regression.
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);

const LOC_DIR = join(import.meta.dirname, '..', 'src', 'lib', 'i18n', 'locales');

interface VoucherStrings {
	readonly daily_ceiling_voucher_heading: string;
	readonly daily_ceiling_voucher_intro: string;
	readonly daily_ceiling_voucher_step_1: string;
	readonly daily_ceiling_voucher_step_2: string;
	readonly daily_ceiling_voucher_step_3: string;
}

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.error(`  ✗ ${name}`);
		console.error(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function loadVoucherStrings(loc: string): VoucherStrings {
	const path = join(LOC_DIR, `${loc}.json`);
	const raw = readFileSync(path, 'utf8');
	const d = JSON.parse(raw) as Record<string, unknown>;
	const onb = d.onboarding as Record<string, unknown> | undefined;
	const reg = onb?.register_name as Record<string, unknown> | undefined;
	const errs = reg?.errors as Record<string, unknown> | undefined;
	if (!errs) {
		throw new Error(`${loc}: missing onboarding.register_name.errors namespace`);
	}
	return {
		daily_ceiling_voucher_heading: String(errs.daily_ceiling_voucher_heading ?? ''),
		daily_ceiling_voucher_intro: String(errs.daily_ceiling_voucher_intro ?? ''),
		daily_ceiling_voucher_step_1: String(errs.daily_ceiling_voucher_step_1 ?? ''),
		daily_ceiling_voucher_step_2: String(errs.daily_ceiling_voucher_step_2 ?? ''),
		daily_ceiling_voucher_step_3: String(errs.daily_ceiling_voucher_step_3 ?? '')
	};
}

console.log('voucher-locale-parity smoke:\n');

for (const loc of LOCALES) {
	scenario(`${loc}: all 5 voucher keys present and non-empty`, () => {
		const s = loadVoucherStrings(loc);
		const empties: string[] = [];
		for (const [k, v] of Object.entries(s)) {
			if (!v) empties.push(k);
		}
		if (empties.length) {
			throw new Error(`empty/missing keys: ${empties.join(', ')}`);
		}
	});

	scenario(`${loc}: step_1 has well-formed {matrix_open}…{matrix_close} pair`, () => {
		const { daily_ceiling_voucher_step_1: s } = loadVoucherStrings(loc);
		const o = s.indexOf('{matrix_open}');
		const c = s.indexOf('{matrix_close}');
		if (o < 0) {
			throw new Error('missing {matrix_open}');
		}
		if (c < 0) {
			throw new Error('missing {matrix_close}');
		}
		if (c <= o) {
			throw new Error('{matrix_close} appears before {matrix_open}');
		}
		// Sanity: the link text between the tokens should be
		// the room alias (or close to it — translators may add
		// a leading hash, that's fine).  We verify it contains
		// 'agorise' and 'matrix.org' as a soft check.
		const inner = s.slice(o + '{matrix_open}'.length, c);
		if (!inner.includes('agorise') || !inner.includes('matrix.org')) {
			throw new Error(`link text doesn't look like a Matrix room alias: ${JSON.stringify(inner)}`);
		}
	});

	scenario(`${loc}: step_2 has well-formed {plugin_open}…{plugin_close} pair`, () => {
		const { daily_ceiling_voucher_step_2: s } = loadVoucherStrings(loc);
		const o = s.indexOf('{plugin_open}');
		const c = s.indexOf('{plugin_close}');
		if (o < 0) {
			throw new Error('missing {plugin_open}');
		}
		if (c < 0) {
			throw new Error('missing {plugin_close}');
		}
		if (c <= o) {
			throw new Error('{plugin_close} appears before {plugin_open}');
		}
		// Sanity: link text should reference blurtplugin.
		const inner = s.slice(o + '{plugin_open}'.length, c);
		if (!inner.includes('blurtplugin')) {
			throw new Error(`link text doesn't reference blurtplugin: ${JSON.stringify(inner)}`);
		}
	});

	scenario(`${loc}: step_3 is plain text (no orphan placeholders)`, () => {
		// step_3 has no link, so it should NOT contain any
		// of our placeholder tokens.  An orphan would mean
		// the translator copy-pasted incorrectly.
		const { daily_ceiling_voucher_step_3: s } = loadVoucherStrings(loc);
		const orphans = ['{matrix_open}', '{matrix_close}', '{plugin_open}', '{plugin_close}'].filter(
			(tok) => s.includes(tok)
		);
		if (orphans.length) {
			throw new Error(`orphan placeholders in step_3: ${orphans.join(', ')}`);
		}
	});
}

// ─── Cross-locale sanity ─────────────────────────────────────

scenario('all locales return distinct heading text (translation actually happened)', () => {
	const headings = LOCALES.map((loc) => {
		const s = loadVoucherStrings(loc);
		return s.daily_ceiling_voucher_heading;
	});
	const unique = new Set(headings);
	// 10 locales should produce at least 8 distinct strings.
	// (zh-CN and zh-HK can be very close; en/es could share
	// rare cognates.)  If we got <8, someone likely
	// copy-pasted English into another locale's slot.
	if (unique.size < 8) {
		throw new Error(
			`only ${unique.size} distinct headings across ${LOCALES.length} locales — copy-paste smell`
		);
	}
});

console.log(
	`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} scenarios passed`
);
process.exit(failures === 0 ? 0 : 1);
