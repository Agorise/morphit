/**
 * app.html, the page every route is served in: without JavaScript, the parts
 * that only work with it (.js-only, and the first-trades card's .ftc-slot) are
 * hidden by a <style> that lives in <head>, inside <noscript> — a <style>
 * inside the <body>'s <noscript> is invalid HTML, and outside any <noscript>
 * it would hide them for everyone. Parsed and styled by jsdom, with and
 * without scripting.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// jsdom ships no type declarations; only these parts are used.
interface Dom {
	window: Window & typeof globalThis;
}
const { JSDOM, VirtualConsole } = (await import(/* @vite-ignore */ 'jsdom' as string)) as {
	JSDOM: new (html: string, opts?: Record<string, unknown>) => Dom;
	VirtualConsole: new () => unknown;
};

const raw = readFileSync(new URL('./app.html', import.meta.url), 'utf8');
const page = raw
	.replaceAll('%sveltekit.assets%', '')
	.replace('%sveltekit.head%', '')
	.replaceAll('%sveltekit.nonce%', '')
	.replace(
		'%sveltekit.body%',
		'<a class="js-only" id="js">Chat</a><div class="ftc-slot" id="ftc">x</div><p id="plain">y</p>'
	);

function display(dom: Dom, id: string): string {
	const el = dom.window.document.getElementById(id)!;
	return dom.window.getComputedStyle(el).display;
}

describe('app.html without JavaScript', () => {
	it('hides what only works with JavaScript, and nothing else', () => {
		const dom = new JSDOM(page); // scripting off: <noscript> is markup
		expect(display(dom, 'js')).toBe('none');
		expect(display(dom, 'ftc')).toBe('none');
		expect(display(dom, 'plain')).toBe('block');
	});

	it('with JavaScript, those stay visible', () => {
		// Scripting on (the page's own inline scripts run; their console is muted).
		const dom = new JSDOM(page, {
			runScripts: 'dangerously',
			virtualConsole: new VirtualConsole()
		});
		expect(display(dom, 'js')).not.toBe('none');
		expect(display(dom, 'ftc')).not.toBe('none');
	});

	it('the hiding <style> is in <head>, inside <noscript>; none in <body>', () => {
		const doc = new JSDOM(page).window.document;
		const styles = [...doc.querySelectorAll('noscript style')];
		expect(styles.length).toBe(1);
		expect(styles[0]!.closest('head')).not.toBeNull();
		expect(doc.body.querySelector('style')).toBeNull();
	});
});
