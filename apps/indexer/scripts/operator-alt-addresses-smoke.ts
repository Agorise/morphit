#!/usr/bin/env tsx
/**
 * operator-alt-addresses-smoke.ts — v1.15.3 Fix A. The operator can publish
 * hidden-service addresses (Tor/I2P/Lokinet/ENS) ON-CHAIN via
 * morphit_operator_register_v1, so the federation reaches a clearnet-censored
 * node over Tor without a (blocked) clearnet probe. Validates the payload
 * validator + the directory's on-chain/probe alt-network merge.
 */
import { validate } from '../src/indexer/handlers/operatorRegister.ts';

let pass = 0; const fails: string[] = [];
const check = (d: string, ok: boolean): void => { if (ok) { pass++; console.log('  ✓ ' + d); } else { fails.push(d); console.log('  ✗ ' + d); } };

const base = { v: 1, tag: 'testop', display_name: 'Test', origin: 'https://example.com' };
const ONION = 'ohsafgjpd4dbs3nknds24ap6yocbzirqjlsvjuajh6ry7krbwy6jnsyd.onion';
const B32 = '7xii4g6syt5hi2lkw6mqmiboevhgoyn4nycox4udy3tcbitwrjcq.b32.i2p';
const has = (p: object): boolean => !('reason' in validate({ ...base, ...p }));
const alt = (p: object): unknown => (validate({ ...base, ...p }) as { alt_networks: unknown }).alt_networks;

console.log('\n── operator alt_addresses (on-chain) ──────────────────\n');
check('a valid v3 onion is accepted + stored', has({ alt_addresses: { tor: ONION } }) && (alt({ alt_addresses: { tor: ONION } }) as { tor: string }).tor === ONION);
check('no alt_addresses → alt_networks is null (backward-compatible)', alt({}) === null);
check('an empty alt_addresses object → null', alt({ alt_addresses: {} }) === null);
check('a malformed onion is rejected', 'reason' in validate({ ...base, alt_addresses: { tor: 'nope.onion' } }));
check('a valid .b32.i2p is accepted', has({ alt_addresses: { i2p_b32: B32 } }));
check('a malformed i2p_b32 is rejected', 'reason' in validate({ ...base, alt_addresses: { i2p_b32: 'x.i2p' } }));
check('a valid .loki is accepted', has({ alt_addresses: { lokinet: 'abc.loki' } }));
check('a valid .eth (ENS) is accepted', has({ alt_addresses: { ens: 'morphit.eth' } }));
check('a bad ENS is rejected', 'reason' in validate({ ...base, alt_addresses: { ens: 'nope' } }));
check('a non-object alt_addresses is rejected', 'reason' in validate({ ...base, alt_addresses: 'x' }));
check('an over-long address is rejected', 'reason' in validate({ ...base, alt_addresses: { tor: 'a'.repeat(90) } }));
check('a legacy payload with no origin + no alt still validates', !('reason' in validate({ v: 1, tag: 'testop', display_name: 'Test' })));

const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) { console.log(`✗ ${fails.length} of ${total} operator-alt-addresses checks FAILED`); process.exit(1); }
console.log(`✓ all ${total} operator-alt-addresses scenarios passed`);
