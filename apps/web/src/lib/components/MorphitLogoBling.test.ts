// @vitest-environment jsdom
/**
 * The logo URLs the pages actually render (v1.21.8). A returning visitor's
 * browser still runs v1.21.7's service worker on the first page after the
 * upgrade; that worker answered brand files from its stored copy (possibly
 * Morphit's logo, from before the site was branded) EXCEPT a read carrying
 * `?fresh=1`, which it fetched from the network. So every logo the pages draw
 * — the image and the shine's mask — must carry it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock(
	'svelte',
	async () =>
		await import(
			/* @vite-ignore */ '../../../../../node_modules/svelte/src/index-client.js' as string
		)
);
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));

afterEach(() => {
	document.body.innerHTML = '';
});

/** v1.21.7's service worker: a brand-file read goes to the network only when
 *  it carries ?fresh=1 (otherwise its stored copy was answered first). */
const v1217WorkerAsksNetwork = (src: string): boolean =>
	new URL(src, 'https://site.example').searchParams.has('fresh');

async function render(props: Record<string, unknown>): Promise<HTMLElement> {
	const { mount, flushSync } = await import('svelte');
	const { default: Logo } = await import('./MorphitLogoBling.svelte');
	const target = document.createElement('div');
	document.body.appendChild(target);
	mount(Logo, { target, props });
	flushSync();
	return target;
}

describe('the logo the pages draw', () => {
	for (const props of [
		{ heightPx: 32, shine: true, priority: true },
		{ heightClass: 'h-11 sm:h-16' },
		{ heightPx: 40, variant: 'footer', shine: true }
	])
		it(`is fetched from the server even by a v1.21.7 worker (${JSON.stringify(props)})`, async () => {
			const el = await render(props);
			const img = el.querySelector('img')!;
			const src = img.getAttribute('src')!;
			expect(src).toMatch(
				props.variant === 'footer'
					? /^\/brand\/site-logo-footer\.svg\?/
					: /^\/brand\/site-logo\.svg\?/
			);
			expect(v1217WorkerAsksNetwork(src)).toBe(true);
			const mask = el.querySelector<HTMLElement>('.morphit-logo-bling-shine');
			if (props.shine) {
				const url = /url\("([^"]+)"\)/.exec(mask!.getAttribute('style') ?? '')![1]!;
				expect(url).toBe(src);
			}
		});
});

// v1.23.5: the operator's logo size (MORPHIT_INSTANCE_LOGO_SIZE → --brand-logo-scale
// in /brand/theme.css) sizes the header logo; the footer keeps its own height.
describe("the operator's logo size", () => {
	it('the header logo is its height times --brand-logo-scale (1 when unset)', async () => {
		const el = await render({ heightPx: 32, shine: true, priority: true });
		for (const node of [el.querySelector('.morphit-logo-bling-host')!, el.querySelector('img')!])
			expect(node.getAttribute('style')).toContain(
				'height: calc(32px * var(--brand-logo-scale, 1));'
			);
	});
	it('the footer logo and an explicit logo keep their plain height', async () => {
		for (const props of [
			{ heightPx: 40, variant: 'footer', shine: true },
			{ heightPx: 24, wordmarkSrc: '/x.svg' }
		]) {
			const el = await render(props);
			const style = el.querySelector('img')!.getAttribute('style') ?? '';
			expect(style).toContain(`height: ${props.heightPx}px;`);
			expect(style).not.toContain('brand-logo-scale');
			document.body.innerHTML = '';
		}
	});
	it("the homepage hero's heights carry the same factor at every breakpoint", async () => {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const page = readFileSync(
			join(import.meta.dirname, '..', '..', 'routes', '[lang]', '+page.svelte'),
			'utf8'
		);
		const m = /<MorphitLogoBling\s+heightClass="([^"]+)"/.exec(page);
		expect(m).not.toBeNull();
		const classes = m![1]!.split(/\s+/);
		expect(classes).toEqual([
			'h-[calc(2.75rem*var(--brand-logo-scale,1))]',
			'sm:h-[calc(4rem*var(--brand-logo-scale,1))]',
			'md:h-[calc(5rem*var(--brand-logo-scale,1))]',
			'lg:h-[calc(6rem*var(--brand-logo-scale,1))]'
		]);
	});
});
