/**
 * Morphit smoke — explorer URL builders.
 *
 * Pure helpers.  Verifies validation refuses garbage and that
 * URLs match the documented external-explorer patterns.
 *
 * Part 109: the BTC/XMR templates are now operator-configurable
 * (instance.chat_link_urls), but the smoke runs outside
 * SvelteKit so it can't import urls.ts directly (which pulls
 * the Svelte store via `$lib`).  Instead it tests the pure
 * helpers in urlsCore (regexes, substitution, validator) and
 * verifies the bundled-default constants match the documented
 * shape.
 */

import {
	BTC_TXID_RE,
	XMR_TXID_RE,
	BLURT_TRXID_RE,
	ACCOUNT_NAME_RE,
	BUNDLED_BTC_CHAT_LINK_URL,
	BUNDLED_XMR_CHAT_LINK_URL,
	substituteTxidIntoTemplate,
	isValidChatLinkTemplate
} from '../../web/src/lib/explorer/urlsCore';

let scenarios = 0;
let failures = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── explorer urls smoke ───────────────────────────────────\n');

const BTC_TXID = 'a'.repeat(64);
const XMR_TXID = 'b'.repeat(64);
const BLURT_TRXID = 'c'.repeat(40);

// ─── BTC / XMR txid regex validation ───────────────────────────

scenario('BTC txid regex accepts 64-char lowercase hex', () => {
	if (!BTC_TXID_RE.test(BTC_TXID)) throw new Error('rejected');
});

scenario('BTC txid regex accepts uppercase', () => {
	if (!BTC_TXID_RE.test(BTC_TXID.toUpperCase())) throw new Error('rejected');
});

scenario('BTC txid regex rejects short input', () => {
	if (BTC_TXID_RE.test('abc')) throw new Error('accepted short');
});

scenario('BTC txid regex rejects non-hex', () => {
	if (BTC_TXID_RE.test('z'.repeat(64))) throw new Error('accepted non-hex');
});

scenario('BTC txid regex rejects injection attempt', () => {
	if (BTC_TXID_RE.test('../../../etc/passwd')) throw new Error('accepted injection');
});

scenario('XMR txid regex accepts 64-char hex', () => {
	if (!XMR_TXID_RE.test(XMR_TXID)) throw new Error('rejected');
});

scenario('Blurt trx_id regex accepts 40-char hex', () => {
	if (!BLURT_TRXID_RE.test(BLURT_TRXID)) throw new Error('rejected');
});

scenario('Blurt trx_id regex rejects 64-char (txid length)', () => {
	if (BLURT_TRXID_RE.test('a'.repeat(64))) throw new Error('accepted txid length');
});

scenario('Account name regex accepts valid names', () => {
	if (!ACCOUNT_NAME_RE.test('alice')) throw new Error('alice');
	if (!ACCOUNT_NAME_RE.test('test-user.foo')) throw new Error('test-user.foo');
});

scenario('Account name regex rejects invalid names', () => {
	if (ACCOUNT_NAME_RE.test('')) throw new Error('empty');
	if (ACCOUNT_NAME_RE.test('AB')) throw new Error('upper');
	if (ACCOUNT_NAME_RE.test('1abc')) throw new Error('starts digit');
	if (ACCOUNT_NAME_RE.test('a/b')) throw new Error('slash');
	if (ACCOUNT_NAME_RE.test('a'.repeat(20))) throw new Error('long');
});

// ─── Bundled defaults ──────────────────────────────────────────────

scenario('Bundled BTC default is mempool.space template', () => {
	if (BUNDLED_BTC_CHAT_LINK_URL !== 'https://mempool.space/tx/{txid}') {
		throw new Error(BUNDLED_BTC_CHAT_LINK_URL);
	}
});

scenario('Bundled XMR default is xmrchain.net template', () => {
	if (BUNDLED_XMR_CHAT_LINK_URL !== 'https://xmrchain.net/tx/{txid}') {
		throw new Error(BUNDLED_XMR_CHAT_LINK_URL);
	}
});

// ─── substituteTxidIntoTemplate ─────────────────────────────────────

scenario('Substitute {txid} into a well-formed template', () => {
	const out = substituteTxidIntoTemplate(BUNDLED_BTC_CHAT_LINK_URL, BTC_TXID);
	if (out !== `https://mempool.space/tx/${BTC_TXID}`) {
		throw new Error(out ?? 'null');
	}
});

scenario('Substitute handles multiple {txid} occurrences', () => {
	const tpl = 'https://example.com/{txid}/details/{txid}';
	const out = substituteTxidIntoTemplate(tpl, BTC_TXID);
	if (out !== `https://example.com/${BTC_TXID}/details/${BTC_TXID}`) {
		throw new Error(out ?? 'null');
	}
});

scenario('Substitute defensively recovers from missing {txid} placeholder', () => {
	// Operator misconfiguration: template has no {txid}.  We fall
	// back to ${origin}/tx/${txid} so at least SOMETHING resolves.
	const tpl = 'https://example.com/some-path';
	const out = substituteTxidIntoTemplate(tpl, BTC_TXID);
	if (out !== `https://example.com/tx/${BTC_TXID}`) {
		throw new Error(out ?? 'null');
	}
});

scenario('Substitute returns null on unparseable template', () => {
	const out = substituteTxidIntoTemplate('not a url at all', BTC_TXID);
	if (out !== null) throw new Error(out);
});

scenario('Substitute with custom self-hosted explorer template', () => {
	const tpl = 'https://my-instance.example/monero/tx/{txid}';
	const out = substituteTxidIntoTemplate(tpl, XMR_TXID);
	if (out !== `https://my-instance.example/monero/tx/${XMR_TXID}`) {
		throw new Error(out ?? 'null');
	}
});

// ─── isValidChatLinkTemplate ───────────────────────────────────────

scenario('Validator accepts the bundled BTC default', () => {
	if (!isValidChatLinkTemplate(BUNDLED_BTC_CHAT_LINK_URL)) {
		throw new Error('rejected');
	}
});

scenario('Validator accepts the bundled XMR default', () => {
	if (!isValidChatLinkTemplate(BUNDLED_XMR_CHAT_LINK_URL)) {
		throw new Error('rejected');
	}
});

scenario('Validator rejects http:// (privacy invariant)', () => {
	if (isValidChatLinkTemplate('http://mempool.space/tx/{txid}')) {
		throw new Error('accepted http');
	}
});

scenario('Validator rejects template without {txid}', () => {
	if (isValidChatLinkTemplate('https://example.com/tx/abc')) {
		throw new Error('accepted no placeholder');
	}
});

scenario('Validator rejects user:pass@ in URL', () => {
	if (isValidChatLinkTemplate('https://bad:secret@example.com/tx/{txid}')) {
		throw new Error('accepted credentials');
	}
});

scenario('Validator rejects unparseable strings', () => {
	if (isValidChatLinkTemplate('not a url')) throw new Error('plain');
	if (isValidChatLinkTemplate('https:///{txid}')) {
		// Empty host after https:/// — URL parser may or may not
		// reject this depending on Node version.  Accept either
		// outcome here; we just want to confirm no crash.
	}
});

scenario('Validator handles non-string input gracefully', () => {
	if (isValidChatLinkTemplate(123 as unknown as string)) throw new Error('number');
	if (isValidChatLinkTemplate(null as unknown as string)) throw new Error('null');
	if (isValidChatLinkTemplate(undefined as unknown as string)) throw new Error('undefined');
});

scenario('Validator accepts a self-hosted explorer template', () => {
	if (
		!isValidChatLinkTemplate('https://my-instance.example/monero/tx/{txid}')
	) {
		throw new Error('rejected self-hosted');
	}
});

scenario('Validator accepts a localhost template with port', () => {
	if (!isValidChatLinkTemplate('https://localhost:8443/tx/{txid}')) {
		throw new Error('rejected localhost+port');
	}
});

// ─── Privacy invariant: explorer choice is per-operator ────────────

scenario('Bundled defaults use distinct hosts (no single SPOF)', () => {
	const btcHost = new URL(BUNDLED_BTC_CHAT_LINK_URL.replace('{txid}', 'x')).host;
	const xmrHost = new URL(BUNDLED_XMR_CHAT_LINK_URL.replace('{txid}', 'x')).host;
	if (btcHost === xmrHost) {
		throw new Error(`BTC and XMR share host: ${btcHost}`);
	}
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
