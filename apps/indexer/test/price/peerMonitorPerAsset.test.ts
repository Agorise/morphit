/**
 * main.ts runs one peer-price monitor per asset. Their sustained-
 * disagreement clocks must be separate: with one shared record, BTC agreeing
 * with its peers reset BLURT's clock every cycle, and a BLURT price sitting
 * 100 % off the peer median never raised the alert.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
	runPeerPriceSampleCycle,
	_resetPeerPriceMonitorState,
	PEER_DISAGREEMENT_SUSTAINED_HOURS
} from '../../src/indexer/price/peerPriceMonitor';

const db = (peerPrice: number) =>
	({
		query: async (sql: string) => {
			if (sql.includes('FROM known_instances ki')) return { rows: [] };
			if (sql.includes('DISTINCT ON')) {
				return { rows: [1, 2, 3].map(() => ({ observed_price: String(peerPrice) })) };
			}
			return { rows: [], rowCount: 0 };
		}
	}) as never;
const own = (p: number) => ({ currentDetailed: () => ({ price: p, stale: false }) }) as never;

const blurt = { db: db(0.002), priceSource: own(0.004), asset: 'BLURT', denominationFiat: 'USD' };
const btc = { db: db(60_000), priceSource: own(60_000), asset: 'BTC', denominationFiat: 'USD' };
const T0 = Date.parse('2026-10-01T00:00:00Z');
const H = 3_600_000;

async function hoursUntilBlurtAlert(withBtc: boolean): Promise<number | null> {
	for (let h = 0; h <= 8; h += 0.5) {
		const r = await runPeerPriceSampleCycle(blurt, new Date(T0 + h * H));
		if (r.alertFired) return h;
		if (withBtc) await runPeerPriceSampleCycle(btc, new Date(T0 + h * H + 60_000));
	}
	return null;
}

describe('per-asset peer-price monitors', () => {
	beforeEach(() => _resetPeerPriceMonitorState());

	it('a BLURT monitor alone alerts after the sustained window', async () => {
		expect(await hoursUntilBlurtAlert(false)).toBe(PEER_DISAGREEMENT_SUSTAINED_HOURS);
	});

	it('an agreeing BTC monitor running alongside does not reset BLURT', async () => {
		expect(await hoursUntilBlurtAlert(true)).toBe(PEER_DISAGREEMENT_SUSTAINED_HOURS);
	});
});
