/**
 * Which I2P address does i2pd on this server serve for Morphit? Read from its
 * console's tunnel page, from MORPHIT'S OWN tunnel only — a router can host
 * other destinations, and the first .b32.i2p on the page may be a stranger's
 * (a check that cries wolf is worse than none). Not readable: "cannot tell",
 * never a mismatch.
 */
import { describe, expect, it } from 'vitest';
import { hostedHere, morphitTunnelB32, reportHosting } from '../src/lib/altAddressHosted.ts';

const OURS = 'q'.repeat(52);
const OTHER = 'z'.repeat(52);
const PAGE =
	'<div class="listitem"><a href="/?page=local_destination&b32=' +
	OTHER +
	'">other-site</a></div>' +
	'<div class="listitem"><a href="/?page=local_destination&b32=' +
	OURS +
	'">morphit-web</a></div>';

describe('i2pd: which address Morphit’s tunnel serves', () => {
	it('takes the morphit tunnel, not the first one on the page', () => {
		expect(morphitTunnelB32(PAGE)).toBe(`${OURS}.b32.i2p`);
	});

	it('no morphit tunnel on the page: cannot tell', () => {
		expect(morphitTunnelB32(PAGE.replace('morphit-web', 'web'))).toBeNull();
	});

	it('hosted / another / cannot tell', async () => {
		const page = { i2pTunnelB32: async () => `${OURS}.b32.i2p` };
		expect(await hostedHere('i2p', `${OURS}.b32.i2p`, page)).toEqual({ status: 'hosted' });
		expect(await hostedHere('i2p', `${OTHER}.b32.i2p`, page)).toEqual({
			status: 'other',
			served: [`${OURS}.b32.i2p`]
		});
		expect(await hostedHere('i2p', `${OURS}.b32.i2p`, { i2pTunnelB32: async () => null })).toEqual({
			status: 'unknown'
		});
	});

	it('cannot tell is said as such, without a warning', async () => {
		const lines: string[] = [];
		await reportHosting('i2p', `${OURS}.b32.i2p`, {
			print: (l) => lines.push(l),
			deps: { i2pTunnelB32: async () => null }
		});
		expect(lines.join('\n')).toMatch(/Could not read i2pd's tunnel page/);
		expect(lines.join('\n')).not.toMatch(/^\s*!/m);
	});
});
