/**
 * cp398 — blocks store: optimistic-overwrite race guard + Settings
 * refresh-on-mount.
 *
 * Two coupled invariants, both surfaced by the cp398 "Blocked Accounts
 * went stale" bug:
 *
 *   1. Settings → Blocked Accounts must call refreshBlocks() on mount, not
 *      loadBlocks() — the latter early-returns once the session has loaded
 *      the store once, so after navigating away and back the card showed a
 *      stale/empty cached set until the user hit Refresh manually.
 *
 *   2. A loadBlocks()/refreshBlocks() fetch must NOT clobber an optimistic
 *      markBlocked()/markUnblocked() that happened while the fetch was in
 *      flight. Without the guard, a Block/Unblock clicked mid-load
 *      "un-sticks" when the (now stale) indexer snapshot lands. Guarded via
 *      a mutation-generation counter: loadBlocks snapshots it before the
 *      fetch and only adopts the indexer set if no mutation intervened.
 *
 * Structural smoke (source-pattern + tamper), matching the house style for
 * store/wiring invariants that have no pure-function seam to unit-test.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BLOCKS = resolve(here, '../src/lib/chat/blocks.ts');
const SETTINGS = resolve(here, '../src/routes/[lang]/settings/+page.svelte');

const blocksSrc = readFileSync(BLOCKS, 'utf8');
const settingsSrc = readFileSync(SETTINGS, 'utf8');

interface Check {
	name: string;
	/** Runs against (blocksSrc, settingsSrc). */
	holds: (blocks: string, settings: string) => boolean;
}

const checks: Check[] = [
	{
		name: 'mutation-generation counter is declared',
		holds: (b) => /let mutationGen = 0;/.test(b)
	},
	{
		name: 'markBlocked bumps the generation (optimistic add is observable to the guard)',
		holds: (b) => /export function markBlocked[\s\S]{0,140}mutationGen\+\+;/.test(b)
	},
	{
		name: 'markUnblocked bumps the generation (optimistic remove is observable to the guard)',
		holds: (b) => /export function markUnblocked[\s\S]{0,140}mutationGen\+\+;/.test(b)
	},
	{
		name: 'loadBlocks snapshots the generation BEFORE the fetch',
		holds: (b) => /const startGen = mutationGen;[\s\S]{0,160}getBlocks\(/.test(b)
	},
	{
		name: 'fetch result only adopted when no mutation intervened (no clobber)',
		holds: (b) => /if \(mutationGen === startGen\)\s*\{[\s\S]{0,200}blockedSet\.set\(/.test(b)
	},
	{
		name: 'refreshBlocks still force-refetches (resets loaded, delegates to loadBlocks)',
		holds: (b) => /export async function refreshBlocks[\s\S]{0,160}loaded = false;[\s\S]{0,80}return loadBlocks\(/.test(b)
	},
	{
		name: 'Settings refreshes the blocked list on mount (refreshBlocks, NOT the no-op-if-loaded loadBlocks)',
		holds: (_b, s) => /void refreshBlocks\(me\);/.test(s) && !/void loadBlocks\(me\);/.test(s)
	}
];

let failing = 0;
for (const c of checks) {
	const ok = c.holds(blocksSrc, settingsSrc);
	console.log(`  ${ok ? '✓' : '✗'} ${c.name}`);
	if (!ok) failing++;
}

// ── Tamper checks: break the source in-memory, confirm the guard flips red.
interface Tamper {
	name: string;
	mutateBlocks?: (b: string) => string;
	mutateSettings?: (s: string) => string;
	check: (typeof checks)[number];
}
const tampers: Tamper[] = [
	{
		name: 'drop the generation guard from the fetch',
		mutateBlocks: (b) => b.replace('if (mutationGen === startGen)', 'if (true)'),
		check: checks[4]
	},
	{
		name: 'revert Settings mount to loadBlocks',
		mutateSettings: (s) => s.replace('void refreshBlocks(me);', 'void loadBlocks(me);'),
		check: checks[6]
	}
];
for (const t of tampers) {
	const b = t.mutateBlocks ? t.mutateBlocks(blocksSrc) : blocksSrc;
	const s = t.mutateSettings ? t.mutateSettings(settingsSrc) : settingsSrc;
	const stillHolds = t.check.holds(b, s);
	const caught = !stillHolds;
	console.log(`  ${caught ? '✓' : '✗'} tamper caught: "${t.name}" turns its check red`);
	if (!caught) failing++;
}

const total = checks.length + tampers.length;
console.log(`\n${total - failing} ok, ${failing} failing`);
if (failing > 0) {
	console.error('chat-blocks-race-guard smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} scenarios passed`);
