#!/usr/bin/env tsx
/**
 * chat-fastpath-dedup-smoke (ADR-0048).
 *
 * The indexer head-block fast path (headTailer.ts) streams a chat
 * message over SSE as a PROVISIONAL copy (wire id 0) seconds before its
 * durable, irreversible copy arrives. Both copies carry the same on-chain
 * client_tag. The frontend merge (chatService.ts) must collapse the two
 * so a message is never shown twice, must adopt the durable id when it
 * lands (never letting a provisional id-0 overwrite a real id), and —
 * the safety-critical bit — must NOT re-run the trade-status side effects
 * (recordAddressShared / recordFundsSent) when the durable twin arrives,
 * or an address/funds-sent payload would be double-recorded.
 *
 * These are source-assertions: the full merge needs the live chat runtime
 * + libsodium, which a smoke can't cheaply stand up (same rationale as
 * chat-own-sent-plaintext-cache-smoke and chat-blocks-race-guard-smoke).
 *
 * Because the wire uses id 0 only for provisional fast-path copies, every
 * guard below is a NO-OP when the fast path is off (durable copies always
 * have id > 0) — so this also documents that the change is inert unless
 * an instance runs the fast path.
 *
 * Usage:
 *   cd apps/web && npx tsx scripts/chat-fastpath-dedup-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const SVC = join(REPO, 'src/lib/chat/chatService.ts');
const body = readFileSync(SVC, 'utf8');

interface Scenario {
	readonly name: string;
	readonly mustHave?: readonly string[];
	readonly mustNotHave?: readonly string[];
	/** Optional custom check returning an error string, or null if OK. */
	readonly check?: () => string | null;
}

const SCENARIOS: readonly Scenario[] = [
	{
		name: '1 — reconcileByClientTag treats wire id 0 as provisional (isDurable flag)',
		mustHave: ['const isDurable = rec.id !== 0;']
	},
	{
		name: '2 — reconcileByClientTag matches our message by client_tag in ANY state (broad match)',
		// The rewrite iterates all messages and skips on tag mismatch,
		// rather than only matching pending/broadcast — so a provisional
		// already reconciled (confirmed, id null) is still found when the
		// durable copy lands.
		mustHave: ['if (m.clientTag !== tag && m.priorTags?.includes(tag) !== true) continue;']
	},
	{
		name: '2a — a tag the message used BEFORE a retry still matches it',
		// v1.18.0. A retry deliberately mints a fresh client_tag, because the
		// previous broadcast may already have landed and a repeated tag would
		// collide. But the ORIGINAL copy identifies itself by the old tag, and
		// with the async broadcast it really can still be in flight — the
		// unconfirmed sweeper exists to prompt a retry for a send that is late
		// rather than lost. Forget the old tag and that original matches nothing,
		// so it is appended as a second message and BOTH people see it twice.
		mustHave: [
			'target.priorTags = [...(target.priorTags ?? []), target.clientTag];',
			// Bounded: someone leaning on Retry must not grow this without limit —
			// by the same constant that bounds what a recipient accepts from
			// `prior_tags`, so the two cannot drift apart.
			'while (target.priorTags.length > MAX_PRIOR_TAGS) target.priorTags.shift();'
		]
	},
	{
		name: '3 — a provisional (id 0) never overwrites a real durable id (our-own)',
		// v1.18.0: adoption goes through ONE function, because landing a durable
		// copy now also has to clear the "still waiting for the chain" markers
		// (sentAtMs, provisionalSinceMs, unrecorded) — see neverRecorded.test.ts.
		mustHave: [
			'if (isDurable && (m.id === null || m.id === 0)) adoptDurable(m, rec);',
			'function adoptDurable(m: LocalMessage, rec: ChatMessageRecord): void {',
			'm.id = rec.id;'
		]
	},
	{
		name: '4 — incoming branch extracts the client_tag + provisional flag',
		mustHave: [
			'const incomingTag = clientTagFromHeader(rec.header);',
			'const isDurable = rec.id !== 0;'
		]
	},
	{
		// The tag is the SENDER's to choose, so a twin must also carry the same
		// encrypted bytes (v1.18.0 review, W1) — else a never-recorded message
		// could inherit a different message's chain proof.
		name: '5 — incoming twin found by (sender + client_tag + identical wire), durable id adopted, then dedup-continue',
		mustHave: [
			'const wire = wireOf(rec);',
			'const twin = messages.find(',
			'm.sender === rec.sender &&',
			'm.clientTag === incomingTag &&',
			'm.wire === wire',
			'if (isDurable && (twin.id === null || twin.id === 0)) {',
			'adoptDurable(twin, rec);'
		]
	},
	{
		name: '6 — provisional incoming stored with null id + its client_tag tracked (not the old clientTag:null)',
		mustHave: ['id: isDurable ? rec.id : null,', 'clientTag: incomingTag,']
	},
	{
		name: '7 — seenIds dedup is gated on isDurable (a provisional id 0 must not collide in seenIds)',
		mustHave: ['if (isDurable && seenIds.has(rec.id)) {'],
		// The pre-change unconditional form must be gone.
		mustNotHave: ['\t\t\t\tif (seenIds.has(rec.id)) continue;\n\t\t\t\tconst d = await decryptOrPlaceholder']
	},
	{
		name: '6a — our own provisional from ANOTHER session is stored with a null id too',
		// Every provisional carries id 0. Stored as an id, the 0 entered seenIds
		// and silenced each later provisional from that session until its
		// durable copy arrived. Behaviour is pinned in neverRecorded.test.ts.
		mustHave: [
			'// from our other session until its durable copy arrived.\n\t\t\t\t\tid: isDurable ? rec.id : null,',
			'if (isDurable && seenIds.has(rec.id)) continue;'
		]
	},
	{
		name: '8 — SAFETY: twin dedup happens BEFORE decode/record, so a durable twin never re-records a money-flow payload',
		check: () => {
			// The incoming twin-collapse block must appear (and `continue`)
			// strictly before the recordAddressShared/recordFundsSent side
			// effects, so an upgraded twin skips them entirely.
			const twinIdx = body.indexOf('const twin = messages.find(');
			const recordIdx = body.indexOf('recordAddressShared({');
			if (twinIdx < 0) return 'twin-find not present';
			if (recordIdx < 0) return 'recordAddressShared not present';
			if (twinIdx >= recordIdx) {
				return `twin-find (idx ${twinIdx}) must come before recordAddressShared (idx ${recordIdx})`;
			}
			// And the twin block must end in a `continue;` between the two,
			// so control never falls through to the decode/record path.
			const between = body.slice(twinIdx, recordIdx);
			if (!/added = true;\s*continue;/.test(between)) {
				return 'twin block does not dedup-continue before the decode/record side effects';
			}
			return null;
		}
	}
];

let failures = 0;
let count = 0;

for (const s of SCENARIOS) {
	count++;
	const missing = (s.mustHave ?? []).filter((m) => !body.includes(m));
	const regressed = (s.mustNotHave ?? []).filter((m) => body.includes(m));
	const customErr = s.check ? s.check() : null;
	if (missing.length === 0 && regressed.length === 0 && customErr === null) {
		console.log(`  ✓ ${s.name}`);
		continue;
	}
	failures++;
	console.log(`  ✗ ${s.name}`);
	for (const m of missing) console.log(`      missing: ${JSON.stringify(m)}`);
	for (const m of regressed) console.log(`      regressed (old pattern present): ${JSON.stringify(m)}`);
	if (customErr) console.log(`      ${customErr}`);
}

console.log(`\n${count} scenarios, ${failures} failed`);
if (failures > 0) {
	console.error('chat-fastpath-dedup-smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${count} chat-fastpath-dedup scenarios passed`);
