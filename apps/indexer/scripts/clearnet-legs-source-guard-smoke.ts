/**
 * clearnet-legs-source-guard-smoke (v1.16.x delta audit — v16-1 + H-1)
 *
 * The `clearnet_eliminated` legs `upgradeHidden` and `priceFederated` are
 * "true by construction" — correct only because code ELSEWHERE fail-closes.
 * And the transport legs must validate the operator's advertised hidden address
 * (audit finding v16-1), not merely check that a string is non-empty. None of
 * those guarantees is expressible in the pure combiner test (clearnet-gate-smoke),
 * so this smoke pins them at the source so a future edit can't silently
 * reintroduce a clearnet path while the leg still reports true.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hiddenHostNetworkOf } from '@morphit/hidden-transport';

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean): void => {
	if (cond) pass++;
	else {
		fail++;
		console.log(`  ✗ ${name}`);
	}
};

// ── v16-1: hiddenHostNetworkOf validates bare addresses (the transport-leg gate)
const onion = 'a'.repeat(56) + '.onion';
check('valid v3 onion → tor', hiddenHostNetworkOf(onion) === 'tor');
check('uppercase onion normalised → tor', hiddenHostNetworkOf(onion.toUpperCase()) === 'tor');
check('short/garbage onion → null', hiddenHostNetworkOf('abc.onion') === null);
check('non-hidden host → null', hiddenHostNetworkOf('evil.com') === null);
check('empty → null', hiddenHostNetworkOf('') === null);
check('b32 i2p → i2p', hiddenHostNetworkOf('x'.repeat(52) + '.b32.i2p') === 'i2p');
check('named i2p → i2p', hiddenHostNetworkOf('morphit.i2p') === 'i2p');
check('loki → loki', hiddenHostNetworkOf('abc.loki') === 'loki');

// ── v16-1: instance.ts derives the transport legs through the validator, not Boolean()
const instance = read('apps/indexer/src/api/instance.ts');
check('instance imports hiddenHostNetworkOf', /hiddenHostNetworkOf/.test(instance) && /@morphit\/hidden-transport/.test(instance));
check(
	'transportTor validated via hiddenHostNetworkOf',
	/transportTor:\s*hiddenHostNetworkOf\([^)]*\)\s*===\s*'tor'/.test(instance)
);
check('transportI2p validated via hiddenHostNetworkOf', /transportI2p:[\s\S]{0,160}hiddenHostNetworkOf/.test(instance));
check('old unvalidated Boolean() derivation is gone', !/transportTor:\s*Boolean\(/.test(instance));

// ── H-1a: the hidden-only upgrade path fail-closes rather than touch a clearnet mirror
const upgrade = read('apps/ops-cli/src/commands/upgrade.ts');
check('upgrade fail-closes (never falls back to a clearnet mirror)', /never fall back to a clearnet mirror/.test(upgrade));
check('upgrade returns fail-closed after the hidden-resolve catch', /return 5;/.test(upgrade));

// ── H-1b: the price factory drops ALL clearnet upstreams on a hidden-only node
const factory = read('apps/indexer/src/indexer/price/factory.ts');
check('factory has a hidden-only branch', /config\.blurtRpcEndpoints\.length === 0/.test(factory));
check('factory drops clearnet upstreams on hidden-only (upstreams: [])', /upstreams:\s*\[\]/.test(factory));

console.log(
	fail === 0
		? `✓ all ${pass} clearnet-legs-source-guard checks hold`
		: `✗ ${fail} failed (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
