/**
 * treasury-mismatch-probe-smoke (cp316)
 *
 * Guards the federation treasury-address Mismatch detection: a peer
 * instance that advertises a fee address DIFFERENT from the canonical
 * (chain-pinned) treasury — i.e. an operator trying to redirect fee
 * payments to their own pocket — must be flagged 'mismatch' on the
 * /instances directory.
 *
 *   LOGIC (treasuryMismatchReason — pure, the heart of the check):
 *     1. matching addresses → no mismatch
 *     2. peer advertises a DIFFERENT btc → mismatch (btc reason)
 *     3. peer advertises a DIFFERENT xmr → mismatch (xmr reason)
 *     4. peer OMITS treasury (older release) → no mismatch (back-compat)
 *     5. peer advertises null (method disabled) → no mismatch (a
 *        legitimate operator choice, NOT a redirection)
 *     6. no local canonical reference → no mismatch (skip)
 *     7. per-chain null canonical → that chain skipped; other compared
 *
 *   WIRING (static drift guards):
 *     8. probeOne calls treasuryMismatchReason and returns mkMismatch
 *     9. /v1/instance exposes the resolved `treasury` block
 *    10. poller exposes currentTreasuryAddresses + feeds the scheduler
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treasuryMismatchReason } from '../src/indexer/federationProbe.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

let failures = 0;
let scenarios = 0;
const ok = (m: string) => {
	console.log(`  ✓ ${m}`);
	scenarios++;
};
const bad = (m: string, d: string) => {
	console.error(`  ✗ ${m}\n      ${d}`);
	failures++;
	scenarios++;
};

const BTC = 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk';
const XMR = '84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
const EVIL_BTC = 'bc1qevilevilevilevilevilevilevilevilxxxxxx';
const EVIL_XMR = '8EVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVILEVI';
const canon = { btc: BTC, xmr: XMR };

const expectNull = (label: string, r: string | null) =>
	r === null ? ok(`${label} → no mismatch`) : bad(`${label} should NOT mismatch`, `got: ${r}`);
const expectMismatch = (label: string, r: string | null, needle: string) =>
	r !== null && r.includes(needle)
		? ok(`${label} → mismatch (${needle})`)
		: bad(`${label} should mismatch on ${needle}`, `got: ${r}`);

// 1
expectNull('matching addresses', treasuryMismatchReason(canon, { btc: BTC, xmr: XMR }));
// 2
expectMismatch('peer redirects btc', treasuryMismatchReason(canon, { btc: EVIL_BTC, xmr: XMR }), 'treasury_btc_address');
// 3
expectMismatch('peer redirects xmr', treasuryMismatchReason(canon, { btc: BTC, xmr: EVIL_XMR }), 'treasury_xmr_address');
// 4
expectNull('peer omits treasury (older release)', treasuryMismatchReason(canon, undefined));
// 5
expectNull('peer disables btc (null)', treasuryMismatchReason(canon, { btc: null, xmr: XMR }));
expectNull('peer disables both (null)', treasuryMismatchReason(canon, { btc: null, xmr: null }));
// 6
expectNull('no local canonical reference', treasuryMismatchReason(null, { btc: EVIL_BTC, xmr: EVIL_XMR }));
// 7
expectNull(
	'local btc disabled → btc skipped, xmr matches',
	treasuryMismatchReason({ btc: null, xmr: XMR }, { btc: EVIL_BTC, xmr: XMR })
);
expectMismatch(
	'local btc disabled → xmr still compared',
	treasuryMismatchReason({ btc: null, xmr: XMR }, { btc: BTC, xmr: EVIL_XMR }),
	'treasury_xmr_address'
);

// 8 — probeOne wiring
const probeSrc = readFileSync(join(REPO, 'apps/indexer/src/indexer/federationProbe.ts'), 'utf-8');
if (probeSrc.includes('treasuryMismatchReason(canonicalTreasury, instanceData.treasury)') && probeSrc.includes('return mkMismatch(treasuryReason)'))
	ok('probeOne calls treasuryMismatchReason and returns mkMismatch on divergence');
else bad('probeOne no longer wires the treasury mismatch check', 'redirection would go unflagged');
// cp768 — probePool now WITHHOLDS the treasury opinion (passes null) until our
// own indexer is synced, so a mid-sync incomplete baseline can't false-flag a
// legit peer as fee-redirection. The relay-account/shape checks are unaffected.
if (probeSrc.includes('probeOne(inst, treasuryForProbe)'))
	ok('cp768: probePool threads treasuryForProbe (gated) into probeOne');
else bad('probePool no longer passes the gated treasury to probeOne', 'either regressed the gate or dropped the check');
if (
	/const selfSynced = selfReachableStatus\(this\.config\.localLagBlocks\?\.\(\) \?\? null\) === 'good'/.test(probeSrc) &&
	/const treasuryForProbe = selfSynced \? \(this\.config\.canonicalTreasury\?\.\(\) \?\? null\) : null/.test(probeSrc)
)
	ok('cp768: treasury opinion is withheld (null) while the local indexer is not synced');
else bad('cp768 gate missing', 'a still-syncing node could false-flag a peer as mismatch');
// The pure mechanism the gate relies on: a null canonical → NO mismatch even
// against an evil peer (already covered above, re-assert intent here).
expectNull('cp768: withheld (null) treasury never flags, even vs a redirecting peer', treasuryMismatchReason(null, { btc: EVIL_BTC, xmr: EVIL_XMR }));

// 9 — /v1/instance exposure
const instSrc = readFileSync(join(REPO, 'apps/indexer/src/api/instance.ts'), 'utf-8');
if (instSrc.includes('treasury: getTreasuryAddresses()') && /treasury:\s*\{\s*btc:/.test(instSrc))
	ok('/v1/instance exposes the resolved treasury block');
else bad('/v1/instance no longer exposes treasury', 'peers cannot audit the address → no mismatch detection');

// 10 — poller wiring
const pollerSrc = readFileSync(join(REPO, 'apps/indexer/src/indexer/poller.ts'), 'utf-8');
if (pollerSrc.includes('currentTreasuryAddresses()') && pollerSrc.includes('canonicalTreasury: () => this.currentTreasuryAddresses()'))
	ok('poller exposes currentTreasuryAddresses + feeds it to the probe scheduler');
else bad('poller no longer feeds the resolved treasury to the probe', 'canonical reference lost');
const mainSrc = readFileSync(join(REPO, 'apps/indexer/src/main.ts'), 'utf-8');
if (mainSrc.includes('instanceRoute(config, () => poller.currentTreasuryAddresses())'))
	ok('main.ts wires the resolved treasury getter into /v1/instance');
else bad('main.ts no longer wires the treasury getter', '/v1/instance treasury would be null');

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
