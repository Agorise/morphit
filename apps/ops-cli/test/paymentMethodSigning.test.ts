/**
 * `morphit-ops payment-method` add / remove sign with the key every install
 * has — the relay account's active key (MORPHIT_RELAY_ACTIVE_KEY_FILE, the one
 * `register` signs with). They used to need MORPHIT_OPERATOR_POSTING_KEY_FILE,
 * which no installer writes, and said so only after every question.
 *
 * Observed: what reaches the signer (the op and the key), that the op is the
 * posting-authority form the indexer's own signer check accepts from that
 * account, and that a setup which cannot work stops BEFORE any question.
 * The chain broadcast and the database are stubbed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signed: Array<{ op: unknown; wif: string }> = [];
/** The broadcast ends with "no final answer" (it may have reached a node). */
let outcomeUnknown = false;
let questions: string[] = [];
let answers: Array<string | number | boolean> = [];
let rows: Array<{ key: string; name: string; category: string; state: string }> = [];
let choiceLists: string[][] = [];

vi.mock('../src/lib/chainAccess.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	return {
		...real,
		signOnceAndBroadcast: vi.fn(async (a: { op: unknown; wif: string }) => {
			signed.push(a);
			if (outcomeUnknown) {
				const E = real.BroadcastOutcomeUnknownError as new (t: string, d: string) => Error;
				throw new E('e'.repeat(40), 'test: no answer in time');
			}
			return { trx_id: 'f'.repeat(40), signed: {} };
		})
	};
});
vi.mock('../src/init/prompt.ts', async (orig) => {
	const real = (await orig()) as Record<string, unknown>;
	const nextAnswer = <T>(q: string): T => {
		questions.push(q);
		if (answers.length === 0) throw new Error(`unexpected question: ${q}`);
		return answers.shift() as T;
	};
	return {
		...real,
		ask: vi.fn(async (q: string) => nextAnswer<string>(q)),
		askYesNo: vi.fn(async (q: string) => nextAnswer<boolean>(q)),
		askPassword: vi.fn(async (q: string) => nextAnswer<string>(q)),
		askChoice: vi.fn(async (q: string, choices: readonly string[]) => {
			choiceLists.push([...choices]);
			return nextAnswer<number>(q);
		})
	};
});
vi.mock('../src/config.ts', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/db.ts', () => ({
	createDatabase: async () => ({
		query: async () => ({ rows }),
		close: async () => {}
	})
}));

const { runPaymentMethod } = await import('../src/commands/paymentMethod.ts');
// The indexer's own signer rule. Imported by a computed path: the indexer's
// module aliases ($blurt/…) are not in this workspace's type-check.
type SignerCheck = (
	op: Record<string, unknown>,
	allowActiveAuth: boolean
) => { ok: true; signer: string } | { ok: false; reason: string };
const VERIFY = join(import.meta.dirname, '..', '..', 'indexer', 'src', 'blurt', 'verify.ts');
const { extractSigner } = (await import(VERIFY)) as { extractSigner: SignerCheck };

const WIF = '5JfakeWifForThisTestOnly0000000000000000000000000000';
let root = '';
let printed: string[] = [];
const saved = { ...process.env };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'pm-signing-'));
	mkdirSync(join(root, 'etc/morphit'), { recursive: true });
	writeFileSync(join(root, 'relay.keystore'), `${WIF}\n`, { mode: 0o400 });
	writeFileSync(
		join(root, 'etc/morphit/indexer.env'),
		'MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME=example-relay\n'
	);
	process.env.MORPHIT_ENV_ROOT = root;
	process.env.MORPHIT_RELAY_ACCOUNT = 'example-relay';
	process.env.MORPHIT_RELAY_ACTIVE_KEY_FILE = join(root, 'relay.keystore');
	process.env.MORPHIT_RELAY_CRED_FILE = join(root, 'no-such.cred');
	delete process.env.MORPHIT_OPERATOR_POSTING_KEY_FILE;
	signed.length = 0;
	outcomeUnknown = false;
	questions = [];
	answers = [];
	rows = [];
	choiceLists = [];
	printed = [];
	vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
		printed.push(a.map(String).join(' '));
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = { ...saved };
	rmSync(root, { recursive: true, force: true });
});

describe('payment-method add', () => {
	it("signs with the relay's active key, as a posting-level op the indexer accepts from the operator", async () => {
		answers = [true]; // Proceed?
		const rc = await runPaymentMethod({
			positional: ['add', 'my_bank'],
			flags: { name: 'My Bank', category: 'online' }
		});
		expect(rc).toBe(0);
		expect(signed).toHaveLength(1);
		expect(signed[0]!.wif).toBe(WIF);
		const [kind, body] = signed[0]!.op as [string, Record<string, unknown>];
		expect(kind).toBe('custom_json');
		expect(body.id).toBe('morphit_payment_method_addition_v1');
		// The indexer's own signer rule (posting authority only, one signer).
		expect(extractSigner(body as unknown as Parameters<typeof extractSigner>[0], false)).toEqual({
			ok: true,
			signer: 'example-relay'
		});
	});

	it("the key file set only in the relay service's own file (/etc/morphit/relay.env) is used", async () => {
		writeFileSync(
			join(root, 'etc/morphit/relay.env'),
			`MORPHIT_RELAY_ACTIVE_KEY_FILE=${join(root, 'relay.keystore')}\n`
		);
		delete process.env.MORPHIT_RELAY_ACTIVE_KEY_FILE;
		answers = [true];
		const rc = await runPaymentMethod({
			positional: ['remove', 'my_bank'],
			flags: {}
		});
		expect(rc).toBe(0);
		expect(signed[0]?.wif).toBe(WIF);
	});

	it('the interactive Add with no key on this server: stops before any question, and says what to do', async () => {
		delete process.env.MORPHIT_RELAY_ACTIVE_KEY_FILE;
		answers = [1, 3]; // Add, then Done
		expect(await runPaymentMethod({ positional: ['menu'], flags: {} })).toBe(0);
		expect(questions.filter((q) => !/payment methods this site adds/i.test(q))).toEqual([]);
		expect(printed.join('\n')).toMatch(/no key to sign with: MORPHIT_RELAY_ACTIVE_KEY_FILE/);
		expect(printed.join('\n')).not.toMatch(/show-key/);
		expect(signed).toHaveLength(0);
	});

	it('an indexer with no operator account set takes them from its default (@morphit): said before any question', async () => {
		writeFileSync(join(root, 'etc/morphit/indexer.env'), 'MORPHIT_INDEXER_LISTEN_PORT=8081\n');
		answers = [1, 3];
		expect(await runPaymentMethod({ positional: ['menu'], flags: {} })).toBe(0);
		expect(questions.filter((q) => !/payment methods this site adds/i.test(q))).toEqual([]);
		expect(printed.join('\n')).toMatch(/accepts payment methods only from @morphit/);
		expect(signed).toHaveLength(0);
	});

	it('a broadcast with no final answer: "may still land" and how to look for it — not "could not complete"', async () => {
		outcomeUnknown = true;
		answers = [true]; // Proceed?
		const rc = await runPaymentMethod({
			positional: ['add', 'my_bank'],
			flags: { name: 'My Bank', category: 'online' }
		});
		expect(rc).toBe(1);
		const text = printed.join('\n');
		expect(text).toMatch(/may already have reached the Blurt network, so it can still land/);
		expect(text).toContain('sudo morphit-ops payment-method list');
		expect(text).not.toMatch(/Could not complete the broadcast/);
	});

	it('an indexer that takes payment methods only from another account: stops before any question', async () => {
		writeFileSync(
			join(root, 'etc/morphit/indexer.env'),
			'MORPHIT_INDEXER_OPERATOR_ACCOUNT_NAME=someone-else\n'
		);
		answers = [1, 3];
		expect(await runPaymentMethod({ positional: ['menu'], flags: {} })).toBe(0);
		expect(questions.filter((q) => !/payment methods this site adds/i.test(q))).toEqual([]);
		expect(printed.join('\n')).toMatch(/accepts payment methods only from @someone-else/);
	});
});

describe('payment-method unlocks an encrypted key the way register does', () => {
	it('a wrong passphrase is said in plain words and asked again; the right one then signs', async () => {
		const { encryptEnvelope } = await import('../../relay/src/crypto/keyEnvelope.ts');
		writeFileSync(
			join(root, 'relay.keystore'),
			JSON.stringify(encryptEnvelope(WIF, 'correct horse battery'))
		);
		answers = [true, 'not the passphrase', 'correct horse battery']; // Proceed? then two tries
		const errs: string[] = [];
		vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
			errs.push(a.map(String).join(' '));
		});
		const rc = await runPaymentMethod({
			positional: ['add', 'my_bank'],
			flags: { name: 'My Bank', category: 'online' }
		});
		expect(rc).toBe(0);
		expect(signed).toHaveLength(1);
		expect(signed[0]!.wif).toBe(WIF);
		const out = [...printed, ...errs].join('\n');
		expect(out).toMatch(/does not open the relay key file/);
		expect(out).not.toMatch(/tamper/i);
	});

	it('three wrong passphrases: nothing is signed, and the reason is plain', async () => {
		const { encryptEnvelope } = await import('../../relay/src/crypto/keyEnvelope.ts');
		writeFileSync(
			join(root, 'relay.keystore'),
			JSON.stringify(encryptEnvelope(WIF, 'correct horse battery'))
		);
		answers = [true, 'wrong 1', 'wrong 2', 'wrong 3'];
		const rc = await runPaymentMethod({ positional: ['remove', 'my_bank'], flags: {} });
		expect(rc).toBe(1);
		expect(signed).toHaveLength(0);
		expect(answers).toEqual([]); // all three tries were asked
		const out = printed.join('\n');
		expect(out).toMatch(/did not open the relay key file in 3 tries/);
		expect(out).not.toMatch(/tamper/i);
	});
});

describe('payment-method menu', () => {
	it('Remove lists only the methods still offered, by name', async () => {
		rows = [
			{ key: 'my_bank', name: 'My Bank', category: 'online', state: 'active' },
			{ key: 'old_bank', name: 'Old Bank', category: 'online', state: 'removed' }
		];
		answers = [2, 1, 3]; // Remove → Cancel → Done
		expect(await runPaymentMethod({ positional: ['menu'], flags: {} })).toBe(0);
		const picker = choiceLists[1]!;
		expect(picker).toHaveLength(2); // My Bank + Cancel
		expect(picker[0]).toMatch(/^My Bank/);
		expect(picker.join(' ')).not.toMatch(/Old Bank/);
	});

	it('the last item says what it does: it leaves the command (no "Back to main menu")', async () => {
		answers = [3];
		expect(await runPaymentMethod({ positional: ['menu'], flags: {} })).toBe(0);
		expect(choiceLists[0]![3]).toBe('Done');
		expect(choiceLists[0]!.join(' ')).not.toMatch(/main menu|additions/i);
	});
});
