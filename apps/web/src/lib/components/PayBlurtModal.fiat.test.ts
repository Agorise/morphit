// @vitest-environment jsdom
/**
 * PayBlurtModal (v1.23.2): field, ticker and the fiat it is worth —
 * [2752.096] BLURT (≈11 BRL) — following what is typed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('svelte-i18n', async (orig) => ({
	...((await orig()) as object),
	_: readable((k: string) => k),
	locale: readable('en')
}));
vi.mock('$stores/identity', () => ({ liveIdentity: readable(null) }));
vi.mock('$blurt/ops/profile', () => ({ getUserBlurtAccount: () => 'kencode' }));
vi.mock('$blurt/sign', () => ({
	prepareUnsignedTransfer: vi.fn(),
	signTransferWithKey: vi.fn(),
	broadcastSignedTransaction: vi.fn()
}));
vi.mock('$crypto/runWithActiveKey', () => ({ runWithActiveKey: vi.fn() }));

const { flushSync, mount, unmount } = await import('svelte');
const { locale } = await import('svelte-i18n');
void locale;
const { default: PayBlurtModal } = await import('./PayBlurtModal.svelte');

let app: ReturnType<typeof mount> | null = null;
afterEach(() => {
	if (app) unmount(app);
	app = null;
	document.body.innerHTML = '';
});

function render(props: Record<string, unknown>) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	app = mount(PayBlurtModal, {
		target,
		props: { recipient: 'josiemoto', memo: '', onPaid: () => {}, onCancel: () => {}, ...props }
	});
	flushSync();
	return target;
}

describe('PayBlurtModal: [amount] BLURT (≈fiat) (v1.23.2)', () => {
	it('shows the pre-filled amount, the ticker and what it is worth', () => {
		const t = render({
			amount: 2752.096,
			amountEditable: true,
			fiatPerUnit: { value: 11 / 2752.096, currency: 'BRL' }
		});
		const input = t.querySelector('input[inputmode="decimal"]') as HTMLInputElement;
		expect(input.value).toBe('2752.096');
		expect(t.textContent).toContain('BLURT');
		expect(t.textContent).toContain('(≈11 BRL)');
	});

	it('follows what is typed', () => {
		const t = render({
			amount: 2752.096,
			amountEditable: true,
			fiatPerUnit: { value: 11 / 2752.096, currency: 'BRL' }
		});
		const input = t.querySelector('input[inputmode="decimal"]') as HTMLInputElement;
		input.value = '1376.048';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(t.textContent).toContain('(≈5.5 BRL)');
	});

	it('no fiat known: just the ticker', () => {
		const t = render({ amount: 0, amountEditable: true });
		expect(t.textContent).toContain('BLURT');
		expect(t.textContent).not.toContain('(≈');
	});
});
