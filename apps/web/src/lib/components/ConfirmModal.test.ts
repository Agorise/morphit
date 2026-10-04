// @vitest-environment jsdom
/**
 * Chat Security (ConversationView) records "keep my copy" only when the user
 * clicks "No, keep them": closing the dialog with Escape or a backdrop click
 * leaves the mode as it was. Other dialogs keep treating a dismissal
 * as Cancel.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

beforeAll(() => {
	// jsdom has no showModal/close: the native behaviour that matters here.
	HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
		this.setAttribute('open', '');
	};
	HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
		if (!this.hasAttribute('open')) return;
		this.removeAttribute('open');
		this.dispatchEvent(new Event('close'));
	};
});
afterEach(() => {
	document.body.innerHTML = '';
});

type How = 'backdrop' | 'escape' | 'cancel button';

async function closeWith(how: How, withDismiss: boolean): Promise<string[]> {
	const { mount, flushSync, unmount } = await import('svelte');
	const { default: ConfirmModal } = await import('./ConfirmModal.svelte');
	const calls: string[] = [];
	const target = document.createElement('div');
	document.body.appendChild(target);
	const app = mount(ConfirmModal, {
		target,
		props: {
			open: true,
			title: 'Chat Security',
			body: 'b',
			confirmLabel: 'Yes',
			cancelLabel: 'No, keep them',
			variant: 'neutral',
			onConfirm: () => void calls.push('confirm'),
			onCancel: () => void calls.push('cancel'),
			...(withDismiss ? { onDismiss: () => void calls.push('dismiss') } : {})
		}
	});
	flushSync();
	const dlg = target.querySelector('dialog') as HTMLDialogElement;
	if (how === 'backdrop') dlg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	else if (how === 'escape') dlg.close();
	else
		[...target.querySelectorAll('button')]
			.find((b) => b.textContent?.includes('No, keep them'))!
			.click();
	flushSync();
	// What the user's action called (unmounting a still-open dialog closes it).
	const made = [...calls];
	unmount(app);
	return made;
}

describe('ConfirmModal dismissal', () => {
	it.each(['backdrop', 'escape'] as const)('%s with onDismiss records no choice', async (how) => {
		expect(await closeWith(how, true)).toEqual(['dismiss']);
	});
	it('the cancel button is still the explicit choice', async () => {
		expect(await closeWith('cancel button', true)).toEqual(['cancel']);
	});
	it.each(['backdrop', 'escape'] as const)(
		'%s without onDismiss is Cancel, as before',
		async (how) => {
			expect(await closeWith(how, false)).toEqual(['cancel']);
		}
	);
});
