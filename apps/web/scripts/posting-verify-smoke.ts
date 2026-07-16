#!/usr/bin/env tsx
/**
 * Smoke for the posting-key verification helper (Batch H).
 *
 * verifyPostingKey is the safety net on the posting-only import
 * path: given a Blurt account fetched from chain and the public
 * key derived from a pasted WIF, it classifies which authority
 * slot (if any) the key belongs to.  The UI uses the verdict to
 * decide whether to accept the import or surface a screaming
 * error ("you pasted your active key, not your posting key").
 *
 * Pure logic; no chain I/O.  These scenarios exercise:
 *   - happy path (key in posting.key_auths)
 *   - wrong-role detection for active / owner / memo
 *   - not-found path (typo in account name)
 *   - posting wins ties when a key is in multiple slots
 *   - zero-weight keys are treated as absent (defense in depth)
 *   - multisig-style authorities (multiple keys, our user owns one)
 */

import { verifyPostingKey } from '../src/lib/crypto/postingVerify.ts';
import type { BlurtAccount } from '../src/lib/blurt/client.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
		console.log(`     ${msg.split('\n').slice(0, 3).join('\n     ')}`);
	}
}

const POSTING_KEY = 'BLT5jBnTuJ1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ACTIVE_KEY = 'BLT5jBnTuJ1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OWNER_KEY = 'BLT5jBnTuJ1cccccccccccccccccccccccccccccccccccccccc';
const MEMO_KEY = 'BLT5jBnTuJ1dddddddddddddddddddddddddddddddddddddddd';
const STRANGER_KEY = 'BLT5jBnTuJ1eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const COSIGNER_KEY = 'BLT5jBnTuJ1ffffffffffffffffffffffffffffffffffffffff';

/** Build a minimal BlurtAccount with the given key in each authority slot. */
function makeAccount(opts: {
	posting?: Array<[string, number]>;
	active?: Array<[string, number]>;
	owner?: Array<[string, number]>;
	memo_key?: string;
}): BlurtAccount {
	return {
		id: 1,
		name: 'alice',
		owner: {
			weight_threshold: 1,
			account_auths: [],
			key_auths: opts.owner ?? [[OWNER_KEY, 1]]
		},
		active: {
			weight_threshold: 1,
			account_auths: [],
			key_auths: opts.active ?? [[ACTIVE_KEY, 1]]
		},
		posting: {
			weight_threshold: 1,
			account_auths: [],
			key_auths: opts.posting ?? [[POSTING_KEY, 1]]
		},
		memo_key: opts.memo_key ?? MEMO_KEY,
		json_metadata: '',
		posting_json_metadata: '',
		created: '2020-01-01T00:00:00',
		last_account_update: '2020-01-01T00:00:00',
		reputation: 0
	};
}

console.log('— posting-key verification —');

// ─── happy path ──────────────────────────────────────────────
scenario('accepts a key that appears in posting.key_auths', () => {
	const v = verifyPostingKey(makeAccount({}), POSTING_KEY);
	if (v.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(v)}`);
});

scenario('accepts a key on a multisig posting (one of N)', () => {
	const account = makeAccount({
		posting: [
			[COSIGNER_KEY, 1],
			[POSTING_KEY, 1]
		]
	});
	const v = verifyPostingKey(account, POSTING_KEY);
	if (v.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(v)}`);
});

// ─── wrong-role detection ────────────────────────────────────
scenario('rejects a key that is in active.key_auths', () => {
	const v = verifyPostingKey(makeAccount({}), ACTIVE_KEY);
	if (v.kind !== 'wrong-role' || v.foundIn !== 'active') {
		throw new Error(`expected wrong-role/active, got ${JSON.stringify(v)}`);
	}
});

scenario('rejects a key that is in owner.key_auths', () => {
	const v = verifyPostingKey(makeAccount({}), OWNER_KEY);
	if (v.kind !== 'wrong-role' || v.foundIn !== 'owner') {
		throw new Error(`expected wrong-role/owner, got ${JSON.stringify(v)}`);
	}
});

scenario('rejects a key that matches memo_key', () => {
	const v = verifyPostingKey(makeAccount({}), MEMO_KEY);
	if (v.kind !== 'wrong-role' || v.foundIn !== 'memo') {
		throw new Error(`expected wrong-role/memo, got ${JSON.stringify(v)}`);
	}
});

// ─── not-found ───────────────────────────────────────────────
scenario('returns not-found for a key on no slot', () => {
	const v = verifyPostingKey(makeAccount({}), STRANGER_KEY);
	if (v.kind !== 'not-found') throw new Error(`expected not-found, got ${JSON.stringify(v)}`);
});

// ─── tie-breaking (audit 2026-05 finding 1-9) ────────────────
// Pre-fix, posting won ties — but a hostile RPC could craft a
// posting.key_auths that contains the user's owner pubkey, and a
// user pasting their owner key would import it as posting.  Now
// privileged authorities win ties: any cross-role appearance is
// rejected as wrong-role.
scenario('1-9: privileged active wins tie even if key also in posting', () => {
	const account = makeAccount({
		posting: [[POSTING_KEY, 1]],
		active: [[POSTING_KEY, 1]]
	});
	const v = verifyPostingKey(account, POSTING_KEY);
	if (v.kind !== 'wrong-role' || v.foundIn !== 'active') {
		throw new Error(`expected wrong-role/active, got ${JSON.stringify(v)}`);
	}
});

scenario('1-9: privileged owner wins tie even if key also in posting', () => {
	const account = makeAccount({
		posting: [[POSTING_KEY, 1]],
		owner: [[POSTING_KEY, 1]]
	});
	const v = verifyPostingKey(account, POSTING_KEY);
	if (v.kind !== 'wrong-role' || v.foundIn !== 'owner') {
		throw new Error(`expected wrong-role/owner, got ${JSON.stringify(v)}`);
	}
});

// ─── zero-weight defense ─────────────────────────────────────
scenario('treats a zero-weight posting key as absent', () => {
	const account = makeAccount({
		posting: [[POSTING_KEY, 0]],
		active: [[ACTIVE_KEY, 1]]
	});
	const v = verifyPostingKey(account, POSTING_KEY);
	// Not in posting (zero weight), not in active/owner/memo, → not-found.
	if (v.kind !== 'not-found') throw new Error(`expected not-found, got ${JSON.stringify(v)}`);
});

scenario('zero-weight active does not trigger wrong-role', () => {
	// Posting must be empty here so the only place POSTING_KEY appears
	// is in active with weight 0 — that should still be not-found.
	const account = makeAccount({
		posting: [],
		active: [[POSTING_KEY, 0]]
	});
	const v = verifyPostingKey(account, POSTING_KEY);
	if (v.kind !== 'not-found') throw new Error(`expected not-found, got ${JSON.stringify(v)}`);
});

// ─── posting-vs-memo precedence (audit 2026-05 finding 1-9) ─
scenario('1-9: memo wins tie when key also matches memo_key', () => {
	const account = makeAccount({
		posting: [[POSTING_KEY, 1]],
		memo_key: POSTING_KEY
	});
	const v = verifyPostingKey(account, POSTING_KEY);
	if (v.kind !== 'wrong-role' || v.foundIn !== 'memo') {
		throw new Error(`expected wrong-role/memo, got ${JSON.stringify(v)}`);
	}
});

// ─── case sensitivity ────────────────────────────────────────
scenario('verification is case-sensitive (BLT keys are case-sensitive base58)', () => {
	const account = makeAccount({});
	const lowercased = POSTING_KEY.toLowerCase();
	const v = verifyPostingKey(account, lowercased);
	// lowercased version is not equal to the chain-stored canonical
	// form, so it should NOT match.
	if (v.kind !== 'not-found') {
		throw new Error(`case mismatch must be not-found, got ${JSON.stringify(v)}`);
	}
});

// ─── empty authority handled ─────────────────────────────────
scenario('handles an account with empty posting.key_auths gracefully', () => {
	const account = makeAccount({ posting: [] });
	const v = verifyPostingKey(account, POSTING_KEY);
	// Posting has no keys; key isn't elsewhere either; expect not-found.
	if (v.kind !== 'not-found') throw new Error(`expected not-found, got ${JSON.stringify(v)}`);
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
