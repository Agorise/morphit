/**
 * The upgrade heal that gives an existing hidden-only node's relay no clearnet.
 *
 * F32 fixed the tor-only template, but `morphit-ops upgrade` does not re-render
 * templates, so the nodes that were actually exposed — every EXISTING tor-only
 * node — would have kept a clearnet relay after upgrading.
 *
 * Everything here goes through real files sourced by real bash, the way the
 * services read them. The end-to-end case goes one step further and hands the
 * healed files to the RELAY'S OWN config loader, because "the heal thinks the
 * relay is hidden-only" is worth nothing unless the relay agrees.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	mkdtempSync,
	writeFileSync,
	readFileSync,
	rmSync,
	chmodSync,
	existsSync,
	mkdirSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	INDEXER_ENV_FILES,
	RELAY_ENV_FILES,
	RELAY_ENV_TARGETS,
	readEffectiveEnv,
	decideRelayHeal,
	healRelayHiddenOnly,
	applyAndVerifyRelayHeal,
	relayHealBackupPath,
	type RelayHealRuntime
} from '../src/lib/relayHiddenHeal.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const ONION = `http://${'a'.repeat(56)}.onion:8091`;
const B32 = `http://${'b'.repeat(52)}.b32.i2p:8091`;

let dir = '';
let morphitEnv = '';
let indexerEnv = '';
let relayEnv = '';
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'relay-heal-'));
	morphitEnv = join(dir, 'morphit.env');
	indexerEnv = join(dir, 'indexer.env');
	relayEnv = join(dir, 'relay.env');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The files each service reads, in the units' order, relocated to `dir`. */
const heal = () => {
	const warnings: string[] = [];
	const r = healRelayHiddenOnly({
		indexerFiles: [morphitEnv, indexerEnv],
		relayFiles: [morphitEnv, relayEnv],
		targets: [relayEnv, morphitEnv],
		warn: (m) => warnings.push(m)
	});
	return { ...r, warnings };
};
const relayView = () =>
	readEffectiveEnv(
		[morphitEnv, relayEnv],
		[
			'MORPHIT_RELAY_BLURT_RPC',
			'MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS',
			'MORPHIT_RELAY_TOR_SOCKS',
			'MORPHIT_RELAY_I2P_HTTP_PROXY'
		]
	);

/** What the OLD ansible templates wrote on a tor-only node: the indexer with
 *  no clearnet, the relay with no RPC line at all. */
function legacyTorOnly(): void {
	writeFileSync(
		indexerEnv,
		[
			'MORPHIT_INDEXER_RPC_ENDPOINTS=',
			`MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=${ONION},${B32}`,
			'MORPHIT_INDEXER_TOR_SOCKS=127.0.0.1:9150',
			'MORPHIT_INDEXER_I2P_HTTP_PROXY=',
			''
		].join('\n')
	);
	writeFileSync(relayEnv, 'MORPHIT_RELAY_ACCOUNT=someop\nMORPHIT_RELAY_SIGNUP_DAILY_CEILING=50\n');
}

// ─────────────────────────────────────────────────────────────────────────────
describe('the file lists are the ones the services actually read', () => {
	/** Parse `for f in A B C; do` out of a unit's ExecStart. */
	const unitFiles = (unit: string): string[] => {
		const text = readFileSync(join(REPO, 'ops', 'systemd', unit), 'utf8');
		const m = /^ExecStart=.*?for f in ([^;]+); do/m.exec(text);
		if (!m) throw new Error(`no env loop in ${unit}`);
		return m[1]!.trim().split(/\s+/);
	};
	it('the indexer’s list is its unit’s list, in order', () => {
		expect([...INDEXER_ENV_FILES]).toEqual(unitFiles('morphit-indexer.service'));
	});
	it('the relay’s list is its unit’s list, in order', () => {
		expect([...RELAY_ENV_FILES]).toEqual(unitFiles('morphit-relay.service'));
	});
	it('every place the heal may write is a file the relay reads', () => {
		for (const t of RELAY_ENV_TARGETS) expect(RELAY_ENV_FILES).toContain(t);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe('reading a setting the way a service does', () => {
	it('unset and empty are different answers', () => {
		writeFileSync(relayEnv, 'MORPHIT_RELAY_BLURT_RPC=\n');
		const v = relayView();
		expect(v.get('MORPHIT_RELAY_BLURT_RPC')).toBe('');
		expect(v.get('MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS')).toBeUndefined();
	});

	it('the later file wins, as it does in the unit', () => {
		writeFileSync(morphitEnv, 'MORPHIT_RELAY_BLURT_RPC=https://rpc.example.com\n');
		writeFileSync(relayEnv, 'MORPHIT_RELAY_BLURT_RPC=\n');
		expect(relayView().get('MORPHIT_RELAY_BLURT_RPC')).toBe('');
	});

	it('quotes are the shell’s, not part of the value', () => {
		writeFileSync(
			relayEnv,
			`MORPHIT_RELAY_BLURT_RPC=""\nMORPHIT_RELAY_TOR_SOCKS='127.0.0.1:9150'\n`
		);
		const v = relayView();
		expect(v.get('MORPHIT_RELAY_BLURT_RPC')).toBe('');
		expect(v.get('MORPHIT_RELAY_TOR_SOCKS')).toBe('127.0.0.1:9150');
	});

	it('this process’s own environment never stands in for a file', () => {
		const saved = process.env.MORPHIT_RELAY_BLURT_RPC;
		process.env.MORPHIT_RELAY_BLURT_RPC = '';
		try {
			writeFileSync(relayEnv, 'MORPHIT_RELAY_ACCOUNT=x\n');
			expect(relayView().get('MORPHIT_RELAY_BLURT_RPC')).toBeUndefined();
		} finally {
			if (saved === undefined) delete process.env.MORPHIT_RELAY_BLURT_RPC;
			else process.env.MORPHIT_RELAY_BLURT_RPC = saved;
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe('an existing tor-only node, as the old template left it', () => {
	it('the relay is given no clearnet, and the indexer’s hidden list and proxies', () => {
		legacyTorOnly();
		const r = heal();
		expect(r.decision?.kind).toBe('add');
		expect(r.wrote).toBe(relayEnv);
		const v = relayView();
		expect(v.get('MORPHIT_RELAY_BLURT_RPC')).toBe('');
		expect(v.get('MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS')).toBe(`${ONION},${B32}`);
		expect(v.get('MORPHIT_RELAY_TOR_SOCKS')).toBe('127.0.0.1:9150');
		// A blank proxy is how the indexer says "no i2pd here"; the relay must
		// not be left dialling a daemon that is not there.
		expect(v.get('MORPHIT_RELAY_I2P_HTTP_PROXY')).toBe('');
	});

	it('what was already in the file is untouched', () => {
		legacyTorOnly();
		const before = readFileSync(relayEnv, 'utf8');
		heal();
		expect(readFileSync(relayEnv, 'utf8').startsWith(before)).toBe(true);
	});

	it('a file with no final newline does not have its last line glued to ours', () => {
		legacyTorOnly();
		writeFileSync(relayEnv, 'MORPHIT_RELAY_SIGNUP_DAILY_CEILING=50');
		heal();
		const v = readEffectiveEnv(
			[relayEnv],
			['MORPHIT_RELAY_SIGNUP_DAILY_CEILING', 'MORPHIT_RELAY_BLURT_RPC']
		);
		expect(v.get('MORPHIT_RELAY_SIGNUP_DAILY_CEILING')).toBe('50');
		expect(v.get('MORPHIT_RELAY_BLURT_RPC')).toBe('');
	});

	it('a second upgrade changes nothing', () => {
		legacyTorOnly();
		heal();
		const once = readFileSync(relayEnv, 'utf8');
		const r = heal();
		expect(r.decision?.kind).toBe('relay-already-hidden-only');
		expect(readFileSync(relayEnv, 'utf8')).toBe(once);
	});

	it('with no relay.env, it writes where the relay also reads', () => {
		legacyTorOnly();
		rmSync(relayEnv);
		writeFileSync(morphitEnv, 'MORPHIT_RELAY_ACCOUNT=x\n');
		expect(heal().wrote).toBe(morphitEnv);
		expect(relayView().get('MORPHIT_RELAY_BLURT_RPC')).toBe('');
	});

	/** THE CASE THAT MATTERS. The heal's opinion is worthless unless the relay,
	 *  handed these exact files, starts — and starts hidden-only. */
	it('the relay’s own config loader, given the healed files, boots hidden-only with push off', async () => {
		legacyTorOnly();
		heal();
		const keyFile = join(dir, 'active.key');
		const { PrivateKey } = await import('@beblurt/dblurt');
		writeFileSync(keyFile, PrivateKey.fromSeed('relay-heal-test').toString());
		chmodSync(keyFile, 0o400);
		const base = {
			MORPHIT_RELAY_ACCOUNT: 'morphit-relay',
			MORPHIT_RELAY_ACTIVE_KEY_FILE: keyFile,
			MORPHIT_RELAY_DATABASE_URL: 'postgres://relay:a-real-password-here@localhost:5432/morphit',
			MORPHIT_RELAY_INVITE_HMAC_SECRET: 'i'.repeat(64),
			MORPHIT_RELAY_ALTCHA_HMAC_SECRET: 'a'.repeat(64),
			MORPHIT_RELAY_VAPID_PUBLIC_KEY: Buffer.concat([
				Buffer.from([4]),
				Buffer.alloc(64, 7)
			]).toString('base64url'),
			MORPHIT_RELAY_VAPID_PRIVATE_KEY: 'p'.repeat(43),
			MORPHIT_RELAY_VAPID_SUBJECT: 'mailto:ops@example.com'
		};
		const healed = relayView();
		const saved = { ...process.env };
		try {
			for (const k of Object.keys(process.env))
				if (k.startsWith('MORPHIT_RELAY_')) delete process.env[k];
			Object.assign(process.env, base);
			for (const [k, v] of healed) if (v !== undefined) process.env[k] = v;
			const { loadConfig } = await import('../../relay/src/config/index.ts');
			const cfg = loadConfig();
			expect(cfg.hiddenOnly).toBe(true);
			expect(cfg.blurtRpcEndpoints).toEqual([]);
			expect(cfg.hiddenRpcEndpoints).toEqual([ONION, B32]);
			expect(cfg.pushEnabled).toBe(false);
			// Control, same process and same keys: WITHOUT the heal the relay is a
			// clearnet relay — so the assertions above are the heal's doing.
			delete process.env.MORPHIT_RELAY_BLURT_RPC;
			delete process.env.MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS;
			const unhealed = loadConfig();
			expect(unhealed.hiddenOnly).toBe(false);
			expect(unhealed.pushEnabled).toBe(true);
		} finally {
			for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
			Object.assign(process.env, saved);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe('what it must never touch', () => {
	const unchanged = (setup: () => void, wantKind: string) => {
		setup();
		const files = [morphitEnv, indexerEnv, relayEnv].filter((f) => existsSync(f));
		const before = files.map((f) => readFileSync(f, 'utf8'));
		const r = heal();
		expect(r.decision?.kind).toBe(wantKind);
		expect(r.wrote).toBeNull();
		expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(before);
		return r;
	};

	it('a clearnet node — the default, with no RPC line anywhere', () => {
		unchanged(() => {
			writeFileSync(indexerEnv, 'MORPHIT_INDEXER_CHAIN_ID=x\n');
			writeFileSync(relayEnv, 'MORPHIT_RELAY_ACCOUNT=x\n');
		}, 'indexer-uses-clearnet');
	});

	it('a clearnet node that lists its own endpoints', () => {
		unchanged(() => {
			writeFileSync(indexerEnv, 'MORPHIT_INDEXER_RPC_ENDPOINTS=https://rpc.example.com\n');
			writeFileSync(relayEnv, 'MORPHIT_RELAY_ACCOUNT=x\n');
		}, 'indexer-uses-clearnet');
	});

	it('a relay list the operator set explicitly — warned about, never rewritten', () => {
		const r = unchanged(() => {
			writeFileSync(indexerEnv, 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n');
			writeFileSync(relayEnv, 'MORPHIT_RELAY_BLURT_RPC=https://rpc.example.com\n');
		}, 'relay-lists-clearnet');
		expect(r.warnings.join(' ')).toContain('https://rpc.example.com');
	});

	it('an override in the later file is the setting that counts', () => {
		unchanged(() => {
			writeFileSync(indexerEnv, 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n');
			writeFileSync(morphitEnv, 'MORPHIT_RELAY_BLURT_RPC=\n');
			writeFileSync(relayEnv, 'MORPHIT_RELAY_BLURT_RPC=https://rpc.example.com\n');
		}, 'relay-lists-clearnet');
	});

	it('a relay whose hidden list was blanked would be left with nothing — so nothing is written', () => {
		unchanged(() => {
			writeFileSync(indexerEnv, 'MORPHIT_INDEXER_RPC_ENDPOINTS=\n');
			writeFileSync(relayEnv, 'MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS=\n');
		}, 'relay-has-no-endpoints');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the upgrade actually runs it', () => {
	/** The phase a real upgrade runs: the old orchestrator re-execs the NEW
	 *  binary with this subcommand, so a heal shipped in this release applies
	 *  on this upgrade. Driven through the real entry point, with the env files
	 *  relocated under a scratch root. */
	it('`__post-upgrade-selfheal` heals a legacy tor-only relay', () => {
		const root = join(dir, 'root');
		for (const d of ['opt/morphit', 'etc/morphit']) mkdirSync(join(root, d), { recursive: true });
		writeFileSync(
			join(root, 'etc/morphit/indexer.env'),
			`MORPHIT_INDEXER_RPC_ENDPOINTS=\nMORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS=${ONION}\n`
		);
		writeFileSync(join(root, 'etc/morphit/relay.env'), 'MORPHIT_RELAY_ACCOUNT=x\n');
		const r = spawnSync(
			join(REPO, 'node_modules', '.bin', 'tsx'),
			[join(REPO, 'apps', 'ops-cli', 'src', 'main.ts'), '__post-upgrade-selfheal'],
			{ encoding: 'utf8', timeout: 120_000, env: { ...process.env, MORPHIT_ENV_ROOT: root } }
		);
		expect(r.status).toBe(0);
		const v = readEffectiveEnv(
			[join(root, 'etc/morphit/relay.env')],
			['MORPHIT_RELAY_BLURT_RPC', 'MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS']
		);
		expect(v.get('MORPHIT_RELAY_BLURT_RPC')).toBe('');
		expect(v.get('MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS')).toBe(ONION);
	}, 150_000);
});

describe('a hidden list the relay would refuse is not copied', () => {
	it('an onion the relay does not accept leaves the relay on its own default list', () => {
		const shortOnion = 'http://tooshort.onion:8091';
		const d = decideRelayHeal(
			new Map([
				['MORPHIT_INDEXER_RPC_ENDPOINTS', ''],
				['MORPHIT_INDEXER_HIDDEN_RPC_ENDPOINTS', `${ONION},${shortOnion}`]
			]),
			new Map()
		);
		expect(d.kind).toBe('add');
		const names = d.kind === 'add' ? d.settings.map(([k]) => k) : [];
		expect(names).toContain('MORPHIT_RELAY_BLURT_RPC');
		expect(names).not.toContain('MORPHIT_RELAY_HIDDEN_RPC_ENDPOINTS');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * v1.18.0 review (O6). The heal printed "The relay now reaches the chain over
 * hidden services only" the moment it appended its lines — before any restart,
 * and nothing ever read the relay's own answer. It now restarts the relay,
 * reads the relay's /v1/health, says only what it observed, and puts the file
 * back if the relay does not come back at all.
 */
describe('the heal is proven on the running relay, not announced', () => {
	function runtime(
		over: Partial<RelayHealRuntime> & {
			answers?: { reachable: boolean; hiddenOnly: boolean | null }[];
		}
	) {
		const calls = { restarts: 0 };
		const answers = [...(over.answers ?? [])];
		const rt: RelayHealRuntime = {
			unitState:
				over.unitState ?? (() => ({ activeState: 'failed', subState: 'failed', restarts: 0 })),
			isActive: over.isActive ?? (() => true),
			restart:
				over.restart ??
				(() => {
					calls.restarts++;
					return true;
				}),
			health:
				over.health ?? (async () => answers.shift() ?? { reachable: false, hiddenOnly: null }),
			sleep: async () => undefined
		};
		return { rt, calls };
	}
	const run = async (rt: RelayHealRuntime) => {
		const infos: string[] = [];
		const warnings: string[] = [];
		const outcome = await applyAndVerifyRelayHeal({
			indexerFiles: [morphitEnv, indexerEnv],
			relayFiles: [morphitEnv, relayEnv],
			targets: [relayEnv, morphitEnv],
			info: (m) => infos.push(m),
			warn: (m) => warnings.push(m),
			runtime: rt,
			deadlineMs: 50
		});
		return { outcome, infos, warnings };
	};

	it('the apply step on its own claims nothing it has not observed', () => {
		legacyTorOnly();
		const infos: string[] = [];
		healRelayHiddenOnly({
			indexerFiles: [morphitEnv, indexerEnv],
			relayFiles: [morphitEnv, relayEnv],
			targets: [relayEnv, morphitEnv],
			info: (m) => infos.push(m)
		});
		expect(
			infos.join(' '),
			'it announced the relay "now reaches" hidden services before anything had restarted'
		).not.toMatch(/now reaches/i);
	});

	it('restarted, and its health says hidden-only: VERIFIED, and only then said', async () => {
		legacyTorOnly();
		const { rt, calls } = runtime({ answers: [{ reachable: true, hiddenOnly: true }] });
		const r = await run(rt);
		expect(r.outcome).toBe('verified');
		expect(calls.restarts).toBe(1);
		expect(r.infos.join(' ')).toMatch(/now reaches the chain over hidden services only.*checked/i);
	});

	it('a relay that is not running is told nothing false', async () => {
		legacyTorOnly();
		const { rt, calls } = runtime({ isActive: () => false });
		const r = await run(rt);
		expect(r.outcome).toBe('written-relay-not-running');
		expect(calls.restarts, 'a stopped relay must not be started by a self-heal').toBe(0);
		expect(r.infos.join(' ')).not.toMatch(/now reaches/i);
		expect(r.infos.join(' ')).toMatch(/next starts/);
	});

	it('a relay that does not come back is put back EXACTLY as it was, and restarted on it', async () => {
		legacyTorOnly();
		const before = readFileSync(relayEnv, 'utf8');
		// systemd shows it crash-looping: restarted by the unit since ours.
		let polls = 0;
		const { rt, calls } = runtime({
			answers: [],
			unitState: () => ({ activeState: 'activating', subState: 'auto-restart', restarts: polls++ })
		});
		const r = await run(rt);
		expect(r.outcome).toBe('reverted');
		expect(
			readFileSync(relayEnv, 'utf8'),
			'the relay was left on settings it cannot start with'
		).toBe(before);
		expect(calls.restarts, 'restarted once with the heal, once after putting it back').toBe(2);
		expect(existsSync(relayHealBackupPath(relayEnv))).toBe(true);
		expect(r.warnings.join(' ')).toMatch(/put back as it was/);
	});

	// The relay does not listen until its first
	// chain read succeeds, and over Tor that read tries each hidden endpoint
	// with a 60 s timeout. A healthy relay could take minutes to answer, so the
	// 60 s deadline put a tor-only node's relay back on CLEARNET RPC on every
	// upgrade. Only a relay systemd reports as failing is reverted now.
	it('a relay that is still starting (slow Tor) keeps the hidden-only setting', async () => {
		legacyTorOnly();
		const { rt, calls } = runtime({
			answers: [],
			unitState: () => ({ activeState: 'active', subState: 'running', restarts: 0 })
		});
		const r = await run(rt);
		expect(r.outcome, 'a slow but healthy relay was reverted to clearnet').toBe(
			'written-still-starting'
		);
		expect(readFileSync(relayEnv, 'utf8')).toMatch(/MORPHIT_RELAY_BLURT_RPC=''/);
		expect(calls.restarts, 'restarted once, for the heal, and not again').toBe(1);
		expect(r.warnings.join(' ')).not.toMatch(/put back/);
	});

	it('a relay that systemd reports as failed is put back', async () => {
		legacyTorOnly();
		const before = readFileSync(relayEnv, 'utf8');
		const { rt } = runtime({
			answers: [],
			unitState: () => ({ activeState: 'failed', subState: 'failed', restarts: 0 })
		});
		const r = await run(rt);
		expect(r.outcome).toBe('reverted');
		expect(readFileSync(relayEnv, 'utf8')).toBe(before);
	});

	it('a crash loop is seen as soon as systemd restarts the relay, without waiting out the deadline', async () => {
		legacyTorOnly();
		let polls = 0;
		const { rt } = runtime({
			answers: [],
			health: async () => {
				polls++;
				return { reachable: false, hiddenOnly: null };
			},
			unitState: () => ({
				activeState: 'active',
				subState: 'running',
				restarts: polls >= 2 ? 1 : 0
			})
		});
		const outcome = await applyAndVerifyRelayHeal({
			indexerFiles: [morphitEnv, indexerEnv],
			relayFiles: [morphitEnv, relayEnv],
			targets: [relayEnv, morphitEnv],
			runtime: rt,
			deadlineMs: 2_000
		});
		expect(outcome).toBe('reverted');
		expect(polls, 'it waited out the whole deadline').toBeLessThan(10);
	});

	it('a relay that is up but still on clearnet keeps the change and names what overrides it', async () => {
		legacyTorOnly();
		const { rt } = runtime({ answers: [{ reachable: true, hiddenOnly: false }] });
		const r = await run(rt);
		expect(r.outcome).toBe('written-not-in-effect');
		expect(r.warnings.join(' ')).toMatch(/MORPHIT_RELAY_BLURT_RPC/);
		expect(r.infos.join(' ')).not.toMatch(/now reaches/i);
	});

	it('nothing to change is nothing restarted', async () => {
		// A clearnet node: no heal applies.
		writeFileSync(indexerEnv, '');
		writeFileSync(relayEnv, 'MORPHIT_RELAY_ACCOUNT=x\n');
		const { rt, calls } = runtime({});
		const r = await run(rt);
		expect(r.outcome).toBe('nothing-to-do');
		expect(calls.restarts).toBe(0);
	});
});
