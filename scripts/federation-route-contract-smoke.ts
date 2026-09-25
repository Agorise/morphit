#!/usr/bin/env tsx
/**
 * federation-route-contract-smoke — one path, four homes, pinned together.
 *
 * `/v1/federation/chat-fast` is written out as a literal in four places that
 * must agree, and nothing tied them:
 *
 *   1. THE SENDER   `chatFastFederation.ts` builds the URL it POSTs to.
 *   2. THE RECEIVER `main.ts` mounts the intake route at that path.
 *   3. THE BODY CAP `middleware/bodyCap.ts` raises the request-size limit for a
 *      path PREFIX, and the mount has to fall inside it.
 *   4. THE DOCTOR   `ops-cli/commands/doctor.ts` probes it through the public
 *      origin to check the operator's reverse proxy passes a large batch.
 *
 * WHY THIS IS NOT PARANOIA. Move the mount in (2) and every peer's push 404s:
 * federated chat stops entirely, for the whole federation at once, and nothing
 * errors — messages just quietly go back to chain timing, which is the exact
 * symptom this release was created to remove. The existing smoke would not
 * notice, because it mounts the intake app itself in-process rather than going
 * through `main.ts`, so it pins the sender against a copy of the path rather
 * than against the receiver.
 *
 * Move it outside `/v1/federation/` and something subtler happens: the route
 * still works for single messages and the body cap silently reverts to the read
 * default, so batches are refused once the instance is busy. That is finding
 * F4's shape — a limit nobody checked the batch against — and it was found the
 * hard way once already.
 *
 * This is the same remedy as `federation-intake-contract-smoke`, for the same
 * reason: when a decision is implemented more than once, the copies will
 * disagree and every one of them will look right on its own.
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

const senderSrc = read('apps/indexer/src/indexer/chatFastFederation.ts');
const mainSrc = read('apps/indexer/src/main.ts');
const capSrc = read('apps/indexer/src/api/middleware/bodyCap.ts');
const doctorSrc = read('apps/ops-cli/src/commands/doctor.ts');

/** The suffix the sender appends to a peer's origin. */
function senderPath(): string | null {
	const m = /const url = `\$\{addr\.origin\.replace\([^)]*\)\}([^`]+)`/.exec(senderSrc);
	return m === null ? null : m[1]!;
}

/** The path `main.ts` mounts the intake app at. */
function mountPath(): string | null {
	const m = /app\.route\(\s*'([^']+)'\s*,\s*chatFastIntake\.app\s*\)/.exec(mainSrc);
	return m === null ? null : m[1]!;
}

/** The prefix that earns the raised federation body cap. */
function bodyCapPrefix(): string | null {
	const m = /federationMax !== undefined && path\.startsWith\('([^']+)'\)/.exec(capSrc);
	return m === null ? null : m[1]!;
}

/** The path the doctor probes through the public origin. */
function doctorPath(): string | null {
	const m = /fetch\(`\$\{origin\}([^`]+)`/.exec(doctorSrc);
	return m === null ? null : m[1]!;
}

const sender = senderPath();
const mount = mountPath();
const prefix = bodyCapPrefix();
const doctor = doctorPath();

// Each must be FOUND. A parse failure here is itself a finding: it means one of
// the four was rewritten into a shape this smoke cannot read, and an unreadable
// contract is an unchecked one.
for (const [name, v] of [
	['sender URL', sender],
	['main.ts mount', mount],
	['bodyCap prefix', prefix],
	['doctor probe', doctor]
] as const) {
	if (v !== null) ok(`found the ${name}: ${v}`);
	else
		bad(
			`could not read the ${name} — it has been rewritten into a shape this smoke cannot parse`,
			'an unreadable contract is an unchecked one; update the matcher deliberately'
		);
}

// THE CHECK. Sender and receiver must be the same string, or every push 404s.
if (sender !== null && mount !== null) {
	if (sender === mount) ok('the sender posts to exactly the path the receiver mounts');
	else
		bad(
			'the sender and the receiver disagree about the federation path',
			`sender posts to "${sender}", main.ts mounts "${mount}" — every peer push would 404 ` +
				'and federated chat would fall back to chain timing across the whole federation, silently'
		);
}

// The mount has to sit inside the body-cap prefix, or a batch is refused by the
// read default once the instance is busy enough to batch at all.
if (mount !== null && prefix !== null) {
	if (mount.startsWith(prefix))
		ok(`the mount sits inside the raised body-cap prefix (${prefix})`);
	else
		bad(
			'the federation route is outside the raised body-cap prefix',
			`mount "${mount}" does not start with "${prefix}" — single messages keep working and ` +
				'BATCHES are refused, which only happens once the instance is busy'
		);
}

// The doctor must probe the path that actually exists, or its all-clear is
// meaningless — it would be testing the proxy against a 404.
if (doctor !== null && mount !== null) {
	if (doctor === mount) ok('the doctor probes the path the receiver actually mounts');
	else
		bad(
			'the doctor probes a different path from the one mounted',
			`doctor "${doctor}" vs mount "${mount}" — its batch-size check would pass or fail on a ` +
				'404 rather than on the reverse proxy it is meant to be testing'
		);
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('✗ federation-route contract FAILED');
	process.exit(1);
}
console.log(`✓ all ${pass} federation-route contract scenarios passed`);
