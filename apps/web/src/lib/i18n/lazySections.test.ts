/**
 * v1.20.2 — the locale bundle is split at build time: every page loads `core`,
 * and a lazy section (the FAQ, …) loads only with its page.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CORE_PART, LAZY_SECTION_NAMES, splitLocaleMessages } from './lazySections';
import { i18nSections } from '../../../scripts/vite-i18n-sections';

const LOCALES = join(__dirname, 'locales');
const en = JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8')) as Record<string, unknown>;

describe('splitLocaleMessages', () => {
	it('core + every lazy section = the whole file, with nothing in two parts', () => {
		const core = splitLocaleMessages(en, CORE_PART);
		const merged: Record<string, unknown> = { ...core };
		for (const s of LAZY_SECTION_NAMES) {
			const part = splitLocaleMessages(en, s);
			expect(Object.keys(part)).toEqual([s]);
			expect(core).not.toHaveProperty(s);
			Object.assign(merged, part);
		}
		expect(merged).toEqual(en);
	});
	it('the lazy sections are most of the file (the point of the split)', () => {
		const size = (o: unknown) => JSON.stringify(o).length;
		expect(size(splitLocaleMessages(en, CORE_PART))).toBeLessThan(size(en) * 0.5);
	});
	it('a locale without a section gives {} (svelte-i18n falls back to English)', () => {
		expect(splitLocaleMessages({ common: { ok: 'OK' } }, 'faq')).toEqual({});
	});
});

describe('the Vite plugin', () => {
	type Hook = (this: { addWatchFile(f: string): void }, id: string) => string | null;
	const plugin = i18nSections(LOCALES) as unknown as { resolveId: Hook; load: Hook };
	const ctx = { addWatchFile: () => {} };
	const load = (id: string): string | null => {
		const r = plugin.resolveId.call(ctx, id);
		return r === null ? null : plugin.load.call(ctx, r);
	};
	const evalDefault = (code: string): unknown =>
		new Function(code.replace('export default', 'return'))() as unknown;

	it('the loader map names every locale file and every part, as static imports', () => {
		const code = load('virtual:morphit-i18n-loaders')!;
		for (const c of ['en', 'de', 'fa', 'zh-CN', 'zh-HK']) {
			for (const p of [CORE_PART, ...LAZY_SECTION_NAMES]) {
				expect(code).toContain(`import("virtual:morphit-i18n/${c}/${p}")`);
			}
		}
	});
	it('a part module is exactly that part of the file', () => {
		expect(evalDefault(load('virtual:morphit-i18n/en/core')!)).toEqual(
			splitLocaleMessages(en, CORE_PART)
		);
		expect(evalDefault(load('virtual:morphit-i18n/en/faq')!)).toEqual({ faq: en.faq });
	});
	it('refuses anything that is not a known locale and part', () => {
		expect(() => load('virtual:morphit-i18n/../../etc/passwd/core')).toThrow();
		expect(() => load('virtual:morphit-i18n/en/nope')).toThrow();
		expect(() => load('virtual:morphit-i18n/xx/core')).toThrow();
		expect(plugin.resolveId.call(ctx, './locales/en.json')).toBeNull();
	});
});
