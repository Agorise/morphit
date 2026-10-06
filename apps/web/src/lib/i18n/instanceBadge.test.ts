/**
 * The instances page badge for an instance that uses no clearnet internet reads
 * "🏅 Zero use of clearnet internet" (the maintainer's wording, restored in
 * v1.21.1 after v1.21.0 changed it to "Says it uses no clearnet internet").
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(__dirname, 'locales');
const badge = (f: string): string =>
	(JSON.parse(readFileSync(join(DIR, f), 'utf8')) as { instances: { clearnet_eliminated: string } })
		.instances.clearnet_eliminated;

describe('instances badge: zero clearnet', () => {
	it('English reads "Zero use of clearnet internet"', () => {
		expect(badge('en.json')).toBe('Zero use of clearnet internet');
	});
	it('no text quotes the old badge wording (FAQ, llms-full.txt, the claims list)', () => {
		const OLD = [
			'Says it uses no clearnet internet',
			'Gibt an, kein Clearnet-Internet zu nutzen',
			'Dice que no usa internet clearnet',
			"Dit ne pas utiliser l'internet clearnet",
			'Dichiara di non usare internet clearnet',
			'Deklaruje, że nie korzysta z clearnetu',
			'Заявляет, что не использует клирнет',
			'自称不使用明网互联网',
			'自稱不使用明網互聯網'
		];
		const repo = join(__dirname, '..', '..', '..', '..', '..');
		const texts = [
			...readdirSync(DIR)
				.filter((n) => n.endsWith('.json'))
				.map((f) => readFileSync(join(DIR, f), 'utf8')),
			readFileSync(join(repo, 'apps', 'web', 'static', 'llms-full.txt'), 'utf8'),
			readFileSync(join(repo, 'apps', 'web', 'static', 'llms.txt'), 'utf8'),
			readFileSync(join(repo, 'docs', 'MORPHIT-BRAG-LIST.md'), 'utf8')
		];
		for (const t of texts) for (const o of OLD) expect(t).not.toContain(o);
	});
	it('no locale words it as a claim ("says it uses", "dice que", …)', () => {
		const SAYS =
			/says it|dice que|gibt an|dit ne pas|dichiara|deklaruje|заявляет|自称|自稱|می‌گوید/i;
		for (const f of readdirSync(DIR).filter((n) => n.endsWith('.json'))) {
			expect(badge(f), f).not.toMatch(SAYS);
		}
	});
});

describe('orderbook language filter hint', () => {
	it('says older orders with no language show only when no language is chosen (v1.21.1)', () => {
		const en = JSON.parse(readFileSync(join(DIR, 'en.json'), 'utf8')) as {
			orderbook: { filters: { language_hint: string } };
		};
		expect(en.orderbook.filters.language_hint).toMatch(
			/Older orders with no language show only when this is empty/
		);
	});
});
