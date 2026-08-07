#!/usr/bin/env tsx
/**
 * health-backup-freshness — v1.8.9.
 *
 * WHY. The built-in daily backup shipped in v1.8.4 and produced nothing on any
 * Debian/Ubuntu host for three releases (dash kills the shell on
 * `set -o pipefail`, silently, before pg_dump). It went unnoticed because
 * `morphit-ops health` reported indexer sync, relay, price feeds and canary
 * freshness — and never looked at backups at all. This smoke keeps that blind
 * spot closed.
 *
 * The unit tests cover the DECISION logic; this covers the WIRING, which is the
 * half that silently rots: exported-but-never-called logic reports nothing,
 * which is precisely the failure being fixed.
 *
 * Tamper tests (each must turn this red):
 *   - Drop the checkBackups call from the health command → fails.
 *   - Remove the Backups block from the rendered output → fails.
 *   - Report `missing` on a permission error instead of `unreadable` → fails.
 *   - Parse the timer's LastTrigger from a locale-formatted date → fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkIpfsSeeding, type IpfsSeedingFacts } from '../apps/ops-cli/src/commands/health.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── health-backup-freshness (v1.8.9) ──────────────────\n');

const health = read('apps/ops-cli/src/commands/health.ts');
const ops = read('docs/OPERATIONS.md');
const runNode = read('docs/RUN-A-MORPHIT-NODE.md');

// ─── the check exists ────────────────────────────────────────────
check('health exposes a pure checkBackups(facts, now)', /export function checkBackups\(facts: BackupFacts, now: Date\): BackupStatus/.test(health));
check('health gathers the facts from disk + systemd', /export function readBackupFacts\(/.test(health));

// ─── ...and is actually WIRED (the half that rots silently) ──────
check(
	'the health command CALLS it',
	/const backups = checkBackups\(readBackupFacts\(\), now\);/.test(health),
	'exported-but-uncalled logic reports nothing — exactly the bug being fixed'
);
check(
	'and RENDERS a Backups block',
	/console\.log\(`  \$\{c\.bold\('Backups'\)\}/.test(health)
);
check(
	'the block shows the newest dump with its size and age',
	/formatBackupSize\(backups\.bytes\)/.test(health) && /formatBackupAge\(backups\.ageMs\)/.test(health)
);
check(
	'the detail line is always printed, so a bad state explains itself',
	/console\.log\(`      \$\{c\.dim\(backups\.detail\)\}`\);/.test(health)
);

// ─── the states that carry the meaning ───────────────────────────
check(
	'a FAILED unit and a missing dump render red',
	/backups\.state === 'failing' \|\| backups\.state === 'missing'\s*\?\s*c\.red/.test(health),
	'these are the two states that mean "you have no working backup"'
);
check(
	'opting out renders neutral, not alarming',
	/backups\.state === 'not-configured'\s*\n?\s*\?\s*c\.dim/.test(health),
	'running your own backup is a legitimate choice and must not shout'
);
check(
	'a permission problem is UNREADABLE, never MISSING',
	/state: 'unreadable'/.test(health) && /if \(!facts\.readable\)/.test(health),
	'claiming "no backups" because the CLI could not look would be a false alarm'
);
check(
	'the fired-but-wrote-nothing case is detected (the dash-bug signature)',
	/facts\.lastTriggerMs > facts\.newest\.atMs \+ BACKUP_TRIGGER_SLACK_MS/.test(health)
);
check(
	'a manual run cannot read as a failure (timer LastTrigger, not service start)',
	/TIMER's last trigger/.test(health)
);

// ─── clock discipline ────────────────────────────────────────────
check(
	'the timer timestamp is requested as unix, never parsed from a locale date',
	/--timestamp=unix/.test(health) && /\^@\(\\d\+\)\$/.test(health),
	'the canary clock documents why locale-formatted dates must not be Date-parsed'
);

// ─── the stale window stays sane for a DAILY timer ───────────────
const staleHours = /BACKUP_STALE_AFTER_MS = (\d+) \* 60 \* 60 \* 1000/.exec(health)?.[1];
check('the stale window is declared in hours', staleHours !== undefined);
check(
	`the stale window (${staleHours ?? '?'}h) tolerates jitter but catches a missed night`,
	staleHours !== undefined && Number(staleHours) > 24.5 && Number(staleHours) <= 48,
	'under ~25h a normal jittered run reads as stale and operators learn to ignore the signal'
);

// ─── a dump too small to BE a dump (cp526) ───────────────────────
// Freshness alone is not enough. The pre-cp526 backup script renamed a FAILED
// pg_dump's ~20-byte gzip member to a real backup name, so the useless
// artefact was also the NEWEST one — every timing rule passes and only size
// betrays it. Without this floor the health line greenlights a directory of
// worthless restore points.
const floorBytes = /BACKUP_MIN_PLAUSIBLE_BYTES = (\d+)/.exec(health)?.[1];
check('a minimum plausible dump size is declared', floorBytes !== undefined);
check(
	`the floor (${floorBytes ?? '?'}B) is above a bare gzip member but far below a real dump`,
	floorBytes !== undefined && Number(floorBytes) > 200 && Number(floorBytes) <= 10_000,
	'too low and a 20-byte fragment passes; too high and a legitimate small dump false-positives'
);
check(
	'the size check runs BEFORE the timing rules, so a fresh fragment cannot slip through',
	health.indexOf('BACKUP_MIN_PLAUSIBLE_BYTES') !== -1 &&
		health.indexOf('facts.newest.bytes < BACKUP_MIN_PLAUSIBLE_BYTES') <
			health.indexOf('facts.lastTriggerMs > facts.newest.atMs + BACKUP_TRIGGER_SLACK_MS'),
	'a truncated dump is typically brand new — checked after the clocks, it reads as fresh'
);

// ─── documented for operators, in BOTH docs ──────────────────────
// Specific enough that they cannot pass on words that merely happen to appear.
check(
	'OPERATIONS.md documents every Backups state, including the silent-failure one',
	/Backups\s+✓ fresh/.test(ops) &&
		['fresh', 'stale', 'failing', 'missing', 'not-configured', 'unreadable'].every((st) =>
			new RegExp(`\`[✓⚠✗○] ${st}\``).test(ops)
		),
	'an operator meeting a red Backups line needs to know which kind of bad it is'
);
check(
	'OPERATIONS.md explains that unreadable is a permission problem, not an absent backup',
	/not\*\* reported as "missing"|not\b[^.]{0,40}reported as "missing"/.test(ops)
);
check(
	'RUN-A-MORPHIT-NODE.md points operators at the Backups line',
	/\*\*Backups\*\* line/.test(runNode)
);

// ─── IPFS / IPNS release seeding (cp667) ─────────────────────────
// Same blind-spot class as backups: the node silently stops doing its share of
// hosting the release / keeping IPNS alive and nothing tells the operator.
check(
	'health exposes a pure checkIpfsSeeding(facts)',
	/export function checkIpfsSeeding\(f: IpfsSeedingFacts\): IpfsSeedingStatus/.test(health)
);
check('health gathers the seeding facts read-only', /export function readIpfsSeedingFacts\(/.test(health));
check(
	'the health command CALLS it',
	/const ipfsSeeding = checkIpfsSeeding\(readIpfsSeedingFacts\(\)\);/.test(health),
	'exported-but-uncalled logic reports nothing'
);
check(
	"and RENDERS an 'IPFS/IPNS release seeding' block",
	/console\.log\(`  \$\{c\.bold\('IPFS\/IPNS release seeding'\)\}/.test(health)
);
check(
	'the detail line is always printed',
	/console\.log\(`      \$\{c\.dim\(ipfsSeeding\.detail\)\}`\);/.test(health)
);
check(
	'a down daemon renders red, a not-configured node stays neutral',
	/ipfsSeeding\.state === 'down'\s*\n?\s*\?\s*c\.red/.test(health) &&
		/ipfsSeeding\.state === 'not-configured'\s*\n?\s*\?\s*c\.dim/.test(health)
);
check(
	'it reads the pin + rebroadcast timers AND the daemon',
	/checkService\('ipfs'\)/.test(health) &&
		/checkService\('morphit-ipfs-pin\.timer'\)/.test(health) &&
		/checkService\('morphit-ipns-rebroadcast\.timer'\)/.test(health)
);

// decision logic (pure)
const mkFacts = (o: Partial<IpfsSeedingFacts>): IpfsSeedingFacts => ({
	daemon: 'active',
	pinTimer: 'active',
	rebroadcastTimer: 'active',
	pinFailed: false,
	pinRanMs: 60_000,
	rebroadcastFailed: false,
	rebroadcastRanMs: 60_000,
	...o
});
check(
	'nothing installed → not-configured (optional, never alarms)',
	checkIpfsSeeding(mkFacts({ daemon: 'not-installed', pinTimer: 'not-installed', rebroadcastTimer: 'not-installed' })).state === 'not-configured'
);
check(
	'daemon down while configured → down (releases NOT seeded)',
	checkIpfsSeeding(mkFacts({ daemon: 'inactive' })).state === 'down'
);
check(
	'daemon up but a timer inactive → degraded',
	checkIpfsSeeding(mkFacts({ pinTimer: 'inactive' })).state === 'degraded'
);
check(
	'daemon up but last rebroadcast FAILED → degraded',
	checkIpfsSeeding(mkFacts({ rebroadcastFailed: true })).state === 'degraded'
);
check(
	'daemon + both timers active + no failures → ok',
	checkIpfsSeeding(mkFacts({})).state === 'ok'
);

// the --json output (Zabbix reads this) must carry backups + ipfs_seeding
check(
	'health --json includes a backups block',
	/backups: \{[\s\S]{0,200}?state: backups\.state/.test(health)
);
check(
	'health --json includes an ipfs_seeding block',
	/ipfs_seeding: \{[\s\S]{0,200}?state: ipfsSeeding\.state/.test(health)
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} health-backup-freshness checks passed` : '✗ health-backup-freshness FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
