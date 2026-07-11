/**
 * orderbook-hide-confirm-smoke — cp453
 *
 * THE BUG THIS GUARDS. The orderbook eyeball toggle used to call `hideAccount`
 * directly on a single, unconfirmed click. The eyeball sits inside the card's
 * stretched "open order" click area, so a stray click silently hid an account —
 * and because the chat inbox filters hidden peers (CHAT-UI-DESIGN.md), that
 * silently swallowed every chat thread with them too (a trader's messages
 * vanished with no signal). Hiding must now go through a confirmation that
 * warns about the chat consequence; unhide stays instant (harmless).
 *
 * These are source-level invariants, tamper-tested: flipping any of them red.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8');

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

const ob = read('apps/web/src/routes/[lang]/orderbook/+page.svelte');
const en = JSON.parse(read('apps/web/src/lib/i18n/locales/en.json')) as {
	orderbook: Record<string, string>;
};

// 1. Hide is NOT fired directly by the eyeball — the toggle sets a pending
//    account (opens the confirm). Unhide still fires instantly.
check(
	'eyeball "hide" opens confirmation (sets accountPendingHide), does NOT call hideAccount inline',
	/accountIsHidden \? unhideAccount\(o\.account\) : \(accountPendingHide = o\.account\)/.test(ob)
);

// 2. hideAccount is reachable ONLY from the ConfirmModal's onConfirm.
const hideCalls = [...ob.matchAll(/(?<!un)hideAccount\(/g)].length;
const unhideInToggle = /unhideAccount\(o\.account\)/.test(ob);
check('hideAccount( appears exactly once (the confirm handler), not on the raw toggle', hideCalls === 1);
check('unhide remains an instant, unconfirmed action', unhideInToggle);

// 3. A destructive ConfirmModal gates it, wired to accountPendingHide.
check(
	'a destructive ConfirmModal is bound to accountPendingHide and calls hideAccount on confirm',
	/<ConfirmModal[\s\S]*?open=\{accountPendingHide !== null\}[\s\S]*?variant="destructive"[\s\S]*?if \(accountPendingHide\) hideAccount\(accountPendingHide\)/.test(
		ob
	)
);

// 4. The confirm body must EDUCATE about the chat consequence — the whole point.
check(
	'the hide-confirm body warns that chats are hidden too',
	/hide_confirm_body/.test(ob) && /chat/i.test(en.orderbook.hide_confirm_title + en.orderbook.hide_confirm_body)
);

// 5. All three confirm keys exist (title/body/yes); cancel reuses common.cancel.
check(
	'hide_confirm title/body/yes keys present + cancel reuses common.cancel',
	Boolean(en.orderbook.hide_confirm_title) &&
		Boolean(en.orderbook.hide_confirm_body) &&
		Boolean(en.orderbook.hide_confirm_yes) &&
		/cancelLabel=\{\$_\('common\.cancel'\)/.test(ob)
);

if (failures === 0) {
	console.log('✓ all 6 orderbook-hide-confirm scenarios passed');
} else {
	console.log(`\n✗ ${failures}/6 orderbook-hide-confirm scenarios failed`);
	process.exit(1);
}
