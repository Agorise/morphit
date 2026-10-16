/**
 * Settings → Offline Notifications: what the FAQ and the code message tell her
 * matches what she actually sees.
 *
 * - The FAQ quotes the note word for word ("Someone just sent you a chat
 *   message on …"). The note itself is written by the relay
 *   (apps/relay/src/notify/text.ts), in her language. A quote that drifts from
 *   the real note teaches her to distrust the real one.
 * - The relay's code message and the FAQ both name the menu path; it must be
 *   the menu item she clicks (avatar_menu.settings) and the card's own title.
 * - The labels the FAQ names (On, Turn off, Delete all my addresses) are the
 *   card's own.
 *
 * Every locale the relay writes notes in is checked against that locale's
 * site strings.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTICE_LOCALES, render } from '../../../../relay/src/notify/text';
import { SUPPORTED_LOCALES } from '$lib/i18n/locales';

type Json = Record<string, unknown>;
const LOCALES_DIR = join(__dirname, '..', 'i18n', 'locales');
const site = (code: string): Json =>
	JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf8')) as Json;
const at = (o: Json, path: string): string => {
	const v = path.split('.').reduce<unknown>((x, k) => (x as Json | undefined)?.[k], o);
	if (typeof v !== 'string') throw new Error(`missing ${path}`);
	return v;
};

/** The note's first sentence, as the relay writes it for a site called {brand}. */
function noteSentence(locale: string): string {
	const text = render(locale, 'notice', { site: '{brand}', link: 'https://x.example/l' });
	return text.split(/[.。](?:\s|$)|。/u)[0]!.trim();
}

describe('offline notifications: the FAQ and the code message match the real note and labels', () => {
	it('covers every locale the relay writes in', () => {
		expect([...NOTICE_LOCALES].sort()).toEqual(SUPPORTED_LOCALES.map((l) => l.code).sort());
	});

	for (const locale of NOTICE_LOCALES) {
		it(`${locale}: the FAQ quotes the note the relay sends`, () => {
			const faq = at(site(locale), 'faq.entries.offline_notifications.a');
			const sentence = noteSentence(locale);
			expect(sentence.length).toBeGreaterThan(10);
			expect(faq, `FAQ must quote: ${sentence}`).toContain(sentence);
		});

		it(`${locale}: the code message and the FAQ name the real menu path`, () => {
			const s = site(locale);
			const menu = at(s, 'avatar_menu.settings');
			const card = at(s, 'settings.offline_notify.title');
			const arrow = locale === 'fa' ? '←' : '→';
			const path = `${menu} ${arrow} ${card}`;
			const code = render(locale, 'code', { site: '{brand}', code: '123456' });
			expect(code, `code message must say: ${path}`).toContain(path);
			expect(at(s, 'faq.entries.offline_notifications.a')).toContain(`**${path}**`);
		});

		it(`${locale}: the FAQ names the card's own buttons and state`, () => {
			const s = site(locale);
			const faq = at(s, 'faq.entries.offline_notifications.a');
			for (const key of ['turn_off', 'delete_all'])
				expect(faq).toContain(`**${at(s, `settings.offline_notify.${key}`)}**`);
			expect(faq).toContain(at(s, 'settings.offline_notify.on'));
		});
	}
});
