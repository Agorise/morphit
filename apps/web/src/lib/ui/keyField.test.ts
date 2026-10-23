// @vitest-environment jsdom
/**
 * A field for a KEY starts read-only, so a browser's password manager does not
 * fill the saved site password into it (Firefox skips read-only password
 * fields), and becomes writable the moment the person touches or focuses it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { keyField } from './keyField';

function field(): HTMLInputElement {
	const input = document.createElement('input');
	input.type = 'password';
	document.body.appendChild(input);
	return input;
}

afterEach(() => {
	document.body.innerHTML = '';
});

describe('keyField', () => {
	it('makes the field read-only until it is used', () => {
		const input = field();
		keyField(input);
		expect(input.readOnly).toBe(true);
	});

	it('a touch or click unlocks it, before the focus moves', () => {
		const input = field();
		keyField(input);
		input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		expect(input.readOnly).toBe(false);
	});

	it('a touch on its label unlocks it too, before the label moves the focus', () => {
		const label = document.createElement('label');
		label.append('Active key');
		const input = document.createElement('input');
		input.type = 'password';
		label.appendChild(input);
		document.body.appendChild(label);
		keyField(input);
		label.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		expect(input.readOnly).toBe(false);
	});

	it('keyboard focus unlocks it', () => {
		const input = field();
		keyField(input);
		input.focus();
		expect(document.activeElement).toBe(input);
		expect(input.readOnly).toBe(false);
	});

	it('stops listening when the field goes away', () => {
		const label = document.createElement('label');
		const input = document.createElement('input');
		input.type = 'password';
		label.appendChild(input);
		document.body.appendChild(label);
		const { destroy } = keyField(input);
		destroy();
		input.readOnly = true;
		input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		label.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		input.focus();
		expect(input.readOnly).toBe(true);
	});
});
