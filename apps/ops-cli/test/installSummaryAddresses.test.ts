/**
 * The install review shows the .onion and .b32.i2p it created — and that they
 * are the addresses the node advertises (2026-10-12: "shouldn't the summary
 * show if the .onion and .b32.i2p were successfully created, and what they
 * are exactly?"). The I2P row showed no address at all, and the Tor row read
 * only Tor's own file, not the settings the node advertises from.
 */
import { describe, expect, it } from 'vitest';
import { collectInstallSummary, type SummaryProbe } from '../src/init/installSummary.ts';

const ONION = 'a'.repeat(56) + '.onion';
const I2P = 'b'.repeat(52) + '.b32.i2p';
const inputs = {
	domain: 'vigilante.trading',
	mode: 'vps' as const,
	torOnly: false,
	enableBunkerweb: true,
	repoPath: '/opt/morphit',
	relayAccount: 'vigil-relay'
};

function probe(config: string): SummaryProbe {
	return {
		serviceActive: () => true,
		failedUnits: () => [],
		containerRunning: () => true,
		firewallActive: () => true,
		pathExists: () => true,
		readText: (p) =>
			p.endsWith('/hostname') ? ONION : p.endsWith('/morphit.config.env') ? config : null,
		indexerHealth: async () => ({ reachable: true, synced: true, rpcOk: true, fxOk: true }),
		relayReachable: async () => true,
		relayBalanceBlurt: async () => 3000,
		systemHealth: () => ({ ok: true })
	};
}
const row = (rows: { label: string }[], re: RegExp) =>
	rows.find((r) => re.test(r.label)) as never as {
		ok: boolean | null;
		value?: string;
		detail?: string;
	};

describe('the review lists the hidden addresses', () => {
	it('shows both addresses when they are created and advertised', async () => {
		const rows = await collectInstallSummary(
			inputs,
			probe(`MORPHIT_INSTANCE_TOR_ADDRESS=${ONION}\nMORPHIT_INSTANCE_I2P_B32_ADDRESS=${I2P}\n`)
		);
		expect(row(rows, /Tor onion/)).toMatchObject({ ok: true, value: ONION });
		expect(row(rows, /I2P address/)).toMatchObject({ ok: true, value: I2P });
	});

	it('an address Tor made but the settings do not advertise is not ✓', async () => {
		const rows = await collectInstallSummary(inputs, probe(''));
		expect(row(rows, /Tor onion/).ok).toBe(false);
		expect(row(rows, /Tor onion/).value).toBe(ONION);
		expect(row(rows, /I2P address/).ok).toBe(false);
	});
});
