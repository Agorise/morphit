import { describe, it, expect } from 'vitest';
import { highlightJsonToHtml } from './jsonHighlight';

/** Grab the highlight span wrapping the VALUE of `key` in the rendered HTML. */
function valueSpanClass(html: string, key: string): string | null {
	// …"key"</span>: <span class="json-XXX">VALUE</span>
	const at = html.indexOf(`${key}\\"</span>`) === -1 ? html.indexOf(`${key}"</span>`) : html.indexOf(`${key}\\"</span>`);
	const from = html.indexOf('<span class="json-', at);
	if (from === -1) return null;
	const m = /^<span class="(json-[a-z]+)"/.exec(html.slice(from));
	return m?.[1] ?? null;
}

describe('highlightJsonToHtml — numeric string values (cp439)', () => {
	it('colours a string-encoded integer like a number (XMR piconero)', () => {
		const html = highlightJsonToHtml(JSON.stringify({ piconero: '781250000' }, null, 2));
		expect(valueSpanClass(html, 'piconero')).toBe('json-num');
	});

	it('still colours a real number like a number (BTC satoshis)', () => {
		const html = highlightJsonToHtml(JSON.stringify({ satoshis: 416 }, null, 2));
		expect(valueSpanClass(html, 'satoshis')).toBe('json-num');
	});

	it('leaves a version string alone (two dots is not a number)', () => {
		const html = highlightJsonToHtml(JSON.stringify({ version: '1.1.0' }, null, 2));
		expect(valueSpanClass(html, 'version')).toBe('json-string');
	});

	it('leaves an address / hash string alone', () => {
		const html = highlightJsonToHtml(JSON.stringify({ address: 'bc1qxy2kg' }, null, 2));
		expect(valueSpanClass(html, 'address')).toBe('json-string');
	});

	it('colours a negative / decimal numeric string like a number', () => {
		const html = highlightJsonToHtml(JSON.stringify({ a: '-42', b: '3.14' }, null, 2));
		expect(valueSpanClass(html, 'a')).toBe('json-num');
		expect(valueSpanClass(html, 'b')).toBe('json-num');
	});

	it('does not colour an empty string or a numeric-looking KEY', () => {
		const html = highlightJsonToHtml(JSON.stringify({ '123': 'x', empty: '' }, null, 2));
		// the "123" KEY stays a key, not a number
		expect(html).toContain('<span class="json-key">"123"</span>');
		expect(valueSpanClass(html, 'empty')).toBe('json-string');
	});

	it('escapes HTML in values regardless of numeric colouring (no injection)', () => {
		const html = highlightJsonToHtml(JSON.stringify({ x: '<b>1</b>' }, null, 2));
		expect(html).not.toContain('<b>');
		expect(html).toContain('&lt;b&gt;');
	});
});
