#!/usr/bin/env tsx
/**
 * Morphit — chat inbox motion smoke (v1.7.7, t.txt #4).
 *
 * [KEN]: "on chat page, whenever a message appears or disappears (manually or
 * dynamically/automatically) from Inbox, Starred, or Archived, please use a
 * smooth slide-in or slide-out effect so the eye can see easier what is
 * happening."
 *
 * THE TRAP THIS FILE MOSTLY EXISTS FOR — reduced motion looks handled and isn't.
 *
 * `app.css` carries the standard global guard:
 *     @media (prefers-reduced-motion: reduce) {
 *       *, *::before, *::after { animation-duration: 0ms !important; ... }
 *     }
 * That rule is real and it works — for CSS. **Svelte 5 transitions are not CSS.**
 * They run through `element.animate()` (WAAPI; see
 * svelte/src/internal/client/dom/elements/transitions.js), which `!important`
 * cannot reach, and Svelte does not check the preference itself — there is no
 * `matchMedia` anywhere in that file.
 *
 * So the global rule gives false coverage: anyone adding `transition:` here and
 * trusting app.css ships a full-length animation to every user who explicitly
 * asked for less motion, with nothing failing and nothing visible in review.
 * That is the exact shape of bug this repo keeps finding — a guard that looks
 * present while doing nothing — so it gets a check rather than a comment.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) { pass++; console.log(`  \u2713 ${name}`); }
	else { fail++; console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`); }
};

const page = read('apps/web/src/routes/[lang]/chat/+page.svelte');
const css = read('apps/web/src/app.css');

check(
	'1 inbox cards slide in and out',
	/transition:slide=\{\{ duration: cardSlideDuration\(\) \}\}/.test(page),
	"Ken: 'so the eye can see easier what is happening'"
);
check(
	'2 the slide honours prefers-reduced-motion EXPLICITLY',
	/function cardSlideDuration\(\)[\s\S]{0,400}?matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches \? 0 : 250;/.test(
		page
	),
	'app.css cannot help: Svelte 5 transitions are WAAPI, not CSS, so animation-duration:0ms !important never touches them'
);
check(
	'3 …and app.css still carries the global CSS guard (it covers everything else)',
	/@media \(prefers-reduced-motion: reduce\)/.test(css) &&
		/animation-duration: 0ms !important;/.test(css),
	'this is not redundant with check 2 — it covers CSS animations, which WAAPI is not'
);
check(
	'4 the duration is read per-transition, not cached at module load',
	/function cardSlideDuration\(\): number \{/.test(page) &&
		!/const cardSlideDuration = \d+/.test(page),
	'someone toggling reduced-motion mid-session is usually doing it BECAUSE something moved'
);
check(
	'5 it is SSR-safe',
	/function cardSlideDuration\(\): number \{\s*if \(typeof window === 'undefined'\) return 0;/.test(page),
	'matchMedia does not exist during prerender, and every locale is prerendered'
);

// ── a tab switch is navigation, not filing ─────────────────────────
check(
	'6 switching tabs does NOT animate',
	/if \(switchingTab\) return 0;/.test(page),
	'a tab switch replaces the whole list: 20 cards collapsing while 20 expand is noise, not information'
);
check(
	'7 …and every tab button goes through setTab',
	!/onclick=\{\(\) => \(activeTab = '/.test(page) &&
		/onclick=\{\(\) => setTab\('inbox'\)\}/.test(page) &&
		/onclick=\{\(\) => setTab\('starred'\)\}/.test(page) &&
		/onclick=\{\(\) => setTab\('archived'\)\}/.test(page),
	'one direct assignment left behind would animate that tab and no other — the worst kind of inconsistency to debug'
);
check(
	'8 the flag clears after the DOM settles',
	/switchingTab = true;[\s\S]{0,120}?void tick\(\)\.then\(\(\) => \{\s*switchingTab = false;/.test(page),
	'Svelte reads transition params when the transition STARTS (same update), so the flag is true then; tick() resolves after'
);

// ── the mechanics slide depends on ─────────────────────────────────
check(
	'9 the each block is KEYED',
	/\{#each activeList as convo \(threadKey\(convo\)\)\}/.test(page),
	'an unkeyed each reuses DOM nodes by index — transitions would fire on the wrong cards, or not at all'
);
check(
	'10 the card can be collapsed by the slide',
	/transition:slide=\{\{ duration: cardSlideDuration\(\) \}\}[\s\S]{0,200}?overflow-hidden/.test(page),
	'slide animates height; without overflow-hidden the contents spill during the collapse'
);
check(
	'11 flip still handles cards MOVING within the list',
	/animate:flip=\{\{ duration: cardFlipDuration\(\) \}\}/.test(page),
	'flip and slide are complementary: flip moves survivors, slide handles arrivals and departures'
);
check(
	'12 the fallback-peer list is deliberately NOT animated',
	/\{#each fallbackPeers as peer \(peer\)\}\s*[\s\S]{0,200}?<li>/.test(page),
	'it only renders when the indexer is down; it has no folders, so nothing files in or out of it'
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} chat-inbox-motion checks passed`);
else { console.error(`\u2717 ${fail} of ${pass + fail} chat-inbox-motion checks FAILED`); process.exit(1); }
