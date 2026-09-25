#!/usr/bin/env tsx
/**
 * fastpath-always-on — v1.7.0, ADR-0051.
 *
 * THE DECISION THIS PINS. The head-block fast path has NO on/off switch, and
 * that is deliberate rather than an oversight someone should "fix" later.
 *
 * ADR-0048 shipped `MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED` as an opt-out for
 * operators who wanted nothing shown until it was irreversible. v1.7.0 removed
 * it — REMOVED, not renamed — because the reasoning didn't survive contact with
 * what the tailer actually is: it never writes the database, so the worst a
 * broken fast path can do is fail to make things fast. There is nothing to
 * protect an operator from, and nobody prefers slow. A flag that is always true
 * is a branch that can be wrong, config that can drift, a second path every
 * smoke must cover, and — via the old `Fast chat: on` health line — an
 * invitation for an operator to conclude that slow is a thing they might want.
 *
 * This replaced `upgrade-fastpath-ensure-smoke`, which existed to check the
 * knob was on. Guarding "the knob is gone" is the same job for the opposite
 * world, so it keeps the registration slot rather than shifting every chunk
 * index after it.
 *
 * Tamper tests (each must turn this smoke red):
 *   - Re-add MORPHIT_INDEXER_CHAT_FASTPATH_ENABLED to the env schema → fails.
 *   - Re-add an `enabled` gate to HeadTailer.run() → fails.
 *   - Put the dead var back in ops/env/indexer.env.example → fails.
 *   - Re-add `enabled` to HeadTailerStatus → fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

/**
 * The same source with its PROSE removed.
 *
 * The no-writes checks below are greps for SQL keywords, and a grep cannot tell
 * a query from a sentence about a query. That is not a hypothetical: the comment
 * explaining why a particular `UPDATE` was removed contains the word UPDATE, so
 * the check failed on a file that does exactly what the check wants. Left alone,
 * the pressure is to reword the explanation until the test is happy — which
 * trades a good comment for a green tick and teaches the next person to do the
 * same.
 *
 * So strip the comments and grep the code. Deliberately conservative: it removes
 * block comments and lines that are ENTIRELY a comment, and never touches a line
 * with code on it. A `//` inside a string literal (a URL, say) is therefore left
 * alone rather than risking truncating real code after it — this must not hide a
 * write, only prose.
 */
/**
 * A database WRITE, as opposed to the word "delete".
 *
 * Matched as SQL SHAPES rather than bare keywords, which matters more than it
 * looks: `\bDELETE\b` is case-insensitive, so it fires on `seen.delete(k)` —
 * an ordinary Map operation. The original check was a bare-keyword grep and got
 * away with it only because the one file it read happened not to use a Map.
 * Pointing the same regex at the federation module lit up on four harmless
 * lines, which is how a check earns a reputation for crying wolf and then gets
 * loosened by whoever is unlucky enough to hit it.
 *
 * `withTx(` stays as a plain call match: it is this codebase's own transaction
 * helper, and there is no innocent reason for it to appear on a read-only path.
 */
const WRITES_SQL = /\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|withTx\(/i;

const codeOnly = (src: string): string =>
	src
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.split('\n')
		.filter((line) => {
			const t = line.trim();
			return !t.startsWith('//') && !t.startsWith('*');
		})
		.join('\n');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── fastpath-always-on (v1.7.0 / ADR-0051) ─────────────\n');

const config = read('apps/indexer/src/config/index.ts');
const tailer = read('apps/indexer/src/indexer/headTailer.ts');
// v1.18.0 — the fast path is no longer only the tailer. A chat message can now
// reach the event bus from a PEER, through these two files, and the invariant
// below has to cover every route to that bus or it covers nothing.
const federation = read('apps/indexer/src/indexer/chatFastFederation.ts');
const intake = read('apps/indexer/src/api/federationChatFast.ts');
const envExample = read('ops/env/indexer.env.example');
const opsHealth = read('apps/ops-cli/src/commands/health.ts');

// ─── the knob is gone from every layer it lived in ───────────────
// Match a DECLARATION, not a mention: the files explain WHY the var was
// removed, and a guard that punishes documentation is a guard people delete.
check(
	'env schema declares no *_FASTPATH_ENABLED var',
	!/^\s*MORPHIT_[A-Z_]*FASTPATH_ENABLED\s*:/m.test(config),
	'fast is not an operator preference — see ADR-0051'
);
check(
	'Config has no fastPathEnabled / chatFastPathEnabled field',
	!/readonly\s+(chat)?[fF]astPathEnabled\s*:/.test(config)
);
check(
	'the interval knob survives (a straining node needs a real lever)',
	/MORPHIT_INDEXER_FASTPATH_INTERVAL_MS\s*:/.test(config) &&
		/readonly fastPathIntervalMs: number;/.test(config)
);

// ─── run() must not be gateable ──────────────────────────────────
check(
	'HeadTailer.run() has no enabled gate',
	!/if \(!this\.config\.[a-zA-Z]*[fF]astPathEnabled\)/.test(tailer),
	'an early return here silently restores the opt-out'
);
check(
	'HeadTailerStatus reports no always-true `enabled`',
	!/export interface HeadTailerStatus \{[^}]*readonly enabled:/s.test(tailer),
	'a status field that cannot vary is noise at best, misleading at worst'
);

// ─── operator-facing surfaces ────────────────────────────────────
check(
	'env example ships no dead FASTPATH_ENABLED assignment',
	!/^MORPHIT_[A-Z_]*FASTPATH_ENABLED=/m.test(envExample)
);
check(
	'env example ships the interval under its new name',
	/^MORPHIT_INDEXER_FASTPATH_INTERVAL_MS=/m.test(envExample)
);
check(
	'health reports LAG, not an on/off line',
	/FASTPATH_HEALTHY_LAG_BLOCKS/.test(opsHealth) && /behind head/.test(opsHealth),
	'"running" is not the question — "is it keeping up" is'
);
check(
	'health parses the `fastpath` block, not `chat_fastpath`',
	/parseFastPath\(b\.fastpath\)/.test(opsHealth)
);

// ─── the invariant that makes losing the switch safe ─────────────
// This is the load-bearing premise of the whole decision. If the tailer ever
// starts writing to the DB, removing the operator's off switch stops being
// defensible and this file's reasoning is void.
check(
	'the tailer still NEVER writes the database (premise of all the above)',
	!WRITES_SQL.test(codeOnly(tailer)),
	'if the fast path can write, a reorg can corrupt state and the opt-out has to come back'
);

// THE SAME INVARIANT, ON THE ROUTE IT ESCAPED THROUGH.
//
// This check used to read headTailer.ts and nothing else, and v1.18.0 added a
// second way into the same event bus: a peer pushes a signed message to
// /v1/federation/chat-fast. A remediation in that release then added an
// `UPDATE accounts SET posting_pubkey` on that path — an entirely reasonable
// line to write, which quietly broke the premise this whole file exists to
// defend, and nothing here noticed because nothing here looked. A fact-check
// caught it; a test should have.
//
// It is also worth stating WHY that particular write was wrong, because "it is
// only a cache" was the obvious defence: `posting_pubkey` had been write-once,
// so a hostile RPC node could poison it only at first observation. Persisting a
// re-read let one poison it on demand, for any account, by answering a single
// query. The correction is held in memory instead.
for (const [name, src] of [
	['the federation module', federation],
	['the federation intake route', intake]
] as const) {
	check(
		`${name} NEVER writes the database either (same premise, second route)`,
		!WRITES_SQL.test(codeOnly(src)),
		'a chat message can reach the event bus from a peer now, so the no-writes premise ' +
			'has to hold on that route too — or a reorg can corrupt state and the opt-out ' +
			'has to come back'
	);
}

// ── THE FAN-OUT IS ONE HOP, AND NOTHING MADE IT SO ──────────────────
//
// A chat message is fanned out by the instance whose user SENT it, to every
// peer. A peer that received one must not fan it out again — and today none
// does, purely because `dispatchIfChat` is called from the broadcast route and
// from nowhere else. That is the entire mechanism: an absence.
//
// WHAT THE ABSENCE IS WORTH. With forty peers, one message currently costs
// forty pushes. Re-dispatch on receipt makes it forty plus forty times forty:
// sixteen hundred pushes for one message, every one of them a real request over
// a hidden transport. It terminates — the replay memory answers `duplicate` on
// the second round — so it would not run away, which is precisely what makes it
// dangerous: it looks survivable in a test with three instances and melts a
// federation of forty under ordinary load.
//
// It is also an EASY line to write, with a good reason attached: "relay it on,
// in case a peer we can reach cannot be reached by the sender." The answer is
// that the chain already carries that case, durably, and a mesh is a different
// design decision from this one — it is not a tweak to the intake route.
//
// Checked structurally because there is nothing else to check: the intake route
// takes no dispatcher, so there is no seam to drive and no behaviour to
// observe. The absence IS the property, so the absence is what is asserted.
{
	const dispatchCalls = /\bdispatchIfChat\s*\(/.exec(codeOnly(intake));
	check(
		'the federation intake NEVER re-fans a received message to other peers',
		dispatchCalls === null,
		'one message would become one push per peer PER PEER — sixteen hundred requests ' +
			'over hidden transports for a single chat line in a forty-instance federation. ' +
			'It terminates on the replay memory rather than running away, which is what ' +
			'makes it look survivable in a three-instance test'
	);
	check(
		'...nor constructs a dispatcher of its own to do it with',
		!/\bChatFastDispatcher\b|\bPeerSender\b/.test(codeOnly(intake)),
		'the intake route holding a sender is the shape that precedes re-fanning, ' +
			'whatever it was added for'
	);
}

console.log(`\n${'─'.repeat(54)}`);
if (failed === 0) {
	console.log(`✓ all ${passed} fastpath-always-on checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed}/${passed + failed} fastpath-always-on checks failed`);
	process.exit(1);
}
