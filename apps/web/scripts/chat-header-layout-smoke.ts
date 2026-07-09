#!/usr/bin/env tsx
/**
 * Smoke: tt.txt #7 — the chat header, restructured (Ken).
 *
 * Ken's reason was mobile: the old header spent its horizontal budget on a
 * single-line IdentityLabel plus a LIVE pip stacked under the kebab, leaving the
 * sprout / trade-count / reputation nowhere to go. The header is now shaped like
 * an order card, and LIVE moved inside the kebab menu.
 *
 *   "Chatting with:"
 *   ┌──────┐  display name  🌱
 *   │ 48px │  (posting key) · N trades · ⭐ 4.87        ⋮  ← top-aligned
 *   └──────┘  RE: <order title>
 *
 * Menu order, top to bottom: LIVE · divider · Chat Security · Verify peer ·
 * Block @username · Export chat.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const src = readFileSync(join(WEB, 'src', 'lib', 'components', 'ConversationView.svelte'), 'utf8');

/** Match CODE, not prose — the fix's own comments describe the old layout. */
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

/** Index of the first occurrence, or Infinity. Used to assert ORDER. */
const at = (needle: string): number => {
	const i = code.indexOf(needle);
	return i === -1 ? Number.POSITIVE_INFINITY : i;
};

// ─── the identity cluster ────────────────────────────────────────────
check('the avatar is bigger (48px) and rendered without its inline handle', /avatarSize=\{48\}/.test(code) && /hideHandle/.test(code));
check('line 1 is the display name', /peerLabelProps\.displayName \|\| `@\$\{peer\}`/.test(code));
check('the sprout sits at the end of the display-name line', at('peerLabelProps.displayName') < at('<NewTraderChip />'));
check('line 2 carries the truncated posting key', /truncatePublicKey\(peerPostingKey\)/.test(code));
check('line 2 carries the trade count', at('truncatePublicKey(peerPostingKey)') < at('orderbook.card.trades_only'));
check('the sprout is on line 1, ABOVE the key/trades line', at('<NewTraderChip />') < at('truncatePublicKey(peerPostingKey)'));
check('line 3 is the RE: order link, below all of it', at('orderbook.card.trades_only') < at('chat.header.re'));

// ─── Ken: the reputation must NEVER wrap ─────────────────────────────
// On a narrow viewport line 2 (key · trades · ⭐) is the line that runs out of
// room, so the score renders on the DISPLAY-NAME line instead. Two variants,
// split by a breakpoint — deterministic, no measuring. There are therefore TWO
// occurrences of the score, and the naive "first occurrence" ordering that used
// to hold no longer does.
// Each variant uses the score three times: aria-label, title, and the visible
// text. Two variants → six. Pinning the number keeps a third stray copy out.
const scoreHits = (code.match(/peerReputation\.score\.toFixed\(2\)/g) ?? []).length;
check('the score is rendered in exactly two places (mobile + desktop)', scoreHits === 6);
check('the mobile score sits on the display-name line and hides from `sm` up', /sm:hidden[\s\S]{0,200}peerReputation\.score\.toFixed\(2\)/.test(code) && at('sm:hidden') < at('truncatePublicKey(peerPostingKey)'));
check('the desktop score sits on line 2 and appears only from `sm` up', /hidden flex-none items-center gap-1 font-semibold text-morphit-emerald sm:inline-flex/.test(code));
check('line 2 cannot wrap at all (flex-nowrap)', /mt-0\.5 flex min-w-0 flex-nowrap items-center/.test(code));
check('if anything must give, it is the posting key that truncates', /<span class="truncate font-mono">\(\{truncatePublicKey\(peerPostingKey\)\}\)<\/span>/.test(code));
check('the trade count never wraps or truncates', /flex-none whitespace-nowrap/.test(code));
check('the RE: line still links to the order', /\/@\$\{orderOwner \?\? peer\}\/\$\{orderPermlink\}/.test(code));

// ─── the kebab ───────────────────────────────────────────────────────
// NB: match the kebab's MARKUP (`bind:this=`), not the identifier — the latter
// is declared in <script>, thousands of characters before any of this.
check('the kebab is the last item of the identity ROW (top-aligned with the name)', at('items-start gap-3') < at('bind:this={overflowTriggerEl}'));
check('…and the RE: line comes before the kebab in that row', at('chat.header.re') < at('bind:this={overflowTriggerEl}'));
check('the old right-hand column wrapper is gone', !/flex flex-none flex-col items-end/.test(code));

// ─── LIVE moved into the menu, in Ken's order ────────────────────────
const menu = code.slice(code.indexOf('role="menu"'));
const m = (needle: string): number => {
	const i = menu.indexOf(needle);
	return i === -1 ? Number.POSITIVE_INFINITY : i;
};
check('LIVE is inside the menu', m("chat.live") < Number.POSITIVE_INFINITY);
check('there is exactly ONE animated pip left in the file', (code.match(/animate-ping/g) ?? []).length === 1);
check('LIVE sits above a hairline divider', m("chat.live") < m('border-t border-ink-200'));
check('divider → Chat Security', m('border-t border-ink-200') < m('chat.security.menu_label'));
check('Chat Security → Verify peer', m('chat.security.menu_label') < m('chat.menu.verify_peer'));
check('Verify peer → Block @username', m('chat.menu.verify_peer') < m('chat.block.confirm'));
check('Block @username → Export chat', m('chat.block.confirm') < m('chat.export.menu_label'));
check('LIVE is a status readout, not a focusable menuitem', !/role="menuitem"[\s\S]{0,200}chat\.live/.test(menu));
check('LIVE only renders while streaming (unchanged semantics, just relocated)', /\{#if streaming\}[\s\S]{0,900}chat\.live/.test(menu));

// ─── each label must sit in the SAME button as its handler ───────────
// Without this, swapping two onclick handlers would leave the menu reading
// correctly while "Chat Security" opened Verify peer — an order check keyed off
// labels alone cannot see that. (Found by tamper-testing this very smoke.)
const buttons = [...menu.matchAll(/<button[\s\S]*?<\/button>/g)].map((mm) => mm[0]);
const pairedIn = (handler: string, label: string): boolean =>
	buttons.some((b) => b.includes(handler) && b.includes(label));

check('Chat Security button carries the Chat Security label', pairedIn('onclick={openChatSecurity}', 'chat.security.menu_label'));
check('Verify peer button carries the Verify peer label', pairedIn('onclick={openVerifyPeer}', 'chat.menu.verify_peer'));
check('Block button carries the block/unblock label', pairedIn('onToggleBlock();', 'chat.block.confirm'));
check('Export button carries the Export label', pairedIn('onclick={exportChatToPdf}', 'chat.export.menu_label'));

// ─── nothing lost ────────────────────────────────────────────────────
check('Block/Unblock still opens the confirm modal', /closeOverflowMenu\(\);\s*\n\s*onToggleBlock\(\);/.test(code));
check('Chat Security still clears its one-time nudge dot', /onclick=\{openChatSecurity\}/.test(code) && /chatSecurityNudgeSeen/.test(code));
check('Export chat still wired', /onclick=\{exportChatToPdf\}/.test(code));
check('the whole menu is still gated on an unlocked session', /\{#if \$isUnlocked\}/.test(code));

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} chat-header-layout scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} chat-header-layout checks FAILED`);
	process.exit(1);
}
