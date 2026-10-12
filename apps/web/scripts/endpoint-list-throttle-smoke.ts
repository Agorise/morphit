/**
 * endpoint-list-throttle-smoke
 *
 * The settings "RPC endpoints" card re-pings the indexer on the refresh button.
 * The maintainer clicked it ~15× over a day and it "only worked once": the button worked
 * fine (it refetched), but the health snapshot is stable so nothing visibly
 * changed AND there was no click feedback. Requirements now:
 *   - never re-ping the indexer faster than once per 5s (protect the pool),
 *   - the button stays clickable as fast as the user likes (throttle the FETCH,
 *     not the click),
 *   - every click reads as "did something" (min-spin + a ✓ confirmation; a
 *     rate-limited click gets a quick pulse ack).
 * Source-level invariants, tamper-tested.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = readFileSync(join(repo, 'apps/web/src/lib/components/EndpointList.svelte'), 'utf8');

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

check(
	'the indexer re-ping is throttled to 5s (THROTTLE_MS = 5000)',
	/THROTTLE_MS = 5000\b/.test(src)
);

check(
	'onRefreshClick enforces the throttle window before fetching',
	/Date\.now\(\) - lastFetchAt < THROTTLE_MS/.test(src) && /function onRefreshClick/.test(src)
);

check(
	'the button calls the throttled handler, NOT loadHealth directly',
	/onclick=\{onRefreshClick\}/.test(src) && !/onclick=\{\(\) => void loadHealth\(\)\}/.test(src)
);

check(
	'the button is no longer disabled while loading (clickable as fast as the user likes)',
	!/disabled=\{loading\}/.test(src)
);

check(
	'a fetch is timestamped so the throttle window is measured from it',
	/lastFetchAt = Date\.now\(\)/.test(src)
);

check(
	'every click gets visible feedback (min-spin + a ✓ confirmation)',
	/MIN_SPIN_MS/.test(src) && /justRefreshed = true/.test(src) && /M20 6 9 17l-5-5/.test(src)
);

check(
	'a rate-limited click still gets a quick ack (justThrottled pulse)',
	/justThrottled = true/.test(src)
);

// v1.21.6 — accurate from the first paint, never stale, never swapped for older
// or guessed figures: the indexer measures every node continuously, the card
// shows its latest figures at once, re-reads them every POLL_MS while visible,
// and a refresh asks for a re-measure WITHOUT repainting anything in between.
check(
	"the first load and the polls read the indexer's latest figures; the refresh asks for a re-measure",
	/fetchHealth\(false\)/.test(src) &&
		/await fetchHealth\(true\)/.test(src) &&
		/getRpcEndpoints\(\{ probe \}\)/.test(src)
);
check(
	'the card re-reads the figures every 10 s while the page is visible (POLL_MS) and on return to the tab',
	/POLL_MS = 10_000/.test(src) &&
		/setInterval\([\s\S]{0,120}visibilityState === 'visible'/.test(src) &&
		/visibilitychange/.test(src)
);
check(
	'nothing repaints the rows from a passive/older source: no merge, and an answer generated earlier than the one shown is dropped',
	!/mergeFreshOverPassive|passiveByUrl|loadHealth/.test(src) &&
		/generated < shownGeneratedAt/.test(src)
);
check(
	'every row says how long ago it was measured (checked_at)',
	/checked_at/.test(src) && /settings\.endpoints\.checked_ago/.test(src)
);

// PRIVACY #1 — the whole point of this card: the BROWSER never contacts a Blurt
// node directly; the indexer does all node contact so a node operator never
// sees the user's IP. EndpointList must only ever call the indexer client, never
// fetch a node or name a Blurt RPC host.
check(
	'PRIVACY: EndpointList never fetches a Blurt node directly (indexer-only)',
	!/fetch\(/.test(src) && !/rpc\.blurt|blurtrpc|beblurt|drakernoise|saboin|blurt\.one/i.test(src)
);

// The stats page must mount the card at once, not after /v1/stats answers (that
// delayed the first measurement, and a failed /v1/stats hid the card entirely).
const statsPage = readFileSync(join(repo, 'apps/web/src/routes/[lang]/stats/+page.svelte'), 'utf8');
const lastIfClose = statsPage.lastIndexOf('{/if}');
check(
	'the stats page renders <EndpointList /> outside its /v1/stats loading block',
	lastIfClose > 0 && statsPage.indexOf('<EndpointList />') > lastIfClose
);

if (failures === 0) {
	console.log('✓ all 13 endpoint-list-throttle scenarios passed');
} else {
	console.log(`\n✗ ${failures}/13 endpoint-list-throttle scenarios failed`);
	process.exit(1);
}
