// @vitest-environment jsdom
/**
 * <PasswordScope> keeps a password manager's autofill inside it (v1.21.14):
 * the Morphit password field is in a form of its own, and the first field of
 * that form is the account name, read-only, as the user name. Firefox looks
 * backwards from the password field for a user-name field and writes the saved
 * user name there; without this it wrote into the page's other fields.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
const signedIn = writable<string | null>('anna');
vi.mock('$blurt/ops/profile', () => ({ blurtAccountName: signedIn }));

afterEach(() => {
	document.body.innerHTML = '';
	signedIn.set('anna');
});

async function render(props: { account?: string | null; class?: string }) {
	const { mount, flushSync, createRawSnippet } = await import('svelte');
	const PasswordScope = (await import('./PasswordScope.svelte')).default;
	const target = document.createElement('div');
	document.body.appendChild(target);
	const children = createRawSnippet(() => ({
		render: () => '<input type="password" autocomplete="current-password" />'
	}));
	mount(PasswordScope, { target, props: { ...props, children } as never });
	flushSync();
	const form = target.querySelector('form') as HTMLFormElement;
	const password = target.querySelector('input[type=password]') as HTMLInputElement;
	const user = form.elements[0] as HTMLInputElement;
	return { target, form, password, user, flushSync };
}

describe('<PasswordScope>', () => {
	it('puts the password field in a form whose first field is the account name, read-only', async () => {
		const { form, password, user } = await render({ account: 'bob' });
		expect(password.form).toBe(form);
		expect(user.getAttribute('autocomplete')).toBe('username');
		expect(user.type).toBe('text');
		expect(user.value).toBe('bob');
		expect(user.readOnly).toBe(true);
		// The user-name field comes before the password in the form, nothing between.
		expect([...form.elements]).toEqual([user, password]);
	});

	it('takes no space: the account field is hidden, the form has no box of its own by default', async () => {
		const { form, user } = await render({ account: 'bob' });
		expect(user.hidden).toBe(true);
		expect(form.classList.contains('contents')).toBe(true);
	});

	it('names the signed-in account when none is given, and follows it', async () => {
		const { user, flushSync } = await render({});
		expect(user.value).toBe('anna');
		signedIn.set('carol');
		flushSync();
		expect(user.value).toBe('carol');
	});

	it('leaves the name empty when it is not known yet (null), whoever is signed in', async () => {
		const { user } = await render({ account: null });
		expect(user.value).toBe('');
	});

	it('never submits: Enter or a submit leaves the page where it is', async () => {
		const { form } = await render({ account: 'bob' });
		const ev = new Event('submit', { bubbles: true, cancelable: true });
		form.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
	});

	it('takes a class for a parent that spaces its children', async () => {
		const { form } = await render({ account: 'bob', class: 'block space-y-4' });
		expect(form.className).toBe('block space-y-4');
	});
});
