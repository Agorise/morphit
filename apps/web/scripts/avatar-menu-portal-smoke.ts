#!/usr/bin/env tsx
/**
 * Smoke: the avatar menu's portaled scrim (Ken: "you broke the avatar menu").
 *
 * The scrim was `use:portal`'d directly as the FIRST node of `{#if open}`.
 * A Svelte block tracks its own first and last nodes; moving the first one to
 * <body> destroys that boundary, so closing the menu removed nothing. The menu
 * stayed open, a dead scrim stayed over the page, and every subsequent click
 * landed on it. Three symptoms, one cause.
 *
 * Rule: portal a STABLE node, never a block boundary. The container is always
 * rendered; `{#if open}` lives inside it.
 *
 * Also pinned: the container sits ABOVE the sticky header (z-40) so the header
 * blurs with the rest of the page, and the panel is anchored to the trigger's
 * viewport rect because it can no longer position itself against it.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const src = readFileSync(join(WEB, 'src', 'lib', 'components', 'AvatarMenu.svelte'), 'utf8');
const code = src
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.split('\n')
	.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
	.join('\n');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean): void => {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
};

const portalIdx = code.indexOf('use:portal');
const ifOpenIdx = code.indexOf('{#if open}', portalIdx);

check('the portaled node exists', portalIdx !== -1);
check('`{#if open}` is INSIDE the portaled container, not around it', portalIdx !== -1 && ifOpenIdx > portalIdx);
check('the portaled container is never itself conditional (stable node)', !/\{#if open\}[\s\S]{0,200}use:portal/.test(code));
check('it renders above the sticky header (z-40) so the header blurs too', /use:portal[\s\S]{0,160}z-\[60\]/.test(code));
check('the closed container cannot eat clicks', /pointer-events-none hidden/.test(code));
check('the scrim and panel opt back INTO pointer events', (code.match(/pointer-events-auto/g) ?? []).length === 2);
check('the scrim closes the menu', /onclick=\{close\}/.test(code));

// Folded in from the retired `avatar-menu-blur-smoke` (cp446): it pinned the OLD
// design — a `fixed inset-0` scrim at z-40, below a z-50 menu — which no longer
// exists and which could never have blurred the header. Its four checks are
// subsumed here; two of its unique assertions are kept verbatim.
check('the overlay dims and blurs the page behind it', /backdrop-blur-sm/.test(code) && /bg-ink-900\/5/.test(code));
check('the overlay covers the viewport (fixed inset-0)', /use:portal[\s\S]{0,120}fixed inset-0/.test(code));
check('the overlay exists only while the menu is open', /\{#if open\}[\s\S]{0,400}backdrop-blur-sm/.test(code));
check('the panel is anchored to the trigger rect (it can no longer be `absolute`)', /style="top: \{panelTop\}px; right: \{panelRight\}px;"/.test(code));
check('…and it is NOT positioned absolutely against a header ancestor', !/absolute end-0 z-50 mt-2/.test(code));
check('the rect is re-measured on resize and scroll', /addEventListener\('resize', measureTrigger\)/.test(code) && /addEventListener\('scroll', measureTrigger, true\)/.test(code));
check('…and those listeners are removed when the menu closes', /removeEventListener\('resize', measureTrigger\)/.test(code) && /removeEventListener\('scroll', measureTrigger, true\)/.test(code));
check('outside-click still closes (document mousedown)', /document\.addEventListener\('mousedown', onClick\)/.test(code));
check('menu categories close the menu before navigating', /function openCategory[\s\S]{0,120}open = false;[\s\S]{0,80}gotoLocale\(path\)/.test(code));

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} avatar-menu-portal scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} avatar-menu-portal checks FAILED`);
	process.exit(1);
}
