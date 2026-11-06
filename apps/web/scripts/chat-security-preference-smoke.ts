/**
 * chat-security-preference-smoke.
 *
 * The per-chat Chat Security preference (stores/chatSecurity.ts) decides two
 * security-relevant things, so this pins the store's contract:
 *
 *   v1.23.2 — "Do you want this chat deleted from this computer after you
 *   leave the chat?" Yes = LOCK ON LEAVING that chat (per account, partner
 *   and order; off by default); and your own messages ALWAYS keep their
 *   on-chain self-copy, so nothing is ever lost. An account that had chosen
 *   the old "don't keep my copy" ('destroy') keeps its copy now and gets
 *   lock-on-leaving in every chat instead, until it says No in one. A
 *   regression that silently stopped the self-copy, leaked one account's or
 *   one chat's choice into another, or nagged forever would be a real bug.
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
	readLockOnLeave,
	writeLockOnLeave,
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

// 1. Lock on leaving is off by default.
check(
	'1 — unset chat does not lock on leaving',
	readLockOnLeave('alice', 'bob', 'order-x') === false
);

// 2/3. Round-trip on → off.
writeLockOnLeave('alice', 'bob', 'order-x', true);
check('2 — writes + reads back on', readLockOnLeave('alice', 'bob', 'order-x') === true);
writeLockOnLeave('alice', 'bob', 'order-x', false);
check('3 — writes + reads back off', readLockOnLeave('alice', 'bob', 'order-x') === false);

// 4. Per chat: another partner, another order, another account are apart.
writeLockOnLeave('alice', 'bob', 'order-x', true);
check(
	'4 — per chat (partner, order) and per account',
	readLockOnLeave('alice', 'carol', 'order-x') === false &&
		readLockOnLeave('alice', 'bob', null) === false &&
		readLockOnLeave('dave', 'bob', 'order-x') === false
);

// 5. Only the exact stored values count.
backing.set('morphit.chatSecurity.lockOnLeave.mallory\u0000bob\u0000', 'yes');
check('5 — a non-exact value → off', readLockOnLeave('mallory', 'bob', null) === false);

// 6-7. Your own messages always keep their on-chain copy (nothing is lost),
//      whatever is stored — including the old 'destroy'.
backing.set('morphit.chatSecurity.mode.frank', 'destroy');
check('6 — the self-copy mode is always keep', readChatSecurityMode('frank') === 'keep');
check(
	'7 — so every message carries its self-copy',
	shouldAttachSelfCopy(readChatSecurityMode('frank')) === true
);

// 8. The old 'destroy' becomes lock-on-leaving in every chat, until No.
check(
	'8a — legacy destroy → locks on leaving any chat',
	readLockOnLeave('frank', 'bob', null) === true && readLockOnLeave('frank', 'zoe', 'o') === true
);
writeLockOnLeave('frank', 'bob', null, false);
check(
	'8b — No in one chat overrides it there only',
	readLockOnLeave('frank', 'bob', null) === false && readLockOnLeave('frank', 'zoe', 'o') === true
);

// 9. The one-time nudge.
check(
	'9a — fresh account has NOT seen the nudge (dot shows)',
	readChatSecurityNudgeSeen('carol') === false
);
markChatSecurityNudgeSeen('carol');
check('9b — after mark, nudge is seen', readChatSecurityNudgeSeen('carol') === true);
check('9c — nudge per-account (dave still sees it)', readChatSecurityNudgeSeen('dave') === false);

// 10. Empty account: safe defaults, nothing written.
const before = backing.size;
writeLockOnLeave('', 'bob', null, true);
markChatSecurityNudgeSeen('');
check(
	'10 — empty account: off, never nags, writes nothing',
	readLockOnLeave('', 'bob', null) === false &&
		readChatSecurityNudgeSeen('') === true &&
		backing.size === before
);

// 11. Keys are namespaced under morphit.chatSecurity.* (inspectable).
check(
	'11 — namespaced storage keys',
	backing.get('morphit.chatSecurity.lockOnLeave.alice\u0000bob\u0000order-x') === '1' &&
		backing.get('morphit.chatSecurity.nudgeSeen.carol') === '1'
);

// 12. The send path's switch itself is unchanged (chatService still uses it).
check(
	'12 — keep / undefined → attach the self-copy',
	shouldAttachSelfCopy('keep') && shouldAttachSelfCopy(undefined)
);

console.log(`\n${count} scenarios, ${failures} failed`);
if (failures > 0) {
	console.error('chat-security-preference-smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${count} chat-security-preference scenarios passed`);

// module marker. Without a top-level import/export tsc treats this
// file as a global script, so its `scenarios`/`failed` consts collide with every
// other script-style smoke when the suite is typechecked as one project. This
// has no runtime effect under tsx.
export {};
