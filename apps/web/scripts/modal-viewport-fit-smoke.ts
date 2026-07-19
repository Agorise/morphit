#!/usr/bin/env tsx
/**
 * Morphit — modal viewport-fit smoke (v1.7.7, t.txt #5).
 *
 * [KEN]: "the send modal is too big for my mobile screen and will not let me
 * scroll my screen up or down so that i can see its full height or the submit
 * button at the bottom."
 *
 * THE BUG, and why it deserves a repo-wide guard rather than one fix:
 * `fixed inset-0` + `flex items-center` and no height cap. `fixed` pins the
 * backdrop to exactly one viewport, so there is nothing to scroll; and centring
 * an over-tall flex child overflows BOTH ends at once — and overflow past the
 * START edge is unreachable, because no scrollbar will take you upward past the
 * container's own origin. So the title vanishes off the top and the submit
 * button sits below the fold, permanently.
 *
 * Reproduced in Chromium at Ken's exact size (1080px @ DPR 3 = 360x800 CSS):
 * card top at -22px, submit unreachable even after scrolling to the end. Also
 * fails at 800x360 (landscape) and 320x568. Fixed at all three.
 *
 * IT WAS IN TWELVE MODALS, not one. Ken only met it on the send screen, but
 * PayBlurtModal is the same bug on the other money screen, and
 * PrivateKeyWarningModal is the dialog that warns you BEFORE you paste a private
 * key. Nothing errors in any of them — the button simply cannot be reached.
 *
 * THE UNIT MATTERS: `dvh`, never `vh`. On a phone `vh` is the LARGE viewport —
 * it counts the space behind the URL bar — so a `95vh` card can still stand
 * taller than what is actually on screen, which is this same bug in miniature.
 * Four modals already capped their height and every one of them used `vh`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WEB = join(ROOT, 'apps/web/src');

function walk(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (e.name.endsWith('.svelte')) out.push(p);
	}
	return out;
}

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) { pass++; console.log(`  \u2713 ${name}`); }
	else { fail++; console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const files = walk(WEB);

// ── every dialog must cap its height ───────────────────────────────
const uncapped: string[] = [];
for (const f of files) {
	const s = readFileSync(f, 'utf8');
	if (!/role="dialog"/.test(s)) continue;
	if (!/max-h-\[/.test(s)) uncapped.push(f.replace(ROOT + '/', ''));
}
check(
	'1 every role="dialog" caps its height',
	uncapped.length === 0,
	`uncapped: ${uncapped.join(', ')} — an over-tall dialog puts its own submit button out of reach`
);

// ── …and can scroll once capped ────────────────────────────────────
const capNoScroll: string[] = [];
for (const f of files) {
	const s = readFileSync(f, 'utf8');
	const m = s.match(/class="[^"]*max-h-\[[^\]]+\][^"]*"/g);
	if (m === null) continue;
	for (const cls of m) {
		if (!/overflow-y-auto|overflow-auto|overflow-y-scroll/.test(cls)) {
			capNoScroll.push(`${f.split('/').pop()}: ${cls.slice(0, 60)}`);
		}
	}
}
check(
	'2 …and every height cap is paired with a scroller',
	capNoScroll.length === 0,
	`a cap without overflow-y-auto CLIPS the content instead of letting the user reach it: ${capNoScroll.join('; ')}`
);

// ── the unit ───────────────────────────────────────────────────────
const vhCaps: string[] = [];
for (const f of files) {
	const s = readFileSync(f, 'utf8');
	// only inside class attributes — prose in comments is fine
	for (const cls of s.match(/class="[^"]*"/g) ?? []) {
		if (/max-h-\[\d+vh\]/.test(cls)) vhCaps.push(`${f.split('/').pop()}: ${/max-h-\[\d+vh\]/.exec(cls)![0]}`);
	}
}
check(
	'3 height caps use dvh, not vh',
	vhCaps.length === 0,
	`vh counts the space behind a phone's URL bar, so the card can still exceed the visible viewport: ${vhCaps.join('; ')}`
);

// ── the two money screens, by name ─────────────────────────────────
for (const name of ['SendBlurtModal', 'PayBlurtModal']) {
	const f = files.find((p) => p.endsWith(`${name}.svelte`))!;
	const s = readFileSync(f, 'utf8');
	check(
		`4 ${name} fits and scrolls (this screen moves money)`,
		/max-h-\[95dvh\]/.test(s) && /overflow-y-auto/.test(s),
		'Ken could not reach the send button; being unable to complete a payment is not a cosmetic bug'
	);
}
check(
	'5 PrivateKeyWarningModal fits and scrolls',
	(() => {
		const s = readFileSync(files.find((p) => p.endsWith('PrivateKeyWarningModal.svelte'))!, 'utf8');
		return /max-h-\[95dvh\]/.test(s) && /overflow-y-auto/.test(s);
	})(),
	'this is the dialog that warns you BEFORE you paste a private key — its buttons must be reachable'
);

// ── the click-catchers are deliberately exempt ─────────────────────
check(
	'6 dropdown click-catchers are correctly NOT treated as modals',
	(() => {
		const s = readFileSync(files.find((p) => p.endsWith('AssetFilterSelect.svelte'))!, 'utf8');
		// a catcher is a bare backdrop: no flex centring, no card, no dialog role
		return /class="fixed inset-0 z-20 cursor-default/.test(s) && !/role="dialog"/.test(s);
	})(),
	'they hold no content — capping their height would mean nothing'
);

// ── hand-written CSS: a vh/dvh fallback pair must be ORDERED (cp478) ───
//
// Checks 1-6 cover the .svelte class attributes, where the rule is "bare dvh, never
// a pair" — Tailwind emits utilities in ITS order, not the class attribute's, so a
// pair there is a coin flip.  app.css is the other case: source order IS real, so a
// pair is legitimate — and therefore so is getting it backwards.
//
// app.css carried `min-height: 100dvh; min-height: 100vh;` from before v1.7.7.  Both
// lines valid, nothing warns, and the dvh line had never once applied to a single
// visitor, because later wins.  The intent was obvious and the effect was its exact
// inverse.  Caught by reading, not by any gate.
//
// Pinned as an OUTCOME, not a literal: this finds any property declared twice in one
// block with a vh value and a dvh value, and requires dvh last.  It keeps holding if
// someone changes 100 to 90, swaps min-height for height, or adds a pair somewhere
// new — none of which is the bug, all of which would break a literal pin.
const cssFiles = (function walkCss(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walkCss(p, out);
		else if (e.name.endsWith('.css')) out.push(p);
	}
	return out;
})(WEB);

const badPairs: string[] = [];
let pairsFound = 0;
for (const f of cssFiles) {
	const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''); // prose is not CSS
	for (const [, body] of src.matchAll(/\{([^{}]*)\}/g)) {
		// property → the order its vh / dvh declarations appear in
		const seen = new Map<string, string[]>();
		for (const [, prop, value] of body.matchAll(/([a-z-]+)\s*:\s*([^;]*(?:d?vh)[^;]*);/g)) {
			const unit = /\d\s*dvh/.test(value) ? 'dvh' : 'vh';
			seen.set(prop, [...(seen.get(prop) ?? []), unit]);
		}
		for (const [prop, units] of seen) {
			if (!units.includes('vh') || !units.includes('dvh')) continue; // not a pair
			pairsFound++;
			if (units.lastIndexOf('dvh') < units.lastIndexOf('vh')) {
				badPairs.push(`${f.split('/').pop()}: ${prop} — ${units.join(' then ')}`);
			}
		}
	}
}
check(
	'7 a vh/dvh fallback pair in hand-written CSS puts dvh LAST',
	badPairs.length === 0,
	`dvh first means the vh line wins and the dvh line applies to nobody — the ` +
		`inverse of the intent, silently: ${badPairs.join('; ')}`
);
check(
	'8 …and the guard is looking at a real pair (it would notice if one vanished)',
	pairsFound > 0,
	'no vh/dvh pair found in any .css — check 7 is passing vacuously; if the pairs were ' +
		'deliberately removed, remove this check with them rather than leaving it green on nothing'
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} modal-viewport-fit checks passed`);
else { console.error(`\u2717 ${fail} of ${pass + fail} modal-viewport-fit checks FAILED`); process.exit(1); }
