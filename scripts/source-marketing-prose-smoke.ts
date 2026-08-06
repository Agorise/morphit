/**
 * Source-marketing-prose smoke (cp152).
 *
 * Catches the cp146 F-mcp-16 class of bug: marketing-grade prose
 * embedded in `.ts` source files (the strings AI agents quote
 * verbatim to users) drifts from the project's #1 Privacy &
 * anonymity priority without any smoke noticing.
 *
 * The cp146 walkthrough surfaced the original instance: the
 * `describeMorphit` tool's summary said "no IP logging by design"
 * which AI agents repeated to users — but the literal truth is
 * "instances see the connecting IP at the HTTP layer; data model
 * retains no per-user IP log; Tor onions available for
 * unlinkability."  cp146 fixed the copy.  cp152 codifies it.
 *
 * The cp141 brag-list-claim-parity-smoke walks MARKETING_DOCS
 * (the brag list, READMEs, etc.).  It DOESN'T walk source files
 * because marketing prose isn't supposed to live in source.
 * But `apps/mcp-server/src/tools/describeMorphit.ts` and
 * `apps/mcp-server/src/tools/searchOrders.ts` each contain
 * marketing-grade claims by design — they're the structured
 * surface AI agents read to summarize Morphit to users.  This
 * smoke gives those claims the same protection.
 *
 * Two invariants per (file, phrase) tuple:
 *
 *   PINNED — phrase MUST be present.  Catches accidental
 *            removal of a load-bearing honesty clause.  Each
 *            pin has a `since` cp-ref so future maintainers
 *            know why it's pinned.
 *
 *   BANNED — phrase MUST NOT appear.  Catches accidental
 *            reintroduction of a known-misleading phrasing.
 *            Each ban has a `from` cp-ref pointing at the bug
 *            that taught us not to use the phrasing.
 *
 * Together: the marketing prose AI agents quote is locked at
 * the cp146 corrected state, with no upward freedom for either
 * removing necessary nuance or reintroducing misleading
 * shorthand.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ANSI_GREEN = '\x1b[32m';
const ANSI_RED = '\x1b[31m';
const ANSI_RESET = '\x1b[0m';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);

interface Result {
	name: string;
	passed: boolean;
	detail?: string;
}
const results: Result[] = [];
function pass(name: string) {
	results.push({ name, passed: true });
}
function fail(name: string, detail: string) {
	results.push({ name, passed: false, detail });
}

/* ---------------- pinned phrases ---------------- */

interface PinnedPhrase {
	file: string;
	phrase: string;
	since: string;
	rationale: string;
}

const PINNED: PinnedPhrase[] = [
	// describeMorphit — the "what is Morphit" summary AI agents
	// repeat to users when asked.  cp146 F-mcp-16 fixed the
	// dishonest "no IP logging by design" to the literal
	// honest version below.  Each clause is pinned because
	// removing it would weaken the user's mental model.

	{
		file: 'apps/mcp-server/src/tools/describeMorphit.ts',
		phrase: 'Instance operators see the connecting IP at the HTTP layer',
		since: 'cp146 F-mcp-16',
		rationale:
			'this is the truthful version of the cp146-corrected IP-visibility clause.  Without it the summary defaults to overclaiming privacy.'
	},
	{
		file: 'apps/mcp-server/src/tools/describeMorphit.ts',
		phrase: 'per-user IP log of its own',
		since: 'cp146 F-mcp-16',
		rationale:
			'the data-model-side honesty clause.  Pairs with the HTTP-layer-side clause above.  Pinned in its source-contiguous form (the full sentence wraps across string-concat lines).'
	},
	{
		file: 'apps/mcp-server/src/tools/describeMorphit.ts',
		phrase: 'Tor onions',
		since: 'cp146 F-mcp-16',
		rationale:
			'the user-actionable mitigation.  Without it the summary leaves the user with no path to IP-level unlinkability.'
	},
	{
		file: 'apps/mcp-server/src/tools/describeMorphit.ts',
		phrase: 'non-custodial',
		since: 'cp140 initial ship',
		rationale:
			'the keys-stay-on-device claim.  Load-bearing for the AI-agent trust model — Charlie tells the user the agent never sees keys.'
	},
	{
		file: 'apps/mcp-server/src/tools/describeMorphit.ts',
		phrase: 'federated',
		since: 'cp140 initial ship',
		rationale:
			"the no-single-point-of-failure claim.  Privacy/decentralization priority #2."
	},
	{
		file: 'apps/mcp-server/src/tools/describeMorphit.ts',
		phrase: 'no email collection',
		since: 'cp140 initial ship',
		rationale: 'the explicit "we do not collect" attestation.'
	},

	// searchOrders — the description AI agents read when deciding
	// whether to invoke the tool and what to expect.

	{
		file: 'apps/mcp-server/src/tools/searchOrders.ts',
		phrase: 'non-custodial and KYC-free',
		since: 'cp140 initial ship',
		rationale:
			'the tool description must reaffirm the trust model so AI agents reading just this string still get the right framing.'
	},
	{
		file: 'apps/mcp-server/src/tools/searchOrders.ts',
		phrase: 'the agent never sees keys',
		since: 'cp140 initial ship',
		rationale:
			"explicit attestation that the MCP server is read-only.  Pairs with cp149's structural read-only-by-construction smoke."
	}
];

/* ---------------- banned phrases ---------------- */

interface BannedPhrase {
	file: string;
	phrase: string;
	from: string;
	rationale: string;
}

const BANNED: BannedPhrase[] = [
	{
		file: 'apps/mcp-server/src/tools/describeMorphit.ts',
		phrase: 'no IP logging by design',
		from: 'cp146 F-mcp-16',
		rationale:
			'this is the pre-cp146 misleading shorthand.  Reads as "no IP visible" which is false — instances see connecting IPs at the HTTP layer.  Use the literal "Instance operators see the connecting IP at the HTTP layer; data model retains no per-user IP log" pinning instead.'
	},
	{
		file: 'apps/mcp-server/src/tools/describeMorphit.ts',
		phrase: 'completely anonymous',
		from: 'cp146 F-mcp-16 class',
		rationale:
			'overclaim.  Morphit does not give anonymity by default — it gives non-custody + no-server-side-account + Tor-onion options.  Anonymity is the user-effort end-state, not the default posture.'
	},
	{
		file: 'apps/mcp-server/src/tools/describeMorphit.ts',
		phrase: 'we cannot see',
		from: 'cp146 F-mcp-16 class',
		rationale:
			'AI agents quote this clause to users; the literal claim "Morphit cannot see X" is rarely true at the HTTP layer.  Use specific "data model retains no per-user log of X" framings instead.'
	},
	{
		file: 'apps/mcp-server/src/tools/searchOrders.ts',
		phrase: 'anonymous',
		from: 'cp146 F-mcp-16 class',
		rationale:
			'searchOrders.ts description should not claim anonymity.  The tool returns public on-chain data; "anonymous" implies more than the trust model delivers.'
	}
];

/* ---------------- scan files ---------------- */

interface FileCache {
	[path: string]: string;
}
const cache: FileCache = {};

function readFile(rel: string): string {
	if (rel in cache) return cache[rel];
	cache[rel] = readFileSync(join(REPO_ROOT, rel), 'utf8');
	return cache[rel];
}

/* ---------------- invariant 1: every pinned phrase is present ---------------- */

interface PinHit {
	file: string;
	phrase: string;
	since: string;
}
const missingPins: PinHit[] = [];

for (const p of PINNED) {
	const src = readFile(p.file);
	if (!src.includes(p.phrase)) {
		missingPins.push({ file: p.file, phrase: p.phrase, since: p.since });
	}
}

if (missingPins.length === 0) {
	pass(`all ${PINNED.length} pinned marketing phrases present in their source files`);
} else {
	const detail = missingPins
		.map(
			(h) =>
				`${h.file} is missing "${h.phrase}" (pinned ${h.since}).  If you intentionally removed it, you may also need to update the cp152 smoke's PINNED list — but first read the original cp-reference to understand why it was pinned.`
		)
		.join('\n      ');
	fail(`all ${PINNED.length} pinned marketing phrases present`, detail);
}

/* ---------------- invariant 2: no banned phrase appears ---------------- */

interface BanHit {
	file: string;
	phrase: string;
	from: string;
}
const presentBans: BanHit[] = [];

for (const b of BANNED) {
	const src = readFile(b.file);
	if (src.includes(b.phrase)) {
		presentBans.push({ file: b.file, phrase: b.phrase, from: b.from });
	}
}

if (presentBans.length === 0) {
	pass(`none of ${BANNED.length} banned phrasings present in source files`);
} else {
	const detail = presentBans
		.map((h) => {
			const rec = BANNED.find((b) => b.file === h.file && b.phrase === h.phrase);
			return `${h.file} contains banned phrase "${h.phrase}" (banned by ${h.from}).  Rationale: ${rec?.rationale ?? '(see BANNED list)'}`;
		})
		.join('\n      ');
	fail(`no banned phrasings present`, detail);
}

/* ---------------- invariant 3: pinned and banned lists are non-empty ---------------- */

// Sanity guard: if a future refactor accidentally truncates one
// of the lists to empty, both invariants would trivially pass.
// Catch that early.

if (PINNED.length === 0) {
	fail('PINNED list is non-empty', 'cp152 smoke is meaningless with no pinned phrases');
} else {
	pass(`PINNED list has ${PINNED.length} entries (non-empty)`);
}

if (BANNED.length === 0) {
	fail('BANNED list is non-empty', 'cp152 smoke is meaningless with no banned phrases');
} else {
	pass(`BANNED list has ${BANNED.length} entries (non-empty)`);
}

/* ---------------- report ---------------- */

let failed = 0;
for (const r of results) {
	if (r.passed) {
		console.log(`  ${ANSI_GREEN}✓${ANSI_RESET} ${r.name}`);
	} else {
		console.log(`  ${ANSI_RED}✗${ANSI_RESET} ${r.name}`);
		if (r.detail) console.log(`      ${r.detail}`);
		failed++;
	}
}

console.log();
console.log('──────────────────────────────────────────────────────');
if (failed > 0) {
	console.log(`✗ ${failed} of ${results.length} scenarios failed`);
	process.exit(1);
} else {
	console.log(`✓ all ${results.length} scenarios passed`);
}
