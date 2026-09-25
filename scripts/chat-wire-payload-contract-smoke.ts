#!/usr/bin/env tsx
/**
 * chat-wire-payload-contract-smoke — the browser writes it, the server reads it,
 * and nothing tied the two.
 *
 * THE CONTRACT. A chat message on the wire is a `morphit_chat_v1` custom_json
 * whose payload has `recipient`, `ciphertext`, and a `header` carrying
 * `client_tag`, `ephemeral_pub`, `nonce` and optionally `self_ciphertext` /
 * `self_nonce`. The browser builds that object in three places; the indexer
 * reads those exact keys off it in two. Five homes for one decision, across two
 * workspaces, and not one check compared them.
 *
 * WHY IT IS WORTH A CHECK OF ITS OWN, and not a hypothetical. The browser's
 * internal envelope calls these fields `ephemeralPub`, `selfCiphertext`,
 * `selfNonce` — camelCase — and converts to snake_case at exactly those three
 * construction sites. "Tidy up the inconsistent naming" is an obvious and
 * well-meant refactor, and it would make every chat message on the network
 * unparseable by every indexer: the durable handler reads `ctx.payload.
 * ciphertext` and `hdr.client_tag` by literal name and rejects what it cannot
 * find.
 *
 * AND THE WHOLE BATTERY WOULD STAY GREEN. Every smoke that exercises a chat
 * message builds its own fixture, and the most careful of them
 * (`federation-chat-fast-smoke`) carries a comment saying the fixture is
 * "field-for-field the payload apps/web/src/lib/chat/chatService.ts puts on the
 * wire… so that a parser change breaks this smoke". That is true of a PARSER
 * change and says nothing about a WRITER change: nothing reads chatService.ts.
 * It is the same shape as the intake-stats defect — a hand-copied shape with a
 * comment asserting the copy is faithful — and a comment is not a check.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  ✓ ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  ✗ ${m}`);
	if (d) console.log(`      ${d}`);
};

const WRITERS = ['apps/web/src/lib/chat/chatService.ts', 'apps/web/src/lib/chat/settledElsewhere.ts'];
const READERS = ['apps/indexer/src/indexer/handlers/chat.ts', 'apps/indexer/src/indexer/headTailer.ts'];

/**
 * Keys the browser puts ON THE WIRE, read out of the payload object literals.
 *
 * Deliberately narrow: only `key:` lines inside a `const payload … = {` block
 * and the `header: {` nested in it, so an unrelated camelCase local cannot be
 * mistaken for a wire field.
 */
function writtenKeys(): Set<string> {
	const keys = new Set<string>();
	for (const f of WRITERS) {
		const src = read(f);
		const re = /const payload[^=]*=\s*\{([\s\S]*?)\n\t\t\};/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(src)) !== null) {
			for (const line of m[1]!.split('\n')) {
				const k = /^\s*(?:\.\.\.\([^)]*\?\s*\{\s*)?([a-z][a-z0-9_]*)\s*:/.exec(line);
				if (k !== null) keys.add(k[1]!);
				// the conditional spread puts two keys on one line
				for (const extra of line.matchAll(/\{\s*([a-z][a-z0-9_]*):[^,}]*,\s*([a-z][a-z0-9_]*):/g)) {
					keys.add(extra[1]!);
					keys.add(extra[2]!);
				}
			}
		}
	}
	return keys;
}

/** Field names the indexer reads off the payload or its header. */
function requiredByServer(): Set<string> {
	const keys = new Set<string>();
	for (const f of READERS) {
		const src = read(f);
		for (const m of src.matchAll(/\b(?:ctx\.payload|payload|hdr|header)\.([a-z][a-z0-9_]*)\b/g)) {
			keys.add(m[1]!);
		}
	}
	return keys;
}

const written = writtenKeys();
const readByServer = requiredByServer();

if (written.size >= 5) ok(`the browser writes ${written.size} wire fields: ${[...written].sort().join(', ')}`);
else
	bad(
		'could not read the browser payload literal — it has been rewritten into a shape this smoke cannot parse',
		`found: ${[...written].sort().join(', ') || '(none)'} — an unreadable contract is an unchecked one`
	);

if (readByServer.size >= 5) ok(`the indexer reads ${readByServer.size} payload/header fields`);
else bad('could not find the indexer field reads', [...readByServer].sort().join(', ') || '(none)');

/**
 * THE CONTRACT HAS TWO HALVES, and the first draft of this smoke got that
 * wrong — worth leaving written down, because the mistake is the instructive
 * part.
 *
 * It asserted that every field the browser writes must be one the INDEXER
 * reads, and flagged `ephemeral_pub` and `nonce` as unread. They are unread,
 * and that is CORRECT: chat is end-to-end encrypted, so the indexer size-checks
 * the header and stores it opaquely without looking inside. Only the
 * RECIPIENT'S BROWSER reads those. A check demanding the server read them would
 * have been pressure to break the privacy property.
 *
 *   HALF A  browser writer -> INDEXER      recipient, ciphertext, client_tag,
 *                                          self_ciphertext, self_nonce
 *   HALF B  browser writer -> RECIPIENT'S  ephemeral_pub, nonce
 *           BROWSER
 *
 * Both halves are one rename from breaking, and they break differently: half A
 * stops the message being accepted at all; half B lets it be stored and relayed
 * and leaves the recipient unable to decrypt it — the worse of the two, because
 * everything looks like it is working.
 */
const READER_BROWSER = read('apps/web/src/lib/chat/chatService.ts');

/** HALF A. Fields the indexer acts on must be fields the browser sends. */
{
	const serverSide = ['recipient', 'ciphertext', 'client_tag', 'self_ciphertext', 'self_nonce'];
	const missing = serverSide.filter((k) => readByServer.has(k) && !written.has(k));
	if (missing.length === 0) ok('every field the INDEXER acts on is one the browser sends');
	else
		bad(
			'the indexer reads field(s) the browser does not send',
			`${missing.join(', ')} — those messages are rejected or silently incomplete`
		);
}

/** HALF B. The E2EE fields must reach the reader that needs them. */
{
	const e2ee = ['ephemeral_pub', 'nonce'];
	const broken = e2ee.filter((k) => !written.has(k) || !READER_BROWSER.includes(`h.${k}`));
	if (broken.length === 0)
		ok('the E2EE header fields are written by the sender and read by the recipient');
	else
		bad(
			'an E2EE header field is not carried from sender to recipient',
			`${broken.join(', ')} — the message would be stored and relayed perfectly and the ` +
				'recipient could not decrypt it, which is the failure that looks like success'
		);
}

/**
 * THE RETRY LINK (v1.18.0), a third reader. A retry names the attempts it
 * replaces in `prior_tags` so the RECIPIENT can fold it into a first attempt
 * the chain never recorded. Like the E2EE fields it is written by one browser
 * and read by another; unlike them nothing on the server needs it. A rename on
 * either side would not break a single message — every retry would simply show
 * twice again, which is exactly the kind of failure nothing else would notice.
 */
{
	// Code only: the module's own prose mentions `header.prior_tags`, and a
	// comment that names a field is not a read of it.
	const code = READER_BROWSER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
	const reads = /\)\.prior_tags\b|\bh(?:eader|dr)?\.prior_tags\b/.test(code);
	if (written.has('prior_tags') && reads)
		ok('the retry link (prior_tags) is written by the sender and read by the recipient');
	else
		bad(
			'the retry link is not carried from sender to recipient',
			`written: ${written.has('prior_tags')}, read: ${reads} — every retried message would appear twice`
		);
}

/**
 * AND THE PRIVACY PROPERTY, asserted as an ABSENCE. The indexer must not read
 * the E2EE fields: it cannot decrypt anything with them, so a read would be
 * introspection of a message body. Stated explicitly because the rest of this
 * file would otherwise create pressure in that direction — "carried end to end"
 * reads like something every field ought to be.
 */
{
	const introspected = ['ephemeral_pub', 'nonce'].filter((k) => readByServer.has(k));
	if (introspected.length === 0)
		ok('the indexer does NOT read the E2EE fields — it stores the header opaquely');
	else
		bad(
			'the indexer has started reading inside the encrypted header',
			`${introspected.join(', ')} — it cannot decrypt, so this is introspection of a message body`
		);
}

// The fixture that CLAIMS to mirror the browser must still claim it, because
// that comment is what tells the next person the fixture is not free-invented.
{
	const smoke = read('apps/indexer/scripts/federation-chat-fast-smoke.ts');
	if (smoke.includes('chatService.ts'))
		ok('the federation smoke still names the browser file its fixture mirrors');
	else
		bad(
			'the federation smoke no longer says which browser file its fixture mirrors',
			'without that, the fixture reads as invented and nobody knows to update it'
		);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('✗ chat-wire-payload contract FAILED');
	process.exit(1);
}
console.log(`✓ all ${pass} chat-wire-payload contract scenarios passed`);
