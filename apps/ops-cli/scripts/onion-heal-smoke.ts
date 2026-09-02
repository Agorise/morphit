#!/usr/bin/env tsx
/**
 * onion-heal-smoke.ts — the Tor-onion self-heal (v1.15.3). On some boxes the
 * onion is generated after the install-time config write, leaving
 * MORPHIT_INSTANCE_TOR_ADDRESS empty so the node advertises `tor: null` and is
 * unreachable over Tor (fatal for a censored node). The upgrade re-captures it.
 * PURE core (applyOnionHeal) — no disk.
 */
import { applyOnionHeal } from '../src/commands/upgrade.ts';

let pass = 0; const fails: string[] = [];
const check = (d: string, ok: boolean): void => { if (ok) { pass++; console.log('  ✓ ' + d); } else { fails.push(d); console.log('  ✗ ' + d); } };
const ONION = 'ohsafgjpd4dbs3nknds24ap6yocbzirqjlsvjuajh6ry7krbwy6jnsyd.onion';

console.log('\n── onion-heal smoke ──────────────────────────────────\n');
{
	const r = applyOnionHeal('MORPHIT_DOMAIN=x\nMORPHIT_INSTANCE_TOR_ADDRESS=\n', ONION);
	check('an empty MORPHIT_INSTANCE_TOR_ADDRESS is populated with the onion', r.changed && r.text.includes('MORPHIT_INSTANCE_TOR_ADDRESS=' + ONION));
}
{
	const r = applyOnionHeal('MORPHIT_INSTANCE_TOR_ADDRESS=existing.onion\n', ONION);
	check('an already-set onion is NEVER clobbered', !r.changed && r.text.includes('existing.onion'));
}
{
	const r = applyOnionHeal('MORPHIT_DOMAIN=x\nPUBLIC_ORIGIN=https://x\n', ONION);
	check('a missing key is appended', r.changed && /\nMORPHIT_INSTANCE_TOR_ADDRESS=/.test(r.text) && r.text.includes(ONION));
}
check('a non-.onion value is refused (no garbage written)', !applyOnionHeal('MORPHIT_INSTANCE_TOR_ADDRESS=\n', 'not-an-onion').changed);
check('an empty onion string is refused', !applyOnionHeal('MORPHIT_INSTANCE_TOR_ADDRESS=\n', '').changed);
{
	// other config lines are preserved
	const r = applyOnionHeal('A=1\nMORPHIT_INSTANCE_TOR_ADDRESS=\nB=2\n', ONION);
	check('surrounding config lines are preserved', r.text.includes('A=1') && r.text.includes('B=2'));
}

const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) { console.log(`✗ ${fails.length} of ${total} onion-heal checks FAILED`); process.exit(1); }
console.log(`✓ all ${total} onion-heal scenarios passed`);
