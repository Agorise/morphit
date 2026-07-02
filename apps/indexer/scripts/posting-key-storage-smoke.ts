#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/posting-key-storage-smoke.ts (cp404, option A)
 *
 * Covers the DISPLAY-ONLY posting-key storage: the pure key extractor,
 * plus source-level assertions that the whole path is wired (schema
 * column, ingest capture, startup backfill, orderbook exposure, and the
 * "verification never trusts this column" invariant). The DB/chain parts
 * of the backfill can't run in the sandbox, so those are asserted at the
 * source level instead of executed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { primaryPostingKey } from '../src/indexer/postingKeyBackfill';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../src');
const read = (p: string) => readFileSync(resolve(SRC, p), 'utf8');

let total = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
	total++;
	if (cond) {
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
		if (detail) console.log(`      ${detail}`);
	}
};

// ─── primaryPostingKey extractor ──────────────────────────────────
check(
	'1 extracts the first posting key from a well-formed authority',
	primaryPostingKey({
		posting: { key_auths: [['BLT5vwvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv7Bjw', 1]] }
	}) === 'BLT5vwvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv7Bjw'
);
check(
	'2 with multiple key_auths, takes the first',
	primaryPostingKey({
		posting: {
			key_auths: [
				['BLTfirst', 1],
				['BLTsecond', 1]
			]
		}
	}) === 'BLTfirst'
);
check('3 absent posting → null', primaryPostingKey({}) === null);
check(
	'4 empty key_auths → null',
	primaryPostingKey({ posting: { key_auths: [] } }) === null
);
check(
	'5 malformed key_auths entry → null',
	// @ts-expect-error deliberately malformed shape
	primaryPostingKey({ posting: { key_auths: [[123, 1]] } }) === null
);

// ─── Source wiring assertions ─────────────────────────────────────
const schema = read('db/schema.sql');
check(
	'6 schema declares accounts.posting_pubkey (v36)',
	/v36/.test(schema) && /ADD COLUMN IF NOT EXISTS posting_pubkey TEXT/.test(schema)
);

const dispatcher = read('indexer/dispatcher.ts');
check(
	'7 account-create ingest captures postingPubkey from the op',
	/postingPubkey/.test(dispatcher) && /key_auths/.test(dispatcher)
);
check(
	'8 INSERT stores posting_pubkey and fills NULLs on conflict (COALESCE)',
	/INSERT INTO accounts[\s\S]*posting_pubkey/.test(dispatcher) &&
		/COALESCE\(accounts\.posting_pubkey, EXCLUDED\.posting_pubkey\)/.test(dispatcher)
);

const backfill = read('indexer/postingKeyBackfill.ts');
check(
	'9 backfill ensures the column exists (idempotent) before filling',
	/ADD COLUMN IF NOT EXISTS posting_pubkey TEXT/.test(backfill) &&
		/WHERE posting_pubkey IS NULL/.test(backfill) &&
		/getAccounts\(/.test(backfill)
);

const main = read('main.ts');
check(
	'10 startup fires the backfill in the background',
	/backfillPostingKeys\(db, blurt\)/.test(main)
);

const orderbook = read('api/orderbook.ts');
const stream = read('api/orderbookStream.ts');
check(
	'11 orderbook REST + stream both SELECT a.posting_pubkey',
	/a\.posting_pubkey/.test(orderbook) && /a\.posting_pubkey/.test(stream)
);

// The key invariant: verification must NOT read this display column.
const verify = read('blurt/verify.ts');
check(
	'12 signature verification never reads posting_pubkey (display-only)',
	!/posting_pubkey/.test(verify),
	'verify.ts must resolve keys from the chain authority, not the stored column'
);

console.log('');
if (failed > 0) {
	console.log(`\u2717 ${failed}/${total} posting-key-storage scenarios failed`);
	process.exit(1);
}
console.log(`\u2713 all ${total} posting-key-storage scenarios passed`);
