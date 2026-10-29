import { describe, expect, it, vi } from 'vitest';
import { topOnChange } from './pageTop';

describe('topOnChange (wizard steps open at their top, v1.21.17)', () => {
	it('scrolls on every change of step, never on the first value or a repeat', () => {
		const scroll = vi.fn();
		const seen = topOnChange<string>({ scroll });
		seen('editing');
		expect(scroll).not.toHaveBeenCalled();
		seen('editing');
		expect(scroll).not.toHaveBeenCalled();
		seen('reviewing');
		expect(scroll).toHaveBeenCalledTimes(1);
		seen('awaiting_password');
		seen('error');
		seen('reviewing');
		expect(scroll).toHaveBeenCalledTimes(4);
	});

	it('the first content after a loading placeholder stays where SvelteKit put it', () => {
		const scroll = vi.fn();
		const seen = topOnChange<string>({ scroll, quietFrom: ['loading'] });
		seen('loading');
		seen('ready');
		expect(scroll).not.toHaveBeenCalled();
		seen('saved');
		expect(scroll).toHaveBeenCalledTimes(1);
	});
});
