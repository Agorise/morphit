/**
 * v1.21.15 — the wizard's fee-explorer explanation counts the default lists
 * right (it said "four onion" after a fifth was added, and named no I2P one).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DEFAULT_BTC_I2P_EXPLORERS,
	DEFAULT_BTC_ONION_EXPLORERS,
	DEFAULT_XMR_I2P_EXPLORERS,
	DEFAULT_XMR_ONION_EXPLORERS
} from '@morphit/operator-config/fee-sources';

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const steps = readFileSync(join(import.meta.dirname, '..', 'src', 'init', 'steps.ts'), 'utf8');
// The explanation, as the operator reads it: its string pieces joined, from
// the BTC line to the end of the XMR one.
const from = steps.indexOf("'  • BTC:");
const to = steps.indexOf('(also checked by your indexer itself: node+https', from);
const text = [...steps.slice(from, to).matchAll(/'((?:[^'\\]|\\.)*)'/g)]
	.map((m) => m[1])
	.join('')
	.replace(/\\n\s*/g, ' ');

describe('the wizard names the default fee explorers right', () => {
	it('BTC: the onion count, and the I2P one', () => {
		expect(text).toContain(
			`• BTC: ${WORDS[DEFAULT_BTC_ONION_EXPLORERS.length]} onion Esplora explorers`
		);
		expect(DEFAULT_BTC_I2P_EXPLORERS.length).toBe(1);
		expect(text).toMatch(/Foundation\) and runbtc on I2P/);
	});
	it('XMR: the onion count, and the I2P one', () => {
		expect(text).toContain(
			`• XMR: ${WORDS[DEFAULT_XMR_ONION_EXPLORERS.length]} onion xmrblocks explorers`
		);
		expect(DEFAULT_XMR_I2P_EXPLORERS.length).toBe(1);
		expect(text).toMatch(/suddenwhipvapor\) and xmr\.mx on I2P/);
	});
});
