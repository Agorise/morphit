/**
 * v1.20.2 (PageSpeed) — Vite plugin `morphit-i18n-sections`: serves each
 * locale file as separate parts, so a page downloads only the messages it can
 * show (see src/lib/i18n/lazySections.ts for the why).
 *
 *   virtual:morphit-i18n-loaders       { <code>: { core: () => import(…), faq: … } }
 *   virtual:morphit-i18n/<code>/<part> that part of locales/<code>.json
 *
 * The loader map is generated with one STATIC import per (locale, part), so
 * Rollup gives each its own chunk. A part is emitted as JSON.parse('…'):
 * engines parse a JSON string faster than the same object literal.
 * (A query on the .json import — `en.json?part=core` — would be taken over by
 * Vite's own JSON plugin; hence virtual modules.)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

import {
	CORE_PART,
	LAZY_SECTION_NAMES,
	isLocalePart,
	splitLocaleMessages
} from '../src/lib/i18n/lazySections';

const LOADERS_ID = 'virtual:morphit-i18n-loaders';
const PART_PREFIX = 'virtual:morphit-i18n/';
const LOCALE_CODE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export function i18nSections(localesDir: string): Plugin {
	const codes = (): string[] =>
		readdirSync(localesDir)
			.filter((f) => f.endsWith('.json'))
			.map((f) => f.slice(0, -'.json'.length))
			.filter((c) => LOCALE_CODE.test(c))
			.sort();
	return {
		name: 'morphit-i18n-sections',
		resolveId(id) {
			if (id === LOADERS_ID || id.startsWith(PART_PREFIX)) return `\0${id}`;
			return null;
		},
		load(id) {
			if (id === `\0${LOADERS_ID}`) {
				const parts = [CORE_PART, ...LAZY_SECTION_NAMES];
				const rows = codes().map(
					(c) =>
						`\t${JSON.stringify(c)}: {\n` +
						parts
							.map(
								(p) =>
									`\t\t${JSON.stringify(p)}: () => import(${JSON.stringify(`${PART_PREFIX}${c}/${p}`)})`
							)
							.join(',\n') +
						'\n\t}'
				);
				return `export default {\n${rows.join(',\n')}\n};\n`;
			}
			if (!id.startsWith(`\0${PART_PREFIX}`)) return null;
			const rest = id.slice(1 + PART_PREFIX.length).split('/');
			const [code, part] = rest;
			const file = join(localesDir, `${code}.json`);
			if (
				rest.length !== 2 ||
				code === undefined ||
				part === undefined ||
				!LOCALE_CODE.test(code) ||
				!isLocalePart(part) ||
				!existsSync(file)
			) {
				throw new Error(`morphit-i18n-sections: no such locale part: ${id.slice(1)}`);
			}
			this.addWatchFile(file);
			const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
			const msgs = splitLocaleMessages(all, part);
			return `export default JSON.parse(${JSON.stringify(JSON.stringify(msgs))});\n`;
		}
	};
}
