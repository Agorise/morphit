#!/usr/bin/env tsx
/**
 * Surface-invariant adversarial smoke — the @↔# replacement
 * footgun.
 *
 * Memory: blanket @user:server → #room:server replacement is
 * actively harmful — would route private security alerts to a
 * public room.  The reverse (room alias → MXID) would publish
 * an MXID where users expect a public room link.
 *
 * This smoke independently verifies the rule at every boundary:
 *
 *   1. parseMxid + parseRoomAlias correctly accept/reject their
 *      respective inputs, including adversarial cases (sigil-
 *      swapped, embedded sigil, lookalike characters).
 *   2. The bot's config parser refuses #-prefixed values in
 *      MORPHIT_MATRIX_BOT_ALERT_MXID with an explicit error
 *      message that mentions the asymmetric harm.
 *   3. The indexer's config schema refuses @-prefixed values in
 *      MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM with the
 *      reciprocal explicit error.
 *   4. /v1/instance response shape exposes operator_matrix_room
 *      but NOT any field carrying an MXID — verified by grepping
 *      the InstanceResponse type definition.
 *   5. matrix.ts sendDm() only accepts MatrixMxid (branded type)
 *      — verified by grepping the function signature.
 *   6. The classifier renders alerts but doesn't itself reach
 *      out to the room alias for anything — verified by static
 *      analysis.
 *
 * Failures here are SHIP-BLOCKERS.  Memory's "actively harmful"
 * framing applies.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMxid, parseRoomAlias } from '@morphit/operator-config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');

interface Check {
	readonly name: string;
	readonly fn: () => string | null; // null = pass; string = failure reason
}

const checks: Check[] = [];

// ─── Layer 1: parser-level invariants ────────────────────────────

checks.push({
	name: 'parseMxid accepts @user:server',
	fn: () =>
		parseMxid('@alice:matrix.org') === '@alice:matrix.org'
			? null
			: 'expected pass-through return'
});

checks.push({
	name: 'parseMxid REJECTS #room:server (would route alerts to public room)',
	fn: () => (parseMxid('#agorise:matrix.org') === null ? null : 'must reject room aliases')
});

checks.push({
	name: 'parseRoomAlias accepts #room:server',
	fn: () =>
		parseRoomAlias('#agorise:matrix.org') === '#agorise:matrix.org'
			? null
			: 'expected pass-through return'
});

checks.push({
	name: 'parseRoomAlias REJECTS @user:server (would publish MXID where room expected)',
	fn: () =>
		parseRoomAlias('@alice:matrix.org') === null ? null : 'must reject MXIDs'
});

checks.push({
	name: 'parseMxid REJECTS empty / null / whitespace / sigil-only',
	fn: () => {
		const adversarial = ['', ' ', '@', '@:', '@a:', '@:server', ':server', '@ :server'];
		for (const x of adversarial) {
			if (parseMxid(x) !== null) return `accepted ${JSON.stringify(x)} (should reject)`;
		}
		return null;
	}
});

checks.push({
	name: 'parseRoomAlias REJECTS empty / sigil-only / embedded @',
	fn: () => {
		const adversarial = ['', '#', '#:', '#a:', '#:server', '#@foo:server', '#a@b:server'];
		for (const x of adversarial) {
			if (parseRoomAlias(x) !== null) return `accepted ${JSON.stringify(x)} (should reject)`;
		}
		return null;
	}
});

checks.push({
	name: 'parsers REJECT lookalike sigils (homoglyphs)',
	fn: () => {
		// Cyrillic а, fullwidth ＠, mathematical # variants — should
		// all be rejected because the first char must be ASCII @ or #.
		const lookalikes = ['а:server', 'ａlice:matrix.org', '＠alice:matrix.org', '＃alice:matrix.org'];
		for (const x of lookalikes) {
			if (parseMxid(x) !== null) return `parseMxid accepted ${JSON.stringify(x)}`;
			if (parseRoomAlias(x) !== null) return `parseRoomAlias accepted ${JSON.stringify(x)}`;
		}
		return null;
	}
});

checks.push({
	name: 'parsers REJECT 513-char input (length bound)',
	fn: () => {
		const big = '@' + 'a'.repeat(600) + ':matrix.org';
		if (parseMxid(big) !== null) return 'overlong MXID accepted';
		const bigRoom = '#' + 'a'.repeat(600) + ':matrix.org';
		if (parseRoomAlias(bigRoom) !== null) return 'overlong room alias accepted';
		return null;
	}
});

// ─── Layer 2: bot config parser ──────────────────────────────────

checks.push({
	name: 'bot config.ts EXPLICITLY rejects #-prefixed value in ALERT_MXID with @↔# guidance in error',
	fn: () => {
		const src = readFileSync(
			join(REPO_ROOT, 'apps/matrix-bot/src/config.ts'),
			'utf-8'
		);
		// The defense-in-depth guard must exist + must mention the
		// asymmetric harm explicitly so an operator hitting it knows
		// WHY (rather than just "not a valid MXID").
		if (!/raw\.startsWith\(['"]#['"]\)/.test(src)) {
			return 'config.ts missing the explicit # prefix guard for ALERT_MXID';
		}
		// The error should mention the privacy implication so an
		// operator hitting this in production understands the stakes.
		if (!/privacy violation|private|public room/i.test(src)) {
			return 'config.ts # guard error message must explain WHY (privacy stakes)';
		}
		return null;
	}
});

// ─── Layer 3: indexer config schema ──────────────────────────────

checks.push({
	name: 'indexer schema rejects @-prefixed value in OPERATOR_MATRIX_ROOM (via parseRoomAlias)',
	fn: () => {
		const src = readFileSync(
			join(REPO_ROOT, 'apps/indexer/src/config/index.ts'),
			'utf-8'
		);
		if (!/MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM/.test(src)) {
			return 'indexer config missing OPERATOR_MATRIX_ROOM env var';
		}
		if (!/parseRoomAlias/.test(src)) {
			return 'indexer config must call parseRoomAlias to validate (single SoT)';
		}
		// The error message must mention the alternative env var so the
		// operator knows where the MXID should have gone.
		if (!/MORPHIT_MATRIX_BOT_ALERT_MXID/.test(src)) {
			return 'indexer config error must mention MORPHIT_MATRIX_BOT_ALERT_MXID as the correct slot for @-prefixed input';
		}
		// And the error must mention the privacy framing (public API,
		// would leak private MXID).
		if (!/public|leak|private/i.test(src)) {
			return 'indexer config error must explain WHY (privacy stakes of exposing MXID via public API)';
		}
		return null;
	}
});

/** Strip TypeScript line + block comments from source.  The
 *  MXID-exposure invariant must check actual field declarations,
 *  not comment text that mentions the env var names for
 *  documentation purposes. */
function stripComments(src: string): string {
	// Block comments /* ... */
	src = src.replace(/\/\*[\s\S]*?\*\//g, '');
	// Line comments // ...
	src = src.replace(/\/\/.*$/gm, '');
	return src;
}

// ─── Layer 4: /v1/instance never exposes an MXID ──────────────────

checks.push({
	name: '/v1/instance InstanceResponse exposes operator_matrix_room ONLY (no MXID field)',
	fn: () => {
		const src = readFileSync(
			join(REPO_ROOT, 'apps/indexer/src/api/instance.ts'),
			'utf-8'
		);
		// Must have the public room field.
		if (!/operator_matrix_room:\s*string\s*\|\s*null/.test(src)) {
			return 'InstanceResponse missing operator_matrix_room: string | null';
		}
		// Strip comments before checking for MXID-shaped FIELDS.
		// Match identifier-like patterns followed by `:` (TS field
		// declaration) — that way doc comments mentioning
		// `MORPHIT_MATRIX_BOT_ALERT_MXID` don't trip the smoke.
		const code = stripComments(src);
		if (/\b(alert_mxid|operator_mxid|admin_mxid|matrix_bot_alert_mxid)\s*[?:]/i.test(code)) {
			return 'InstanceResponse contains a field looking like an MXID exposure — must never expose @user:server publicly';
		}
		// `operator_matrix_*` patterns OTHER than `_room`.
		if (/\boperator_matrix_(?!room\b)[a-z_]+\s*[?:]/i.test(code)) {
			return 'InstanceResponse contains an operator_matrix_* field other than _room — review for MXID leak';
		}
		return null;
	}
});

// ─── Layer 5: matrix.ts sender accepts MatrixMxid only ───────────

checks.push({
	name: 'matrix.ts sendDm() typed signature requires MatrixMxid (branded — prevents passing room alias)',
	fn: () => {
		const src = readFileSync(
			join(REPO_ROOT, 'apps/matrix-bot/src/matrix.ts'),
			'utf-8'
		);
		if (!/sendDm\(\s*to:\s*MatrixMxid/.test(src)) {
			return 'sendDm signature must take MatrixMxid (not plain string) — branded type prevents room-alias misuse';
		}
		if (!/from\s+['"]@morphit\/operator-config['"]/.test(src)) {
			return 'matrix.ts must import MatrixMxid from @morphit/operator-config (single SoT)';
		}
		return null;
	}
});

// ─── Layer 6: classifier emits via the typed sender path only ────

checks.push({
	name: 'main.ts wires classifier → sendDm chain; no direct room-alias send in CODE',
	fn: () => {
		const src = readFileSync(
			join(REPO_ROOT, 'apps/matrix-bot/src/main.ts'),
			'utf-8'
		);
		// The bot must iterate config.alertMxids when sending.
		if (!/for\s*\(\s*const\s+mxid\s+of\s+config\.alertMxids/.test(src)) {
			return 'main.ts must iterate config.alertMxids (the typed MXID list) when sending';
		}
		// Strip comments — the file LEGITIMATELY references
		// operator_matrix_room in its module docstring to explain
		// the invariant; that's documentation, not a code path.
		const code = stripComments(src);
		// In CODE: no read of operator_matrix_room.  Match either a
		// property access (`.operator_matrix_room`) or an object key
		// in a destructure (`{ operator_matrix_room`).
		if (/\.\s*operator_matrix_room\b|\{\s*[^}]*operator_matrix_room\b/.test(code)) {
			return 'main.ts CODE must not read operator_matrix_room — that field is for the indexer\'s public API; the bot must only send to alertMxids';
		}
		return null;
	}
});

// ─── Layer 7: indexer-client mirror preserves the split ──────────

checks.push({
	name: 'indexer-client InstanceResponse mirror exposes operator_matrix_room ONLY (no MXID leak)',
	fn: () => {
		const src = readFileSync(
			join(REPO_ROOT, 'packages/indexer-client/src/index.ts'),
			'utf-8'
		);
		if (!/operator_matrix_room\?\s*:\s*string\s*\|\s*null/.test(src)) {
			return 'indexer-client InstanceResponse missing operator_matrix_room?: string | null';
		}
		// Field-declaration pattern, comments stripped — same logic
		// as Layer 4.
		const code = stripComments(src);
		if (/\b(alert_mxid|operator_mxid|admin_mxid|matrix_bot_alert_mxid)\s*[?:]/i.test(code)) {
			return 'indexer-client InstanceResponse contains a field looking like an MXID exposure — must never';
		}
		return null;
	}
});

// ─── Run ────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
console.log('surface-invariant adversarial smoke:\n');
for (const c of checks) {
	const reason = c.fn();
	if (reason === null) {
		console.log(`  ✓ ${c.name}`);
		pass++;
	} else {
		console.error(`  ✗ ${c.name}`);
		console.error(`      ${reason}`);
		fail++;
	}
}
console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} adversarial invariants hold`);
	process.exit(0);
} else {
	console.error(`✗ ${fail} failed, ${pass} passed — SHIP-BLOCKER`);
	process.exit(1);
}
