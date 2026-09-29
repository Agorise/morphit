#!/usr/bin/env tsx
/**
 * Relay signup state + live RPC directory smoke (v1.20.0 fix wave, D3 + D12).
 *
 * D3  Every installed relay ran with the daily-ceiling counter in memory only
 *     and the kill-switch file disabled: no installer set MORPHIT_RELAY_DATA_DIR
 *     or MORPHIT_RELAY_SIGNUP_CEILING_PERSIST_PATH, and the code defaulted both
 *     to "off" (while ops/env/relay.env.example claimed a default). A restart
 *     reset the day's ceiling to zero. Checked through the REAL loadConfig and
 *     GlobalDailyCeiling: a relay started with the env the installers render
 *     keeps its count across a restart.
 * D12 The relay read the on-chain RPC directory once, at boot. Checked through
 *     the real sync with a real BlurtClient pool: a node that appears in the
 *     directory later is in the pool after the next tick.
 *
 * Usage: cd apps/relay && ../../node_modules/.bin/tsx --tsconfig ../../tsconfig.smoke.json scripts/signup-state-persistence-smoke.ts
 */
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const work = mkdtempSync(join(tmpdir(), 'relay-state-'));
process.env.MORPHIT_RPC_HEALTH_STATE = join(work, 'h.json');

let failures = 0;
let scenarios = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
	scenarios++;
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}
function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

const keyFile = join(work, 'key.wif');
writeFileSync(keyFile, '5JRaypasxMx1L97ZUX7YuC5Psb5EAbF821kkAGtBj7xCJFQcbLg\n');
chmodSync(keyFile, 0o600);
function baseEnv(): void {
	for (const k of Object.keys(process.env))
		if (k.startsWith('MORPHIT_RELAY_')) delete process.env[k];
	process.env.MORPHIT_RELAY_ACCOUNT = 'relayacct';
	process.env.MORPHIT_RELAY_ACTIVE_KEY_FILE = keyFile;
	process.env.MORPHIT_RELAY_DATABASE_URL = 'postgres://u:realpw@localhost/db';
}

const { loadConfig } = await import('../src/config/index.ts');
const { GlobalDailyCeiling } = await import('../src/policy/globalDailyCeiling.ts');

console.log('relay signup-state + RPC directory smoke:\n');

await check(
	'D3: with the env the installers render (no DATA_DIR / PERSIST_PATH) the ceiling is persisted',
	async () => {
		baseEnv();
		const c = loadConfig();
		assert(
			c.dataDir !== null && c.signupCeilingPersistPath !== null,
			`dataDir=${c.dataDir} persistPath=${c.signupCeilingPersistPath}`
		);
		assert(
			c.signupCeilingPersistPath.startsWith(`${c.dataDir}/`),
			`persist path ${c.signupCeilingPersistPath} is not under ${c.dataDir}`
		);
	}
);

await check(
	'D3: DATA_DIR alone puts the persisted ceiling inside it; an explicit PERSIST_PATH wins',
	async () => {
		baseEnv();
		process.env.MORPHIT_RELAY_DATA_DIR = '/srv/relay-state';
		const c1 = loadConfig();
		process.env.MORPHIT_RELAY_SIGNUP_CEILING_PERSIST_PATH = '/elsewhere/c.json';
		const c2 = loadConfig();
		assert(
			c1.signupCeilingPersistPath === '/srv/relay-state/signup-ceiling.json',
			`got ${c1.signupCeilingPersistPath}`
		);
		assert(
			c2.signupCeilingPersistPath === '/elsewhere/c.json',
			`got ${c2.signupCeilingPersistPath}`
		);
	}
);

await check(
	'D3: the day’s count survives a relay restart (real config → real ceiling)',
	async () => {
		baseEnv();
		process.env.MORPHIT_RELAY_DATA_DIR = join(work, 'state');
		const c = loadConfig();
		const { prepareSignupStateDir } = await import('../src/policy/signupState.ts');
		const st = prepareSignupStateDir(c.dataDir!);
		assert(st.writable && existsSync(c.dataDir!), `state dir not prepared: ${st.error}`);
		const g1 = new GlobalDailyCeiling(c.signupDailyCeiling, () => {}, c.signupCeilingPersistPath);
		for (let i = 0; i < c.signupDailyCeiling; i++) {
			g1.tryReserve();
			g1.recordSuccess();
		}
		const g2 = new GlobalDailyCeiling(c.signupDailyCeiling, () => {}, c.signupCeilingPersistPath);
		assert(
			g2.currentCount() === c.signupDailyCeiling && g2.canAccept() === false,
			`after restart count=${g2.currentCount()} canAccept=${g2.canAccept()}`
		);
	}
);

await check('D3: an unwritable state dir is REPORTED, not silently assumed', async () => {
	const { prepareSignupStateDir } = await import('../src/policy/signupState.ts');
	const blocker = join(work, 'a-file');
	writeFileSync(blocker, 'x');
	const st = prepareSignupStateDir(join(blocker, 'sub')); // a path under a regular file
	assert(st.writable === false && typeof st.error === 'string', `writable=${st.writable}`);
});

await check(
	'D12: a node published to the on-chain directory after boot joins the relay pool',
	async () => {
		const { BlurtClient } = await import('../src/blurt/client.ts');
		const { startRpcDirectorySync } = await import('../src/blurt/rpcDirectorySync.ts');
		const c = new BlurtClient(['https://rpc.example.org'], 100);
		const late = 'http://f6cijlm7vn32tc4kxr3vxve5pkbysoq2etlihvx25spwtkpqsa25siad.onion:8091';
		let endpoints: string[] = [];
		const db = { query: async () => ({ rows: [{ endpoints, node_names: { [late]: 'Star' } }] }) };
		const sync = startRpcDirectorySync(db as never, c, () => {}, 50);
		await sync.first;
		endpoints = [late];
		await new Promise((r) => setTimeout(r, 200));
		sync.stop();
		const urls = c.endpointSnapshot().map((e) => e.url);
		assert(urls.includes(late), `pool after the directory changed: ${urls.join(', ')}`);
	}
);

console.log('');
if (failures > 0) {
	console.log(`✗ ${failures} of ${scenarios} signup-state scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} signup-state scenarios passed`);
process.exit(0);
