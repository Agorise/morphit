/**
 * Two looks that are easy to lose in a class string (v1.21.17):
 *   - the profile tabs show where the keyboard is without a box (the owner saw
 *     a cut-off box around the tab on a Mac): a clear tint and underlined
 *     text (the faint /10 tint alone was all but invisible);
 *   - the wallet card and a chat address card take the instance's brand
 *     colour in light mode too (stock Tailwind emerald is green on a gold
 *     instance).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(LIB, rel), 'utf8');

describe('profile tabs', () => {
	it('a focused tab is tinted and underlined, with no box', () => {
		const src = read('../routes/[lang]/[x+40][account=account]/+page.svelte');
		const tab = src.slice(src.indexOf('role="tab"'), src.indexOf('{tab.label}'));
		expect(tab).toContain('focus-visible:bg-morphit-emerald/20');
		expect(tab).toContain('focus-visible:underline ');
		expect(tab).not.toMatch(/ring/);
	});
});

describe('brand colour in light mode', () => {
	it('the wallet card', () => {
		const src = read('components/MyBalanceCard.svelte');
		expect(src).toMatch(
			/class="card border border-morphit-emerald\/30 bg-morphit-emerald\/\[0\.04\] /
		);
	});
	it('a chat address card', () => {
		const src = read('components/ChatMessage.svelte');
		expect(src).toContain('border-morphit-emerald/40 bg-morphit-emerald/[0.04] p-3');
		expect(src).not.toContain('bg-emerald-50/40 p-3');
	});
});
