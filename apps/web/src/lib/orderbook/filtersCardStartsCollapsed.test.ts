// @vitest-environment jsdom
/**
 * The orderbook's Filter card starts closed on every visit, whatever this
 * browser has stored (owner's report, v1.21.18: on a branded instance the card
 * was open on every visit in a normal window, closed in a private one).
 *
 * The cause was the page itself: it opened the card whenever the language
 * filter it starts with was not empty, and that filter comes from storage —
 * the one left on the orderbook (`morphit.orderbookLangFilter.v1`, written back
 * on every visit) or, failing that, the languages chosen in Settings
 * (`morphit.preferredLangs.v1`). Once either held a language, every later
 * visit opened the card, though the person never opened it. The language in
 * force is now named on the card's title row instead, so it never hides
 * orders unseen.
 *
 * The real page is mounted in the browser runtime; the network, router and
 * i18n are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable, writable } from 'svelte/store';

// The browser build of svelte (vitest resolves the server one by default).
vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
// The page's locale, per visit.
const site = vi.hoisted(() => ({ lang: 'en' }));
vi.mock('$app/stores', () => ({
	page: {
		subscribe: (fn: (v: unknown) => void) => {
			fn({
				params: { lang: site.lang },
				data: { lang: site.lang },
				url: new URL(`https://m.example/${site.lang}/orderbook`)
			});
			return () => {};
		}
	}
}));
// A key renders as itself, with its values in brackets: what the page hands
// the translation is visible.
vi.mock('svelte-i18n', () => ({
	_: readable((k: string, o?: { values?: Record<string, unknown> }) =>
		o?.values ? `${k}[${Object.values(o.values).join('|')}]` : k
	),
	locale: readable('en')
}));
vi.mock('$components/Head.svelte', () => ({ default: () => {} }));
vi.mock('$components/WelcomeFirstBuyHero.svelte', () => ({ default: () => {} }));
vi.mock('$components/FeaturedAuctionHistory.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/OrderCard.svelte', () => ({ default: () => {} }));
vi.mock('$lib/indexer/client', () => ({
	getOrderbook: async () => ({ ok: true, data: { items: [], next_cursor: null } }),
	getHealth: async () => ({ ok: false, message: 'stub' })
}));
vi.mock('$lib/indexer/profileCache', () => ({
	getProfilesBatch: async () => new Map(),
	isSoftMiss: () => false
}));
vi.mock('$lib/orderbook/stream', () => ({
	createOrderbookStream: () => ({ start: () => {}, stop: () => {} })
}));
vi.mock('$lib/stores/instanceAdditions', () => ({
	instanceAdditions: readable(null),
	instanceNameLookup: () => null
}));
vi.mock('$lib/stores/instance', () => ({
	instance: readable({ disabled_payment_methods: [] })
}));
vi.mock('$lib/stores/selfProfile', () => ({ selfProfile: readable({ account: null }) }));
vi.mock('$lib/chat/blocks', () => ({
	blockedAccounts: readable(new Set<string>()),
	loadBlocks: async () => {}
}));
vi.mock('$lib/utils/hiddenAccounts', () => ({
	hiddenAccounts: writable(new Set<string>()),
	hideAccount: () => {},
	unhideAccount: () => {}
}));
vi.mock('$lib/orders/listingFee', () => ({
	checkWaiverEligibility: async () => ({ kind: 'eligible' })
}));
vi.mock('$stores/identity', () => ({
	isUnlocked: readable(false),
	hasAnySession: readable(false)
}));
vi.mock('$stores/sessionAccount', () => ({ sessionAccountName: () => null }));
vi.mock('$blurt/ops/profile', () => ({ getUserBlurtAccount: () => null }));

const OB_FILTER = 'morphit.orderbookLangFilter.v1';
const PREFS = 'morphit.preferredLangs.v1';

beforeEach(() => {
	site.lang = 'en';
	localStorage.clear();
	sessionStorage.clear();
	// The page's placeholder typewriters ask for reduced motion.
	window.matchMedia = ((q: string) => ({
		matches: true,
		media: q,
		addEventListener: () => {},
		removeEventListener: () => {}
	})) as unknown as typeof window.matchMedia;
	// jsdom has no Web Animations; the card's slide transition asks for it.
	Element.prototype.animate = (() => ({
		cancel: () => {},
		finish: () => {},
		onfinish: null,
		currentTime: 0
	})) as unknown as typeof Element.prototype.animate;
});
let mounted: Record<string, unknown> | null = null;
afterEach(async () => {
	const { unmount } = await import('svelte');
	if (mounted) await unmount(mounted);
	mounted = null;
	document.body.innerHTML = '';
});

async function visitOrderbook(): Promise<HTMLElement> {
	const { mount, unmount, flushSync, tick } = await import('svelte');
	const { default: Page } = await import('../../routes/[lang]/orderbook/+page.svelte');
	if (mounted) await unmount(mounted);
	document.body.innerHTML = '';
	const target = document.createElement('div');
	document.body.append(target);
	mounted = mount(Page, { target });
	await vi.waitFor(async () => {
		await tick();
		expect(target.querySelector('[data-testid="filters-toggle"]')).not.toBeNull();
	});
	// Let onMount's seed and the effects after it settle: a few turns of the
	// event loop, no wall-clock wait.
	for (let i = 0; i < 5; i++) {
		await new Promise((r) => setImmediate(r));
		await tick();
	}
	flushSync();
	return target;
}

const toggle = (t: HTMLElement): HTMLButtonElement =>
	t.querySelector<HTMLButtonElement>('[data-testid="filters-toggle"]')!;
const summary = (t: HTMLElement): string | undefined =>
	t.querySelector('[data-testid="filters-lang-summary"]')?.textContent?.trim();
const isOpen = (t: HTMLElement): boolean =>
	toggle(t).getAttribute('aria-expanded') === 'true' &&
	t.querySelector('#orderbook-filters-body') !== null;

describe('the orderbook Filter card starts closed', () => {
	it('nothing stored (a private window): closed', async () => {
		const t = await visitOrderbook();
		expect(isOpen(t)).toBe(false);
	});

	it('a language filter left on the orderbook on an earlier visit: still closed', async () => {
		localStorage.setItem(OB_FILTER, JSON.stringify({ v: 1, langs: ['en'] }));
		const t = await visitOrderbook();
		expect(isOpen(t)).toBe(false);
		// The filter is still in force, and the title row says which.
		expect(localStorage.getItem(OB_FILTER)).toBe(JSON.stringify({ v: 1, langs: ['en'] }));
		expect(summary(t)).toBe('orderbook.filters.language_in_force[English]');
	});

	it('languages chosen in Settings (the filter seeds from them): closed', async () => {
		localStorage.setItem(PREFS, JSON.stringify({ v: 2, langs: ['es', 'en'] }));
		const t = await visitOrderbook();
		expect(isOpen(t)).toBe(false);
		expect(summary(t)).toBe('orderbook.filters.language_in_force[Español or English]');
	});

	it('a second visit after that one: still closed', async () => {
		localStorage.setItem(PREFS, JSON.stringify({ v: 2, langs: ['es'] }));
		await visitOrderbook();
		// The first visit wrote the filter back as the orderbook's own…
		expect(localStorage.getItem(OB_FILTER)).toBe(JSON.stringify({ v: 1, langs: ['es'] }));
		// …so this visit starts from it.
		const t = await visitOrderbook();
		expect(isOpen(t)).toBe(false);
		expect(toggle(t).textContent).toContain('Español');
	});

	it('opens when the person opens it; no language named when none is in force', async () => {
		const { flushSync } = await import('svelte');
		const t = await visitOrderbook();
		expect(t.querySelector('[data-testid="filters-lang-summary"]')).toBeNull();
		toggle(t).click();
		flushSync();
		expect(isOpen(t)).toBe(true);
	});

	it('the language named on the title row stays there when the card is opened', async () => {
		const { flushSync } = await import('svelte');
		localStorage.setItem(OB_FILTER, JSON.stringify({ v: 1, langs: ['ru'] }));
		const t = await visitOrderbook();
		const before = t.querySelector('[data-testid="filters-lang-summary"]')?.textContent;
		expect(before).toContain('Русский');
		toggle(t).click();
		flushSync();
		expect(isOpen(t)).toBe(true);
		expect(t.querySelector('[data-testid="filters-lang-summary"]')?.textContent).toBe(before);
	});
});

describe('the language named on the Filter card reads as the page’s language does', () => {
	it('zh-CN: the list takes its own separators (、 and 或), not ", "', async () => {
		site.lang = 'zh-CN';
		localStorage.setItem(OB_FILTER, JSON.stringify({ v: 1, langs: ['en', 'es', 'ru'] }));
		const t = await visitOrderbook();
		expect(summary(t)).toBe('orderbook.filters.language_in_force[English、Español或Русский]');
	});

	it('fa: the list takes its own separators (، and یا)', async () => {
		site.lang = 'fa';
		localStorage.setItem(OB_FILTER, JSON.stringify({ v: 1, langs: ['en', 'es', 'ru'] }));
		const t = await visitOrderbook();
		expect(summary(t)).toContain('،');
		expect(summary(t)).toContain('یا');
		expect(summary(t)).not.toContain(', ');
	});

	it('every locale words "Language: …" itself, around one {languages}', async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const own: Record<string, string> = {
			en: 'Language: {languages}',
			de: 'Sprache: {languages}',
			es: 'Idioma: {languages}',
			fr: 'Langue : {languages}',
			it: 'Lingua: {languages}',
			pl: 'Język: {languages}',
			ru: 'Язык: {languages}',
			fa: 'زبان: {languages}',
			'zh-CN': '语言：{languages}',
			'zh-HK': '語言：{languages}'
		};
		for (const [code, want] of Object.entries(own)) {
			const d = JSON.parse(
				readFileSync(join(__dirname, '..', 'i18n', 'locales', `${code}.json`), 'utf8')
			) as { orderbook: { filters: Record<string, string> } };
			const f = d.orderbook.filters;
			expect(f.language_in_force, code).toBe(want);
			// The same word as the form's own "Language" field.
			expect(f.language_in_force!.startsWith(f.language_label!), code).toBe(true);
		}
	});
});
