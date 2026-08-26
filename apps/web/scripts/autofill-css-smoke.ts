#!/usr/bin/env tsx
/**
 * autofill-css smoke.
 *
 * The browser autofill background override in app.css must keep each engine's
 * selectors in SEPARATE rules. A comma-joined selector list is non-forgiving:
 * one pseudo-class an engine doesn't recognise (`:-webkit-autofill` in Firefox,
 * `:-moz-autofill` in Chrome) invalidates the ENTIRE list, so a combined rule
 * silently applies in NEITHER browser — which is exactly how Firefox went on
 * painting the unlock-keystore password field olive-yellow. This locks the fix.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cssRaw = readFileSync(join(__dirname, '..', 'src', 'app.css'), 'utf-8');
// Strip CSS comments first — they mention `:-webkit-autofill` / `:-moz-autofill`
// by name as examples, which must not be mistaken for real selectors.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

console.log('autofill-css smoke:\n');

// Split each rule (declaration block) out by its selector prelude.
const rules = css.split('}').map((chunk) => {
	const braceAt = chunk.indexOf('{');
	return braceAt === -1 ? '' : chunk.slice(0, braceAt);
});

// 1. THE invariant: no single selector list may contain BOTH a -webkit-autofill
//    and a -moz-autofill selector (that combo invalidates the rule in both).
const mixed = rules.filter(
	(prelude) => /:-webkit-autofill\b/.test(prelude) && /:-moz-autofill\b/.test(prelude)
);
check(
	'no selector list mixes :-webkit-autofill and :-moz-autofill',
	mixed.length === 0,
	mixed.length ? `${mixed.length} rule(s) mix them — the whole rule is dropped by both engines` : ''
);

// 2. All three override paths are present (standard + each prefix), so every
//    engine is actually covered.
check('standard :autofill override present', /input:autofill[\s\S]{0,400}?background-color:\s*#0f141c\s*!important/.test(css));
check('WebKit -webkit-autofill override present', /input:-webkit-autofill[\s\S]{0,400}?-webkit-box-shadow:[^;]*inset\s*!important/.test(css));
check('Firefox -moz-autofill override present', /input:-moz-autofill[\s\S]{0,300}?inset\s*!important/.test(css));

// 3. The long transition guard (defeats both the animated re-tint and the paint
//    on a pre-filled field) is on the standard/webkit rules.
check('long transition guard present (>= 100000s)', /transition:\s*background-color\s*\d{6,}s/.test(css));

console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass}${fail === 0 ? '' : '/' + (pass + fail)} autofill-css scenarios passed`);
process.exit(fail === 0 ? 0 : 1);
