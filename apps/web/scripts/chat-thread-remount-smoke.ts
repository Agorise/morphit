/**
 * chat-thread-remount-smoke — v1.4.8 (t.txt #4 root cause)
 *
 * A conversation's identity is (peer, order_permlink). ConversationView's
 * controller captures BOTH once in onMount (`runtimeDeps(me, peer, …,
 * orderPermlink ?? null)`), so if the `?order=` query param changes on the
 * SAME peer WITHOUT the component remounting, `deps.orderPermlink` goes stale.
 * A stale value breaks chat in two directions at once:
 *   • the SENDER tags outgoing messages with the wrong thread (or omits it),
 *     landing them in a different thread than the one on screen; and
 *   • the RECEIVER's mergePollResponse thread filter (the
 *     `rec.order_permlink !== deps.orderPermlink` skip) hides correctly-tagged
 *     messages from the thread being viewed.
 * The fix is a {#key} on (peer, order) around the lazily-loaded component so it
 * remounts — and re-captures deps — whenever either changes. Pin it.
 *
 * Parsing note: the key expression is a template literal containing `}`, so we
 * locate by index rather than a brace-delimited regex (which truncates at `}`).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const page = readFileSync(
	join(repo, 'apps/web/src/routes/[lang]/chat/[peer=account]/+page.svelte'),
	'utf8'
);

let failures = 0;
let total = 0;
function check(name: string, cond: boolean): void {
	total++;
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

const keyOpen = page.indexOf('{#key');
const keyClose = page.indexOf('{/key}');
const compAt = page.indexOf('<Component');

check('the chat page has a {#key} block', keyOpen !== -1 && keyClose !== -1);
check(
	'the ConversationView <Component> renders INSIDE the {#key}…{/key}',
	compAt !== -1 && keyOpen !== -1 && keyClose !== -1 && keyOpen < compAt && compAt < keyClose
);

const keyHeader = keyOpen !== -1 && compAt !== -1 ? page.slice(keyOpen, compAt) : '';
check('the {#key} keys on `peer`', /\bpeer\b/.test(keyHeader));
check('the {#key} keys on `orderPermlink`', /\borderPermlink\b/.test(keyHeader));

const compTagEnd = compAt !== -1 ? page.indexOf('/>', compAt) : -1;
const compTag = compAt !== -1 && compTagEnd !== -1 ? page.slice(compAt, compTagEnd + 2) : '';
check(
	'the Component still receives me, peer, and orderPermlink props',
	/\{me\}/.test(compTag) && /\{peer\}/.test(compTag) && /\{orderPermlink\}/.test(compTag)
);

if (failures === 0) {
	console.log(`✓ all ${total} chat-thread-remount scenarios passed`);
} else {
	console.log(`\n✗ ${failures} chat-thread-remount scenarios failed`);
	process.exit(1);
}
