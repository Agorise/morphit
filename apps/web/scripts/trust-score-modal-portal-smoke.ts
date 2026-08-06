#!/usr/bin/env tsx
/**
 * Smoke: the TrustScoreModal's portaled backdrop (Ken, t.txt v1.8.16 #4 —
 * wrap-is-wrong.png / "click outside should always close, no matter which page").
 *
 * Two symptoms, one cause, same family as the avatar-menu bug:
 * TrustScoreModal is NOT mounted at page/layout level like SendBlurtModal — it
 * lives deep inside RatingChip, which sits inside TradeRepCluster's
 * `whitespace-nowrap` span (inside OrderCard), and also inside
 * ConversationView's slide-transitioned chat panel and the sticky
 * `backdrop-blur-md` header. So:
 *   (a) the modal `<p>` text INHERITED `white-space: nowrap` from the cluster —
 *       every paragraph ran off the side instead of wrapping; and
 *   (b) an ancestor with `transform`/`filter`/`backdrop-filter` is the containing
 *       block for `position: fixed`, so `fixed inset-0` did not cover the
 *       viewport on those pages — the scrim was clipped and a click in the
 *       uncovered area never reached it, so the modal would not close.
 *
 * Fix: `use:portal` the backdrop to <body> (escapes both the nowrap ancestor and
 * the fixed-containing-block ancestor). This smoke pins the fix AND the Svelte
 * gotcha the avatar bug taught us: portal a STABLE node, never a block boundary.
 * The portaled container is ALWAYS rendered and toggles visibility via classes;
 * `{#if open}` lives INSIDE it. Portaling the first node of an `{#if}` block
 * moves that block's boundary to <body> and breaks teardown.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');

/** Strip comments before grepping — a fix's own comment necessarily names the
 *  very anti-patterns it replaced (`white-space: nowrap`, `transform`, …), so an
 *  un-stripped grep would match the explanation and pass/fail on prose. */
function strip(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
		.join('\n');
}

const modal = strip(
	readFileSync(join(WEB, 'src', 'lib', 'components', 'TrustScoreModal.svelte'), 'utf8')
);
const chip = strip(
	readFileSync(join(WEB, 'src', 'lib', 'components', 'RatingChip.svelte'), 'utf8')
);

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

const portalIdx = modal.indexOf('use:portal');
const ifOpenIdx = modal.indexOf('{#if open}', portalIdx >= 0 ? portalIdx : 0);

// --- the portal itself ---
check("imports the shared portal action", modal.includes("from '$lib/ui/portal'"));
check('the backdrop is portaled (use:portal)', portalIdx !== -1);

// --- the STABLE-node rule (the avatar-menu lesson) ---
check(
	'`{#if open}` is INSIDE the portaled container, not around it',
	portalIdx !== -1 && ifOpenIdx > portalIdx
);
check(
	'the portaled container is never itself conditional (stable node, not a block boundary)',
	!/\{#if open\}[\s\S]{0,200}use:portal/.test(modal)
);
check(
	'closed container is display:none so it shows nothing and cannot eat clicks',
	/pointer-events-none hidden/.test(modal)
);

// --- above the sticky header once we are a <body> child ---
check(
	'renders above the sticky header (z-40) — z-[60] on the portaled node',
	/use:portal[\s\S]{0,200}z-\[60\]/.test(modal)
);
check(
	'the scrim covers the viewport (fixed inset-0 on the portaled node)',
	/use:portal[\s\S]{0,200}fixed inset-0/.test(modal)
);

// --- click-outside + escape close; inside-click does not ---
check(
	'clicking the backdrop (role=presentation) closes the modal',
	/role="presentation"[\s\S]{0,160}onclick=\{onClose\}/.test(modal)
);
check(
	'a click INSIDE the dialog does not dismiss (stopPropagation)',
	/role="dialog"[\s\S]{0,400}stopPropagation\(\)/.test(modal)
);
check(
	'Escape closes (window keydown wired to onClose while open)',
	/on:keydown=\{open \? onKeydown/.test(modal) && /if \(e\.key === 'Escape'\) onClose\(\)/.test(modal)
);

// --- the wrap fix: text is explicitly allowed to wrap regardless of ancestor ---
check(
	'the paragraph block is `whitespace-normal` (nowrap can never be inherited again)',
	/space-y-3 whitespace-normal text-sm/.test(modal)
);

// --- wiring: the modal is actually mounted, and gated by chip state ---
check('RatingChip mounts <TrustScoreModal>', /<TrustScoreModal/.test(chip));
check(
	'…and passes its open state + onClose',
	/open=\{explainerOpen\}/.test(chip) && /onClose=\{\(\) => \(explainerOpen = false\)\}/.test(chip)
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} trust-score-modal-portal scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} trust-score-modal-portal checks FAILED`);
	process.exit(1);
}
