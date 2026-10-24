#!/usr/bin/env tsx
/**
 * scripts/canary-news-onion-fallback-smoke.ts
 *
 * v1.21.15 — the warrant canary's news headline also comes from the newsrooms'
 * ONION feeds: asked all at once through Tor (the fastest feed with a headline
 * wins), FIRST on a tor-only node and, on a clearnet node, only when every
 * clearnet feed failed. Never without the SOCKS proxy.
 *
 * Runs the real news section of scripts/canary/generate.sh (cut out between
 * its markers) under bash with `set -euo pipefail`, against a fake `curl` on
 * PATH that logs every call and answers per URL.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const GEN = readFileSync(join(REPO, 'scripts/canary/generate.sh'), 'utf8');

let pass = 0;
const fails: string[] = [];
function check(desc: string, ok: boolean, detail = ''): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${desc}`);
	} else {
		fails.push(desc);
		console.log(`  ✗ ${desc}${detail ? `\n      ${detail.slice(0, 1500)}` : ''}`);
	}
}

console.log('\n── canary news onion fallback smoke ───────────────────\n');

const start = GEN.indexOf('news_headline_of() {');
const endMarker = 'if [ -n "$NEWS_WON_SRC" ]; then';
const end = GEN.indexOf(endMarker);
check('generate.sh has the news section between its markers', start > 0 && end > start);
const section = GEN.slice(start, end);

const work = mkdtempSync(join(tmpdir(), 'canary-news-'));
const bin = join(work, 'bin');
mkdirSync(bin);
const calls = join(work, 'calls.log');
// curl stand-in: logs "<url> <socks-or-none>"; answers per URL from env
// FAKE_<n>="<url-substring>|<delay>|<title>" (no match: fails).
writeFileSync(
	join(bin, 'curl'),
	`#!/bin/bash
url=""; socks=none
while [ $# -gt 0 ]; do
	case "$1" in
		--socks5-hostname) socks="$2"; shift 2 ;;
		--proxy-user|--max-time|-A|--proxy) shift 2 ;;
		-*) shift ;;
		*) url="$1"; shift ;;
	esac
done
echo "$url $socks" >> "${calls}"
echo "$$ $url" >> "${calls}.pids"
echo "$PPID $url" >> "${calls}.pids"
for i in 1 2 3 4 5; do
	v="FAKE_$i"; spec="\${!v:-}"
	[ -n "$spec" ] || continue
	IFS='|' read -r match delay title <<< "$spec"
	case "$url" in *"$match"*)
		sleep "$delay"
		printf '<rss><channel><title>Feed</title><item><title>%s</title></item></channel></rss>' "$title"
		exit 0 ;;
	esac
done
exit 7
`
);
chmodSync(join(bin, 'curl'), 0o755);

// Runs the script under a parent that adopts orphans and never reaps them —
// what PID 1 (`tail -f /dev/null`) is in the CI container — and, while it is
// still that parent, reports what became of each process named in WATCH_PIDS
// for WATCH_URL: "gone", or its state ("Z" a zombie: stopped but never reaped;
// anything else: still running). On a desktop, init reaps an orphan at once,
// so this is the only place such a leak shows.
const NO_REAP = `import ctypes, os, subprocess, sys, time
assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0  # PR_SET_CHILD_SUBREAPER
p = subprocess.Popen(sys.argv[1:])
_, st = os.waitpid(p.pid, 0)
def state(pid):
    try:
        with open('/proc/%s/stat' % pid) as f:
            return f.read().rsplit(') ', 1)[1].split(' ')[0]
    except OSError:
        return 'gone'
pids = []
try:
    for line in open(os.environ['WATCH_PIDS']):
        pid, url = line.split()
        if url == os.environ['WATCH_URL']:
            pids.append(pid)
except OSError:
    pass
for _ in range(30):
    if all(state(x) == 'gone' for x in pids):
        break
    time.sleep(0.1)
for x in pids:
    print('WATCH %s %s' % (x, state(x)))
sys.exit(os.waitstatus_to_exitcode(st))`;

function run(
	torOnly: boolean,
	env: Record<string, string>,
	noReap = false
): {
	won: string;
	headline: string;
	calls: string[];
	status: number | null;
	err: string;
	watch: string[];
} {
	rmSync(calls, { force: true });
	rmSync(`${calls}.pids`, { force: true });
	const script = `set -euo pipefail
NEWS_UA=test
NEWS_RSS=https://operator-feed.example/rss
CURL_PROXY_ARGS=()
CANARY_TOR_SOCKS=127.0.0.1:9
CANARY_TOR_ONLY=${torOnly ? 1 : 0}
NEWS_HEADLINE=''
NEWS_WON_SRC=''
${section}
echo "WON=$NEWS_WON_SRC"
echo "HEADLINE=$NEWS_HEADLINE"
`;
	const r = spawnSync(
		noReap ? 'python3' : 'bash',
		noReap ? ['-c', NO_REAP, 'bash', '-c', script] : ['-c', script],
		{
			encoding: 'utf8',
			timeout: 90_000,
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env }
		}
	);
	const won = /^WON=(.*)$/m.exec(r.stdout)?.[1] ?? '';
	const headline = /^HEADLINE=(.*)$/m.exec(r.stdout)?.[1] ?? '';
	let c: string[] = [];
	try {
		c = readFileSync(calls, 'utf8')
			.trim()
			.split('\n')
			.filter((l) => l !== '');
	} catch {
		/* no calls */
	}
	const watch = [...r.stdout.matchAll(/^WATCH (\S+) (\S+)$/gm)].map((m) => `${m[1]} ${m[2]}`);
	return { won, headline, calls: c, status: r.status, err: r.stderr, watch };
}
const onionCalls = (c: string[]): string[] => c.filter((l) => l.split(' ')[0]!.includes('.onion'));

{
	const r = run(false, { FAKE_1: 'feeds.bbci.co.uk|0|Clearnet headline' });
	check(
		'clearnet node, a clearnet feed answers: its headline, and no onion feed is asked',
		r.status === 0 &&
			r.won === 'https://feeds.bbci.co.uk/news/rss.xml' &&
			r.headline === 'Clearnet headline' &&
			onionCalls(r.calls).length === 0,
		JSON.stringify(r)
	);
}
// Three onion feeds of our own (valid v3-shaped names) for the race.
const A = 'https://a234567890123456789012345678901234567890123456789012345.onion/rss';
const B = 'https://b234567890123456789012345678901234567890123456789012345.onion/rss';
const C = 'https://c234567890123456789012345678901234567890123456789012345.onion/rss';
{
	const r = run(false, {
		MORPHIT_CANARY_ONION_NEWS_RSS: `${A} ${B} ${C}`,
		FAKE_1: 'a2345678|0.6|A over Tor',
		FAKE_2: 'b2345678|0.1|B over Tor'
	});
	const onions = onionCalls(r.calls);
	check(
		'clearnet node, every clearnet feed fails: the onion feeds are asked all at once and the FASTEST headline wins',
		r.status === 0 && r.headline === 'B over Tor' && r.won === B && onions.length === 3,
		JSON.stringify(r)
	);
	check(
		'every onion feed goes through the Tor SOCKS proxy, never directly',
		onions.every((l) => l.endsWith(' 127.0.0.1:9')),
		r.calls.join('\n')
	);
	check(
		'the clearnet feeds were all tried first (operator feed + five)',
		r.calls.slice(0, 6).every((l) => !l.includes('.onion')) && r.calls.length === 9,
		r.calls.join('\n')
	);
}
{
	const r = run(false, { FAKE_1: 'bbcnewsd73hk|0|BBC over Tor' });
	check(
		"the default onion list is the BBC's feed (the one that loaded in the maintainer's check)",
		r.headline === 'BBC over Tor' &&
			r.won ===
				'https://www.bbcnewsd73hkzno2ini43t4gblxvycyac5aw4gnv7t2rccijh7745uqd.onion/news/rss.xml' &&
			onionCalls(r.calls).length === 1,
		JSON.stringify(r)
	);
}
{
	const r = run(true, {
		FAKE_1: 'feeds.bbci.co.uk|0|Clearnet headline',
		FAKE_2: 'bbcnewsd73hk|0|BBC over Tor'
	});
	check(
		'tor-only node: the onion feeds first — a clearnet feed is not asked when one answers',
		r.status === 0 && r.headline === 'BBC over Tor' && r.calls.every((l) => l.includes('.onion')),
		JSON.stringify(r)
	);
}
{
	// The losers are stopped once a feed has won: no curl outlives the race.
	const t0 = Date.now();
	const r = run(
		false,
		{
			MORPHIT_CANARY_ONION_NEWS_RSS: `${A} ${B}`,
			FAKE_1: 'a2345678|0.1|A over Tor',
			FAKE_2: 'b2345678|30|B too slow',
			WATCH_PIDS: `${calls}.pids`,
			WATCH_URL: B
		},
		true
	);
	// The fake curl wrote its own PID and its parent's (the subshell that
	// fetches that feed); for the slow feed both must be gone within 3 s of the
	// stop (it was asked to wait 30) — not running, and not a zombie.
	const lingering = r.watch.filter((w) => !w.endsWith(' gone')).join(', ');
	check(
		'the slower feeds are stopped once one wins, and reaped (no curl left running, no zombie — even under a parent that never reaps)',
		r.headline === 'A over Tor' &&
			Date.now() - t0 < 20_000 &&
			r.watch.length === 2 &&
			lingering === '',
		`${JSON.stringify(r)} lingering=${lingering}`
	);
}
{
	const r = run(false, {});
	check(
		'every feed fails: no headline, and the canary carries on (exit 0)',
		r.status === 0 && r.won === '' && r.headline === '',
		JSON.stringify(r)
	);
}
{
	const r = run(false, {
		MORPHIT_CANARY_ONION_NEWS_RSS:
			'https://clearnet.example/rss https://clearnet.example/x.onion/rss https://x23456789012345678901234567890123456789012345678901234.onion/rss',
		FAKE_1: 'x2345678901|0|Own onion'
	});
	check(
		'an operator onion list is used; a non-onion entry in it is never fetched',
		r.headline === 'Own onion' && !r.calls.some((l) => l.startsWith('https://clearnet.example/')),
		JSON.stringify(r)
	);
}

rmSync(work, { recursive: true, force: true });
const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} canary-news-onion-fallback checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} canary-news-onion-fallback scenarios passed`);
