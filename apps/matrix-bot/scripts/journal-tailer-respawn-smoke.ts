#!/usr/bin/env tsx
/**
 * journal-tailer-respawn-smoke — the bot must not go deaf when journalctl dies.
 *
 * The tailer used to log "journalctl exited" and stop: no restart, while the
 * health endpoint kept answering ok — every later alert was lost and nothing
 * said so. Now the tailer respawns journalctl with backoff, resumes after the
 * last line it saw (no lost and no repeated alert), and the health endpoint
 * reports the tailer down (HTTP 503) while it is.
 *
 * A fake `journalctl` on PATH plays three runs: (1) one alert, then exits
 * 1; (2) exits 1 at once; (3) one more alert, then stays up.
 */

import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { tailJournalctl } from '../src/journalctl.ts';
import { createHealthServer } from '../src/health.ts';

let failures = 0;
let n = 0;
function check(name: string, cond: boolean, detail = ''): void {
	n++;
	if (cond) console.log(`  ✓ ${name}`);
	else {
		failures++;
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return true;
		await sleep(20);
	}
	return cond();
}

const dir = mkdtempSync(join(tmpdir(), 'mb-tailer-'));
const counter = join(dir, 'runs');
const argsLog = join(dir, 'args');
const line = (event: string, cursor: string) =>
	JSON.stringify({
		__CURSOR: cursor,
		_SYSTEMD_UNIT: 'morphit-indexer.service',
		MESSAGE: JSON.stringify({
			ts: '2026-10-01T00:00:00.000Z',
			level: 'error',
			module: 'smoke',
			event,
			context: {}
		})
	});
writeFileSync(
	join(dir, 'journalctl'),
	`#!/bin/sh
n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'
echo "run$n $*" >> '${argsLog}'
case $n in
1) printf '%s\\n' '${line('first_alert', 'c1')}'; exit 1 ;;
2) exit 1 ;;
*) printf '%s\\n' '${line('second_alert', 'c2')}'; exec sleep 30 ;;
esac
`
);
chmodSync(join(dir, 'journalctl'), 0o755);
process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;

const alerts: string[] = [];
const tailer = tailJournalctl(
	['morphit-indexer.service'],
	(a) => alerts.push(a.event),
	() => {},
	{ initialBackoffMs: 300, maxBackoffMs: 2_000 }
);
const server = createHealthServer({
	alertMxids: [],
	dryRun: true,
	sender: { sendDm: async () => {} },
	renderTestBody: () => ({ plain: '', html: '' }),
	tailerAlive: () => tailer.isAlive()
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as AddressInfo).port;
const health = async () => {
	const res = await fetch(`http://127.0.0.1:${port}/`);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

try {
	console.log('journal-tailer-respawn-smoke');
	const runs = () => Number(existsSync(counter) ? readFileSync(counter, 'utf8') : '0');
	await until(() => runs() >= 2, 5_000);
	// Run 2 has exited; run 3 starts only after the backoff.
	const down = await health();
	check(
		'while journalctl is down, health says so (503, tailer_alive false)',
		down.status === 503 && down.body['tailer_alive'] === false,
		`status=${down.status} body=${JSON.stringify(down.body)}`
	);
	const resumed = await until(() => alerts.includes('second_alert'), 8_000);
	check(
		'journalctl is respawned and alerting resumes',
		resumed,
		`alerts=${alerts.join(',')} runs=${runs()}`
	);
	const args = existsSync(argsLog) ? readFileSync(argsLog, 'utf8') : '';
	const run3 = args.split('\n').find((l) => l.startsWith('run3 ')) ?? '';
	check(
		'the respawn resumes after the last line seen (no lost or repeated alert)',
		run3.includes('--after-cursor=c1') && alerts.filter((e) => e === 'first_alert').length === 1,
		`run3="${run3}" alerts=${alerts.join(',')}`
	);
	const up = await health();
	check(
		'once journalctl runs again, health is ok',
		up.status === 200 && up.body['ok'] === true && up.body['tailer_alive'] === true,
		`status=${up.status} body=${JSON.stringify(up.body)}`
	);
} finally {
	tailer.stop();
	server.close();
	rmSync(dir, { recursive: true, force: true });
}

console.log();
if (failures > 0) {
	console.error(`✗ ${failures} of ${n} journal tailer checks failed`);
	process.exit(1);
}
console.log(`✓ all ${n} journal tailer checks passed`);
process.exit(0);
