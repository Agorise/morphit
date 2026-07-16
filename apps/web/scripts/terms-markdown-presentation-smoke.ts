#!/usr/bin/env tsx
/**
 * terms-markdown-presentation — cp474 (t.txt #11 + #12).
 *
 * Two of Ken's reports about the order Terms field, both presentation living in
 * .svelte files that no vitest can reach.
 *
 * #11 — "when i am typing in the Terms/details textarea, and I accidentally
 *       mouseover the markdown icon, the tooltip won't disappear when I stop
 *       mousing over the markdown icon."
 *
 *       It was a pure-CSS `group-hover:block` tooltip, so the ONLY thing that
 *       could dismiss it was the pointer physically moving off the icon. That is
 *       a bad bargain for THIS tooltip specifically: it is absolutely positioned
 *       below a 16px icon that sits directly above the Terms textarea, so it
 *       covers the field you are typing into. And while you type, browsers hide
 *       the cursor and do not re-evaluate `:hover` until the pointer actually
 *       moves — so a tooltip that opened as your hand left the mouse sits over
 *       your text with no mouseleave coming until you jiggle the mouse. It is now
 *       state-driven, and TYPING dismisses it.
 *
 * #12 — "whenever i use a blockquote (markdown) in the terms textarea, please
 *       indent that rendered blockquote on the ui."
 *
 *       The blockquote had a quote BAR (border + padding inside it) but no
 *       margin, so the bar sat flush against the same edge as every paragraph
 *       and the quote never read as set apart.
 *
 * Both fixes also had to be RTL-safe: `dir` really is flipped for Farsi
 * (app.html sets documentElement.dir = 'rtl' for fa), and the blockquote's old
 * `border-l-4` + `pl-3` put the quote bar on the far side of its own
 * right-aligned text for those readers.
 *
 * Tamper tests (each must turn this smoke red):
 *   - Put `group-hover:block` back on the tooltip → fails.
 *   - Remove the typing-dismiss effect → fails.
 *   - Drop `ms-*` from the blockquote → fails.
 *   - Revert the blockquote to `border-l-4` / `pl-3` → fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

function read(rel: string): string {
	return readFileSync(join(REPO, rel), 'utf8');
}

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
}

console.log('\n── terms-markdown-presentation (cp474 / t.txt #11+#12) ─\n');

const post = read('apps/web/src/routes/[lang]/post/+page.svelte');
const terms = read('apps/web/src/lib/components/TermsText.svelte');

// ─── #11: the tooltip must be dismissable without moving the mouse ──
check(
	'#11 the tooltip is state-driven, not CSS-hover-only',
	/let mdTipOpen = \$state\(false\)/.test(post) && /\{#if mdTipOpen\}/.test(post)
);
check(
	'#11 no `group-hover:block` tooltip survives anywhere in the app',
	!/class="[^"]*group-hover:block/.test(post),
	'CSS hover can only be undone by moving the pointer — the whole complaint'
);
check(
	'#11 TYPING in Terms dismisses the tooltip',
	/\$effect\(\(\) => \{\s*void terms;\s*mdTipOpen = false;\s*\}\)/.test(post),
	'`terms` is bound to the textarea, so it changes on every keystroke'
);
check('#11 pointer entry still opens it', /onmouseenter=\{\(\) => \(mdTipOpen = true\)\}/.test(post));
check('#11 pointer exit still closes it', /onmouseleave=\{\(\) => \(mdTipOpen = false\)\}/.test(post));
check(
	'#11 keyboard users can open it too (focus) — the icon is a real button',
	/onfocus=\{\(\) => \(mdTipOpen = true\)\}/.test(post) &&
		/onblur=\{\(\) => \(mdTipOpen = false\)\}/.test(post)
);
check(
	'#11 Escape closes it without needing a pointer at all',
	/if \(e\.key === 'Escape'\) mdTipOpen = false;/.test(post)
);
check(
	'#11 opening the guide modal closes the tooltip',
	/mdTipOpen = false;\s*mdGuideOpen = true;/.test(post),
	'otherwise it strands behind the dialog with no pointer left to un-hover it'
);

// ─── #12: the blockquote is actually indented ───────────────────────
const bq = /<blockquote\s+class="([^"]*)"/.exec(terms)?.[1] ?? '';
check('#12 the blockquote was found', bq.length > 0);
check(
	'#12 the blockquote is INDENTED from the surrounding text',
	/\bms-\d/.test(bq),
	`a border with inner padding is a bar, not an indent. class was: ${bq}`
);
check(
	'#12 it keeps its quote bar',
	/\bborder-s-4\b/.test(bq) && /border-morphit-emerald/.test(bq)
);
check(
	'#12 …and the bar/padding are RTL-safe (dir IS flipped for fa)',
	!/\bborder-l-\d/.test(bq) && !/\bpl-\d/.test(bq) && /\bps-\d/.test(bq),
	'physical l/r puts the quote bar on the far side of its own text in Farsi'
);

// The lists are the blockquote's immediate neighbours with the identical
// defect; leaving one wrong while fixing its twin is how drift starts.
check(
	'#12 the sibling lists are RTL-safe too (identical rendering in LTR)',
	!/list-(disc|decimal) space-y-0\.5 pl-\d/.test(terms) &&
		(terms.match(/list-(disc|decimal) space-y-0\.5 ps-\d/g) ?? []).length === 2
);

// ─── the premise the RTL reasoning rests on ─────────────────────────
const appHtml = read('apps/web/src/app.html');
check(
	'RTL really is live for Farsi (premise of the logical-property checks)',
	/documentElement\.dir = code === 'fa' \? 'rtl' : 'ltr'/.test(appHtml),
	'if this ever stops flipping dir, the ps-/ms-/border-s reasoning is moot'
);

// ─── one renderer, so every surface inherits the fix ────────────────
check(
	'TermsText is still the single terms-markdown renderer',
	/parseTermsMarkdown/.test(terms),
	'a second renderer would need the same indent — this is the drift check'
);

console.log(`\n${'─'.repeat(54)}`);
if (failed === 0) {
	console.log(`✓ all ${passed} terms-markdown-presentation checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed}/${passed + failed} terms-markdown-presentation checks failed`);
	process.exit(1);
}
