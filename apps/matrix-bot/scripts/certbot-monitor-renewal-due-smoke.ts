#!/usr/bin/env tsx
/**
 * certbot-monitor-renewal-due-smoke (v1.23.4).
 *
 * A live box sent "TLS cert expires soon: … expires in 30 days (threshold 30
 * days). Last successful renewal 999 days ago." Both halves were the monitor's
 * own doing, not a renewal problem:
 *   - certbot renews a 90-day certificate once fewer than 30 days are left, so
 *     a warning at 30 days fires the day before certbot is even due — on every
 *     certificate, every cycle;
 *   - certbot starts /var/log/letsencrypt/letsencrypt.log afresh on every run,
 *     so its newest file almost never holds the "renewed" line: 999.
 *
 * This EXECUTES the real monitor against real certificates whose dates are set
 * to the second (`openssl ca -selfsign -startdate -enddate`, Let's Encrypt's
 * shape: 90 days less a second), at points through their life, and renders
 * every alert it emits through the bot's own classifier — so the script and
 * the alert text cannot drift apart (a missing field renders as `<unknown>`).
 *
 * To watch it fail on the old script:
 *   MORPHIT_CERTBOT_MONITOR_SCRIPT=<old>/ops/scripts/morphit-certbot-monitor.sh \
 *     npx tsx scripts/certbot-monitor-renewal-due-smoke.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { classify, renderAlertBody } from '../src/classifier.ts';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT =
	process.env.MORPHIT_CERTBOT_MONITOR_SCRIPT ??
	join(REPO, 'ops/scripts/morphit-certbot-monitor.sh');
const H = 3600;
const D = 86400;
/** Let's Encrypt: 90 days less a second. */
const LE = 90 * D - 1;

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

interface Emitted {
	level: string;
	module: string;
	event: string;
	context: Record<string, unknown>;
}

const work = mkdtempSync(join(tmpdir(), 'morphit-certbot-monitor-'));
const CA_CNF = join(work, 'ca.cnf');
writeFileSync(
	CA_CNF,
	'[ca]\ndefault_ca=d\n[d]\ndatabase=index.txt\nnew_certs_dir=.\ndefault_md=sha256\n' +
		'policy=p\nunique_subject=no\nrand_serial=yes\n[p]\ncommonName=supplied\n'
);
let seq = 0;

const asn1 = (sec: number): string =>
	new Date(sec * 1000)
		.toISOString()
		.replace(/[-:T]/g, '')
		.replace(/\.\d+Z$/, 'Z');

function sh(cmd: string, args: string[], cwd: string): void {
	const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
}

interface Spec {
	readonly name: string;
	/** Seconds until notAfter, from now (negative: expired). */
	readonly left: number;
	/** notAfter − notBefore, seconds. */
	readonly lifetime?: number;
	/** The certificate's renewal file, if any. */
	readonly conf?: string;
}

/** One live/ + renewal/ tree holding the given certificates. */
function tree(...certs: Spec[]): { live: string; renewal: string } {
	const base = join(work, `t${++seq}`);
	const live = join(base, 'live');
	const renewal = join(base, 'renewal');
	mkdirSync(renewal, { recursive: true });
	mkdirSync(live, { recursive: true });
	const now = Math.floor(Date.now() / 1000);
	for (const c of certs) {
		const dir = join(live, c.name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'index.txt'), '');
		const end = now + c.left;
		const start = end - (c.lifetime ?? LE);
		sh(
			'openssl',
			[
				'req',
				'-new',
				'-newkey',
				'ec',
				'-pkeyopt',
				'ec_paramgen_curve:prime256v1',
				'-nodes',
				'-keyout',
				'privkey.pem',
				'-out',
				'req.csr',
				'-subj',
				`/CN=${c.name}`
			],
			dir
		);
		sh(
			'openssl',
			[
				'ca',
				'-batch',
				'-selfsign',
				'-config',
				CA_CNF,
				'-keyfile',
				'privkey.pem',
				'-in',
				'req.csr',
				'-startdate',
				asn1(start),
				'-enddate',
				asn1(end),
				'-notext',
				'-out',
				'cert.pem'
			],
			dir
		);
		if (c.conf !== undefined) writeFileSync(join(renewal, `${c.name}.conf`), c.conf);
	}
	return { live, renewal };
}

function run(t: { live: string; renewal: string }, env: Record<string, string> = {}): Emitted[] {
	const r = spawnSync('sh', [SCRIPT], {
		encoding: 'utf8',
		env: {
			...process.env,
			JOURNAL_STREAM: '1', // emit to stdout, as under its systemd unit
			MORPHIT_EMIT_DEDUP: '0',
			MORPHIT_CERTBOT_CERT_DIR: t.live,
			MORPHIT_CERTBOT_RENEWAL_DIR: t.renewal,
			...env
		}
	});
	if (r.status !== 0) throw new Error(`monitor exited ${r.status}: ${r.stderr}`);
	return r.stdout
		.split('\n')
		.filter((l) => l.trim() !== '')
		.map((l) => {
			try {
				return JSON.parse(l) as Emitted;
			} catch {
				throw new Error(`not JSON (the bot would drop it): ${l}`);
			}
		});
}

/** One certificate named `c.example`, `left` seconds to go. */
const one = (left: number, more: Partial<Spec> = {}, env: Record<string, string> = {}): Emitted[] =>
	run(tree({ name: 'c.example', left, ...more }), env);

/** The bot's rendering of an emitted line: tier + plain text. */
function rendered(e: Emitted): { tier: string; plain: string } {
	const c = classify({
		module: e.module,
		event: e.event,
		payload: e.context,
		ts: '2026-11-08T00:00:00.000Z'
	});
	return { tier: c.tier, plain: renderAlertBody(c).plain };
}

const events = (out: Emitted[]): string =>
	out.map((e) => `${e.event} ${JSON.stringify(e.context)}`).join('; ') || '(nothing)';
const only = (out: Emitted[], event: string): boolean =>
	out.length === 1 && out[0]?.event === event;
const quiet = (name: string, out: Emitted[]): void => check(name, out.length === 0, events(out));

function rendersFully(name: string, e: Emitted | undefined, tier: string): void {
	if (!e) return check(name, false, '(nothing emitted)');
	const r = rendered(e);
	check(name, r.tier === tier && !r.plain.includes('<unknown>'), r.plain);
}

console.log('\n── certbot-monitor-renewal-due smoke ──────────────────────\n');
try {
	// ── A Let's Encrypt certificate through its life ──
	quiet('30 days left (the live false alarm): nothing — certbot is not due yet', one(30 * D + H));
	quiet('29 days left: certbot is due and tries twice a day — nothing yet', one(29 * D + H));
	quiet('just over 23 days left (6 days overdue): within the grace — nothing', one(23 * D + H));

	let out = one(23 * D - H);
	const w = out[0];
	check(
		'23 days left (a week overdue): one cert_expiry_warn',
		only(out, 'cert_expiry_warn'),
		events(out)
	);
	check(
		"…its age comes from the certificate itself, not certbot's log (no 999)",
		w?.context.issued_days_ago === 67 && !('last_renewal_success_age_days' in (w?.context ?? {})),
		JSON.stringify(w?.context)
	);
	check(
		'…when certbot was due (30, though the certificate is 90 days less a second) and how overdue',
		w?.context.renew_due_days_left === 30 &&
			w?.context.overdue_days === 7 &&
			w?.context.threshold_days === 23 &&
			w?.context.days_left === 22 &&
			w?.context.cert === 'c.example',
		JSON.stringify(w?.context)
	);
	rendersFully('…the bot renders it WARN, every field filled in', w, 'WARN');

	out = one(7 * D + H);
	check('just over 7 days left: still the warning', only(out, 'cert_expiry_warn'), events(out));
	out = one(7 * D - H);
	check('7 days left: renewal_stalled (CRITICAL)', only(out, 'renewal_stalled'), events(out));
	rendersFully('…the bot renders it CRITICAL, every field filled in', out[0], 'CRITICAL');
	out = one(-12 * H);
	check(
		'expired 12 hours ago: renewal_stalled, days_left -1 (not "expires in 0 days")',
		only(out, 'renewal_stalled') && out[0]?.context.days_left === -1,
		events(out)
	);

	// ── Who decides "stalled": the certificate's age against the stall days ──
	// An hour off a whole day of age: with LE's 90 days less a second, 6 days
	// left put the age within a second of 84 days, so it read 83 or 84 by
	// whether the clock ticked between writing the certificate and the monitor
	// reading the time (a loaded machine: the second call read 84, the first 83).
	out = one(6 * D - H);
	const age = out[0]?.context.issued_days_ago as number;
	out = one(6 * D - H, {}, { MORPHIT_CERTBOT_RENEWAL_STALL_DAYS: String(age) });
	check(
		'issued exactly the stall days ago: renewal_stalled',
		only(out, 'renewal_stalled'),
		events(out)
	);
	out = one(6 * D - H, {}, { MORPHIT_CERTBOT_RENEWAL_STALL_DAYS: String(age + 1) });
	check(
		'issued a day less than that: cert_expiry_critical',
		only(out, 'cert_expiry_critical'),
		events(out)
	);
	// A 15-day certificate: due at 5 days left, grace 2 (half the window), critical at 3.
	out = one(3 * D - H, { lifetime: 15 * D });
	check(
		'a 15-day certificate issued 12 days ago, overdue: cert_expiry_critical (stall default 14)',
		only(out, 'cert_expiry_critical') && out[0]?.context.threshold_days === 3,
		events(out)
	);
	rendersFully('…rendered CRITICAL, every field filled in', out[0], 'CRITICAL');

	// ── Settings ──
	quiet(
		'MORPHIT_CERTBOT_EXPIRY_WARN_DAYS=30 (the old default): still nothing at 29 days left',
		one(29 * D - H, {}, { MORPHIT_CERTBOT_EXPIRY_WARN_DAYS: '30' })
	);
	quiet(
		'MORPHIT_CERTBOT_EXPIRY_WARN_DAYS=14: nothing at 20 days left',
		one(20 * D, {}, { MORPHIT_CERTBOT_EXPIRY_WARN_DAYS: '14' })
	);
	out = one(14 * D - H, {}, { MORPHIT_CERTBOT_EXPIRY_WARN_DAYS: '14' });
	check(
		'MORPHIT_CERTBOT_EXPIRY_WARN_DAYS=14: warns at 14 days left',
		only(out, 'cert_expiry_warn') && out[0]?.context.threshold_days === 14,
		events(out)
	);
	out = one(23 * D - H, {}, { MORPHIT_CERTBOT_RENEWAL_GRACE_DAYS: 'x7' });
	check(
		'a grace that is not a number falls back to 7 (the check still runs)',
		only(out, 'cert_expiry_warn') && out[0]?.context.threshold_days === 23,
		events(out)
	);
	quiet(
		'MORPHIT_CERTBOT_RENEWAL_GRACE_DAYS=08 (a leading zero): read as 8 — nothing at 22 days',
		one(22 * D + H, {}, { MORPHIT_CERTBOT_RENEWAL_GRACE_DAYS: '08' })
	);
	out = one(22 * D - H, {}, { MORPHIT_CERTBOT_RENEWAL_GRACE_DAYS: '08' });
	check(
		'…and warns just under 22 (the check did not stop)',
		only(out, 'cert_expiry_warn') && out[0]?.context.threshold_days === 22,
		events(out)
	);
	out = one(6 * D, {}, { MORPHIT_CERTBOT_RENEWAL_STALL_DAYS: '09' });
	check(
		'MORPHIT_CERTBOT_RENEWAL_STALL_DAYS=09: valid JSON, read as 9',
		only(out, 'renewal_stalled') && out[0]?.context.stall_threshold_days === 9,
		events(out)
	);
	out = one(6 * D, {}, { MORPHIT_CERTBOT_EXPIRY_CRITICAL_DAYS: '99999999999999999999' });
	check(
		'an over-long critical days value falls back to 7 (6 days left is still CRITICAL)',
		only(out, 'renewal_stalled'),
		events(out)
	);
	out = one(10 * D, {}, { MORPHIT_CERTBOT_EXPIRY_CRITICAL_DAYS: '99999999999999999999' });
	check('…and 10 days left is still only the warning', only(out, 'cert_expiry_warn'), events(out));

	// ── The renewal file's renew_before_expiry (certbot reads it above the first [section]) ──
	for (const [conf, due] of [
		['renew_before_expiry = 20 days\n', 20],
		['renew_before_expiry = 20\n', 20],
		['renew_before_expiry = "20 days"\n', 20],
		["renew_before_expiry='20 Days'  # earlier\n", 20],
		['renew_before_expiry = 3 weeks\n', 21],
		['renew_before_expiry = 2 months\n', 60]
	] as const) {
		const label = JSON.stringify(conf.trim());
		quiet(`${label}: nothing until a week after it is due`, one((due - 7) * D + H, { conf }));
		out = one((due - 7) * D - H, { conf });
		check(
			`${label}: due at ${due} days left, warns a week later`,
			only(out, 'cert_expiry_warn') && out[0]?.context.renew_due_days_left === due,
			events(out)
		);
	}
	out = one(23 * D - H, { conf: '# renew_before_expiry = 10 days\n' });
	check(
		'a commented-out renew_before_expiry (how certbot writes it) is ignored',
		only(out, 'cert_expiry_warn') && out[0]?.context.renew_due_days_left === 30,
		events(out)
	);
	out = one(23 * D - H, { conf: '[renewalparams]\nrenew_before_expiry = 10 days\n' });
	check(
		'one under [renewalparams] (certbot ignores it there) is ignored too',
		only(out, 'cert_expiry_warn') && out[0]?.context.renew_due_days_left === 30,
		events(out)
	);

	// ── Never silent at the end, whatever the settings ──
	const zero = { conf: 'renew_before_expiry = 0 days\n' };
	quiet('renew_before_expiry = 0 days: nothing with a day and an hour left', one(D + H, zero));
	out = one(D - H, zero);
	check(
		'renew_before_expiry = 0 days: CRITICAL with under a day left',
		only(out, 'renewal_stalled'),
		events(out)
	);
	out = one(-H, zero);
	check(
		'renew_before_expiry = 0 days: CRITICAL once expired',
		only(out, 'renewal_stalled'),
		events(out)
	);

	// ── Other lifetimes ──
	const six = { lifetime: 6 * D - 1 };
	quiet('a fresh 6-day certificate: nothing', one(6 * D - H, six));
	quiet(
		'a 6-day certificate half an hour after certbot is due: nothing (it has a day of grace)',
		one(3 * D - H / 2, six)
	);
	out = one(2 * D - H, six);
	check(
		'a 6-day certificate a day overdue: cert_expiry_critical',
		only(out, 'cert_expiry_critical'),
		events(out)
	);
	rendersFully('…rendered CRITICAL, every field filled in', out[0], 'CRITICAL');
	quiet(
		'a 180-day certificate at 53 days left: nothing (certbot 2.x renews at 30, not a third)',
		one(53 * D, { lifetime: 180 * D })
	);
	out = one(23 * D - H, { lifetime: 180 * D });
	check(
		'…and warns a week after 30',
		only(out, 'cert_expiry_warn') && out[0]?.context.renew_due_days_left === 30,
		events(out)
	);

	// ── Several certificates ──
	out = run(tree({ name: 'fresh.example', left: 89 * D }, { name: 'stuck.example', left: 20 * D }));
	check(
		'two certificates, one overdue: one warning, for that one',
		only(out, 'cert_expiry_warn') && out[0]?.context.cert === 'stuck.example',
		events(out)
	);
	quiet('no certificates at all: nothing', run(tree()));
} catch (e) {
	fail++;
	console.log(`  ✗ ${(e as Error).message}`);
} finally {
	rmSync(work, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(56)}`);
if (fail === 0) {
	console.log(`✓ all ${pass} checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} failed, ${pass} passed`);
	process.exit(1);
}
