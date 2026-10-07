/**
 * Every profile link the web's Settings form accepts is a link the indexer
 * stores. From CONSENSUS_V2_ACTIVATION_TIME (2026-11-01) the indexer checks the
 * values of website_url / streaming_url / nostr_url; a value the form lets
 * through but the indexer refuses is broadcast and then silently not saved.
 *
 * The web validators are plain TypeScript with no imports, so they are loaded
 * here directly; the indexer side is its own read-path filter, which runs the
 * same metadataProblem the handler runs.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeStoredProfileMetadata } from '../../src/indexer/handlers/profile';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/** Load a web module that has no imports, compiled here: importing it through
 *  vite would read apps/web's tsconfig, which needs a synced .svelte-kit
 *  folder a fresh checkout (CI) does not have. */
async function loadWebModule<T>(rel: string): Promise<T> {
	const src = readFileSync(join(__dirname, '..', '..', '..', 'web', 'src', rel), 'utf8');
	const js = ts.transpileModule(src, {
		compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
	}).outputText;
	const f = join(mkdtempSync(join(tmpdir(), 'webmod-')), 'm.mjs');
	writeFileSync(f, js);
	return (await import(/* @vite-ignore */ pathToFileURL(f).href)) as T;
}
type V = { ok: true; cleaned: string } | { ok: false; reason: string } | null;
const { validateNostrUrl } = await loadWebModule<{ validateNostrUrl: (s: string) => V }>(
	'lib/utils/nostrUrl.ts'
);
const { validateWebUrl } = await loadWebModule<{ validateWebUrl: (s: string) => V }>(
	'lib/utils/webUrl.ts'
);

const NPUB = 'npub1' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2);

const NOSTR_CORPUS: string[] = [
	`nostr:${NPUB}`,
	`Nostr:${NPUB}`,
	`NOSTR:${NPUB.toUpperCase()}`,
	`nostr:${NPUB.toUpperCase()}`,
	`nostr:${NPUB.slice(0, 20)}${NPUB.slice(20).toUpperCase()}`,
	`nostr:nprofile1${'qpzry9x8gf2tvdw0'.repeat(4)}`,
	`nostr:npub1${'q'.repeat(450)}`,
	'nostr:npub1abc',
	'https://primal.net/p/' + NPUB,
	'https://example.org/' + 'é'.repeat(120),
	'https://example.org/' + ' '.repeat(10) + 'x',
	'http://example.org/a b'
];

const WEB_CORPUS: string[] = [
	'https://example.org',
	'https://example.org/' + 'é'.repeat(120),
	'https://example.org/' + 'ü'.repeat(60),
	'https://example.org/' + 'a'.repeat(480),
	'https://example.org/' + '%'.repeat(100),
	'https://ex.org/?q=' + '東'.repeat(100),
	'https://ex.org/#' + 'ñ'.repeat(200),
	'http://example.onion/path',
	'https://xn--nxasmq6b.example/'
];

function indexerKeeps(key: string, value: string): boolean {
	return Object.prototype.hasOwnProperty.call(sanitizeStoredProfileMetadata({ [key]: value }), key);
}

describe('profile links: the web form sends only what the indexer stores', () => {
	it.each(NOSTR_CORPUS)('nostr_url %#', (raw) => {
		const v = validateNostrUrl(raw);
		if (v && v.ok) expect(indexerKeeps('nostr_url', v.cleaned)).toBe(true);
	});
	it.each(WEB_CORPUS)('website_url / streaming_url %#', (raw) => {
		const v = validateWebUrl(raw);
		if (v && v.ok) {
			expect(indexerKeeps('website_url', v.cleaned)).toBe(true);
			expect(indexerKeeps('streaming_url', v.cleaned)).toBe(true);
		}
	});
	it('a nostr: link typed in capitals is still accepted (sent in the form the indexer stores)', () => {
		const v = validateNostrUrl(`Nostr:${NPUB}`);
		expect(v && v.ok && v.cleaned).toBe(`nostr:${NPUB}`);
		const u = validateNostrUrl(`NOSTR:${NPUB.toUpperCase()}`);
		expect(u && u.ok && u.cleaned).toBe(`nostr:${NPUB}`);
	});
});
