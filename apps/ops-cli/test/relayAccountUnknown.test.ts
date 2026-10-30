/**
 * A server whose relay account is not known (relayAccountFromEnv found none:
 * Config.relayAccount is ''). The menu's "relay balance low" marker and the
 * status dashboard's relay row used to look up the account '' on the chain
 * (and, before that, morphit.io's @morphit-relay). Nothing is looked up now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.fn(async () => ({ name: 'x', balance: '1.000 BLURT', balanceBlurt: 1 }));
vi.mock('../src/init/chainCheck.ts', async (orig) => ({
	...((await orig()) as object),
	lookupBlurtAccount: (...a: unknown[]) => lookup(...(a as []))
}));

const { relayBalanceStatus: menuRelayBalance } = await import('../src/lib/menuAnnotations.ts');
const { relayBalanceStatus: statusRelayBalance } = await import('../src/commands/status.ts');

beforeEach(() => {
	lookup.mockClear();
	for (const k of [
		'MORPHIT_OPS_RELAY_ACCOUNT',
		'MORPHIT_RELAY_ACCOUNT',
		'MORPHIT_INDEXER_RELAY_ACCOUNT'
	])
		vi.stubEnv(k, '');
	vi.stubEnv('MORPHIT_OPS_DATABASE_URL', 'postgres://u:p@127.0.0.1:1/x');
});
afterEach(() => vi.unstubAllEnvs());

describe('no relay account known on this server', () => {
	it('the menu marker looks nothing up and shows nothing', async () => {
		expect(await menuRelayBalance()).toBeNull();
		expect(lookup).not.toHaveBeenCalled();
	});

	it('the status row looks nothing up and says why', async () => {
		const r = await statusRelayBalance({ config: { relayAccount: '' } } as never);
		expect(lookup).not.toHaveBeenCalled();
		expect(r.balance).toBeNull();
		expect(r.note).toMatch(/relay account is not known/);
	});

	it('a known account is still looked up', async () => {
		vi.stubEnv('MORPHIT_RELAY_ACCOUNT', 'alice-relay');
		await menuRelayBalance();
		expect(lookup).toHaveBeenCalledWith('alice-relay');
	});
});
