/**
 * first-online-tls-smoke.
 *
 * Runs the REAL ops/first-online/morphit-first-online.sh with stub binaries on
 * PATH (curl answers, so the box is "online"; `ss` says whether port 80 is
 * held; certbot records its arguments and can be told to succeed) and checks
 * the certificate step:
 *  - with port 80 held (BunkerWeb up) certbot writes into the web build
 *    (--webroot), never its own server on the held port (--standalone);
 *  - with port 80 free it uses --standalone;
 *  - a failed attempt is not repeated on the next tick: attempts back off
 *    (5 min, then doubling) so Let's Encrypt's failed-validation limit is never
 *    hit; after the wait it tries again;
 *  - a success marks the step done and clears the back-off.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './ansible-template-render.ts';

const SCRIPT =
	process.env.MORPHIT_FIRST_ONLINE_SCRIPT ?? join(REPO, 'ops/first-online/morphit-first-online.sh');
let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

interface Box {
	dir: string;
	run(opts: { port80: boolean; certbotOk: boolean; now: number }): {
		out: string;
		certbot: string[];
	};
}
const box = (): Box => {
	const dir = mkdtempSync(join(tmpdir(), 'fo-tls-'));
	const bin = join(dir, 'bin');
	mkdirSync(bin);
	mkdirSync(join(dir, 'state'));
	mkdirSync(join(dir, 'live'));
	mkdirSync(join(dir, 'build'));
	writeFileSync(join(dir, 'build', 'canary.txt'), 'x');
	for (const s of ['rpc.done', 'canary.done']) writeFileSync(join(dir, 'state', s), '');
	writeFileSync(
		join(dir, 'first-online.env'),
		`MORPHIT_DOMAIN=trade.example.org\nMORPHIT_ACME_EMAIL=ops@example.org\nMORPHIT_AUTO_REGISTER=no\nMORPHIT_OPS_DIR=${dir}\nMORPHIT_CANARY_SERVE_DIR=${join(dir, 'build')}\n`
	);
	const stub = (name: string, body: string): void => {
		writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
	};
	stub('curl', 'exit 0');
	for (const n of ['systemctl', 'logger', 'apt-get', 'docker', 'chgrp', 'chmod']) stub(n, 'exit 0');
	stub(
		'ss',
		`[ -f "${join(dir, 'port80')}" ] && echo 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*'; exit 0`
	);
	stub('date', `[ "$1" = "+%s" ] && cat "${join(dir, 'now')}" && exit 0; exec /bin/date "$@"`);
	stub(
		'certbot',
		`echo "$*" >> "${join(dir, 'certbot.log')}"\n[ -f "${join(dir, 'certbot-ok')}" ] || exit 1\nmkdir -p "${join(dir, 'live', 'trade.example.org')}" && : > "${join(dir, 'live', 'trade.example.org', 'fullchain.pem')}"\nexit 0`
	);
	return {
		dir,
		run({ port80, certbotOk, now }) {
			for (const [f, on] of [
				['port80', port80],
				['certbot-ok', certbotOk]
			] as const) {
				if (on) writeFileSync(join(dir, f), '');
				else rmSync(join(dir, f), { force: true });
			}
			writeFileSync(join(dir, 'now'), String(now));
			writeFileSync(join(dir, 'certbot.log'), '');
			const r = spawnSync('sh', [SCRIPT], {
				encoding: 'utf8',
				timeout: 60_000,
				env: {
					PATH: `${bin}:${process.env.PATH}`,
					HOME: dir,
					MORPHIT_FIRST_ONLINE_STATE_DIR: join(dir, 'state'),
					MORPHIT_FIRST_ONLINE_ENV: join(dir, 'first-online.env'),
					MORPHIT_FIRST_ONLINE_INDEXER_ENV: join(dir, 'indexer.env'),
					MORPHIT_FIRST_ONLINE_RELAY_ENV: join(dir, 'relay.env'),
					MORPHIT_FIRST_ONLINE_LE_LIVE: join(dir, 'live')
				}
			});
			return {
				out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
				certbot: readFileSync(join(dir, 'certbot.log'), 'utf8').split('\n').filter(Boolean)
			};
		}
	};
};

const T0 = 1_800_000_000;
{
	const b = box();
	let r = b.run({ port80: true, certbotOk: false, now: T0 });
	check(
		'port 80 held: certbot writes into the web build, not its own server on the held port',
		r.certbot.length === 1 &&
			r.certbot[0]!.includes(`--webroot --webroot-path ${join(b.dir, 'apps/web/build')}`) &&
			!r.certbot[0]!.includes('--standalone'),
		r.certbot.join(' | ')
	);
	r = b.run({ port80: true, certbotOk: false, now: T0 + 60 });
	check(
		'a failed attempt is not repeated on the next tick',
		r.certbot.length === 0,
		r.certbot.join(' | ')
	);
	r = b.run({ port80: true, certbotOk: false, now: T0 + 301 });
	check('it tries again after 5 minutes', r.certbot.length === 1);
	r = b.run({ port80: true, certbotOk: false, now: T0 + 301 + 400 });
	check('the second wait is longer (10 minutes)', r.certbot.length === 0);
	r = b.run({ port80: true, certbotOk: true, now: T0 + 301 + 601 });
	check(
		'a success marks the step done and clears the back-off',
		r.certbot.length === 1 &&
			existsSync(join(b.dir, 'state', 'tls.done')) &&
			!existsSync(join(b.dir, 'state', 'tls.next')) &&
			!existsSync(join(b.dir, 'state', 'tls.tries'))
	);
	rmSync(b.dir, { recursive: true, force: true });
}
{
	const b = box();
	const r = b.run({ port80: false, certbotOk: true, now: T0 });
	check(
		'port 80 free: certbot uses its own server (--standalone)',
		r.certbot.length === 1 && r.certbot[0]!.includes('--standalone')
	);
	rmSync(b.dir, { recursive: true, force: true });
}
{
	// many failures: the wait never exceeds a day
	const b = box();
	let t = T0;
	let last = T0;
	let calls = 0;
	for (let i = 0; i < 12; i++) {
		last = t;
		calls += b.run({ port80: true, certbotOk: false, now: t }).certbot.length;
		const next = join(b.dir, 'state', 'tls.next');
		t = existsSync(next) ? Number(readFileSync(next, 'utf8')) : t + 1;
	}
	const triesFile = join(b.dir, 'state', 'tls.tries');
	const tries = existsSync(triesFile) ? Number(readFileSync(triesFile, 'utf8')) : 0;
	check(
		'after many failures the wait grows to a day and stays there',
		calls === 12 && tries === 12 && t - last === 86_400,
		`calls ${calls}, tries ${tries}, last wait ${t - last}s`
	);
	rmSync(b.dir, { recursive: true, force: true });
}

console.log('');
if (fail === 0) {
	console.log(`✓ all ${pass} first-online-tls checks passed`);
	process.exit(0);
}
console.log(`✗ ${fail} of ${pass + fail} first-online-tls checks failed`);
process.exit(1);
