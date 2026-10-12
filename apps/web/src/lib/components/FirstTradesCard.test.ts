// @vitest-environment jsdom
/**
 * FirstTradesCard (v1.21.5): the homepage invitation to sign in and make a
 * first few trades. v1.21.6: six numbered tiles; the ones this site's relay
 * pays for (the free first buy, welcome coins, loyalty rewards) appear only on
 * a site with an operator tag (as RewardsPanel), and the passive-income tile
 * names the chain's staking rate once it is read. Someone with an account on
 * this device is sent to post or browse, not to sign up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readable, writable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/stores', () => ({ page: readable({ data: { lang: 'en' } }) }));
vi.mock('svelte-i18n', async (orig) => ({
	...((await orig()) as object),
	_: readable((k: string, o?: { values?: Record<string, string> }) =>
		o?.values ? `${k}(${Object.values(o.values).join(',')})` : k
	),
	locale: readable('en')
}));
const inst = writable({
	loaded: true,
	operator_tag: 'morphit' as string | null,
	relay_account: 'morphit-relay'
});
// The staking rate is read through the indexer (the relay account's balance
// route carries the chain's global properties).
const balanceCalls: string[] = [];
let balanceAnswer: unknown = { kind: 'error', message: 'unset' };
vi.mock('$blurt/accountBalance', () => ({
	fetchAccountBalance: async (_origin: string, account: string) => {
		balanceCalls.push(account);
		return balanceAnswer;
	}
}));
let aprValue = 1.7;
vi.mock('$blurt/apr', () => ({
	computeBlurtVestingApr: () => aprValue,
	formatApr: (n: number) => `${n.toFixed(2)}%`
}));
vi.mock('$net/config', () => ({ resolveOrigin: (o: string) => o, MORPHIT_INDEXER_ORIGIN: '' }));
vi.mock('$stores/instance', () => ({ instance: { subscribe: inst.subscribe } }));
const session = writable(false);
vi.mock('$stores/identity', () => ({ hasAnySession: { subscribe: session.subscribe } }));
let persisted = false;
vi.mock('$crypto/persistentKeystore', () => ({ hasPersistedKeystore: () => persisted }));

afterEach(() => {
	document.body.innerHTML = '';
});

function tiles(t: HTMLElement): { tile: string; num: string }[] {
	return [...t.querySelectorAll<HTMLElement>('[data-testid="first-trades-tiles"] > li')].map(
		(li) => ({
			tile: li.dataset.tile ?? '',
			num: li.querySelector('.ftc-tile-num')?.textContent ?? ''
		})
	);
}

async function render(): Promise<HTMLElement> {
	const { mount, flushSync } = await import('svelte');
	const { default: Card } = await import('./FirstTradesCard.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(Card, { target });
	flushSync();
	return target;
}

describe('FirstTradesCard', () => {
	it('a visitor on a site that pays rewards: the rewards, and the free signup first', async () => {
		inst.set({ loaded: true, operator_tag: 'morphit', relay_account: 'morphit-relay' });
		session.set(false);
		persisted = false;
		const t = await render();
		expect(tiles(t)).toEqual([
			{ tile: 'signin', num: '1' },
			{ tile: 'post', num: '2' },
			{ tile: 'chat', num: '3' },
			{ tile: 'welcome', num: '4' },
			{ tile: 'income', num: '5' },
			{ tile: 'loyalty', num: '6' }
		]);
		expect(t.textContent).toContain('home.first_trades.tile_post_body');
		expect(t.textContent).not.toContain('home.first_trades.tile_post_body_paid');
		expect(t.textContent).not.toContain('home.first_trades.eyebrow');
		const primary = t.querySelector<HTMLAnchorElement>('[data-testid="first-trades-primary"]')!;
		expect(primary.getAttribute('href')).toBe('/en/onboarding');
		expect(primary.textContent).toContain('home.first_trades.cta_signup_free');
		expect(t.querySelector('a[href="/en/login"]')).not.toBeNull();
	});

	it('a site without an operator tag claims no rewards', async () => {
		inst.set({ loaded: true, operator_tag: null, relay_account: 'morphit-relay' });
		session.set(false);
		persisted = false;
		const t = await render();
		expect(tiles(t)).toEqual([
			{ tile: 'signin', num: '1' },
			{ tile: 'post', num: '2' },
			{ tile: 'chat', num: '3' },
			{ tile: 'income', num: '4' }
		]);
		expect(t.textContent).toContain('home.first_trades.tile_post_body_paid');
		expect(t.textContent).not.toContain('home.first_trades.cta_signup_free');
		expect(t.textContent).toContain('home.first_trades.cta_signup');
	});

	it('someone with an account on this device (signed in or locked) is sent to trade', async () => {
		inst.set({ loaded: true, operator_tag: 'morphit', relay_account: 'morphit-relay' });
		for (const [s, p] of [
			[true, false],
			[false, true]
		] as const) {
			session.set(s);
			persisted = p;
			const t = await render();
			const primary = t.querySelector<HTMLAnchorElement>('[data-testid="first-trades-primary"]')!;
			expect(primary.getAttribute('href')).toBe('/en/post');
			expect(t.querySelector('a[href="/en/onboarding"]')).toBeNull();
			document.body.innerHTML = '';
		}
	});

	it("the passive-income tile names the chain's staking rate once read, and no rate before or without it", async () => {
		inst.set({ loaded: true, operator_tag: 'morphit', relay_account: 'vt-relay' });
		session.set(false);
		persisted = false;
		balanceCalls.length = 0;
		balanceAnswer = {
			kind: 'ok',
			data: {
				dgp: {
					head_block_number: 1,
					current_supply: '1.000 BLURT',
					total_vesting_fund_blurt: '1.000 BLURT',
					total_vesting_shares: '1.000000 VESTS'
				}
			}
		};
		const { flushSync } = await import('svelte');
		const t = await render();
		expect(balanceCalls).toEqual(['vt-relay']);
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(t.textContent).toContain('home.first_trades.tile_income_body(1.70%)');
		document.body.innerHTML = '';

		balanceAnswer = { kind: 'error', message: 'down' };
		const t2 = await render();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(t2.textContent).toContain('home.first_trades.tile_income_body_no_rate');
		expect(t2.textContent).not.toContain('home.first_trades.tile_income_body(');
	});

	it('no rate is named when the chain figure is not a positive number ($blurt/apr bounds the plausible ones)', async () => {
		inst.set({ loaded: true, operator_tag: 'morphit', relay_account: 'morphit-relay' });
		session.set(false);
		persisted = false;
		balanceAnswer = { kind: 'ok', data: { dgp: {} } };
		const { flushSync } = await import('svelte');
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -2, 0]) {
			aprValue = value;
			const t = await render();
			await new Promise((r) => setTimeout(r, 0));
			flushSync();
			expect(t.textContent).toContain('home.first_trades.tile_income_body_no_rate');
			document.body.innerHTML = '';
		}
		aprValue = 1.7;
	});
});
