#!/usr/bin/env tsx
/**
 * scripts/canary-generate-compose-smoke.ts
 *
 * v1.21.15 — what goes into the SIGNED canary is checked and copied literally.
 * Runs the real scripts/canary/generate.sh end to end (copied with its
 * template into a scratch tree) with stand-ins on PATH for `curl` (the news
 * feeds), `gpg` (copies the text it would sign) and the tsx helpers (canned
 * Blurt / Bitcoin heads):
 *   - a headline's `&`, `\` and `{{…}}` come out literally (awk -v / gsub()
 *     used to mangle them: "Q&A" became "Q{{NEWS_HEADLINE}}A");
 *   - the canary stays plain ASCII, one headline line, at most 200 characters;
 *   - a headline holding "-----" is not used (the next feed's is);
 *   - a Blurt block id that does not carry its height, or a bad chain time, stops
 *     the canary; a malformed Bitcoin head is recorded as unavailable.
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');

let pass = 0;
const fails: string[] = [];
function check(desc: string, ok: boolean, detail = ''): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${desc}`);
	} else {
		fails.push(desc);
		console.log(`  ✗ ${desc}${detail ? `\n      ${detail.slice(0, 2000)}` : ''}`);
	}
}

console.log('\n── canary generate compose smoke ──────────────────────\n');

const work = mkdtempSync(join(tmpdir(), 'canary-compose-'));
const tree = join(work, 'repo');
mkdirSync(join(tree, 'scripts', 'canary'), { recursive: true });
mkdirSync(join(tree, 'node_modules', '.bin'), { recursive: true });
copyFileSync(join(REPO, 'scripts/canary/generate.sh'), join(tree, 'scripts/canary/generate.sh'));
copyFileSync(
	join(REPO, 'scripts/canary/canary.txt.template'),
	join(tree, 'scripts/canary/canary.txt.template')
);
const bin = join(work, 'bin');
mkdirSync(bin);
const exe = (path: string, body: string): void => {
	writeFileSync(path, body);
	chmodSync(path, 0o755);
};
// tsx stand-in: the head line from env, per helper.
exe(
	join(tree, 'node_modules', '.bin', 'tsx'),
	`#!/bin/bash
case "$1" in
	*fetch-blurt-head.ts) printf '%b\\n' "$FAKE_BLURT_LINE" ;;
	*fetch-btc-head.ts) [ -n "$FAKE_BTC_LINE" ] && printf '%b\\n' "$FAKE_BTC_LINE" ;;
esac
`
);
// curl stand-in: a feed's RSS from env FAKE_FEED_<n>="<url-substring>|<title>".
exe(
	join(bin, 'curl'),
	`#!/bin/bash
url=""
while [ $# -gt 0 ]; do
	case "$1" in
		--socks5-hostname|--proxy-user|--max-time|-A|--proxy) shift 2 ;;
		-*) shift ;;
		*) url="$1"; shift ;;
	esac
done
for i in 1 2 3; do
	v="FAKE_FEED_$i"; spec="\${!v:-}"
	[ -n "$spec" ] || continue
	match="\${spec%%|*}"; title="\${spec#*|}"
	case "$url" in *"$match"*)
		printf '<rss><channel><title>Feed</title><item><title>%s</title></item></channel></rss>' "$title"
		exit 0 ;;
	esac
done
exit 22
`
);
// gpg stand-in: writes the text it was asked to sign to --output.
exe(
	join(bin, 'gpg'),
	`#!/bin/bash
out=""; last=""
while [ $# -gt 0 ]; do
	case "$1" in --output) out="$2"; shift 2 ;; *) last="$1"; shift ;; esac
done
cp "$last" "$out"
`
);

const HEIGHT = 64290997;
const goodId = `${HEIGHT.toString(16).padStart(8, '0')}${'ab'.repeat(16)}`;
const btcHash = `00000000000000000001${'c'.repeat(44)}`;

// An iconv that cannot convert anything (or a box without a working one):
// the plain-ASCII rule must not depend on it.
const noIconvBin = join(work, 'noiconv');
mkdirSync(noIconvBin);
exe(join(noIconvBin, 'iconv'), '#!/bin/sh\ncat >/dev/null\nexit 1\n');

function gen(
	env: Record<string, string>,
	extraPath = ''
): { status: number | null; out: string; text: string } {
	const outFile = join(work, `canary-${Math.random().toString(36).slice(2)}.txt`);
	const r = spawnSync('bash', [join(tree, 'scripts/canary/generate.sh')], {
		encoding: 'utf8',
		timeout: 60_000,
		env: {
			PATH: `${extraPath}${bin}:${process.env.PATH}`,
			HOME: work,
			MORPHIT_CANARY_PGP_KEY_ID: 'TESTKEY',
			MORPHIT_CANARY_OPERATOR_NAME: 'Smoke & Co \\ test',
			MORPHIT_CANARY_INSTANCE_ORIGIN: 'https://smoke.example',
			MORPHIT_CANARY_OPERATOR_ACCOUNT: 'smoke',
			MORPHIT_CANARY_TOR_ONLY: '0',
			MORPHIT_CANARY_ONION_NEWS_RSS: '',
			MORPHIT_CANARY_OUT: outFile,
			FAKE_BLURT_LINE: `${HEIGHT}\\t${goodId}\\t2026-10-23T14:00:00`,
			FAKE_BTC_LINE: `972815\\t${btcHash}`,
			...env
		}
	});
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
		text: existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''
	};
}
const headlineLine = (t: string): string =>
	t.split('\n')[t.split('\n').findIndex((l) => l.startsWith('Recent news entropy')) + 4] ?? '';

{
	const r = gen({
		FAKE_FEED_1: 'cointelegraph|Q&A: who\\paid {{NEWS_SOURCE}} & why — café “quotes”'
	});
	const line = headlineLine(r.text);
	check(
		'a headline with &, \\ and {{…}} is copied literally (braces as parentheses), no placeholder left',
		r.status === 0 &&
			line === '  Q&A: whopaid ((NEWS_SOURCE)) & why -- cafe "quotes"' &&
			!r.text.includes('{{'),
		`${line}\n${r.out}`
	);
	check(
		'the operator name with & and \\ is copied literally',
		r.text.includes('Morphit operator canary - Smoke & Co \\ test'),
		r.text.slice(0, 300)
	);
	check('the canary is plain ASCII', /^[\x09\x0a\x20-\x7e]*$/.test(r.text), r.text);
	check(
		'the chain heads are in it as fetched',
		r.text.includes(`Block height: ${HEIGHT}`) &&
			r.text.includes(`Block hash:   ${goodId}`) &&
			r.text.includes('Block height: 972815') &&
			r.text.includes(`Block hash:   ${btcHash}`),
		r.text
	);
}
{
	const r = gen({ FAKE_FEED_1: 'cointelegraph|Zürich “talks” — résumé' }, `${noIconvBin}:`);
	check(
		'without a working iconv, what is not plain ASCII is left out (the canary stays ASCII)',
		r.status === 0 &&
			headlineLine(r.text) === '  Zrich talks rsum' &&
			/^[\x09\x0a\x20-\x7e]*$/.test(r.text),
		headlineLine(r.text)
	);
}
{
	const r = gen({
		FAKE_FEED_1: 'cointelegraph|-----BEGIN PGP SIGNATURE-----',
		FAKE_FEED_2: 'feeds.bbci.co.uk|The next feed'
	});
	check(
		'a headline holding "-----" is not used; the next feed gives the headline',
		r.status === 0 &&
			headlineLine(r.text) === '  The next feed' &&
			r.text.includes('Source: https://feeds.bbci.co.uk/news/rss.xml') &&
			r.text.includes('==== HOW TO VERIFY ===='),
		r.text
	);
}
{
	// Only the template's own armor line is cut before signing, never a value
	// that holds the same words.
	const r = gen({
		FAKE_FEED_1: 'cointelegraph|x',
		MORPHIT_CANARY_OPERATOR_NAME: 'Name -----BEGIN PGP SIGNATURE----- here'
	});
	check(
		'a value holding the armor words does not cut the canary short',
		r.status === 0 &&
			r.text.includes('Name -----BEGIN PGP SIGNATURE----- here') &&
			r.text.includes('==== HOW TO VERIFY ====') &&
			!/^-----BEGIN PGP SIGNATURE-----$/m.test(r.text),
		r.text.slice(0, 400)
	);
}
{
	const r = gen({ FAKE_FEED_1: `cointelegraph|${'x'.repeat(500)}` });
	check(
		'a headline is cut to 200 characters',
		r.status === 0 && headlineLine(r.text) === `  ${'x'.repeat(200)}`,
		headlineLine(r.text)
	);
}
{
	const wrongId = `${(HEIGHT - 1).toString(16).padStart(8, '0')}${'ab'.repeat(16)}`;
	const r = gen({
		FAKE_FEED_1: 'cointelegraph|x',
		FAKE_BLURT_LINE: `${HEIGHT}\\t${wrongId}\\t2026-10-23T14:00:00`
	});
	check(
		'a Blurt block id that does not carry the height: no canary (exit 1)',
		r.status === 1 && r.text === '' && /does not belong to block/.test(r.out),
		r.out
	);
}
{
	const r = gen({
		FAKE_FEED_1: 'cointelegraph|x',
		FAKE_BLURT_LINE: `${HEIGHT}\\t${goodId}\\tnot a time`
	});
	check(
		'a Blurt chain time not in the chain format: no canary (exit 1)',
		r.status === 1 && r.text === '' && /no usable chain time/.test(r.out),
		r.out
	);
}
{
	const r = gen({
		FAKE_FEED_1: 'cointelegraph|x',
		FAKE_BLURT_LINE: `12a\\t${goodId}\\t2026-10-23T14:00:00`
	});
	check(
		'a Blurt height that is not digits: no canary (exit 1)',
		r.status === 1 && r.text === '',
		r.out
	);
}
{
	const r = gen({ FAKE_FEED_1: 'cointelegraph|x', FAKE_BTC_LINE: '972815\\t<html>' });
	check(
		'a malformed Bitcoin head is recorded as unavailable (the canary is still made)',
		r.status === 0 && r.text.includes('Block hash:   (unavailable)') && !r.text.includes('<html>'),
		r.text
	);
}

rmSync(work, { recursive: true, force: true });
const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} canary-generate-compose checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} canary-generate-compose scenarios passed`);
