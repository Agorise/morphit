#!/usr/bin/env tsx
/**
 * apps/matrix-bot/scripts/dm-room-persistence-smoke.ts
 *
 * The operator's Matrix inbox filled up with a separate "Morphit alerts" room per
 * bot restart, and most messages in them read "Unable to decrypt message".
 *
 * ONE bug, two symptoms. The DM room id lived in an in-memory Map, so every
 * restart (one per upgrade — four in two days) started blank and
 * `dms.getOrCreateDm` created a fresh room instead of finding the old one. Each
 * new room then needed its own Megolm session shared to devices the bot had never
 * verified, so the alerts inside were undecryptable.
 *
 * Guards, in order of how badly each failure hurt:
 *   1. the room id is PERSISTED, so restarts reuse one room
 *   2. E2EE is opt-in, because an alert you cannot read is worth nothing
 *   3. crypto recovery wipes ONLY the crypto store — not the sync token and not
 *      the room map, which would re-spawn rooms while "fixing" encryption
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..', '..', '..');
const read = (rel: string): string => {
	const p = join(repo, rel);
	return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

let pass = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

const matrix = read('apps/matrix-bot/src/matrix.ts');
const main = read('apps/matrix-bot/src/main.ts');

ok('matrix.ts is present', matrix.length > 0);

// ── 1. Room id survives a restart ────────────────────────────────────
ok('the DM room map is written to disk', /dm-rooms\.json/.test(matrix) && /writeFileSync/.test(matrix));
ok('…and read back on startup', /loadRoomMap\(\)/.test(matrix) && /readFileSync/.test(matrix));
ok(
	'the in-memory cache is SEEDED from the file (an empty map on boot is what created a new room each restart)',
	/for \(const \[k, v\] of Object\.entries\(loadRoomMap\(\)\)\)/.test(matrix)
);
ok(
	'a stored room is re-validated before use, so alerts never go to a room the operator left',
	/getRoomStateEvent\(cached/.test(matrix)
);
ok(
	'persistence failure is non-fatal (a bot that cannot write its map still sends alerts)',
	/still works; it just re-resolves next start/.test(matrix)
);

// ── 2. Encryption is a choice, not an accident ───────────────────────
ok('E2EE is opt-in via MORPHIT_MATRIX_ENCRYPT', /MORPHIT_MATRIX_ENCRYPT/.test(matrix));
ok(
	'…and defaults to OFF (undecryptable alerts are worse than unencrypted ones)',
	/=== '1'/.test(matrix)
);
ok(
	'the crypto store is only created when encryption is actually wanted',
	/if \(wantEncryption\) \{[\s\S]{0,400}RustSdkCryptoStorageProvider/.test(matrix)
);
ok(
	'the plaintext path builds a client with no crypto provider',
	/new MatrixClient\(homeserver, accessToken, storage\)/.test(matrix)
);
ok(
	'the trade-off is documented for whoever turns it back on',
	/verified the bot's device/.test(matrix)
);

// ── 3. Crypto recovery must not take the room map with it ────────────
ok(
	'crypto recovery deletes ONLY the crypto store, not the whole storage dir',
	/rmSync\(join\(cryptoStorePath, 'crypto'\)/.test(main) &&
		!/rmSync\(cryptoStorePath,/.test(main)
);

console.log('');
if (fails.length > 0) {
	console.error(`✗ ${fails.length} dm-room-persistence scenario(s) failed:`);
	for (const f of fails) console.error(`   - ${f}`);
	process.exit(1);
}
console.log(`✓ all ${pass} dm-room-persistence scenarios passed`);
