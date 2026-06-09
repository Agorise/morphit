/**
 * RSS output — XML-parse-validation smoke.
 *
 * The handler smoke runner string-matches for specific tags.
 * This runner invokes each handler and checks the output
 * parses as well-formed XML by using a minimal tag-stack
 * validator. Catches issues like unclosed tags, mismatched
 * nesting, and unescaped attribute quotes.
 *
 * Usage (from apps/indexer):
 *   tsx scripts/rss-orderbook-xml-validate.ts
 */

import type pg from 'pg';
import {
	globalFeedHandler,
	perAssetFeedHandler,
	perAccountFeedHandler
} from '../src/api/rssOrderbookHandlers.ts';
import type { Database } from '../src/db/pool.ts';
import type { Config } from '../src/config/index.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
	scenarios++;
	return Promise.resolve()
		.then(fn)
		.then(
			() => console.log(`  ✓ ${name}`),
			(err) => {
				failures++;
				console.log(`  ✗ ${name}`);
				console.log(`      ${err instanceof Error ? err.message : String(err)}`);
			}
		);
}

/** Minimal stack-based XML well-formedness checker.
 *  Good enough for our simple RSS output — verifies tags
 *  balance and self-closing tags (like <atom:link ... />)
 *  are properly marked. Does not attempt to fully validate
 *  arbitrary XML; only checks structural properties we care
 *  about. */
function validateXml(xml: string): { ok: boolean; error?: string } {
	// Strip XML prolog and comments.
	let remaining = xml.replace(/<\?xml[^>]*\?>/g, '');

	const stack: string[] = [];
	const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9:.-]*)([^>]*)>/g;
	let match: RegExpExecArray | null;

	while ((match = tagRe.exec(remaining)) !== null) {
		const [whole, tagName, attrs] = match;
		const isClose = whole.startsWith('</');
		const isSelfClose = attrs.trimEnd().endsWith('/');

		if (isClose) {
			const top = stack.pop();
			if (top !== tagName) {
				return {
					ok: false,
					error: `Mismatched close: expected </${top}>, got </${tagName}> at offset ${match.index}`
				};
			}
		} else if (!isSelfClose) {
			stack.push(tagName!);
		}

		// Attribute validation: every attribute must be name="value"
		// or name='value'. Sniff for unbalanced quotes.
		const attrStr = attrs.replace(/\/$/, '').trim();
		if (attrStr) {
			// Simple tokenizer: split on unquoted whitespace.
			const doubleCount = (attrStr.match(/"/g) || []).length;
			const singleCount = (attrStr.match(/'/g) || []).length;
			if (doubleCount % 2 !== 0) {
				return {
					ok: false,
					error: `Unbalanced double quotes in attrs of <${tagName}>: ${attrStr}`
				};
			}
			if (singleCount % 2 !== 0) {
				return {
					ok: false,
					error: `Unbalanced single quotes in attrs of <${tagName}>: ${attrStr}`
				};
			}
		}
	}

	if (stack.length > 0) {
		return {
			ok: false,
			error: `Unclosed tags: ${stack.join(', ')}`
		};
	}

	return { ok: true };
}

function assertValidXml(xml: string, label: string): void {
	const r = validateXml(xml);
	if (!r.ok) {
		// Dump a window of the XML around failures for debugging.
		const preview = xml.length > 800 ? xml.slice(0, 800) + '...' : xml;
		throw new Error(`${label}: ${r.error}\n--- preview ---\n${preview}`);
	}
}

function makeMockDb(rows: unknown[]): Database {
	return {
		query: async <R extends pg.QueryResultRow = pg.QueryResultRow>(): Promise<
			pg.QueryResult<R>
		> => ({
			rows: rows as R[],
			rowCount: rows.length,
			command: 'SELECT',
			oid: 0,
			fields: []
		}),
		withTx: async () => {
			throw new Error('mock: withTx not used');
		},
		close: async () => {}
	};
}

const FAKE_CONFIG: Config = {
	publicOrigin: 'https://indexer.example.com'
} as Config;

console.log('\n── RSS XML well-formedness ─────────────────────────');

// Rows with every special character we escape, in every field
// where a user supplies content.
const HOSTILE_ROWS = [
	{
		account: `user-<with>&"all'chars`,
		permlink: 'permlink & "<test>"',
		side: 'buy',
		asset: 'BTC',
		fiat_currency: 'X&Y "Z"',
		amount_min: '100',
		amount_max: '500',
		location_region: '<region & more>',
		payment_methods: ['SEPA & friends', 'Revolut "pro"'],
		fee_method: 'BLURT & <test>',
		created_at: new Date('2026-04-20T12:00:00Z'),
		updated_at: new Date('2026-04-20T13:00:00Z')
	}
];

const NORMAL_ROWS = [
	{
		account: 'alice',
		permlink: 'sell-btc-eur-12345',
		side: 'sell',
		asset: 'BTC',
		fiat_currency: 'EUR',
		amount_min: '100',
		amount_max: '500',
		location_region: 'EU',
		payment_methods: ['SEPA'],
		fee_method: 'BLURT',
		created_at: new Date('2026-04-20T12:00:00Z'),
		updated_at: new Date('2026-04-20T13:00:00Z')
	}
];

// ─── Global feed ────────────────────────────────────────────

await scenario('global feed (normal rows) produces well-formed XML', async () => {
	const db = makeMockDb(NORMAL_ROWS);
	const r = await globalFeedHandler(db, FAKE_CONFIG);
	assertValidXml(r.body, 'global feed');
});

await scenario('global feed (empty) produces well-formed XML', async () => {
	const db = makeMockDb([]);
	const r = await globalFeedHandler(db, FAKE_CONFIG);
	assertValidXml(r.body, 'global feed empty');
});

await scenario('global feed (hostile chars in all fields) produces well-formed XML', async () => {
	const db = makeMockDb(HOSTILE_ROWS);
	const r = await globalFeedHandler(db, FAKE_CONFIG);
	assertValidXml(r.body, 'global feed hostile');
});

// ─── Per-asset feed ─────────────────────────────────────────

await scenario('per-asset feed (btc, normal) produces well-formed XML', async () => {
	const db = makeMockDb(NORMAL_ROWS);
	const r = await perAssetFeedHandler('btc.xml', db, FAKE_CONFIG);
	assertValidXml(r.body, 'per-asset BTC');
});

await scenario('per-asset feed (xmr, empty) produces well-formed XML', async () => {
	const db = makeMockDb([]);
	const r = await perAssetFeedHandler('xmr.xml', db, FAKE_CONFIG);
	assertValidXml(r.body, 'per-asset XMR empty');
});

await scenario('per-asset feed (blurt, hostile) produces well-formed XML', async () => {
	const db = makeMockDb(HOSTILE_ROWS);
	const r = await perAssetFeedHandler('blurt.xml', db, FAKE_CONFIG);
	assertValidXml(r.body, 'per-asset BLURT hostile');
});

// ─── Per-account feed ───────────────────────────────────────

await scenario('per-account feed (@alice, normal) produces well-formed XML', async () => {
	const db = makeMockDb(NORMAL_ROWS);
	const r = await perAccountFeedHandler('@alice.xml', db, FAKE_CONFIG);
	assertValidXml(r.body, 'per-account alice');
});

await scenario('per-account feed (empty) produces well-formed XML', async () => {
	const db = makeMockDb([]);
	const r = await perAccountFeedHandler('@alice.xml', db, FAKE_CONFIG);
	assertValidXml(r.body, 'per-account alice empty');
});

await scenario('per-account feed (hostile) produces well-formed XML', async () => {
	const db = makeMockDb(HOSTILE_ROWS);
	const r = await perAccountFeedHandler('@alice.xml', db, FAKE_CONFIG);
	assertValidXml(r.body, 'per-account alice hostile');
});

// ─── Atom self-link correctness ─────────────────────────────

await scenario('atom:link href is a self-closing element with proper attrs', async () => {
	const db = makeMockDb(NORMAL_ROWS);
	const r = await globalFeedHandler(db, FAKE_CONFIG);
	// atom:link should be self-closing and have both href and rel attrs.
	const m = r.body.match(/<atom:link\s+([^>]*)\/>/);
	if (!m) {
		throw new Error(`atom:link not found or not self-closing in body:\n${r.body.slice(0, 500)}`);
	}
	const attrs = m[1]!;
	if (!attrs.includes('href=')) throw new Error('atom:link missing href');
	if (!attrs.includes('rel="self"')) throw new Error('atom:link missing rel="self"');
	if (!attrs.includes('type="application/rss+xml"')) throw new Error('atom:link missing type attr');
});

// ─── Atom 1.0 well-formedness (same validator — Atom is XML) ─

await scenario('global Atom feed (normal) is well-formed XML', async () => {
	const r = await globalFeedHandler(makeMockDb(NORMAL_ROWS), FAKE_CONFIG, 'atom');
	assertValidXml(r.body, 'global atom normal');
});

await scenario('global Atom feed (hostile chars in all fields) is well-formed XML', async () => {
	const r = await globalFeedHandler(makeMockDb(HOSTILE_ROWS), FAKE_CONFIG, 'atom');
	assertValidXml(r.body, 'global atom hostile');
});

await scenario('global Atom feed (empty) is well-formed XML', async () => {
	const r = await globalFeedHandler(makeMockDb([]), FAKE_CONFIG, 'atom');
	assertValidXml(r.body, 'global atom empty');
});

await scenario('per-asset Atom feed (btc, hostile) is well-formed XML', async () => {
	const r = await perAssetFeedHandler('btc.atom', makeMockDb(HOSTILE_ROWS), FAKE_CONFIG);
	assertValidXml(r.body, 'per-asset atom hostile');
});

await scenario('per-account Atom feed (@alice, hostile) is well-formed XML', async () => {
	const r = await perAccountFeedHandler('@alice.atom', makeMockDb(HOSTILE_ROWS), FAKE_CONFIG);
	assertValidXml(r.body, 'per-account atom hostile');
});

await scenario('Atom self link is a self-closing <link rel="self"> with href', async () => {
	const r = await globalFeedHandler(makeMockDb(NORMAL_ROWS), FAKE_CONFIG, 'atom');
	const m = r.body.match(/<link\s+rel="self"\s+href="[^"]*"\s*\/>/);
	if (!m) throw new Error(`atom self link missing/not self-closing:\n${r.body.slice(0, 500)}`);
});

// ─── JSON Feed parseability (hostile data must stay valid JSON) ─

await scenario('global JSON feed (hostile chars) parses as valid JSON', async () => {
	const r = await globalFeedHandler(makeMockDb(HOSTILE_ROWS), FAKE_CONFIG, 'json');
	const parsed = JSON.parse(r.body) as { items: unknown[] };
	if (!Array.isArray(parsed.items) || parsed.items.length !== 1) {
		throw new Error('JSON feed items malformed for hostile row');
	}
});

await scenario('per-account JSON feed (empty) parses with zero items', async () => {
	const r = await perAccountFeedHandler('@alice.json', makeMockDb([]), FAKE_CONFIG);
	const parsed = JSON.parse(r.body) as { items: unknown[] };
	if (parsed.items.length !== 0) throw new Error('expected zero items');
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
