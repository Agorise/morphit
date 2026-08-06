#!/usr/bin/env tsx
/*
 * rpc-probe-failure-reason — cp471 (tt.txt C) guard.
 *
 * The settings "RPC endpoints" card used to render a flat red "unreachable"
 * for EVERY failure mode, because `probeOne` collapsed TLS errors, non-2xx
 * answers, JSON-RPC errors, DNS failures and timeouts into a bare `ok:false`.
 *
 * That is not a cosmetic problem: rpc.blurt.blog's operator confirmed to Ken
 * that every request returns 200 and that he had just renovated the balancer
 * certificate — i.e. the node was FINE and our probe was failing the TLS
 * handshake, while the card blamed the node for being "unreachable" and sent
 * Ken chasing the wrong problem.
 *
 * This sentinel locks the diagnosis chain:
 *   1. classifyProbeError maps each real Node/undici error code to the right
 *      stable reason (the actual function, called directly — functional, not
 *      a source scan);
 *   2. the probe still reports a reason for the answered-but-bad cases
 *      (non-2xx / JSON-RPC error / unparseable body) rather than silently
 *      dropping to "unreachable";
 *   3. the PUBLIC vocabulary contains no 'cors' member — the probe is
 *      server-side, so CORS can never be the cause, and claiming it would be
 *      a lie to the operator reading the card;
 *   4. the card maps every reason to its own one-liner and only falls back to
 *      the generic "unreachable" label as a default;
 *   5. every reason key exists in all 10 locales.
 *
 * Revert any of it and this fails.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyProbeError } from '../src/api/rpcHealth';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

let pass = 0;
let fail = 0;
function ok(msg: string): void {
	pass++;
	console.log(`  ✓ ${msg}`);
}
function bad(scope: string, msg: string): void {
	fail++;
	console.log(`  ✗ ${scope}: ${msg}`);
}

// ── 1. Functional: the classifier maps real error shapes ────────────
// Node's fetch throws TypeError('fetch failed') with the true cause on
// `err.cause.code`; an abort surfaces via `name`.
const CASES: ReadonlyArray<{ label: string; err: unknown; want: string }> = [
	{ label: 'expired cert', err: { cause: { code: 'CERT_HAS_EXPIRED' } }, want: 'tls' },
	{
		label: 'untrusted chain',
		err: { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } },
		want: 'tls'
	},
	{ label: 'wrong host on cert', err: { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }, want: 'tls' },
	{ label: 'self-signed', err: { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }, want: 'tls' },
	{ label: 'DNS miss', err: { cause: { code: 'ENOTFOUND' } }, want: 'dns' },
	{ label: 'DNS temp fail', err: { cause: { code: 'EAI_AGAIN' } }, want: 'dns' },
	{ label: 'refused', err: { cause: { code: 'ECONNREFUSED' } }, want: 'refused' },
	{ label: 'abort/deadline', err: { name: 'AbortError' }, want: 'timeout' },
	{ label: 'undici headers timeout', err: { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }, want: 'timeout' },
	{ label: 'connection reset', err: { cause: { code: 'ECONNRESET' } }, want: 'network' },
	{ label: 'unknown error', err: new Error('boom'), want: 'network' }
];
let classifyBad = 0;
for (const c of CASES) {
	const got = classifyProbeError(c.err);
	if (got !== c.want) {
		classifyBad++;
		bad('classify', `${c.label}: expected '${c.want}', got '${got}'`);
	}
}
if (classifyBad === 0) ok(`classifyProbeError: all ${CASES.length} real error shapes map correctly`);

// ── 2-4. Source guards on the probe + the card ──────────────────────
const health = readFileSync(resolve(REPO, 'apps/indexer/src/api/rpcHealth.ts'), 'utf8');
const flatHealth = health.replace(/\s+/g, ' ');
const card = readFileSync(resolve(REPO, 'apps/web/src/lib/components/EndpointList.svelte'), 'utf8');
const flatCard = card.replace(/\s+/g, ' ');

// The answered-but-bad cases must each carry their own reason.
for (const [reason, why] of [
	['http', 'a non-2xx answer (e.g. a 403 from a WAF in front of the node)'],
	['rpc_error', 'HTTP 200 with a JSON-RPC error'],
	['bad_body', 'HTTP 200 with an unparseable body']
] as const) {
	if (new RegExp(`reason: '${reason}'`).test(flatHealth)) {
		ok(`probe reports '${reason}' for ${why}`);
	} else {
		bad('probe', `no longer reports '${reason}' — ${why} would collapse back into a flat "unreachable" (cp471, tt.txt C)`);
	}
}

// The HTTP status must ride along, or "blocked by a security policy" is unprovable.
if (/httpStatus: res\.status/.test(flatHealth)) {
	ok('probe carries the HTTP status alongside an http failure');
} else {
	bad('probe', 'the HTTP status is no longer captured — the card cannot distinguish 403 (blocked) from 502 (bad gateway).');
}

// PRIVACY/honesty: no 'cors' in the public vocabulary.
// Strip comments first — the source deliberately EXPLAINS in prose that a
// 'cors' code can never exist here, and that explanation must not trip the
// guard. We only want real code (a union member / a switch case).
function stripComments(src: string): string {
	return src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '');
}
const codeHealth = stripComments(health).replace(/\s+/g, ' ');
const codeCard = stripComments(card).replace(/\s+/g, ' ');
if (/'cors'/.test(codeHealth) || /'cors'/.test(codeCard)) {
	bad(
		'vocabulary',
		"a 'cors' failure reason appeared. The probe runs SERVER-SIDE (the browser never pings a node — privacy #1, locked by endpoint-error-classify-smoke), so CORS cannot be the cause and must never be shown."
	);
} else {
	ok("no 'cors' reason in the public vocabulary (the probe is server-side; CORS is impossible here)");
}

// The card maps each reason to its own line, with the generic label as default.
const CARD_KEYS = [
	'err_timeout',
	'err_tls',
	'err_dns',
	'err_refused',
	'err_rpc',
	'err_body',
	'err_http',
	'err_http_blocked',
	'err_http_rate'
] as const;
const missingCard = CARD_KEYS.filter((k) => !flatCard.includes(`settings.endpoints.${k}`));
if (missingCard.length === 0) {
	ok(`card renders a distinct one-liner for all ${CARD_KEYS.length} failure reasons`);
} else {
	bad('card', `missing reason line(s): ${missingCard.join(', ')} — those failures would fall back to the useless flat label.`);
}
if (/default: return \$_\('settings\.endpoints\.unreachable'\)/.test(flatCard)) {
	ok('card falls back to the plain "Unreachable" label only as the default');
} else {
	bad('card', 'the generic "unreachable" fallback is gone — an unclassified failure would render blank.');
}

// ── 5. EVERY shipped locale carries every reason key ────────────────
// Derived from the on-disk locale files, never a hardcoded list: an inline
// array silently under-covers the day an 11th locale graduates, which is
// exactly what locale-source-of-truth-smoke forbids (it caught this).
const LOCALES = readdirSync(resolve(REPO, 'apps/web/src/lib/i18n/locales'))
	.filter((f) => f.endsWith('.json') && !f.endsWith('_meta.json'))
	.map((f) => f.slice(0, -'.json'.length))
	.sort();
let localeBad = 0;
for (const loc of LOCALES) {
	const json = JSON.parse(
		readFileSync(resolve(REPO, `apps/web/src/lib/i18n/locales/${loc}.json`), 'utf8')
	) as { settings?: { endpoints?: Record<string, unknown> } };
	const ep = json.settings?.endpoints ?? {};
	const missing = CARD_KEYS.filter((k) => typeof ep[k] !== 'string' || (ep[k] as string).length === 0);
	if (missing.length > 0) {
		localeBad++;
		bad(`locale ${loc}`, `missing endpoint reason key(s): ${missing.join(', ')}`);
	}
}
if (localeBad === 0) ok(`all ${LOCALES.length} locales carry every failure-reason string`);

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
