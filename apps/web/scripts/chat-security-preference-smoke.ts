#!/usr/bin/env tsx
/**
 * chat-security-preference-smoke (cp406).
 *
 * The per-account Chat Security preference (stores/chatSecurity.ts) gates a
 * security-critical decision: whether every sent message carries a self-copy
 * (keep-history) or not (PFS "destroy on leave"). A regression that silently
 * flipped the default, leaked one account's posture into another, or nagged
 * forever would be a real bug — so this pins the store's contract.
 *
 * We shim window.localStorage (node has none) BEFORE importing the store, so
 * safeStorage sees a working backend and the round-trips are exercised for
 * real rather than falling through to the storage-unavailable defaults.
 *
 * Usage:
 *   cd apps/web && npx tsx --tsconfig ../../tsconfig.smoke.json scripts/chat-security-preference-smoke.ts
 */

// ── localStorage shim (must run before the store import) ──
const backing = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
	localStorage: {
		getItem: (k: string): string | null => (backing.has(k) ? backing.get(k)! : null),
		setItem: (k: string, v: string): void => {
			backing.set(k, String(v));
		},
		removeItem: (k: string): void => {
			backing.delete(k);
		}
	}
};

const {
	readChatSecurityMode,
	writeChatSecurityMode,
	readChatSecurityNudgeSeen,
	markChatSecurityNudgeSeen,
	shouldAttachSelfCopy
} = await import('../src/lib/stores/chatSecurity.ts');

let failures = 0;
let count = 0;
function check(name: string, cond: boolean, detail = ''): void {
	count++;
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

// 1. Default mode is 'keep' for an account with nothing stored.
check('1 — unset account defaults to keep', readChatSecurityMode('alice') === 'keep');

// 2/3. Round-trip destroy → keep.
writeChatSecurityMode('alice', 'destroy');
check('2 — writes + reads back destroy', readChatSecurityMode('alice') === 'destroy');
writeChatSecurityMode('alice', 'keep');
check('3 — writes + reads back keep', readChatSecurityMode('alice') === 'keep');

// 4. Per-account isolation — alice's posture must not bleed into bob.
writeChatSecurityMode('alice', 'destroy');
check(
	'4 — mode is per-account (bob unaffected by alice)',
	readChatSecurityMode('bob') === 'keep' && readChatSecurityMode('alice') === 'destroy'
);

// 5. Defensive parse — any non-exact value falls back to keep (safe default),
//    never accidentally to destroy.
backing.set('morphit.chatSecurity.mode.mallory', 'DESTROY'); // wrong case
check('5a — non-exact "DESTROY" → keep', readChatSecurityMode('mallory') === 'keep');
backing.set('morphit.chatSecurity.mode.mallory', 'destroyed'); // superstring
check('5b — "destroyed" → keep', readChatSecurityMode('mallory') === 'keep');
backing.set('morphit.chatSecurity.mode.mallory', ''); // empty
check('5c — empty value → keep', readChatSecurityMode('mallory') === 'keep');
backing.set('morphit.chatSecurity.mode.mallory', 'destroy'); // exact
check('5d — exact "destroy" → destroy', readChatSecurityMode('mallory') === 'destroy');

// 6. Nudge default — an account that has never opened the item should see the
//    dot (nudgeSeen === false).
check('6 — fresh account has NOT seen the nudge (dot shows)', readChatSecurityNudgeSeen('carol') === false);

// 7. One-time: after marking, it stays seen (dot cleared for good).
markChatSecurityNudgeSeen('carol');
check('7a — after mark, nudge is seen', readChatSecurityNudgeSeen('carol') === true);
markChatSecurityNudgeSeen('carol'); // idempotent
check('7b — marking again is idempotent', readChatSecurityNudgeSeen('carol') === true);

// 8. Nudge is per-account too.
check('8 — nudge per-account (dave still sees it)', readChatSecurityNudgeSeen('dave') === false);

// 9. Empty-account safety — no key to write, safe fallbacks, no nagging.
check('9a — empty account mode → keep', readChatSecurityMode('') === 'keep');
writeChatSecurityMode('', 'destroy'); // must be a no-op
check('9b — writing empty account is a no-op', backing.has('morphit.chatSecurity.mode.') === false);
check('9c — empty account nudge → seen (never nag)', readChatSecurityNudgeSeen('') === true);
markChatSecurityNudgeSeen(''); // no-op
check('9d — marking empty account is a no-op', backing.has('morphit.chatSecurity.nudgeSeen.') === false);

// 10. Keys are namespaced under morphit.chatSecurity.* (no collisions with
//     other settings, and inspectable).
writeChatSecurityMode('erin', 'destroy');
markChatSecurityNudgeSeen('erin');
check(
	'10 — namespaced storage keys',
	backing.get('morphit.chatSecurity.mode.erin') === 'destroy' &&
		backing.get('morphit.chatSecurity.nudgeSeen.erin') === '1'
);

// 11-13. shouldAttachSelfCopy — the pure gate the send + retry paths use to
//        decide whether a self-copy rides on chain. This is the security
//        pivot: 'destroy' MUST return false (nothing recoverable after leave).
check('11 — keep → attach self-copy', shouldAttachSelfCopy('keep') === true);
check('12 — destroy → do NOT attach self-copy (PFS)', shouldAttachSelfCopy('destroy') === false);
check('13 — undefined mode → attach (safe keep default)', shouldAttachSelfCopy(undefined) === true);

console.log(`\n${count} scenarios, ${failures} failed`);
if (failures > 0) {
	console.error('chat-security-preference-smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${count} chat-security-preference scenarios passed`);

// cp474 — module marker. Without a top-level import/export tsc treats this
// file as a global script, so its `scenarios`/`failed` consts collide with every
// other script-style smoke when the suite is typechecked as one project. This
// has no runtime effect under tsx.
export {};
