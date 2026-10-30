/**
 * The instance-local hiding predicate (api/localHiding.ts) inlines the
 * operator's switched-off tickers and method keys into SQL; anything that is
 * not a plain token is dropped, never inlined. Behaviour against real rows is
 * in test/integration/fee-rules-at-block-consensus.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { andLocallyShown, locallyShownSql, setLocalOrderHiding } from '$api/localHiding';

afterEach(() => setLocalOrderHiding({ disabledAssets: [], disabledPaymentMethods: [] }));

describe('instance-local order hiding', () => {
	it('hides nothing when nothing is switched off', () => {
		setLocalOrderHiding({ disabledAssets: [], disabledPaymentMethods: [] });
		expect(locallyShownSql()).toBeNull();
		expect(andLocallyShown()).toBe('');
	});
	it('a value that is not a plain token never reaches the SQL', () => {
		setLocalOrderHiding({
			disabledAssets: ["USDT'); DROP TABLE orders; --", 'usdc'],
			disabledPaymentMethods: ["x' OR '1'='1"]
		});
		const sql = locallyShownSql()!;
		expect(sql).toContain("'USDC'");
		expect(sql).not.toContain('DROP');
		expect(sql).not.toContain("'1'='1");
		expect(sql).not.toContain('payment_methods');
	});
});
