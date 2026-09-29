/**
 * v1.20.0 (G1) — the operator's fees account in the on-chain registration.
 *
 * Other Morphit instances accept the 90 % leg of a BLURT fee paid through this
 * instance only when this operator's register op carries `fee_recipient` equal
 * to the account the frontend pays (the indexer's RESOLVED
 * MORPHIT_INDEXER_FEE_RECIPIENT). These tests drive:
 *   - the real `register` command (chain broadcast mocked) — it must publish it;
 *   - the resolver, through real env files sourced by real bash, as the
 *     indexer service reads them;
 *   - the unattended key unlock the upgrade heal relies on;
 *   - the upgrade heal's decisions, broadcast and read-back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const broadcasts: Array<{ account: string; opId: string; payload: Record<string, unknown> }> = [];
vi.mock('../src/commands/chainErrors.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		broadcastCustomJson: vi.fn(
			async (a: { account: string; opId: string; payload: Record<string, unknown> }) => {
				broadcasts.push({ account: a.account, opId: a.opId, payload: a.payload });
				return { trx_id: 'f'.repeat(40) };
			}
		)
	};
});
vi.mock('../src/lib/operatorTagGuard.ts', () => ({
	operatorTagConflict: () => false,
	fetchRegisteredTag: async () => 'b-node'
}));

const { runRegister, loadRelayKeyUnattended } = await import('../src/commands/register.ts');
const {
	acceptedRegistration,
	configuredFeeRecipient,
	resolveFeeRecipientValue,
	registerOpIn,
	latestChainRegistration
} = await import('../src/lib/operatorFeeRecipient.ts');
const { healFeeRecipientRegistration } = await import('../src/lib/feeRecipientHeal.ts');
const { selfHealSteps } = await import('../src/commands/upgrade.ts');
const { encryptEnvelope } = await import('../../relay/src/crypto/keyEnvelope.ts');

const WIF = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFDe';
let root = '';
const saved = { ...process.env };

/** Lay down the env files the indexer / relay services source, under root. */
function envFiles(files: Record<string, string>): void {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, '..'), { recursive: true });
		writeFileSync(join(root, path), text);
	}
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-feerecip-'));
	broadcasts.length = 0;
	process.env.MORPHIT_ENV_ROOT = root;
	process.env.MORPHIT_RELAY_CRED_FILE = join(root, 'no-such.cred');
	delete process.env.MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE_FILE;
	delete process.env.MORPHIT_INDEXER_FEE_RECIPIENT;
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
	vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...saved };
	rmSync(root, { recursive: true, force: true });
});

describe('the fees account the indexer service resolves', () => {
	it('matches the indexer’s resolveFeeRecipient (valid as written, else the treasury)', () => {
		expect(resolveFeeRecipientValue('b-fees')).toEqual({ recipient: 'b-fees', fellBack: false });
		expect(resolveFeeRecipientValue('  b-fees ')).toEqual({ recipient: 'b-fees', fellBack: false });
		for (const bad of [undefined, '', '@morphit-fees', '@b-fees', 'B-Fees', 'x']) {
			expect(resolveFeeRecipientValue(bad)).toEqual({ recipient: 'morphit-fees', fellBack: true });
		}
	});

	it('is read from the service env files, last file wins, like the unit sources them', () => {
		envFiles({
			'/opt/morphit/morphit.config.env': 'MORPHIT_INDEXER_FEE_RECIPIENT="b-fees"\n',
			'/etc/morphit/indexer.env': 'MORPHIT_INDEXER_LISTEN_PORT=8081\n'
		});
		process.env.MORPHIT_INDEXER_FEE_RECIPIENT = 'shell-value';
		expect(configuredFeeRecipient().recipient).toBe('b-fees');
		envFiles({ '/etc/morphit/indexer.env': 'MORPHIT_INDEXER_FEE_RECIPIENT=override-fees\n' });
		expect(configuredFeeRecipient().recipient).toBe('override-fees');
		// The ansible default "@morphit-fees" resolves to the treasury, as in the indexer.
		envFiles({ '/etc/morphit/indexer.env': 'MORPHIT_INDEXER_FEE_RECIPIENT=@morphit-fees\n' });
		expect(configuredFeeRecipient().recipient).toBe('morphit-fees');
	});
});

describe('morphit-ops register publishes the fees account', () => {
	it('sends fee_recipient = the resolved account, alongside every other field', async () => {
		envFiles({ '/opt/morphit/morphit.config.env': 'MORPHIT_INDEXER_FEE_RECIPIENT=b-fees\n' });
		const keyFile = join(root, 'relay.key');
		writeFileSync(keyFile, WIF);
		Object.assign(process.env, {
			MORPHIT_RELAY_ACCOUNT: 'bop',
			MORPHIT_RELAY_ACTIVE_KEY_FILE: keyFile,
			MORPHIT_INSTANCE_NAME: 'B market',
			MORPHIT_INSTANCE_ORIGIN: 'https://b.example',
			MORPHIT_INSTANCE_OPERATOR_TAG: 'b-node',
			MORPHIT_INSTANCE_TOR_ADDRESS: `${'a'.repeat(56)}.onion`
		});
		const rc = await runRegister({ flags: { 'non-interactive': 'true' }, positional: [] });
		expect(rc).toBe(0);
		expect(broadcasts).toHaveLength(1);
		expect(broadcasts[0]!.opId).toBe('morphit_operator_register_v1');
		expect(broadcasts[0]!.payload).toMatchObject({
			v: 1,
			tag: 'b-node',
			display_name: 'B market',
			origin: 'https://b.example',
			fee_recipient: 'b-fees',
			alt_addresses: { tor: `${'a'.repeat(56)}.onion` }
		});
	});
});

describe('unattended key unlock (what the upgrade heal can use)', () => {
	it('opens an encrypted key with the passphrase file named in the relay service env', async () => {
		const keyFile = join(root, 'relay.key');
		writeFileSync(keyFile, JSON.stringify(encryptEnvelope(WIF, 'correct horse battery')));
		writeFileSync(join(root, 'pass'), 'correct horse battery\n');
		envFiles({
			'/etc/morphit/relay.env': `MORPHIT_RELAY_ACTIVE_KEY_PASSPHRASE_FILE=${join(root, 'pass')}\n`
		});
		expect(await loadRelayKeyUnattended(keyFile)).toBe(WIF);
	});

	it('refuses (does not prompt) when nothing on the box can open it', async () => {
		const keyFile = join(root, 'relay.key');
		writeFileSync(keyFile, JSON.stringify(encryptEnvelope(WIF, 'secret-passphrase')));
		await expect(loadRelayKeyUnattended(keyFile)).rejects.toThrow(/sudo morphit-ops register/);
	});

	it('returns a plaintext WIF as is', async () => {
		const keyFile = join(root, 'relay.key');
		writeFileSync(keyFile, `${WIF}\n`);
		expect(await loadRelayKeyUnattended(keyFile)).toBe(WIF);
	});
});

describe('reading the newest register op from the chain history', () => {
	const entry = (seq: number, json: object, account = 'bop', id = 'morphit_operator_register_v1') =>
		[
			seq,
			{
				trx_id: `t${seq}`,
				block: 1000 + seq,
				op: [
					'custom_json',
					{ id, json: JSON.stringify(json), required_auths: [], required_posting_auths: [account] }
				]
			}
		] as [number, { trx_id: string; block: number; op: unknown }];

	it('takes the NEWEST register op signed by the account, across pages', async () => {
		const pages: Record<string, unknown[]> = {
			'-1': [
				entry(1500, { tag: 'b', fee_recipient: 'x' }, 'someone-else'),
				entry(1999, { foo: 1 }, 'bop', 'other_op')
			],
			'1499': [entry(700, { tag: 'b', fee_recipient: 'old-fees' }), entry(900, { tag: 'b' })]
		};
		const read = (async (_m: string, params: readonly unknown[]) =>
			pages[String(params[1])] ?? []) as never;
		expect(await latestChainRegistration('bop', {}, read)).toEqual({
			found: true,
			trxId: 't900',
			block: 1900,
			feeRecipient: null,
			payload: { tag: 'b' }
		});
		expect(registerOpIn(entry(5, { fee_recipient: 'b-fees' }), 'bop')).toMatchObject({
			feeRecipient: 'b-fees'
		});
	});
});

describe('upgrade heal: publish the fees account when the chain lacks it', () => {
	const ENV = {
		account: 'bop',
		keyFile: '/k',
		instanceName: 'B market',
		origin: 'https://b.example',
		contactUrl: null,
		operatorTag: 'b-node',
		altAddresses: { tor: null, i2p_b32: null, i2p_name: null, lokinet: null, ens: null },
		feeRecipient: 'b-fees'
	};
	const ACCEPTED = {
		v: 1,
		tag: 'b-node',
		display_name: 'B market (web)',
		contact_url: 'https://b.example/contact',
		origin: 'https://b.example',
		alt_addresses: { tor: `${'b'.repeat(56)}.onion` }
	};
	function harness(over: Record<string, unknown> = {}) {
		const lines: string[] = [];
		const sent: Array<Record<string, unknown>> = [];
		let t = 0;
		let chainSeesIt = false;
		const deps = {
			info: (l: string) => lines.push(l),
			warn: (l: string) => lines.push(l),
			spinner: () => () => {},
			env: () => ENV,
			localRegistration: async () =>
				({
					state: 'registered',
					tag: 'b-node',
					displayName: 'B market (web)',
					contactUrl: 'https://b.example/contact'
				}) as const,
			// What the chain ACCEPTED last — set later through the web form, so it
			// differs from the config (display name, contact, a Tor address).
			acceptedRegistration: async () => ({
				state: 'ok' as const,
				source: "this node's indexer",
				payload: ACCEPTED
			}),
			// A v1.19 indexer is still running during the upgrade: no field.
			localFeeView: async () => ({
				feeRecipient: 'b-fees',
				registered: null,
				reportsRegistration: false
			}),
			chainRegistration: async () =>
				chainSeesIt
					? {
							found: true as const,
							trxId: 'new-trx',
							block: 77,
							feeRecipient: 'b-fees',
							payload: {}
						}
					: {
							found: true as const,
							trxId: 'old-trx',
							block: 5,
							feeRecipient: null,
							// What the last `register` published (same record, no fees account).
							payload: {
								v: 1,
								tag: 'b-node',
								display_name: 'B market',
								origin: 'https://b.example'
							}
						},
			loadKey: async () => WIF,
			broadcast: async (_a: string, _w: string, payload: Record<string, unknown>) => {
				sent.push(payload);
				return { trx_id: 'new-trx' };
			},
			hiddenOnly: () => false,
			now: () => t,
			sleep: async (ms: number) => {
				t += ms;
				if (t >= 10_000) chainSeesIt = true;
			},
			hardStopAt: Number.POSITIVE_INFINITY,
			...over
		};
		return { deps, lines, sent, setSeen: (v: boolean) => (chainSeesIt = v) };
	}

	it('V3-4: re-publishes the ACCEPTED registration verbatim with only fee_recipient added; config differences are advice, not published', async () => {
		const h = harness();
		expect(await healFeeRecipientRegistration(h.deps as never)).toBe('published_verified');
		expect(h.sent).toEqual([{ ...ACCEPTED, fee_recipient: 'b-fees' }]);
		expect(h.lines.at(-1)).toMatch(
			/✓ Fees account @b-fees published .*new-trx.*chain history \(block 77\)/
		);
		const advice = h.lines.find((l) => /Your config also differs/.test(l));
		expect(advice).toBe(
			'  Your config also differs from your on-chain registration (display name: B market (web) on ' +
				'chain, B market in config; contact: https://b.example/contact on chain, (none) in config; ' +
				`Tor/I2P addresses: {"tor":"${'b'.repeat(56)}.onion"} on chain, (none) in config). That was ` +
				'left as it is on chain; to publish your config, run on this server:  sudo morphit-ops register'
		);
	});

	it('V3-4: when the accepted registration cannot be read reliably, NOTHING is broadcast — one calm line', async () => {
		const h = harness({
			acceptedRegistration: async () => ({
				state: 'unavailable',
				why: 'the newest register op on chain is not the one this node applied'
			})
		});
		expect(await healFeeRecipientRegistration(h.deps as never)).toBe('needs_operator');
		expect(h.sent).toEqual([]);
		expect(h.lines).toHaveLength(1);
		expect(h.lines[0]).toMatch(
			/did not publish anything\)\..*run on this server: {2}sudo morphit-ops register$/
		);
	});

	it("V3-4: the accepted payload comes from the indexer's event log, else from chain history only if it matches what was applied", async () => {
		const applied = {
			tag: 'b-node',
			displayName: 'B market (web)',
			contactUrl: 'https://b.example/contact'
		};
		// v1.20+ indexer: its event log.
		const v20 = await acceptedRegistration('bop', applied, {
			localJson: (async () => ({ payload: ACCEPTED })) as never
		});
		expect(v20).toEqual({ state: 'ok', payload: ACCEPTED, source: "this node's indexer" });
		// v1.20+ indexer that applied none: unavailable (no chain guess).
		const none = await acceptedRegistration('bop', applied, {
			localJson: (async () => {
				throw new Error('no applied registration');
			}) as never,
			chainRegistration: async () => {
				throw new Error('must not be asked');
			}
		});
		expect(none.state).toBe('unavailable');
		// Older indexer (no such route) → the chain's newest op, when it matches.
		const oldIdx = (async () => {
			throw new Error('HTTP 404');
		}) as never;
		const chainOp = (payload: Record<string, unknown>) => async () => ({
			found: true as const,
			trxId: 't',
			block: 5,
			feeRecipient: null,
			payload
		});
		const ok = await acceptedRegistration('bop', applied, {
			localJson: oldIdx,
			chainRegistration: chainOp({ ...ACCEPTED, display_name: '  B market (web) ' })
		});
		expect(ok.state).toBe('ok');
		// ...and refuses one the indexer did not apply (e.g. a later op it rejected).
		const bad = await acceptedRegistration('bop', applied, {
			localJson: oldIdx,
			chainRegistration: chainOp({ ...ACCEPTED, display_name: 'Something Else' })
		});
		expect(bad.state).toBe('unavailable');
	});

	it('does nothing when the chain already has it (v1.20 indexer or chain history)', async () => {
		const a = harness({
			localFeeView: async () => ({
				feeRecipient: 'b-fees',
				registered: true,
				reportsRegistration: true
			})
		});
		expect(await healFeeRecipientRegistration(a.deps as never)).toBe('already_registered');
		const b = harness();
		b.setSeen(true);
		expect(await healFeeRecipientRegistration(b.deps as never)).toBe('already_registered');
		expect([...a.sent, ...b.sent]).toEqual([]);
	});

	it('does nothing for the canonical treasury or an unregistered account', async () => {
		const a = harness({ env: () => ({ ...ENV, feeRecipient: 'morphit-fees' }) });
		expect(await healFeeRecipientRegistration(a.deps as never)).toBe('not_needed_canonical');
		const b = harness({ localRegistration: async () => ({ state: 'not_registered' }) });
		expect(await healFeeRecipientRegistration(b.deps as never)).toBe('not_registered');
		expect([...a.sent, ...b.sent, ...a.lines, ...b.lines]).toEqual([]);
	});

	it('one calm line with the exact command when the key cannot be unlocked unattended', async () => {
		const h = harness({
			loadKey: async () => {
				throw new Error('locked');
			}
		});
		expect(await healFeeRecipientRegistration(h.deps as never)).toBe('needs_operator');
		expect(h.sent).toEqual([]);
		expect(h.lines).toHaveLength(1);
		expect(h.lines[0]).toMatch(/run on this server: {2}sudo morphit-ops register$/);
	});

	it('the same when the configured tag differs from the registered one, or time is short', async () => {
		const a = harness({ env: () => ({ ...ENV, operatorTag: 'other' }) });
		expect(await healFeeRecipientRegistration(a.deps as never)).toBe('needs_operator');
		const b = harness({ hardStopAt: 30_000 });
		expect(await healFeeRecipientRegistration(b.deps as never)).toBe('needs_operator');
		expect([...a.sent, ...b.sent]).toEqual([]);
	});

	it('says it could not check — and changes nothing — when the indexer does not answer', async () => {
		const h = harness({
			localRegistration: async () => ({ state: 'unknown', why: 'ECONNREFUSED' })
		});
		expect(await healFeeRecipientRegistration(h.deps as never)).toBe('unknown');
		expect(h.sent).toEqual([]);
		expect(h.lines[0]).toMatch(/^ {2}Could not check/);
	});

	it('a broadcast never seen back within the bound is reported as unverified, not as done', async () => {
		const h = harness({ sleep: async (ms: number) => void ms });
		let t = 0;
		h.deps.now = () => (t += 1_000);
		expect(await healFeeRecipientRegistration(h.deps as never)).toBe('published_unverified');
		expect(h.lines.at(-1)).toMatch(/was broadcast .* but was not seen on chain in time/);
	});

	it('is one of the upgrade self-heal steps', () => {
		expect(selfHealSteps().map(([n]) => n)).toContain('the fees-account registration heal');
	});
});

describe('morphit-ops status: the fees-account row', async () => {
	const { feesAccountStatus } = await import('../src/commands/status.ts');
	const view = (o: Record<string, unknown>) =>
		({
			feeRecipient: 'b-fees',
			registered: true,
			reportsRegistration: true,
			...o
		}) as never;

	it('warns — with the exact command — only when the indexer REPORTS it unregistered', () => {
		const s = feesAccountStatus(view({ registered: false }));
		expect(s.status).toBe('warn');
		expect(s.note).toMatch(/run on this server: {2}sudo morphit-ops register$/);
	});
	it('says "could not read" (not "unregistered") when the indexer is down or older', () => {
		for (const s of [
			feesAccountStatus(null),
			feesAccountStatus(view({ reportsRegistration: false, registered: null }))
		]) {
			expect(s.registered).toBeNull();
			expect(s.status).toBe('info');
			expect(s.note).not.toMatch(/sudo morphit-ops register/);
		}
	});
	it('ok, with nothing to do, once the fees account is registered on chain', () => {
		expect(feesAccountStatus(view({}))).toMatchObject({
			status: 'ok',
			registered: true,
			note: null
		});
	});
});
