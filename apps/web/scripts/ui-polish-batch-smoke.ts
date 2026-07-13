#!/usr/bin/env tsx
/**
 * Smoke: the cp442 UI-polish batch (Ken, 2026-07-08).
 *
 *  1. WALLET CARD — the fiat approximation sits on the balance's baseline,
 *     separated by exactly one space; the three columns get an even gutter.
 *  2. FOCUS BORDER — text fields get the crisp 1px emerald focus border
 *     site-wide, not the dim 3px translucent glow (`--focus-ring`, alpha .35).
 *  3. SEND BLURT — the button stays disabled until every field validates,
 *     including the active-key password, and the amount can't be silently
 *     rounded by `toFixed(3)`.
 *  4. DOWNLOAD PAGE — cards gain the same dim-emerald hover the order cards
 *     have, via a single shared `.card-hover-emerald` class rather than a
 *     fourth copy-paste of the four-class incantation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);

const css = readFileSync(join(WEB, 'src', 'app.css'), 'utf8');
const wallet = readFileSync(join(WEB, 'src', 'lib', 'components', 'MyBalanceCard.svelte'), 'utf8');
const send = readFileSync(join(WEB, 'src', 'lib', 'components', 'SendBlurtModal.svelte'), 'utf8');
const validation = readFileSync(join(WEB, 'src', 'lib', 'blurt', 'sendValidation.ts'), 'utf8');
const download = readFileSync(join(WEB, 'src', 'routes', '[lang]', 'download', '+page.svelte'), 'utf8');
const orderCard = readFileSync(join(WEB, 'src', 'lib', 'components', 'OrderCard.svelte'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

// ─── 1. wallet card ──────────────────────────────────────────────────
check('balance + fiat share one baseline row', /flex flex-wrap items-baseline gap-x-1/.test(wallet));
check('fiat is no longer an inline-block with ml-1 (double-space + off-baseline)', !/ml-1 inline-block align-baseline/.test(wallet));
check('the fiat keeps its own text-xs line-box (no phantom gap)', /font-sans text-xs font-normal leading-tight/.test(wallet));
check('the three columns get an even, roomier gutter', /grid grid-cols-3 gap-x-6 gap-y-3/.test(wallet));

// ─── 2. focus border ─────────────────────────────────────────────────
check('a crisp 1px emerald focus border is defined for text fields', /:focus-visible \{[\s\S]{0,200}border-color: theme\('colors\.morphit\.emerald'\)/.test(css));
check('it paints a 1px ring, not a 3px translucent glow', /box-shadow: 0 0 0 1px theme\('colors\.morphit\.emerald'\)/.test(css));
check('invalid fields keep their red border on focus', /:not\(\[aria-invalid='true'\]\):not\(\[class\*='border-red'\]\):focus-visible/.test(css));
check('buttons/links keep the soft glow (rule is field-only)', !/:where\(a, button[^)]*\)[\s\S]{0,80}border-color: theme/.test(css));

// ─── 3. Send BLURT validation ────────────────────────────────────────
check('send validation lives in a pure, testable module', /export function validateBlurtAmount/.test(validation));
check('amount precision is capped at BLURT\u2019s 3 decimals', /\^\\d\*\(\\\.\\d\{0,3\}\)\?\$/.test(validation));
check('a sub-precision amount cannot become 0.000 BLURT', /MIN_BLURT = 0\.001/.test(validation) && /n >= MIN_BLURT/.test(validation));
check('the modal uses the shared validator', /import \{[^}]*\bvalidateBlurtAmount\b[^}]*\} from '\$lib\/blurt\/sendValidation';/.test(send) && /validateBlurtAmount\(amountInput, blurtBalance\)/.test(send));
// deep-deep: "use full balance" must FLOOR, never round — toFixed(3) can fill
// the field with more BLURT than the user has, which the validator then rejects.
check('use-full-balance floors to BLURT precision (never rounds up)', /floorToBlurtPrecision\(blurtBalance\)/.test(send) && !/amountInput = blurtBalance\.toFixed\(3\)/.test(send));
check('canSend requires the active-key password', /passwordFilled/.test(send) && /canSend = \$derived\([\s\S]{0,220}passwordFilled/.test(send));
check('canSend still requires a resolved recipient + valid amount', /recipientState === 'valid'[\s\S]{0,80}amountValid/.test(send));
check('a precision error gets its own message (not "up to your balance")', /!amountPrecisionOk[\s\S]{0,400}error_amount_precision/.test(send) && /\{:else if[\s\S]{0,200}error_amount'/.test(send));
check('amount + password fields expose aria-invalid', /aria-invalid=\{amountInput\.trim\(\)\.length > 0 && !amountValid\}/.test(send) && /aria-invalid=\{passwordError\.length > 0\}/.test(send));

let allLoc = true;
for (const loc of LOCALES) {
	const v = JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', `${loc}.json`), 'utf8'))
		?.profile?.wallet?.error_amount_precision as string | undefined;
	if (typeof v !== 'string' || !v || !v.includes('BLURT')) allLoc = false;
}
check('error_amount_precision exists in all 10 locales (BLURT untranslated)', allLoc);

// ─── 4. download hover, defined once ─────────────────────────────────
check('.card-hover-emerald exists as a shared class', /\.card-hover-emerald \{/.test(css));
check('it is defined AFTER .card-interactive so it wins the hover', css.indexOf('.card-hover-emerald') > css.indexOf('.card-interactive'));
check('OrderCard now uses the shared class', /card-hover-emerald/.test(orderCard));
check('no inline copy of the four-class incantation remains', !/hover:bg-emerald-50\/30/.test(orderCard) && !/hover:bg-emerald-50\/30/.test(download));
check('download cards gained the hover', (download.match(/card-hover-emerald/g) ?? []).length >= 4);
check('the already-emerald sections were left alone (hover would dim their border)', /<section class="card border-morphit-emerald\/40 bg-morphit-emerald\/5">/.test(download));

// ─── 5. double-green focus border, repo-wide (cp468) ─────────────────
// The §2 site-wide rule turns a text field's border emerald + paints a 1px
// ring on :focus-visible. A field that is `border-2` (2px) reads that as a
// 2px emerald border PLUS the ring = TWO green edges (Ken, kentest3). A field
// that ALSO declares its own emerald ring double-declares the same thing.
// The fix made `border` (1px) + app.css the single source for EVERY text
// field; these guards walk the whole .svelte tree so a new field can't
// silently reintroduce the double. Error fields (border-red, app.css-exempt)
// may keep a thicker/own-ring treatment. See docs/UX-STANDARD.md.
function walkSvelte(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) walkSvelte(p, out);
		else if (e.endsWith('.svelte')) out.push(p);
	}
	return out;
}
// strip HTML + JS comments so a doc-comment describing the bug can't trip us.
function stripComments(s: string): string {
	return s
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
// capture a field's opening tag, honouring quotes + {expr} so a `>` inside a
// class expression doesn't end the tag early.
function openTag(src: string, start: number): string {
	let i = start,
		depth = 0,
		q: string | null = null;
	for (; i < src.length; i++) {
		const c = src[i];
		if (q) {
			if (c === q) q = null;
		} else if (c === '"' || c === "'") q = c;
		else if (c === '{') depth++;
		else if (c === '}') depth--;
		else if (c === '>' && depth === 0) return src.slice(start, i + 1);
	}
	return src.slice(start);
}
const FIELD = /<(input|textarea|select)\b/g;
const svelteFiles = walkSvelte(join(WEB, 'src'));
const thick: string[] = [];
const ownRing: string[] = [];
const branchRing: string[] = [];
for (const f of svelteFiles) {
	const src = stripComments(readFileSync(f, 'utf8'));
	const rel = f.slice(f.indexOf('src/') + 4);
	if (src.includes('focus:ring-2 focus:ring-morphit-emerald')) ownRing.push(rel);
	let m: RegExpExecArray | null;
	FIELD.lastIndex = 0;
	while ((m = FIELD.exec(src))) {
		const tag = openTag(src, m.index);
		// A border-2 in a {ternary} branch is conditional (e.g. only the red
		// error state); harmless. A border-2 in the STATIC classes is
		// unconditional — it renders 2px in the normal state, which app.css
		// then turns into a 2px emerald border + the 1px ring = a double edge.
		// So strip the {expr} branches and test what's left. Always-red static
		// fields (border-red in the static part, app.css-exempt) are allowed.
		let staticPart = tag,
			prev = '';
		while (staticPart !== prev) {
			prev = staticPart;
			staticPart = staticPart.replace(/\{[^{}]*\}/g, '');
		}
		if (/\bborder-2\b/.test(staticPart) && !/border-red/.test(staticPart))
			thick.push(`${rel} <${m[1]}>`);
		if (/border-ink-\d+ focus:ring-morphit-emerald/.test(tag)) branchRing.push(`${rel} <${m[1]}>`);
	}
}
check(
	'no text field declares its own emerald focus ring (app.css owns it site-wide)',
	ownRing.length === 0
);
if (ownRing.length) console.error('      offenders: ' + [...new Set(ownRing)].join(', '));
check(
	'no non-error input/textarea/select uses border-2 (app.css would double it)',
	thick.length === 0
);
if (thick.length) console.error('      offenders: ' + thick.join(', '));
check(
	'no field keeps an emerald ring in its normal ternary branch (E6 pattern)',
	branchRing.length === 0
);
if (branchRing.length) console.error('      offenders: ' + branchRing.join(', '));
// the custom-select opt-out must stay wired: app.css exempts `no-app-focus-ring`
// so the borderless inner inputs of the Fiat/Payment selects don't draw a 2nd
// ring inside the wrapper's own emerald edge.
const fiatSel = readFileSync(join(WEB, 'src', 'lib', 'components', 'FiatCurrencySelect.svelte'), 'utf8');
const paySel = readFileSync(join(WEB, 'src', 'lib', 'components', 'PaymentFilterSelect.svelte'), 'utf8');
check(
	'app.css exempts no-app-focus-ring inputs from the field focus ring',
	/input[\s\S]{0,260}:not\(\[class\*='no-app-focus-ring'\]\)[\s\S]{0,80}:focus-visible/.test(css)
);
check(
	'the Fiat + Payment custom-select inner inputs carry no-app-focus-ring',
	/no-app-focus-ring/.test(fiatSel) && /no-app-focus-ring/.test(paySel)
);

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} ui-polish-batch scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} ui-polish-batch checks FAILED`);
	process.exit(1);
}
