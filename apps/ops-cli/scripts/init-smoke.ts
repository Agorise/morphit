/**
 * Morphit ops CLI — init wizard smoke runner.
 *
 * Exercises the non-interactive logic of the setup wizard:
 *   - Blurt account name validation
 *   - passphrase strength check
 *   - --out path resolution
 *   - config + keystore writer (against a temp directory)
 *
 * Doesn't exercise the readline prompts (tested manually via
 * `tsx src/main.ts init`) or the system check (network-bound,
 * runs as live integration).
 */

import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

import { validateBlurtAccountName } from '../src/init/chainCheck.ts';
import { checkPassphraseStrength } from '../src/init/encrypt.ts';
import { resolveOutputPath, writeWizardOutput } from '../src/init/render.ts';
import type { WizardAnswers } from '../src/init/render.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

function assertTrue(cond: boolean, label: string): void {
	if (!cond) throw new Error(`${label}: expected true`);
}

function assertContains(haystack: string, needle: string, label: string): void {
	if (!haystack.includes(needle)) {
		throw new Error(`${label}: expected to find ${JSON.stringify(needle)}`);
	}
}

// ─── validateBlurtAccountName ────────────────────────────────────

scenario('validateBlurtAccountName: ok — simple valid name', () => {
	assertEqual(validateBlurtAccountName('alice').ok, true, 'alice');
	assertEqual(validateBlurtAccountName('bob123').ok, true, 'bob123');
	assertEqual(validateBlurtAccountName('my-relay').ok, true, 'my-relay');
});

scenario('validateBlurtAccountName: rejects too short', () => {
	const r = validateBlurtAccountName('ab');
	assertEqual(r.ok, false, 'too short ok');
	assertContains(r.message ?? '', 'minimum 3', 'too short msg');
});

scenario('validateBlurtAccountName: rejects too long', () => {
	const r = validateBlurtAccountName('a'.repeat(17));
	assertEqual(r.ok, false, 'too long ok');
	assertContains(r.message ?? '', 'maximum 16', 'too long msg');
});

scenario('validateBlurtAccountName: rejects starting with number', () => {
	const r = validateBlurtAccountName('1alice');
	assertEqual(r.ok, false, 'starts with num');
});

scenario('validateBlurtAccountName: rejects starting with dash', () => {
	const r = validateBlurtAccountName('-alice');
	assertEqual(r.ok, false, 'starts with dash');
});

scenario('validateBlurtAccountName: rejects uppercase', () => {
	const r = validateBlurtAccountName('Alice');
	assertEqual(r.ok, false, 'uppercase');
});

scenario('validateBlurtAccountName: rejects underscores', () => {
	const r = validateBlurtAccountName('alice_b');
	assertEqual(r.ok, false, 'underscore');
});

scenario('validateBlurtAccountName: rejects double dash', () => {
	const r = validateBlurtAccountName('a--b');
	assertEqual(r.ok, false, 'double dash');
});

scenario('validateBlurtAccountName: rejects trailing dash', () => {
	const r = validateBlurtAccountName('alice-');
	assertEqual(r.ok, false, 'trailing dash');
});

// ─── checkPassphraseStrength ─────────────────────────────────────

scenario('checkPassphraseStrength: rejects <8 chars', () => {
	const r = checkPassphraseStrength('1234567');
	assertEqual(r.ok, false, '7 chars');
});

scenario('checkPassphraseStrength: ok with warning at 8-11 chars', () => {
	const r = checkPassphraseStrength('12345678');
	assertEqual(r.ok, true, '8 chars ok');
	assertTrue(r.message !== undefined, '8 chars has warning');
});

scenario('checkPassphraseStrength: ok no warning at 12+ chars', () => {
	const r = checkPassphraseStrength('correcthorsebattery');
	assertEqual(r.ok, true, '12+ ok');
	assertEqual(r.message, undefined, '12+ no warning');
});

// ─── resolveOutputPath ───────────────────────────────────────────

scenario('resolveOutputPath: undefined returns default', () => {
	assertEqual(resolveOutputPath(undefined, '/repo'), '/repo', 'undefined');
});

scenario('resolveOutputPath: empty string returns default', () => {
	assertEqual(resolveOutputPath('', '/repo'), '/repo', 'empty');
});

scenario('resolveOutputPath: absolute path passes through', () => {
	assertEqual(resolveOutputPath('/etc/morphit', '/repo'), '/etc/morphit', 'absolute');
});

// ─── writeWizardOutput ───────────────────────────────────────────

const sampleAnswers: WizardAnswers = {
	instanceName: 'test-instance',
	tagline: 'A test',
	databaseUrl: 'postgres://test:secret@localhost/test',
	blurtRpcEndpoints: ['https://rpc.beblurt.com', 'https://rpc.blurt.world'],
	relayAccount: {
		name: 'testrelay',
		account: null,
		chainLookupSucceeded: false
	},
	activeKey: {
		mode: 'plaintext',
		plaintextWif: '5J' + 'a'.repeat(50),
		envelope: undefined,
		passphraseHint: undefined
	},
	feesAccount: 'testrelay',
	dailyCeiling: 25,
	contactUrl: 'https://example.com/contact',
	origin: null,
	altNetworks: { tor: null, lokinet: null, i2p: null, nostr: null },
	feeExplorers: {
		btc: ['https://blockstream.info/api', 'https://mempool.space/api'],
		xmr: [
			'https://xmrchain.net',
			'https://localmonero.co/blocks',
			'https://monerohash.com/explorer',
			'https://exploremonero.com',
			'https://moneroexplorer.org'
		]
	},
	chatLinkExplorers: {
		btc: 'https://mempool.space/tx/{txid}',
		xmr: 'https://xmrchain.net/tx/{txid}',
		bch: 'https://blockchair.com/bitcoin-cash/transaction/{txid}',
		ltc: 'https://litecoinspace.org/tx/{txid}',
		dash: 'https://insight.dash.org/insight/tx/{txid}',
		doge: 'https://blockchair.com/dogecoin/transaction/{txid}',
		zec: 'https://mainnet.zcashexplorer.app/transactions/{txid}',
		arrr: 'https://explorer.piratechain.com/tx/{txid}',
		usdt: {
			erc20: 'https://etherscan.io/tx/{txid}',
			trc20: 'https://tronscan.org/#/transaction/{txid}',
			spl: 'https://solscan.io/tx/{txid}',
			bep20: 'https://bscscan.com/tx/{txid}'
		},
		usdc: {
			erc20: 'https://etherscan.io/tx/{txid}',
			spl: 'https://solscan.io/tx/{txid}',
			base: 'https://basescan.org/tx/{txid}',
			polygon: 'https://polygonscan.com/tx/{txid}'
		},
		dai: {
			erc20: 'https://etherscan.io/tx/{txid}',
			polygon: 'https://polygonscan.com/tx/{txid}',
			base: 'https://basescan.org/tx/{txid}',
			arbitrum: 'https://arbiscan.io/tx/{txid}'
		}
	},
	listingFee: {
		targetUsd: 0.25,
		btcSatoshis: 416,
		xmrPiconero: 781_250_000,
		fallbackBlurtPriceUsd: 0.002,
		source: 'default'
	},
	seo: { title: null, description: null, keywords: null },
	backup: { enabled: false, backupDir: null, retainDays: null },
	operatorTag: { tag: 'morphit' },
	// Part 122 cp39 — disabledAssets fixture field.  The sampleAnswers
	// fixture had been missing `disabledAssets` since the wizard
	// step was added in cp30; every writeWizardOutput-based scenario
	// hit a TypeError until cp39 added it.  Empty list = baseline
	// "accept all assets" instance.  Per-scenario overrides exercise
	// the populated paths.
	disabledAssets: { disabledTickers: [] },
	// Part 121 cp9 — both Matrix surfaces opted-out in the
	// baseline fixture.  Per-scenario overrides exercise the
	// populated paths.
	matrix: { alertMxid: null, groupRoomAlias: null },
	mcpServer: { enabled: true }
};

scenario('writeWizardOutput: writes config + env + keystore at expected paths', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const result = writeWizardOutput(sampleAnswers, tmp);
		assertEqual(result.configPath, join(tmp, 'morphit.config.env'), 'config path');
		assertEqual(result.envPath, join(tmp, 'morphit.env'), 'env path');
		const expectedKeystore = join(tmp, 'apps', 'relay', 'keystore.wif');
		assertEqual(result.keystorePath, expectedKeystore, 'keystore path');
		assertTrue(result.configBytes > 0, 'config nonempty');
		assertTrue(result.envBytes > 0, 'env nonempty');
		assertTrue(result.keystoreBytes > 0, 'keystore nonempty');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: morphit.config.env contains operator-tunable keys', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const result = writeWizardOutput(sampleAnswers, tmp);
		const content = readFileSync(result.configPath, 'utf8');
		assertContains(content, 'MORPHIT_INSTANCE_NAME=test-instance', 'instance name');
		// cp139-D-1 v2: morphit.config.env is the parseEnv consumer.
		// Single-quoted form works for everything except embedded
		// apostrophes; "A test" has no apostrophe → single-quoted.
		assertContains(content, "MORPHIT_INSTANCE_TAGLINE='A test'", 'tagline (parseEnv = single-quoted)');
		assertContains(content, 'MORPHIT_RELAY_SIGNUP_DAILY_CEILING=25', 'ceiling');
		assertContains(content, 'MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT=100', 'fee fallback');
		assertContains(content, 'MORPHIT_INSTANCE_CONTACT_URL=https://example.com/contact', 'contact');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: morphit.env contains critical-infra keys', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const result = writeWizardOutput(sampleAnswers, tmp);
		const content = readFileSync(result.envPath, 'utf8');
		assertContains(
			content,
			'MORPHIT_INDEXER_DATABASE_URL=postgres://test:secret@localhost/test',
			'indexer db url'
		);
		assertContains(
			content,
			'MORPHIT_RELAY_DATABASE_URL=postgres://test:secret@localhost/test',
			'relay db url'
		);
		assertContains(content, 'MORPHIT_RELAY_ACCOUNT=testrelay', 'relay account');
		assertContains(content, 'MORPHIT_INDEXER_RELAY_ACCOUNT=testrelay', 'indexer relay account');
		assertContains(content, 'MORPHIT_INDEXER_FEE_RECIPIENT=testrelay', 'fees account');
		assertContains(content, 'MORPHIT_RELAY_ACTIVE_KEY_FILE=', 'key file');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: morphit.config.env does NOT contain critical-infra keys', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const result = writeWizardOutput(sampleAnswers, tmp);
		const content = readFileSync(result.configPath, 'utf8');
		assertTrue(!content.includes('MORPHIT_INDEXER_DATABASE_URL'), 'no db url in config');
		assertTrue(!content.includes('MORPHIT_INDEXER_FEE_RECIPIENT'), 'no fees account in config');
		assertTrue(!content.includes('MORPHIT_RELAY_ACTIVE_KEY_FILE'), 'no keystore path in config');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: omits optional keys when null', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const noOpt: WizardAnswers = { ...sampleAnswers, contactUrl: null };
		const result = writeWizardOutput(noOpt, tmp);
		const content = readFileSync(result.configPath, 'utf8');
		assertTrue(!content.includes('MORPHIT_INSTANCE_CONTACT_URL'), 'no contact url line');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── cp139-D-1: per-consumer quote-format split ─────────────────
//
// morphit.config.env → parseEnv consumer (operator-config package).
//   Format: double-quoted.  parseEnv does NOT expand $/backtick
//   inside double-quoted values (dotenv semantics).  Apostrophes
//   pass through verbatim — needed because parseEnv does NOT
//   support the POSIX `'\''` close-escape-reopen idiom.
//
// morphit.env → bash consumer (sourced via `set -a; .` or
//   systemd EnvironmentFile=).
//   Format: single-quoted.  Suppresses every form of bash
//   expansion.  Apostrophes use the POSIX close-escape-reopen
//   idiom which bash understands but parseEnv doesn't.
//
// cp139-C-11 first switched both to single-quoted; cp139-D-1
// discovered the parseEnv/POSIX mismatch and split by consumer.

scenario('cp139-D-1: $HOME in tagline (parseEnv consumer) is single-quoted', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const answers: WizardAnswers = { ...sampleAnswers, tagline: 'Morphit $HOME instance' };
		const result = writeWizardOutput(answers, tmp);
		const content = readFileSync(result.configPath, 'utf8');
		// cp139-D-1 v2: prefer single-quoted in parseEnv consumer
		// (no apostrophe in value → single-quoted works).  parseEnv
		// reads $HOME inside single-quotes literally; bash never
		// sources morphit.config.env so the would-be bash expansion
		// is not a concern.
		assertContains(content, "MORPHIT_INSTANCE_TAGLINE='Morphit $HOME instance'", 'single-quoted');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('cp139-D-1: command-substitution $(...) in tagline is single-quoted (parseEnv literal)', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const answers: WizardAnswers = {
			...sampleAnswers,
			tagline: 'evil $(curl http://x.example) instance'
		};
		const result = writeWizardOutput(answers, tmp);
		const content = readFileSync(result.configPath, 'utf8');
		// parseEnv reads $(curl ...) inside single-quotes literally.
		assertContains(
			content,
			"MORPHIT_INSTANCE_TAGLINE='evil $(curl http://x.example) instance'",
			'single-quoted (parseEnv literal)'
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario("cp139-D-1: embedded apostrophe in tagline falls back to double-quoted (parseEnv consumer)", () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const answers: WizardAnswers = {
			...sampleAnswers,
			tagline: "alice's morphit"
		};
		const result = writeWizardOutput(answers, tmp);
		const content = readFileSync(result.configPath, 'utf8');
		// Apostrophe in value → can't use single-quoted (parseEnv
		// doesn't support POSIX close-escape-reopen).  Fall back to
		// double-quoted; parseEnv reads $ inside double-quotes
		// literally (no expansion).  Apostrophe survives verbatim.
		assertContains(content, 'MORPHIT_INSTANCE_TAGLINE="alice\'s morphit"', 'double-quoted fallback');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('cp139-D-1: bare-safe values still emit without quotes', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const result = writeWizardOutput(sampleAnswers, tmp);
		const content = readFileSync(result.configPath, 'utf8');
		// `test-instance` matches the bare regex — must emit without
		// quotes.
		assertContains(content, 'MORPHIT_INSTANCE_NAME=test-instance', 'bare emission');
		assertTrue(
			!content.includes("MORPHIT_INSTANCE_NAME='test-instance'"),
			'bare must NOT be force-quoted'
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario("cp139-D-1: bash consumer (morphit.env critical-infra) stays single-quoted", () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		// morphit.env's writable values (DB URL + RPC list) are
		// the bash consumer.  The DB URL in sampleAnswers has a
		// colon-port + an @ inside the password section so it'll
		// pass through bare; but the RPC endpoints join is comma-
		// separated which doesn't match the bare regex.
		const answers: WizardAnswers = {
			...sampleAnswers,
			blurtRpcEndpoints: ['https://rpc1.example', 'https://rpc2.example']
		};
		const result = writeWizardOutput(answers, tmp);
		const env = readFileSync(result.envPath, 'utf8');
		assertContains(
			env,
			"MORPHIT_INDEXER_RPC_ENDPOINTS='https://rpc1.example,https://rpc2.example'",
			'bash consumer = single-quoted'
		);
		assertTrue(
			!env.includes('MORPHIT_INDEXER_RPC_ENDPOINTS="https://'),
			'bash consumer must NOT use double-quotes (would expand $-substring in URL params)'
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario(
	"cp139-D-1 negative: value with both ' and \" throws at quote() time (unrepresentable in parseEnv)",
	() => {
		const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
		try {
			// parseEnv supports neither escape form for the OTHER
			// quote char inside a given quote.  An operator typing
			// `alice's "first" morphit` into the tagline is an edge
			// case we surface loudly rather than silently corrupt.
			// Wizard prompt layer is the right place to reject — for
			// now the write throws, which is much better than
			// truncating at parse time.
			const answers: WizardAnswers = {
				...sampleAnswers,
				tagline: "alice's \"first\" morphit"
			};
			let threw = false;
			try {
				writeWizardOutput(answers, tmp);
			} catch (err) {
				if (
					err instanceof Error &&
					err.message.includes('both') &&
					err.message.includes('unrepresentable')
				) {
					threw = true;
				} else {
					throw err;
				}
			}
			assertTrue(threw, 'expected quote() to throw on value with both apostrophe and double-quote');
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
);

// ─── cp139-D-1: parseEnv round-trip invariant ───────────────────
//
// The big regression sentinel: the wizard's emitted morphit.config.env
// must round-trip cleanly through Node's parseEnv (operator-config's
// consumer).  This is the test that would have CAUGHT cp139-D-1 if
// it had existed at cp139-C-11 ship time.

scenario(
	"cp139-D-1 round-trip: tagline with apostrophe survives parseEnv read-back",
	() => {
		const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
		try {
			// "Berlin's first Morphit node." — the EXACT example string
			// stepTagline shows the operator.  cp139-C-11 would have
			// emitted this as 'Berlin'\''s first Morphit node.' which
			// parseEnv truncates to "Berlin" silently.
			const answers: WizardAnswers = {
				...sampleAnswers,
				tagline: "Berlin's first Morphit node."
			};
			const result = writeWizardOutput(answers, tmp);
			const content = readFileSync(result.configPath, 'utf8');
			const parsed = parseEnv(content);
			assertTrue(
				parsed.MORPHIT_INSTANCE_TAGLINE === "Berlin's first Morphit node.",
				`round-trip failed: parsed = ${JSON.stringify(parsed.MORPHIT_INSTANCE_TAGLINE)}, expected "Berlin's first Morphit node."`
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
);

scenario(
	"cp139-D-1 round-trip: tagline with $HOME survives parseEnv read-back as literal",
	() => {
		const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
		try {
			const answers: WizardAnswers = {
				...sampleAnswers,
				tagline: 'My $HOME node'
			};
			const result = writeWizardOutput(answers, tmp);
			const content = readFileSync(result.configPath, 'utf8');
			const parsed = parseEnv(content);
			// parseEnv doesn't expand $ inside double-quotes (dotenv
			// semantics); the literal string $HOME survives.
			assertTrue(
				parsed.MORPHIT_INSTANCE_TAGLINE === 'My $HOME node',
				`round-trip failed: parsed = ${JSON.stringify(parsed.MORPHIT_INSTANCE_TAGLINE)}`
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
);

scenario(
	"cp139-D-1 round-trip: every config field round-trips through parseEnv",
	() => {
		const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
		try {
			// Hostile-ish values that hit the non-bare-safe regex path
			// in each operator-tunable field.  All must round-trip
			// through Node's parseEnv (the canonical consumer for
			// morphit.config.env).
			const answers: WizardAnswers = {
				...sampleAnswers,
				instanceName: 'My Test Node',  // space → quote path
				tagline: "alice's tagline with $HOME",  // apostrophe + $ literal
				contactUrl: 'https://example.com/contact?to=alice@example.com',  // @ + ? + =
				origin: 'https://my-morphit.example.com:8443',  // : (bare-safe)
				operatorTag: {
					tag: 'my-org.morphit-instance'  // bare-safe
				},
				seo: {
					title: "morphit's first instance",  // apostrophe → double-quoted fallback
					description: null,
					keywords: null
				}
			};
			const result = writeWizardOutput(answers, tmp);
			const content = readFileSync(result.configPath, 'utf8');
			const parsed = parseEnv(content);

			// All fields below are in morphit.config.env (parseEnv
			// consumer).  OPERATOR_TAG lives in morphit.env per
			// render.ts (bash consumer) and is exercised by a
			// separate bash-consumer round-trip in edit-smoke.
			const checks: Array<[string, string]> = [
				['MORPHIT_INSTANCE_NAME', 'My Test Node'],
				['MORPHIT_INSTANCE_TAGLINE', "alice's tagline with $HOME"],
				['MORPHIT_INSTANCE_CONTACT_URL', 'https://example.com/contact?to=alice@example.com'],
				['MORPHIT_INSTANCE_ORIGIN', 'https://my-morphit.example.com:8443'],
				['MORPHIT_INSTANCE_SEO_TITLE', "morphit's first instance"]
			];
			for (const [key, expected] of checks) {
				assertTrue(
					parsed[key] === expected,
					`${key}: parsed=${JSON.stringify(parsed[key])}, expected=${JSON.stringify(expected)}`
				);
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
);

scenario('writeWizardOutput: writes MORPHIT_INSTANCE_ORIGIN when origin set', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const withOrigin: WizardAnswers = {
			...sampleAnswers,
			origin: 'https://alice-morphit.example'
		};
		const result = writeWizardOutput(withOrigin, tmp);
		const content = readFileSync(result.configPath, 'utf8');
		assertContains(
			content,
			'MORPHIT_INSTANCE_ORIGIN=https://alice-morphit.example',
			'origin written'
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: omits MORPHIT_INSTANCE_ORIGIN when null', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const result = writeWizardOutput(sampleAnswers, tmp);
		const content = readFileSync(result.configPath, 'utf8');
		assertTrue(!content.includes('MORPHIT_INSTANCE_ORIGIN'), 'no origin line when null');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: keystore file has 0600 permissions', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const result = writeWizardOutput(sampleAnswers, tmp);
		const stat = statSync(result.keystorePath);
		// Mask off the file-type bits, keep the permission bits.
		const perms = stat.mode & 0o777;
		assertEqual(perms, 0o600, 'keystore perms');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: config file has 0600 permissions', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const result = writeWizardOutput(sampleAnswers, tmp);
		const stat = statSync(result.configPath);
		const perms = stat.mode & 0o777;
		assertEqual(perms, 0o600, 'config perms');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: env file has 0600 permissions', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const result = writeWizardOutput(sampleAnswers, tmp);
		const stat = statSync(result.envPath);
		const perms = stat.mode & 0o777;
		assertEqual(perms, 0o600, 'env perms');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: encrypted mode writes JSON envelope to keystore.json', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const encryptedAnswers: WizardAnswers = {
			...sampleAnswers,
			activeKey: {
				mode: 'encrypted',
				plaintextWif: undefined,
				envelope: {
					v: 1,
					kdf: 'scrypt',
					kdf_params: { N: 131072, r: 8, p: 1, salt: 'fakesalt' },
					cipher: 'aes-256-gcm',
					iv: 'fakeiv',
					ct: 'fakect'
				},
				passphraseHint: undefined
			}
		};
		const result = writeWizardOutput(encryptedAnswers, tmp);
		assertContains(result.keystorePath, 'keystore.json', 'json filename');
		const content = readFileSync(result.keystorePath, 'utf8');
		const parsed = JSON.parse(content);
		assertEqual(parsed.v, 1, 'envelope v');
		assertEqual(parsed.kdf, 'scrypt', 'envelope kdf');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: alt-network addresses written when present', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const withAlt: WizardAnswers = {
			...sampleAnswers,
			altNetworks: {
				tor: 'abc.onion',
				lokinet: null,
				i2p: 'xyz.b32.i2p',
				nostr: null
			}
		};
		const result = writeWizardOutput(withAlt, tmp);
		const content = readFileSync(result.configPath, 'utf8');
		assertContains(content, 'MORPHIT_INSTANCE_TOR_ADDRESS=abc.onion', 'tor written');
		assertContains(content, 'MORPHIT_INSTANCE_I2P_ADDRESS=xyz.b32.i2p', 'i2p written');
		assertTrue(!content.includes('MORPHIT_INSTANCE_LOKINET_ADDRESS'), 'no lokinet');
		assertTrue(!content.includes('MORPHIT_INSTANCE_NOSTR_PUBKEY'), 'no nostr');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── Backup automation (Audit Part 32) ───────────────────────────

scenario('writeWizardOutput: backup disabled writes no backup.env', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const result = writeWizardOutput(sampleAnswers, tmp);
		assertEqual(result.backupEnvPath, null, 'backupEnvPath null');
		assertEqual(result.backupEnvBytes, 0, 'backupEnvBytes 0');
		assertTrue(
			!existsSync(join(tmp, 'ops/backup/backup.env')),
			'no ops/backup/backup.env file written'
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: backup enabled writes backup.env with operator values', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const withBackup: WizardAnswers = {
			...sampleAnswers,
			backup: {
				enabled: true,
				backupDir: '/data/morphit-backups',
				retainDays: 14
			}
		};
		const result = writeWizardOutput(withBackup, tmp);
		assertTrue(result.backupEnvPath !== null, 'backupEnvPath populated');
		assertTrue(result.backupEnvBytes > 0, 'backupEnvBytes > 0');
		const content = readFileSync(result.backupEnvPath!, 'utf8');
		assertTrue(content.includes('BACKUP_DIR=/data/morphit-backups'), 'BACKUP_DIR honored');
		assertTrue(content.includes('RETAIN_DAYS=14'), 'RETAIN_DAYS honored');
		assertTrue(content.includes('DB_NAME=morphit_indexer'), 'DB_NAME default');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: backup.env has 0600 permissions', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const withBackup: WizardAnswers = {
			...sampleAnswers,
			backup: {
				enabled: true,
				backupDir: '/home/morphit/backups',
				retainDays: 30
			}
		};
		const result = writeWizardOutput(withBackup, tmp);
		const stats = statSync(result.backupEnvPath!);
		const mode = stats.mode & 0o777;
		assertEqual(mode, 0o600, 'backup.env is 0600');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── Part 121 cp9 — Matrix surface emission ───────────────────────

scenario('writeWizardOutput: both Matrix surfaces opted-out → no Matrix block in env', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		writeWizardOutput(sampleAnswers, tmp);
		const env = readFileSync(join(tmp, 'morphit.config.env'), 'utf-8');
		assertTrue(!env.includes('MORPHIT_MATRIX_BOT_ALERT_MXID'), 'no MXID line when opted out');
		assertTrue(
			!env.includes('MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM'),
			'no room line when opted out'
		);
		assertTrue(!env.includes('# Matrix surfaces'), 'no Matrix block heading when opted out');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: only MXID populated → only MORPHIT_MATRIX_BOT_ALERT_MXID emitted', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const answers: WizardAnswers = {
			...sampleAnswers,
			matrix: { alertMxid: '@alice:matrix.org', groupRoomAlias: null }
		};
		writeWizardOutput(answers, tmp);
		const env = readFileSync(join(tmp, 'morphit.config.env'), 'utf-8');
		assertTrue(
			env.includes('MORPHIT_MATRIX_BOT_ALERT_MXID=@alice:matrix.org'),
			'MXID line present'
		);
		assertTrue(
			!env.includes('MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM='),
			'no room line when room is null'
		);
		assertTrue(env.includes('# Matrix surfaces'), 'Matrix block heading present');
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: only room populated → only MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM emitted', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const answers: WizardAnswers = {
			...sampleAnswers,
			matrix: { alertMxid: null, groupRoomAlias: '#agorise:matrix.org' }
		};
		writeWizardOutput(answers, tmp);
		const env = readFileSync(join(tmp, 'morphit.config.env'), 'utf-8');
		// # is NOT in quote()'s safe-char set (shell-comment hazard) so
		// the value gets wrapped in quotes.  cp139-C-11: quote() now
		// uses SINGLE quotes for bash-safety (was double in earlier
		// audit), and the regex accepts either form for posterity.
		assertTrue(
			/^MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM=(['"]?)#agorise:matrix\.org\1$/m.test(env),
			'room line present (quoted or unquoted)'
		);
		assertTrue(
			!env.includes('MORPHIT_MATRIX_BOT_ALERT_MXID='),
			'no MXID line when MXID is null'
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

scenario('writeWizardOutput: both Matrix surfaces populated → both env lines emitted', () => {
	const tmp = mkdtempSync(join(tmpdir(), 'morphit-init-test-'));
	try {
		const answers: WizardAnswers = {
			...sampleAnswers,
			matrix: {
				alertMxid: '@alice:matrix.org',
				groupRoomAlias: '#agorise:matrix.org'
			}
		};
		writeWizardOutput(answers, tmp);
		const env = readFileSync(join(tmp, 'morphit.config.env'), 'utf-8');
		assertTrue(
			env.includes('MORPHIT_MATRIX_BOT_ALERT_MXID=@alice:matrix.org'),
			'MXID line present (unquoted: @ is in safe-char set)'
		);
		assertTrue(
			/^MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM=(['"]?)#agorise:matrix\.org\1$/m.test(env),
			'room line present (quoted: # is shell-comment hazard so quote() wraps it)'
		);
		// Critical: the room line must carry #-prefixed value, the
		// MXID line @-prefixed value.  If they got swapped, that's
		// the @↔# replacement footgun made manifest.
		const lines = env.split('\n');
		const mxidLine = lines.find((l) => l.startsWith('MORPHIT_MATRIX_BOT_ALERT_MXID='));
		const roomLine = lines.find((l) =>
			l.startsWith('MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM=')
		);
		assertTrue(mxidLine !== undefined && /=(['"]?)@/.test(mxidLine), 'MXID line carries @');
		assertTrue(roomLine !== undefined && /=(['"]?)#/.test(roomLine), 'room line carries #');
		assertTrue(
			mxidLine !== undefined && !/=(['"]?)#/.test(mxidLine),
			'MXID line must NOT carry a # value (the @↔# footgun)'
		);
		assertTrue(
			roomLine !== undefined && !/=(['"]?)@/.test(roomLine),
			'room line must NOT carry an @ value (the @↔# footgun)'
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ─── Summary ─────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
