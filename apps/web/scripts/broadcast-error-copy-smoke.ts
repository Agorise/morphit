/**
 * broadcast-error-copy-smoke (v1.16.5)
 *
 * Every broadcast failure must resolve to an EXACT, actionable UI message — never
 * an opaque "try again", never "open DevTools". This pins the pure
 * classifier: each error type / chain reason maps to the right i18n key, the key
 * exists in en.json, and settings.+page.svelte routes through the classifier.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	classifyBroadcastError,
	classifyChainReason
} from '../src/lib/blurt/broadcastErrorClass.ts';
import { ChainRejectedError, BroadcastUnavailableError } from '../src/lib/blurt/broadcastTransport.ts';
import { BroadcastError } from '../src/lib/blurt/broadcastTransport.ts';
import { AccountBindingError } from '../src/lib/blurt/accountBinding.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

// ── classifyChainReason: recognise the actionable causes ──
check('fee-insufficiency reason → low_blurt', classifyChainReason('insufficient balance to pay operation fee') === 'low_blurt');
check('unaffordable-fee reason → low_blurt', classifyChainReason('account does not have enough BLURT for the fee') === 'low_blurt');
// Blurt's own words (libraries/chain/database.cpp, process_tx_fee), as the
// node returns them: what a bio save on an account short of the fee gets back.
check('blurtd fee assertion → low_blurt', classifyChainReason('Assert Exception:acnt.balance >= fee: Account does not have sufficient funds for transaction fee.') === 'low_blurt');
check('size reason → too_large', classifyChainReason('custom_json payload too large, exceeds maximum size') === 'too_large');
check('auth reason → auth', classifyChainReason('missing required posting authority') === 'auth');

// v1.16.12 — a WAF status must classify SPECIFICALLY, not as generic 'unreachable'
check('unreachable w/ 413 → waf_too_large (names the body-size fix)', classifyBroadcastError(new BroadcastUnavailableError('POST /v1/broadcast failed (status 413)'), 'gets.owner').key === 'waf_too_large');
check('unreachable w/ 403 → waf_blocked (names the WAF exemption fix)', classifyBroadcastError(new BroadcastUnavailableError('blocked (status 403)'), 'gets.owner').key === 'waf_blocked');
check('unreachable w/o a status → still generic unreachable', classifyBroadcastError(new BroadcastUnavailableError('connection refused'), 'gets.owner').key === 'unreachable');
check('clock/expiry reason → tx_expired', classifyChainReason('transaction expiration exceeds head block time') === 'tx_expired');
check('tapos reason → tx_expired', classifyChainReason('TaPoS reference block mismatch') === 'tx_expired');
check('duplicate reason → duplicate', classifyChainReason('duplicate transaction') === 'duplicate');
	check('unknown reason → null (show raw)', classifyChainReason('some novel error') === null);

// ── classifyBroadcastError: every branch → the right key ──
const A = 'gets.owner';
check('unreachable instance → unreachable', classifyBroadcastError(new BroadcastUnavailableError('no chain head'), A).key === 'unreachable');
check('chain fee rejection → low_blurt', classifyBroadcastError(new ChainRejectedError('unable to pay operation fee, balance too low'), A).key === 'low_blurt');
check('chain size rejection → too_large', classifyBroadcastError(new ChainRejectedError('serialized size exceeds maximum'), A).key === 'too_large');
check('chain expiry rejection → tx_expired (clock)', classifyBroadcastError(new ChainRejectedError('trx expired: expiration in the past'), A).key === 'tx_expired');
check('chain unknown rejection → rejected (+reason)', (() => {
	const c = classifyBroadcastError(new ChainRejectedError('weird chain thing'), A);
	return c.key === 'rejected' && c.values?.reason === 'weird chain thing';
})());
check('locked → locked', classifyBroadcastError(new BroadcastError('locked', 'x'), A).key === 'locked');
check('key_mismatch → key_mismatch (+account)', (() => {
	const c = classifyBroadcastError(new BroadcastError('key_mismatch', 'x'), A);
	return c.key === 'key_mismatch' && c.values?.account === A;
})());
check('binding wrong-account → wrong_account', classifyBroadcastError(new AccountBindingError('key_not_in_authority', 'x', ['bob']), A).key === 'wrong_account');
check('raw Error → generic_detail (+detail, never opaque)', (() => {
	const c = classifyBroadcastError(new Error('boom from rpc'), A);
	return c.key === 'generic_detail' && c.values?.detail === 'boom from rpc';
})());
check('empty error → generic (only when no detail at all)', classifyBroadcastError(new Error(''), A).key === 'generic');

// ── every returned key exists in en.json ──
const en = JSON.parse(readFileSync(join(REPO, 'apps/web/src/lib/i18n/locales/en.json'), 'utf8'));
const be = en.common.broadcast_err as Record<string, string>;
for (const k of ['unreachable', 'offline', 'low_blurt', 'too_large', 'auth', 'tx_expired', 'duplicate', 'rejected', 'key_mismatch', 'locked', 'no_account', 'wrong_account', 'no_account_for_key', 'lookup_failed', 'generic', 'generic_detail'])
	check(`i18n key exists: ${k}`, typeof be[k] === 'string' && be[k].length > 0);
// the actionable messages must include a {placeholder} so the real cause shows
for (const [k, ph] of [['unreachable', '{detail}'], ['too_large', '{reason}'], ['generic_detail', '{detail}']] as const)
	check(`${k} surfaces the real cause (${ph})`, be[k].includes(ph));
// Out of BLURT for the fee: the cause and the fix in plain words, the chain's
// own wording not needed (v1.21.12, the maintainer's wording).
check('low_blurt says insufficient funds and to buy BLURT', be.low_blurt === 'Broadcast rejected due to insufficient funds. Buy BLURT to save more data to the chain.');

// ── every chain-write screen with its own error handling shows the same
//    out-of-BLURT line (v1.21.12): a fee or balance refusal is classified, not
//    shown as the screen's generic "rejected" copy ──
for (const rel of [
	'apps/web/src/lib/components/SendBlurtModal.svelte',
	'apps/web/src/lib/components/PowerModal.svelte',
	'apps/web/src/lib/components/FeatureBidForm.svelte',
	'apps/web/src/lib/components/PayBlurtModal.svelte'
]) {
	const src = readFileSync(join(REPO, rel), 'utf8');
	check(
		`${rel.split('/').pop()}: a fee/balance refusal shows common.broadcast_err.low_blurt`,
		/classifyChainReason\([^)]*\) === 'low_blurt'/.test(src) && src.includes("'common.broadcast_err.low_blurt'")
	);
}
{
	const src = readFileSync(join(REPO, 'apps/web/src/routes/[lang]/post/edit/[permlink]/+page.svelte'), 'utf8');
	check(
		'post/edit: a chain refusal goes through the shared resolver (not the generic line)',
		/err instanceof ChainRejectedError\)\s*\{[^}]*broadcastErrorMessage\(/.test(src)
	);
}

// ── settings routes through the classifier (no opaque generic-only path) ──
const settings = readFileSync(join(REPO, 'apps/web/src/routes/[lang]/settings/+page.svelte'), 'utf8');
check('settings uses the shared broadcastErrorMessage resolver', /broadcastErrorMessage\(/.test(settings));

console.log(fail === 0 ? `✓ all ${pass} broadcast-error-copy checks hold` : `✗ ${fail} failed (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
