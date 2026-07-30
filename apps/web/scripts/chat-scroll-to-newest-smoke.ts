#!/usr/bin/env tsx
/**
 * chat-scroll-to-newest — cp474 (t.txt #7).
 *
 * THE BUG THIS GUARDS AGAINST. Ken, on live morphit.io, for the second time:
 * "when the chatroom page loads, it STILL does not always scroll the bubble all
 * the way up so that i can see the last, most recent message that was sent."
 *
 * The first attempt (tt.txt #8) added `pinToBottom`: jump instantly, then
 * re-pin while the content settles. The idea was right; the wiring made it a
 * no-op in two independent ways, and BOTH have to stay fixed or the symptom
 * comes straight back:
 *
 *   1. SELF-CANCEL. `pinToBottom` works by assigning `scrollTop`. The browser
 *      fires a `scroll` event for that assignment on the next frame, and
 *      `ConversationView.onScroll` cancelled the pin on ANY scroll event — so
 *      the pin tore itself down before re-pinning even once. First load was a
 *      single instant jump, and anything that grew the list afterwards (a
 *      web-font swap, the Payment Receipt bubble, a decrypted body, avatars)
 *      pushed the newest message back under the fold with nothing left to
 *      correct it. The fix cancels only when the scroll LEAVES the bottom: our
 *      own pin always lands AT the bottom so it can't cancel itself, while a
 *      user scrolling up still cancels instantly.
 *
 *   2. DEAD OBSERVER. `pinToBottom` watched the SCROLL CONTAINER with a
 *      ResizeObserver. That container is `flex-1 overflow-y-auto` — a
 *      fixed-height viewport whose border-box does not change when its content
 *      grows — so the observer could never fire for the one event it existed
 *      for. It now measures `scrollHeight` (the thing that actually changes)
 *      and holds on until that has been STABLE for a quiet period, instead of
 *      guessing a fixed deadline for the slowest asset on the page.
 *
 * The pin helper's own behaviour is unit-tested in `pinToBottom.test.ts`. This
 * smoke exists for the parts that live in a .svelte file, which those tests
 * cannot reach.
 *
 * Tamper tests (each must turn this smoke red):
 *   - Make onScroll cancel unconditionally again → fails.
 *   - Point the pin's re-pin loop back at a fixed deadline → fails.
 *   - Re-introduce a ResizeObserver on the scroll container → fails.
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

console.log('\n── chat-scroll-to-newest (cp474 / t.txt #7) ───────────\n');

const view = read('apps/web/src/lib/components/ConversationView.svelte');
const pin = read('apps/web/src/lib/ui/pinToBottom.ts');

// ─── 1. the pin is actually installed on first load ──────────────
check('ConversationView imports pinToBottom', /import \{ pinToBottom \}/.test(view));
check(
	'first load installs the pin (not just a one-shot scrollToBottom)',
	/!initialScrollDone[\s\S]{0,400}?cancelPin = pinToBottom\(scrollEl\)/.test(view),
	'the initial-load branch must hand the container to pinToBottom'
);

// ─── 2. the pin must not cancel itself ───────────────────────────
const onScrollBody = /function onScroll\(\): void \{([\s\S]*?)\n\t\}/.exec(view)?.[1] ?? '';
check('onScroll() found', onScrollBody.length > 0);
check(
	'onScroll cancels the pin ONLY when the scroll leaves the bottom',
	/if \(!userAtBottom\) \{[\s\S]{0,120}?cancelPin\?\.\(\)/.test(onScrollBody),
	'an unconditional cancelPin() here makes the pin tear itself down on its own scroll event'
);
check(
	'…and NOT unconditionally on every scroll event',
	!/^\s*cancelPin\?\.\(\);/m.test(onScrollBody.replace(/if \(!userAtBottom\) \{[\s\S]*?\n\t\t\}/, '')),
	'the cancel must be inside the !userAtBottom guard'
);
check(
	'onScroll still cancels for a user who scrolled away (never fight them)',
	/userAtBottom = isAtBottom\(\)/.test(onScrollBody) && /cancelPin/.test(onScrollBody)
);

// ─── 3. the pin watches content growth, not a fixed deadline ─────
check(
	'pinToBottom measures scrollHeight to detect late growth',
	/const height = el\.scrollHeight;[\s\S]{0,200}?if \(height !== lastHeight\)/.test(pin),
	'without this it cannot tell "still settling" from "settled"'
);
check(
	'pinToBottom restarts its quiet period when the content grows',
	/lastGrowthAt = now\(\)/.test(pin)
);
check(
	'pinToBottom lets go on a QUIET period, not a fixed wall-clock deadline',
	/now\(\) - lastGrowthAt >= settleMs/.test(pin),
	'a fixed deadline is a guess about the slowest asset on the page'
);
check('pinToBottom is still bounded by a hard cap', /PIN_MAX_MS/.test(pin) && /hardDeadline/.test(pin));

// ─── 4. the dead ResizeObserver must not come back ───────────────
// Match USE, not mention: the header legitimately explains why the observer was
// removed, and a bare /ResizeObserver/ would fail on that prose — a guard that
// punishes documentation is a guard people delete.
check(
	'pinToBottom does NOT observe the fixed-height scroll container',
	!/new ResizeObserver\(/.test(pin) && !/\.observe\(/.test(pin),
	'the container is `flex-1 overflow-y-auto`; its border-box never changes when content grows, so a ResizeObserver on it cannot fire'
);

// ─── 5. the container really is the fixed-height viewport ────────
// This is the premise the check above rests on. If the layout ever changes so
// the container itself grows, the reasoning is void and this should be re-read.
check(
	'the scroll container is still a fixed-height flex child (premise of #4)',
	/class="chat-scroll flex-1 overflow-y-auto[^"]*"[\s\S]{0,80}?bind:this=\{scrollEl\}/.test(view),
	'if the container stopped being flex-1/overflow-y-auto, revisit the ResizeObserver reasoning'
);

console.log(`\n${'─'.repeat(54)}`);
if (failed === 0) {
	console.log(`✓ all ${passed} chat-scroll-to-newest checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed}/${passed + failed} chat-scroll-to-newest checks failed`);
	process.exit(1);
}
