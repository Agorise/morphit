/**
 * The wizard announces "Step N of T" up front; T must equal the steps it then
 * shows (a later change added the backup-encryption step).
 * Counts the step() calls collectInstallInputs makes and compares them with
 * the core-question share of installStepTotal().
 */
import { describe, it, expect, vi } from 'vitest';

let shown = 0;
vi.mock('../src/init/prompt.ts', async (orig) => ({
	...((await orig()) as object),
	step: () => void shown++
}));

const { collectInstallInputs } = await import('../src/init/collectInstallInputs.ts');
const { installStepTotal } = await import('../src/init/runAnsibleInstall.ts');

async function coreSteps(torOnly: boolean): Promise<number> {
	shown = 0;
	await collectInstallInputs(
		{
			mode: 'vps',
			torOnly,
			operatorAccount: 'opacct',
			operatorTag: 'optag',
			feesAccount: 'feesacct',
			keystorePath: '/etc/morphit/relay.keystore'
		},
		{
			ask: (async (q: string, def?: string) => {
				if (/Instance title/.test(q)) return 'Morphit Test';
				if (/web address/.test(q)) return 'trade.example.org';
				if (/email/i.test(q)) return 'me@example.org';
				return def ?? '';
			}) as never,
			askChoice: (async () => 0) as never,
			askSecret: (async () => '') as never,
			examples: () => {},
			print: () => {},
			dnsCheck: async () => ({ ok: true, note: '' })
		} as never
	);
	return shown;
}

describe('the announced step total', () => {
	// 3 account steps before and 3 after the core questions on a VPS.
	it('clearnet VPS', async () => {
		expect(installStepTotal('vps', false)).toBe(3 + (await coreSteps(false)) + 3);
	});
	it('tor-only VPS', async () => {
		expect(installStepTotal('vps', true)).toBe(3 + (await coreSteps(true)) + 3);
	});
});
