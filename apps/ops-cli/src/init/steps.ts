/**
 * Morphit ops CLI — wizard step implementations.
 *
 * Each step is a self-contained async function that:
 *   1. Renders a step header.
 *   2. Prints an ELI5 explanation.
 *   3. Prompts (with validation loop).
 *   4. Returns the collected value.
 *
 * Steps don't write files; the orchestrator collects all
 * answers and writes morphit.config.env at the end after the
 * operator approves the review.
 *
 * Why one big file: 9 steps × ~50 LOC each is within readable
 * limits, and consolidating them lets the wizard tone stay
 * consistent without cross-file imports for shared phrasing.
 */

import {
	ask,
	askInt,
	askFloat,
	askYesNo,
	askPassword,
	askChoice,
	step,
	explain,
	examples
} from './prompt.ts';
import { lookupBlurtAccount, validateBlurtAccountName, type AccountInfo } from './chainCheck.ts';
import { encryptEnvelope, checkPassphraseStrength, type KeyEnvelope } from './encrypt.ts';
import {
	probeBitcoinExplorer,
	probeMoneroExplorer,
	probeChatLinkExplorer,
	renderProbeStatus,
	type ProbeStatus
} from './explorerHealth.ts';
import {
	computeFeeAmounts,
	fetchBtcXmrPricesFromCoingecko
} from '../../../indexer/src/lib/feeAmountCalc.ts';
import type { ListingFeeResult } from './render.ts';

const TOTAL_STEPS = 17;

// ─── Step 1: Instance name ───────────────────────────────────────

export async function stepInstanceName(): Promise<string> {
	step(1, TOTAL_STEPS, 'Instance name');
	explain(
		'This is the name people will see in the title bar and footer\n' +
			'of YOUR Morphit instance.  Most operators name it after\n' +
			'themselves or their location.\n' +
			'\n' +
			'It only needs to be memorable to you and your users — there\n' +
			'is no central registry; you can change it later.'
	);
	examples(['alice-morphit', 'morphit.berlin', 'free-morphit-canada']);

	while (true) {
		const name = await ask('Instance name (required)');
		if (name.length === 0) {
			console.log('  ✗ Required.  Try again.\n');
			continue;
		}
		if (name.length > 64) {
			console.log('  ✗ Too long — keep it under 64 characters.\n');
			continue;
		}
		// Allow letters, numbers, spaces, dashes, dots, underscores.
		// Disallow shell-meta to avoid escaping headaches downstream.
		if (!/^[\w. -]+$/u.test(name)) {
			console.log('  ✗ Use letters, numbers, spaces, dashes, dots, or underscores only.\n');
			continue;
		}
		return name;
	}
}

// ─── Step 2: Tagline ─────────────────────────────────────────────

export async function stepTagline(): Promise<string> {
	step(2, TOTAL_STEPS, 'Instance tagline');
	explain(
		'A one-line subtitle shown under the instance name on the\n' +
			'homepage.  Optional, but a friendly tagline helps your\n' +
			"users feel they're in the right place."
	);
	examples([
		'P2P Bitcoin & Monero trading, no KYC.',
		"Berlin's first Morphit node.",
		'Run by alice, for fellow Morphit traders.'
	]);
	const DEFAULT = 'A Morphit instance';
	const v = await ask('Tagline', DEFAULT);
	return v.length > 200 ? v.slice(0, 200) : v;
}

// ─── Step 3: Database connection ─────────────────────────────────

export async function stepDatabase(): Promise<string> {
	step(3, TOTAL_STEPS, 'Database connection');
	explain(
		'Morphit stores indexed chain state in a Postgres database.\n' +
			"You'll need a database created beforehand.  If you haven't\n" +
			'made one, open another terminal and run:\n' +
			'\n' +
			'  sudo -u postgres createuser -P morphit\n' +
			'  sudo -u postgres createdb -O morphit morphit\n' +
			'\n' +
			'Then come back here.\n' +
			'\n' +
			'The connection string format is:\n' +
			'  postgres://USER:PASSWORD@HOST:PORT/DATABASE'
	);
	examples([
		'postgres://morphit:secret@localhost:5432/morphit       (typical)',
		'postgres://morphit@127.0.0.1/morphit                   (peer auth)'
	]);

	while (true) {
		const url = await ask('Database URL (required)');
		if (url.length === 0) {
			console.log('  ✗ Required.  Try again.\n');
			continue;
		}
		if (!/^postgres(?:ql)?:\/\//.test(url)) {
			console.log('  ✗ Must start with postgres:// or postgresql://.  Try again.\n');
			continue;
		}
		// Lightweight URL-shape probe; full connection test happens in
		// the post-install health check.
		try {
			new URL(url);
		} catch {
			console.log('  ✗ Could not parse as a URL.  Try again.\n');
			continue;
		}
		return url;
	}
}

// ─── Step 4: Relay Blurt account ─────────────────────────────────

export interface RelayAccountResult {
	readonly name: string;
	readonly account: AccountInfo | null;
	readonly chainLookupSucceeded: boolean;
}

export async function stepRelayAccount(): Promise<RelayAccountResult> {
	step(4, TOTAL_STEPS, "Your relay's Blurt account");
	explain(
		'Morphit uses the Blurt blockchain.  Your relay is the account\n' +
			'that pays the chain fee when a NEW user signs up to your\n' +
			'instance — currently 100 BLURT per signup.  This account\n' +
			'needs to be funded with enough BLURT to cover the signups\n' +
			'you expect to handle.\n' +
			'\n' +
			'For example, with the default daily ceiling of 50 signups,\n' +
			'your relay could spend up to 5,000 BLURT in a single day.\n' +
			'Most operators start with a smaller ceiling (10-20) and\n' +
			"raise it once they're confident in their setup.\n" +
			'\n' +
			'You probably want to use the Blurt account you signed up\n' +
			"Morphit with.  If you don't have a Blurt account yet,\n" +
			'register one at:\n' +
			'\n' +
			'  https://blurtplugin.online/account/\n' +
			'\n' +
			'Then come back here.'
	);
	examples(['alice', 'my-morphit-relay', 'bob123']);

	while (true) {
		const name = await ask('Blurt account name (required)');
		if (name.length === 0) {
			console.log('  ✗ Required.  Try again.\n');
			continue;
		}
		const validation = validateBlurtAccountName(name);
		if (!validation.ok) {
			console.log(`  ✗ ${validation.message}  Try again.\n`);
			continue;
		}
		// Look it up on chain.
		console.log(`  Looking up @${name} on Blurt...`);
		try {
			const account = await lookupBlurtAccount(name);
			if (account === null) {
				console.log(
					`  ⚠ @${name} doesn't exist on Blurt.  Either you typed it wrong, or you need to register it first at https://blurtplugin.online/account/.\n`
				);
				const useAnyway = await askYesNo('Use this name anyway? (recommended: no)', false);
				if (useAnyway) {
					return { name, account: null, chainLookupSucceeded: true };
				}
				continue;
			}
			console.log(`  ✓ @${name} exists on Blurt.  Current balance: ${account.balance}`);
			// Estimate runway at 100 BLURT/signup.
			const runway = Math.floor(account.balanceBlurt / 100);
			if (runway < 50) {
				console.log(
					`  Heads up: with a 50/day ceiling, you'd run out after ~${runway} signup${runway === 1 ? '' : 's'}.`
				);
				console.log(
					"  You'll set the ceiling in step 7 — pick a smaller value, or top up your account first."
				);
			}
			console.log('');
			return { name, account, chainLookupSucceeded: true };
		} catch (err) {
			console.log(
				`  ⚠ Could not check @${name} on Blurt: ${err instanceof Error ? err.message : 'unknown error'}`
			);
			const useAnyway = await askYesNo(
				'Use this name anyway? (will validate later when relay starts)',
				true
			);
			if (useAnyway) {
				return { name, account: null, chainLookupSucceeded: false };
			}
		}
	}
}

// ─── Step 5: Posting key ─────────────────────────────────────────

export interface PostingKeyResult {
	readonly mode: 'encrypted' | 'plaintext';
	readonly plaintextWif: string | undefined;
	readonly envelope: KeyEnvelope | undefined;
	readonly passphraseHint: string | undefined;
}

export async function stepPostingKey(relayAccountName: string): Promise<PostingKeyResult> {
	step(5, TOTAL_STEPS, "Your relay's posting key");
	explain(
		'This is the secret key that authorizes your relay to post\n' +
			'operations on Blurt on your behalf.  It looks like:\n' +
			'\n' +
			'  5J...... (51 characters, starts with 5)\n' +
			'\n' +
			'You can find it in your Blurt wallet under "Permissions"\n' +
			'or "Keys".  Use the POSTING key, not the active or owner\n' +
			'key.\n' +
			'\n' +
			'⚠  This key gives whoever has it the ability to post on\n' +
			'   your account.  Treat it like a password.'
	);

	const choiceIdx = await askChoice(
		'Two storage options:',
		[
			'Encrypted (recommended).  Prompt for an unlock passphrase, encrypt the key, ' +
				'relay prompts for the passphrase at startup.',
			'Plaintext.  Key sits in morphit.config.env in plain text.  Easier (no ' +
				'passphrase) but if someone reads the file they can post as you.'
		],
		0
	);
	const mode: 'encrypted' | 'plaintext' = choiceIdx === 0 ? 'encrypted' : 'plaintext';
	console.log('');

	let wif: string;
	while (true) {
		wif = await askPassword('Posting key (paste the 5J... string; it will not be echoed)');
		if (wif.length === 0) {
			console.log('  ✗ Required.  Try again.\n');
			continue;
		}
		// Blurt WIFs are exactly 51 chars and start with '5'.
		if (!/^5[1-9A-HJ-NP-Za-km-z]{50}$/.test(wif)) {
			console.log(
				`  ✗ Doesn't look like a valid WIF (expected 51 chars starting with 5).  Try again.\n`
			);
			continue;
		}
		break;
	}
	console.log(`  ✓ Key shape looks valid.\n`);
	// Note: we don't verify against @relayAccount's posting pubkey
	// here — that requires deriving the pubkey from the WIF, which
	// would couple ops-cli to dblurt.  The relay's startup unlock
	// performs the pubkey-on-chain match check instead.

	if (mode === 'plaintext') {
		return {
			mode: 'plaintext',
			plaintextWif: wif,
			envelope: undefined,
			passphraseHint: undefined
		};
	}

	// Encrypted mode — ask for passphrase.
	console.log(
		"Now choose an unlock passphrase.  This is what you'll type\n" +
			'when starting your relay; it never leaves this machine.\n' +
			'\n' +
			'Use a passphrase you can remember but is hard to guess —\n' +
			'several random words or a long sentence work well.  Length\n' +
			'≥8 characters.\n'
	);

	let passphrase: string;
	while (true) {
		const p1 = await askPassword('Passphrase');
		const strength = checkPassphraseStrength(p1);
		if (!strength.ok) {
			console.log(`  ✗ ${strength.message}  Try again.\n`);
			continue;
		}
		const p2 = await askPassword('Confirm passphrase');
		if (p1 !== p2) {
			console.log('  ✗ Passphrases do not match.  Try again.\n');
			continue;
		}
		if (strength.message !== undefined) {
			// Soft warning for the 8-11 char range — proceed but inform.
			console.log(`  ⚠ ${strength.message}\n`);
		}
		passphrase = p1;
		break;
	}

	console.log('  ✓ Passphrase set.');
	console.log('  Encrypting your posting key (takes ~1 second)...');
	const envelope = encryptEnvelope(wif, passphrase);
	console.log('  ✓ Done.\n');

	return {
		mode: 'encrypted',
		plaintextWif: undefined,
		envelope,
		passphraseHint: undefined
	};
}

// ─── Step 6: Fees account ────────────────────────────────────────

export async function stepFeesAccount(relayAccountName: string): Promise<string> {
	step(6, TOTAL_STEPS, 'Fees account');
	explain(
		'Morphit charges a small listing fee per order (paid by the\n' +
			'person posting the order, not by users browsing).  Those\n' +
			'fees land in your fees account.  You earn revenue here.\n' +
			'\n' +
			'You can use the same account as your relay (simpler), or\n' +
			'use a separate account (cleaner accounting, easier to\n' +
			'redirect).'
	);
	console.log(`Default: same as your relay account (${relayAccountName})`);
	console.log('');

	while (true) {
		const v = await ask('Fees account name', relayAccountName);
		if (v.length === 0) return relayAccountName;
		const validation = validateBlurtAccountName(v);
		if (!validation.ok) {
			console.log(`  ✗ ${validation.message}  Try again.\n`);
			continue;
		}
		return v;
	}
}

// ─── Step 7: Daily signup ceiling ────────────────────────────────

export async function stepDailyCeiling(relayAccount: AccountInfo | null): Promise<number> {
	step(7, TOTAL_STEPS, 'Daily signup ceiling');
	explain(
		'To prevent runaway costs from a signup-flood attack, your\n' +
			'relay caps how many new accounts it will create per day.\n' +
			'When the cap is hit, signups pause until UTC midnight.\n' +
			'\n' +
			'Each signup currently costs 100 BLURT (set by the Blurt\n' +
			'chain itself, not Morphit).  At a ceiling of 50, your\n' +
			'maximum daily spend is 5,000 BLURT.'
	);

	let suggestedDefault = 50;
	if (relayAccount !== null) {
		const balance = relayAccount.balanceBlurt;
		const safeCeiling = Math.max(1, Math.floor(balance / 100 / 2));
		// Aim for "balance funds at least 2 days at ceiling rate".
		suggestedDefault = Math.min(50, safeCeiling);
		console.log(
			`Suggestions based on your @${relayAccount.name} balance (${relayAccount.balance}):`
		);
		const tightDays3 = Math.max(1, Math.floor(balance / 100 / 3));
		console.log(`  • ${tightDays3}        — most conservative (~3 days runway at this rate)`);
		console.log(`  • ${safeCeiling}        — balanced (~2 days runway at this rate)`);
		const exceeds = balance / 100 < 50;
		console.log(
			`  • 50       — default${exceeds ? ' (exceeds your current balance — top up first)' : ''}`
		);
		console.log('  • 200+     — high-volume instances');
	} else {
		console.log('Suggested ceilings:');
		console.log('  • 10       — small instance (just yourself + a few friends)');
		console.log('  • 50       — medium instance (community of <100)');
		console.log('  • 200+     — large instance (open to anyone)');
	}
	console.log('');

	return askInt('Daily ceiling', { min: 1, max: 10000, default: suggestedDefault });
}

// ─── Step 8: Contact URL ─────────────────────────────────────────

export async function stepContactUrl(): Promise<string | null> {
	step(8, TOTAL_STEPS, 'Contact URL (optional)');
	explain(
		'A way for your users to reach YOU, the operator, when they\n' +
			'have questions.  Shown in the instance footer.  Skip with\n' +
			"Enter if you don't want to publicize a contact."
	);
	examples([
		'https://matrix.to/#/@alice:matrix.org',
		'https://nostr.directory/p/alice',
		'mailto:alice@example.com'
	]);

	while (true) {
		const v = await ask('Contact URL (optional)');
		if (v.length === 0) return null;
		try {
			const url = new URL(v);
			if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'mailto:') {
				console.log('  ✗ Use https://, http://, or mailto: only.  Try again.\n');
				continue;
			}
			return v;
		} catch {
			console.log('  ✗ Could not parse as a URL.  Try again.\n');
		}
	}
}

// ─── Step 9: Alt-network addresses ───────────────────────────────

export interface AltNetworkResult {
	readonly tor: string | null;
	readonly lokinet: string | null;
	readonly i2p: string | null;
	readonly nostr: string | null;
}

// ─── Step 9: Public origin URL ───────────────────────────────────

export async function stepOrigin(): Promise<string | null> {
	step(9, TOTAL_STEPS, 'Public origin URL (optional but recommended)');
	explain(
		'The HTTPS URL where your Morphit instance is reachable on the\n' +
			'public web.  Just the scheme + host, no path:\n' +
			'\n' +
			'Examples:\n' +
			'  https://alice-morphit.example\n' +
			'  https://morphit.berlin\n' +
			'\n' +
			'Why this matters: the origin is what gets published on-chain\n' +
			'when you register your operator account.  Other Morphit\n' +
			"instances' indexers see the registration and add you to\n" +
			'their /instances directory automatically.  Without an origin,\n' +
			"your instance won't appear in the federation directory and\n" +
			'users on other Morphit instances will not discover you.\n' +
			'\n' +
			'You can skip this step and set MORPHIT_INSTANCE_ORIGIN later;\n' +
			"the wizard won't ask again.\n" +
			'\n' +
			'NOTE: this is your indexer/frontend origin (the URL users\n' +
			'visit), NOT a Blurt RPC endpoint.'
	);

	while (true) {
		const v = await ask('Public origin URL (leave blank to skip)');
		if (v.length === 0) return null;
		let parsed: URL;
		try {
			parsed = new URL(v);
		} catch {
			console.log('  ✗ Could not parse as a URL.  Try again.\n');
			continue;
		}
		if (parsed.protocol !== 'https:') {
			console.log('  ✗ Must use https://.  Try again.\n');
			continue;
		}
		if (parsed.username !== '' || parsed.password !== '') {
			console.log('  ✗ Remove the user:pass@ portion.  Try again.\n');
			continue;
		}
		if (parsed.pathname !== '/' && parsed.pathname !== '') {
			console.log('  ✗ Origin must be scheme + host only (no path).  Try again.\n');
			continue;
		}
		if (parsed.search !== '') {
			console.log('  ✗ No query string allowed.  Try again.\n');
			continue;
		}
		if (parsed.hash !== '') {
			console.log('  ✗ No fragment allowed.  Try again.\n');
			continue;
		}
		// Normalize: drop the trailing slash that URL-parser appends.
		return `${parsed.protocol}//${parsed.host}`;
	}
}

// ─── Step 10: Alt-network addresses ──────────────────────────────

export async function stepAltNetworks(): Promise<AltNetworkResult> {
	step(10, TOTAL_STEPS, 'Alt-network addresses (optional)');
	explain(
		'Morphit can serve your instance over privacy networks in\n' +
			'addition to (or instead of) the regular internet.  This is\n' +
			'optional — you can skip and add them later.\n' +
			'\n' +
			'Each network gives users a different way to reach you that\n' +
			'hides their IP from your VPS provider:\n' +
			'\n' +
			'  • Tor       — most popular, .onion address (recommended\n' +
			'                if you run any privacy-focused service)\n' +
			'  • Lokinet   — newer, .loki address, less infrastructure\n' +
			'  • I2P       — established, .b32.i2p address\n' +
			'  • Nostr     — pubkey for cross-network discovery'
	);

	const wantsTor = await askYesNo('Generate a Tor hidden service address now?', false);
	let tor: string | null = null;
	if (wantsTor) {
		console.log(
			'  Tor address generation requires the existing\n' +
				'  scripts/generate-onion.sh helper.  This step prepares the\n' +
				'  config to expect a Tor address; run\n' +
				'    ./scripts/generate-onion.sh\n' +
				'  separately when Tor is installed, then paste the\n' +
				'  resulting .onion address here.\n'
		);
		const v = await ask('Tor .onion address (paste, or Enter to skip and configure later)', '');
		tor = v.length > 0 ? v : null;
	}

	const wantsLokinet = await askYesNo('Add a Lokinet (.loki) address?', false);
	let lokinet: string | null = null;
	if (wantsLokinet) {
		const v = await ask('Lokinet .loki address (paste, or Enter to skip)', '');
		lokinet = v.length > 0 ? v : null;
	}

	const wantsI2p = await askYesNo('Add an I2P (.b32.i2p) address?', false);
	let i2p: string | null = null;
	if (wantsI2p) {
		const v = await ask('I2P .b32.i2p address (paste, or Enter to skip)', '');
		i2p = v.length > 0 ? v : null;
	}

	const wantsNostr = await askYesNo('Add a Nostr pubkey?', false);
	let nostr: string | null = null;
	if (wantsNostr) {
		const v = await ask('Nostr npub (paste, or Enter to skip)', '');
		nostr = v.length > 0 ? v : null;
	}

	return { tor, lokinet, i2p, nostr };
}

export interface SeoResult {
	readonly title: string | null;
	readonly description: string | null;
	readonly keywords: string | null;
}

export async function stepSeo(): Promise<SeoResult> {
	step(14, TOTAL_STEPS, 'SEO override (optional)');
	const wantsOverride = await askYesNo(
		'Override homepage SEO copy (title/description/keywords)?',
		false
	);
	if (!wantsOverride) {
		return { title: null, description: null, keywords: null };
	}
	const title = await ask('SEO title (Enter to skip)', '');
	const description = await ask('SEO description (Enter to skip)', '');
	const keywords = await ask('SEO keywords, comma-separated (Enter to skip)', '');
	return {
		title: title.length > 0 ? title : null,
		description: description.length > 0 ? description : null,
		keywords: keywords.length > 0 ? keywords : null
	};
}

// ─── Step 12: Daily DB backup automation ─────────────────────────
//
// Default = enabled.  An operator who's never set up backups
// before will have backups by default; one who wants to
// integrate with their own backup system can disable here.
//
// What we install when enabled:
//   - The shipped script at ops/backup/morphit-backup.sh
//     (NOT generated; the same one for every operator)
//   - A per-operator config at ops/backup/backup.env (this
//     file is the one that varies — backup dir + retention
//     come from operator answers here)
//   - The shipped systemd timer + service at
//     ops/systemd/morphit-backup.{service,timer}
//
// What the operator runs manually after the wizard:
//   - sudo install of /etc/morphit/backup.env (root-owned
//     because the daemon reads it)
//   - sudo install of the systemd units
//   - sudo systemctl enable --now morphit-backup.timer
//
// The wizard PRINTS those commands in printNextSteps so the
// operator copy-pastes them.  We don't try to run sudo from
// the wizard — that's a footgun and breaks the
// "wizard runs as the operator user" principle.

export interface BackupResult {
	readonly enabled: boolean;
	readonly backupDir: string | null;
	readonly retainDays: number | null;
}

export async function stepBackup(): Promise<BackupResult> {
	step(15, TOTAL_STEPS, 'Daily DB backup');
	explain(
		"The indexer's PostgreSQL database is rebuildable from the\n" +
			'Blurt blockchain in case of total loss, but a same-day\n' +
			'snapshot saves you hours of catch-up time when you actually\n' +
			'need to recover.\n' +
			'\n' +
			'When enabled, a systemd timer fires once a day at 04:00\n' +
			'local time and writes a gzipped pg_dump to your backup\n' +
			'directory.  Old backups beyond the retention window are\n' +
			'pruned automatically.  Strongly recommended for production.'
	);

	const enabled = await askYesNo('Enable daily DB backup automation?', true);
	if (!enabled) {
		console.log(
			'  ⚠  Backups disabled.  You can enable later by running\n' +
				'     `morphit ops init` again, or follow the manual recipe\n' +
				'     in docs/RUN-A-MORPHIT-NODE.md §10.\n'
		);
		return { enabled: false, backupDir: null, retainDays: null };
	}

	const backupDir = await ask('Backup directory', '/home/morphit/backups');
	const retainDays = await askInt('Days of backups to keep', {
		min: 1,
		max: 3650,
		default: 30
	});

	return {
		enabled: true,
		backupDir,
		retainDays
	};
}

// ─── Edit-only step: Blurt RPC endpoints ─────────────────────────
//
// Used by `morphit-ops edit` when an operator needs to update the
// Blurt RPC endpoint list — typically because a community RPC node
// went offline or a new one came online.  The init wizard does NOT
// prompt for this (the canonical defaults work for first-time
// setup); this step is reachable only via `edit`.
//
// The validation rules mirror the indexer's Zod schema in
// apps/indexer/src/config/index.ts:
//   - At least one endpoint required.
//   - Every endpoint must start with https://.
// Comma-separated input is the standard env-var format, matching
// what the indexer actually parses.

/** The canonical default RPC list shipped with the project.  Kept
 *  in sync with the env example by `MORPHIT_INDEXER_RPC_ENDPOINTS`
 *  in ops/env/indexer.env.example.  If you update this list,
 *  update the env example too — there's a smoke that'll catch
 *  drift if you forget. */
export const DEFAULT_BLURT_RPC_ENDPOINTS: readonly string[] = [
	'https://rpc.beblurt.com',
	'https://rpc.blurt.world',
	'https://blurt-rpc.saboin.com'
] as const;

/** Parse and validate a comma-separated RPC endpoint list.  Used
 *  by the wizard step and also exposed for tests.  Returns the
 *  cleaned array on success, or a string error message on failure. */
export function parseRpcEndpoints(raw: string): readonly string[] | string {
	const list = raw
		.split(',')
		.map((u) => u.trim())
		.filter((u) => u.length > 0);
	if (list.length === 0) {
		return 'At least one RPC endpoint is required.';
	}
	for (const u of list) {
		if (!u.startsWith('https://')) {
			return `RPC endpoint must start with https:// — got "${u}"`;
		}
		try {
			const parsed = new URL(u);
			if (parsed.protocol !== 'https:') {
				return `RPC endpoint must be https — got "${u}"`;
			}
			if (parsed.username !== '' || parsed.password !== '') {
				return `RPC endpoint must not include user:pass@ — got "${u}"`;
			}
		} catch {
			return `Could not parse RPC endpoint as URL: "${u}"`;
		}
	}
	// De-dupe while preserving order.
	const seen = new Set<string>();
	const out: string[] = [];
	for (const u of list) {
		if (!seen.has(u)) {
			seen.add(u);
			out.push(u);
		}
	}
	return out;
}

export async function stepRpcEndpoints(
	current: readonly string[] | null
): Promise<readonly string[]> {
	const defaultDisplay =
		current !== null && current.length > 0
			? current.join(',')
			: DEFAULT_BLURT_RPC_ENDPOINTS.join(',');
	explain(
		'The list of Blurt RPC endpoints your indexer connects to.\n' +
			'The indexer rotates between them, so multiple endpoints give\n' +
			'you redundancy when one is down.\n' +
			'\n' +
			'Format: comma-separated https:// URLs, no spaces.\n' +
			'\n' +
			'Press Enter to keep the current value.  When you change\n' +
			'this, you must restart the indexer service for the new\n' +
			'list to take effect:\n' +
			'\n' +
			'  sudo systemctl restart morphit-indexer\n' +
			'\n' +
			'A good practice: include 2-3 endpoints from independent\n' +
			'operators.  When a witness updates rotate, having the\n' +
			'spread protects you from any single endpoint going stale.\n' +
			'\n' +
			'You can find the current set of community RPC endpoints\n' +
			'by checking the Blurt witness network or asking in the\n' +
			'project Matrix channel.'
	);

	while (true) {
		const raw = await ask('Blurt RPC endpoints (comma-separated)', defaultDisplay);
		const result = parseRpcEndpoints(raw);
		if (typeof result === 'string') {
			console.log(`  ✗ ${result}  Try again.\n`);
			continue;
		}
		return result;
	}
}

// ─── Defaults for the explorer-config steps ──────────────────────

/** Default BTC fee-verifier explorers — Esplora-API-compatible
 *  public instances.  Matches the indexer's config-default. */
export const DEFAULT_BTC_FEE_EXPLORERS: readonly string[] = [
	'https://blockstream.info/api',
	'https://mempool.space/api'
];

/** Default XMR fee-verifier explorers — five independent
 *  instances of the moneroexamples/onion-monero-blockchain-explorer
 *  reference codebase.  Matches the indexer's config-default
 *  (Part 108++ Finding D-1 fix). */
export const DEFAULT_XMR_FEE_EXPLORERS: readonly string[] = [
	'https://xmrchain.net',
	'https://localmonero.co/blocks',
	'https://monerohash.com/explorer',
	'https://exploremonero.com',
	'https://moneroexplorer.org'
];

/** Default chat-link URL templates — for the frontend's
 *  "click a txid in chat, open in an external explorer"
 *  routing.  Each template MUST contain `{txid}` somewhere;
 *  the frontend substitutes the txid at render time. */
export const DEFAULT_BTC_CHAT_LINK_URL = 'https://mempool.space/tx/{txid}';
export const DEFAULT_XMR_CHAT_LINK_URL = 'https://xmrchain.net/tx/{txid}';

// ─── Step 11: Fee-verifier explorer URLs ─────────────────────────

export interface FeeExplorersResult {
	readonly btc: readonly string[];
	readonly xmr: readonly string[];
}

/** Parse a comma-separated URL list with the same rules as
 *  parseRpcEndpoints (HTTPS-only, no user:pass, de-duped).
 *  Returns the list on success, an error message on failure. */
export function parseExplorerUrlList(raw: string): readonly string[] | string {
	const list = raw
		.split(',')
		.map((u) => u.trim())
		.filter((u) => u.length > 0);
	if (list.length === 0) {
		return 'At least one explorer URL is required.';
	}
	for (const u of list) {
		if (!u.startsWith('https://')) {
			return `Explorer URL must start with https:// — got "${u}"`;
		}
		try {
			const parsed = new URL(u);
			if (parsed.protocol !== 'https:') {
				return `Explorer URL must be https — got "${u}"`;
			}
			if (parsed.username !== '' || parsed.password !== '') {
				return `Explorer URL must not include user:pass@ — got "${u}"`;
			}
		} catch {
			return `Could not parse explorer URL: "${u}"`;
		}
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const u of list) {
		if (!seen.has(u)) {
			seen.add(u);
			out.push(u);
		}
	}
	return out;
}

/** Probe every URL in the list, render results inline so the
 *  operator sees status indicators next to each URL. */
async function renderHealthChecks(
	urls: readonly string[],
	probe: (u: string) => Promise<ProbeStatus>
): Promise<void> {
	if (urls.length === 0) {
		console.log('  (no URLs configured)');
		return;
	}
	console.log('  Checking health of each URL...\n');
	// Probe in parallel — they're independent third-party hosts.
	const results = await Promise.all(urls.map((u) => probe(u).catch(() => null)));
	for (let i = 0; i < urls.length; i++) {
		const r = results[i];
		const status =
			r === null || r === undefined ? '✗ probe failed' : renderProbeStatus(r);
		console.log(`  ${i + 1}. ${urls[i]}\n     ${status}`);
	}
	console.log('');
}

export async function stepFeeExplorers(): Promise<FeeExplorersResult> {
	step(11, TOTAL_STEPS, 'Fee-verifier explorer URLs');
	explain(
		'When users pay fees in BTC or XMR, your indexer verifies\n' +
			'the on-chain payment by querying public block explorers.\n' +
			'Multi-explorer cross-check rejects single-source\n' +
			'manipulation: if one explorer lies about the amount or\n' +
			'recipient, the other explorers catch it.\n' +
			'\n' +
			'Defaults:\n' +
			'  • BTC: blockstream.info + mempool.space\n' +
			'    (Esplora-API-compatible, independent operators)\n' +
			'  • XMR: 5 independent instances of the\n' +
			"    onion-monero-blockchain-explorer reference codebase\n" +
			'    (xmrchain.net, localmonero.co/blocks,\n' +
			'    monerohash.com/explorer, exploremonero.com,\n' +
			'    moneroexplorer.org)\n' +
			'\n' +
			'You can keep the defaults (recommended for new\n' +
			'operators), or customize the list now.  For maximum\n' +
			'independence, self-host the explorers — see\n' +
			'docs/OPERATIONS.md §40.4 for a docker-compose recipe.\n' +
			'\n' +
			'Format: comma-separated https:// URLs, no spaces.\n' +
			'\n' +
			'The wizard will run a quick health check on each URL\n' +
			'before continuing, so you see which ones are reachable\n' +
			'right now.'
	);

	// ─── BTC ──
	console.log('  ── BTC explorer URLs ──\n');
	const btc = await editExplorerList(
		'BTC fee-verifier explorers',
		DEFAULT_BTC_FEE_EXPLORERS,
		probeBitcoinExplorer
	);

	// ─── XMR ──
	console.log('\n  ── XMR explorer URLs ──\n');
	const xmr = await editExplorerList(
		'XMR fee-verifier explorers',
		DEFAULT_XMR_FEE_EXPLORERS,
		probeMoneroExplorer
	);

	return { btc, xmr };
}

/** Interactive edit-and-probe loop for a single list of URLs.
 *  Operator sees the current list with health-check status next
 *  to each entry, then chooses: keep / replace / customize. */
async function editExplorerList(
	label: string,
	defaults: readonly string[],
	probe: (u: string) => Promise<ProbeStatus>
): Promise<readonly string[]> {
	let current: readonly string[] = defaults;
	while (true) {
		console.log(`  Current ${label}:`);
		await renderHealthChecks(current, probe);
		const choice = await askChoice(
			'What would you like to do?',
			['Keep this list', 'Edit (comma-separated)', 'Reset to defaults']
		);
		if (choice === 0) {
			return current;
		}
		if (choice === 2) {
			current = defaults;
			console.log('  ↻ reset to defaults\n');
			continue;
		}
		// Edit
		const defaultDisplay = current.join(',');
		const raw = await ask(
			`${label} (comma-separated)`,
			defaultDisplay
		);
		const result = parseExplorerUrlList(raw);
		if (typeof result === 'string') {
			console.log(`  ✗ ${result}  Try again.\n`);
			continue;
		}
		current = result;
		console.log('  ↻ list updated, re-checking...\n');
	}
}

// ─── Step 12: Chat-link external explorer URL templates ──────────

export interface ChatLinkExplorersResult {
	readonly btc: string;
	readonly xmr: string;
}

/** Validate a chat-link URL template.  Must be https://, must
 *  contain `{txid}` somewhere, must parse as a URL after txid
 *  substitution.  Returns the template on success, an error
 *  message on failure. */
export function parseChatLinkTemplate(raw: string): string | string {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return 'Template is required.';
	}
	if (!trimmed.startsWith('https://')) {
		return 'Template must start with https://.';
	}
	if (!trimmed.includes('{txid}')) {
		return "Template must contain the placeholder '{txid}'.";
	}
	const sampleTxid =
		'0000000000000000000000000000000000000000000000000000000000000000';
	const filled = trimmed.replace(/\{txid\}/g, sampleTxid);
	try {
		const parsed = new URL(filled);
		if (parsed.protocol !== 'https:') {
			return 'Template must use https://.';
		}
		if (parsed.username !== '' || parsed.password !== '') {
			return 'Template must not include user:pass@.';
		}
	} catch {
		return 'Template does not parse as a URL after {txid} substitution.';
	}
	return trimmed;
}

export async function stepChatLinkExplorers(): Promise<ChatLinkExplorersResult> {
	step(12, TOTAL_STEPS, 'Chat-link external explorer URLs');
	explain(
		'When a counterparty sends a BTC or XMR txid in chat, the\n' +
			'Morphit frontend renders it as a clickable link that opens\n' +
			'a third-party block explorer in a new tab.  This is\n' +
			'separate from the FEE-VERIFIER explorer URLs (which are\n' +
			'server-side and used for cross-checking payment claims).\n' +
			'\n' +
			'The URLs you set here are the ones YOUR USERS click.\n' +
			'Privacy note: each click sends the user\'s IP and browser\n' +
			'fingerprint to the third-party explorer.  Default values\n' +
			'use well-known privacy-respecting explorers, but operators\n' +
			'who run their own explorers (or trust different ones) can\n' +
			'override here.\n' +
			'\n' +
			'Format: an https:// URL template containing the placeholder\n' +
			'{txid}, which Morphit substitutes at render time.\n' +
			'\n' +
			'Defaults:\n' +
			'  • BTC: https://mempool.space/tx/{txid}\n' +
			'  • XMR: https://xmrchain.net/tx/{txid}\n' +
			'\n' +
			'You can change these later by editing morphit.config.env.\n' +
			'\n' +
			'The wizard will run a quick reachability check on each\n' +
			'host before continuing.'
	);

	// ─── BTC ──
	console.log('  ── BTC chat-link URL ──\n');
	const btc = await editChatLinkUrl('BTC chat-link URL', DEFAULT_BTC_CHAT_LINK_URL);

	// ─── XMR ──
	console.log('\n  ── XMR chat-link URL ──\n');
	const xmr = await editChatLinkUrl('XMR chat-link URL', DEFAULT_XMR_CHAT_LINK_URL);

	return { btc, xmr };
}

async function editChatLinkUrl(label: string, defaultUrl: string): Promise<string> {
	let current = defaultUrl;
	while (true) {
		console.log(`  Current ${label}: ${current}`);
		const probe = await probeChatLinkExplorer(current).catch(
			(): ProbeStatus => ({ kind: 'unreachable', reason: 'probe threw' })
		);
		console.log(`     ${renderProbeStatus(probe)}\n`);
		const choice = await askChoice(
			'What would you like to do?',
			['Keep this URL', 'Change it', 'Reset to default']
		);
		if (choice === 0) {
			return current;
		}
		if (choice === 2) {
			current = defaultUrl;
			console.log('  ↻ reset to default\n');
			continue;
		}
		const raw = await ask(`${label}`, current);
		const result = parseChatLinkTemplate(raw);
		if (result.startsWith('https://')) {
			current = result;
			console.log('  ↻ updated, re-checking...\n');
		} else {
			console.log(`  ✗ ${result}  Try again.\n`);
		}
	}
}

// ─── Step 13: Listing fee + fallback BLURT price ─────────────────

/**
 * Part 110 — operator-configurable listing fee USD target and
 * fallback BLURT/USD price.
 *
 * Two editable knobs in one step:
 *
 *   1. Listing fee USD target (default $0.25 USD).  The wizard
 *      computes BTC sat + XMR piconero amounts from live
 *      Coingecko prices targeting this USD value.  When
 *      Coingecko is unreachable, the operator can enter the
 *      amounts manually or keep the hardcoded defaults.  The
 *      50% BLURT-paid discount is separate
 *      (MORPHIT_INDEXER_FEE_BASE_BLURT) and not exposed here
 *      per operator decision.
 *
 *   2. Fallback BLURT/USD price (default $0.002).  Used by the
 *      indexer's composite price source when both Klingex and
 *      Coingecko are unreachable AND no value has cached
 *      successfully since boot.  Display-only at the indexer;
 *      fee verification is BLURT-native.
 */

const DEFAULT_LISTING_FEE_TARGET_USD = 0.25;
const DEFAULT_LISTING_FEE_BTC_SATOSHIS = 416;
const DEFAULT_LISTING_FEE_XMR_PICONERO = 781_250_000;
const DEFAULT_FALLBACK_BLURT_PRICE_USD = 0.002;

export async function stepListingFee(): Promise<ListingFeeResult> {
	step(13, TOTAL_STEPS, 'Listing fee + fallback BLURT price');
	explain(
		'Two operator-tunable amounts:\n' +
			'\n' +
			'  1. Listing fee USD target.  Users posting orders pay\n' +
			'     a listing fee.  The default targets $0.25 USD,\n' +
			'     converted to BTC satoshis and XMR piconero using\n' +
			'     live exchange rates at wizard-run time.  Users\n' +
			'     paying in BLURT get an automatic 50% discount\n' +
			'     (~$0.125 worth) — that discount is configured\n' +
			'     separately and not editable here.\n' +
			'\n' +
			'  2. Fallback BLURT/USD price.  The indexer normally\n' +
			'     pulls live BLURT/USD prices from Klingex and\n' +
			'     Coingecko.  When BOTH are unreachable AND nothing\n' +
			'     has cached, the indexer falls back to this number.\n' +
			'     Display-only — fee verification is BLURT-native\n' +
			'     and does not consult USD prices.  Default $0.002.\n' +
			'\n' +
			'Both can be edited later via:\n' +
			'   morphit-ops edit  →  Listing fee + fallback BLURT price\n' +
			'or directly in morphit.config.env (and restart).'
	);

	// ─── Listing fee USD target ──
	console.log('  ── Listing fee USD target ──\n');
	const targetUsd = await askFloat('  USD target per listing fee', {
		min: 0.01,
		max: 100,
		default: DEFAULT_LISTING_FEE_TARGET_USD
	});

	// Attempt live recompute via Coingecko.
	console.log('\n  Fetching live BTC/USD and XMR/USD from Coingecko...\n');
	let btcSatoshis = DEFAULT_LISTING_FEE_BTC_SATOSHIS;
	let xmrPiconero = DEFAULT_LISTING_FEE_XMR_PICONERO;
	let source: 'coingecko' | 'manual' | 'default' = 'default';

	try {
		const prices = await fetchBtcXmrPricesFromCoingecko();
		const computed = computeFeeAmounts(targetUsd, prices);
		btcSatoshis = computed.btcSatoshis;
		xmrPiconero = computed.xmrPiconero;
		source = 'coingecko';
		console.log(
			`  ✓ BTC/USD: $${prices.btcUsd.toLocaleString()}` +
				`  XMR/USD: $${prices.xmrUsd.toLocaleString()}\n`
		);
		console.log(`  → BTC: ${btcSatoshis.toLocaleString()} satoshis`);
		console.log(`  → XMR: ${xmrPiconero.toLocaleString()} piconero\n`);
		const ok = await askYesNo('  Accept these amounts?', true);
		if (!ok) {
			source = 'manual';
			btcSatoshis = await askInt('  BTC fee amount in satoshis', {
				min: 1,
				max: 100_000_000_000,
				default: btcSatoshis
			});
			xmrPiconero = await askInt('  XMR fee amount in piconero', {
				min: 1,
				default: xmrPiconero
			});
		}
	} catch (err) {
		console.log(
			`  ⚠ Coingecko unreachable: ${err instanceof Error ? err.message : String(err)}\n`
		);
		console.log('  You can enter BTC sat + XMR piconero amounts by hand,');
		console.log("  or keep the hardcoded defaults (calibrated for $0.25 at");
		console.log('  ~$60K BTC / ~$320 XMR — likely stale by now).');
		console.log('');
		const choice = await askChoice('What would you like to do?', [
			'Enter amounts manually',
			'Keep hardcoded defaults (may be stale)'
		]);
		if (choice === 0) {
			source = 'manual';
			btcSatoshis = await askInt('  BTC fee amount in satoshis', {
				min: 1,
				max: 100_000_000_000,
				default: DEFAULT_LISTING_FEE_BTC_SATOSHIS
			});
			xmrPiconero = await askInt('  XMR fee amount in piconero', {
				min: 1,
				default: DEFAULT_LISTING_FEE_XMR_PICONERO
			});
		} else {
			source = 'default';
			btcSatoshis = DEFAULT_LISTING_FEE_BTC_SATOSHIS;
			xmrPiconero = DEFAULT_LISTING_FEE_XMR_PICONERO;
		}
	}

	// ─── Fallback BLURT/USD price ──
	console.log('\n  ── Fallback BLURT/USD price ──\n');
	const fallbackBlurtPriceUsd = await askFloat(
		'  Fallback BLURT/USD price (used only when live upstreams fail)',
		{
			min: 0.000001,
			max: 1,
			default: DEFAULT_FALLBACK_BLURT_PRICE_USD
		}
	);

	console.log('\n  ✓ Listing fee configured:');
	console.log(`     Target:   $${targetUsd.toFixed(2)} USD`);
	console.log(`     BTC:      ${btcSatoshis.toLocaleString()} satoshis`);
	console.log(`     XMR:      ${xmrPiconero.toLocaleString()} piconero`);
	console.log(`     Source:   ${source}`);
	console.log(`     Fallback: $${fallbackBlurtPriceUsd} BLURT/USD\n`);

	return {
		targetUsd,
		btcSatoshis,
		xmrPiconero,
		fallbackBlurtPriceUsd,
		source
	};
}

// ─── Step 16: Operator tag (Part 111) ────────────────────────────

/** Result of step 16 — the operator tag for this instance. */
export interface OperatorTagResult {
	/** The operator tag, an identifier matching the regex
	 *  `^[a-z0-9._-]+$`, 1..64 chars.  Canonical morphit.io uses
	 *  `morphit`; community operators pick their own (e.g.
	 *  `example-community`).  Written to morphit.config.env as
	 *  MORPHIT_INSTANCE_OPERATOR_TAG. */
	readonly tag: string;
}

const DEFAULT_OPERATOR_TAG = 'morphit';
const OPERATOR_TAG_PATTERN = /^[a-z0-9._-]+$/;
const OPERATOR_TAG_MAX = 64;

/**
 * Part 111 — operator tag for federation-scoped payout
 * attribution.
 *
 * Each Morphit instance writes its operator tag onto every
 * order op it broadcasts; each indexer in the federation
 * sees that tag and decides whether to queue the resulting
 * payouts to its own relay or skip them (because the op is
 * for a different operator's instance).
 *
 * Pre-Part-111, every operator's relay queued payouts for
 * every op in the federation — multiplying treasury spend
 * by the federation count.  With this step, each operator's
 * payouts are scoped to ops served by their own instance.
 *
 * Canonical morphit.io uses the tag `morphit`.  Community
 * operators MUST pick a unique tag and call
 * `morphit_operator_register_v1` on chain to claim it before
 * launch — otherwise their indexer recognizes no incoming
 * ops as "ours" and queues nothing.
 */
export async function stepOperatorTag(): Promise<OperatorTagResult> {
	step(16, TOTAL_STEPS, 'Operator tag');
	explain(
		'Your operator tag identifies this instance in the\n' +
			'federation.  Each Morphit order op carries it, and\n' +
			'each indexer in the federation uses it to decide\n' +
			'which payouts (welcome bonus, dust refill, operator\n' +
			'90% share, loyalty BP) to queue to ITS relay.\n' +
			'\n' +
			'Canonical morphit.io uses `morphit`.  Community\n' +
			'operators MUST pick a unique tag (you can register\n' +
			'it on chain via `morphit_operator_register_v1` after\n' +
			'wizard setup).\n' +
			'\n' +
			'Without this set correctly, your relay will pay\n' +
			'NOTHING — every op will look like it belongs to a\n' +
			'different operator.  This is the conservative\n' +
			'default; "if I do not know who I am, I pay for\n' +
			'nothing."\n' +
			'\n' +
			'Constraints: lowercase letters, digits, dots,\n' +
			'underscores, hyphens; 1..64 characters.'
	);

	while (true) {
		const raw = await ask('  Operator tag', DEFAULT_OPERATOR_TAG);
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			console.log('  ✗ Empty.  Try again.\n');
			continue;
		}
		if (trimmed.length > OPERATOR_TAG_MAX) {
			console.log(`  ✗ Too long (max ${OPERATOR_TAG_MAX}).  Try again.\n`);
			continue;
		}
		if (!OPERATOR_TAG_PATTERN.test(trimmed)) {
			console.log(
				'  ✗ Invalid character.  Allowed: a-z 0-9 . _ -\n'
			);
			continue;
		}
		console.log(`\n  ✓ Operator tag: ${trimmed}\n`);
		if (trimmed !== DEFAULT_OPERATOR_TAG) {
			console.log(
				'  ⚠ Remember to register this tag on chain via\n' +
					'    `morphit_operator_register_v1` before launch,\n' +
					'    otherwise your instance will not receive\n' +
					'    operator-payout (90% of BLURT-paid fees).\n'
			);
		}
		return { tag: trimmed };
	}
}

// ─── Step 17/18: Matrix surfaces ─────────────────────────────────

import {
	parseMxid,
	parseRoomAlias,
	MATRIX_EXAMPLE_MXID,
	MATRIX_EXAMPLE_ROOM_ALIAS
} from '@morphit/operator-config';
import type { MatrixSurfacesResult } from './render.ts';

/** Part 121 cp9 — collect both Matrix surfaces (operator alert
 *  MXID + public group chat room alias).  Either or both may be
 *  skipped.  Validates shape via the shared
 *  @morphit/operator-config parsers so the @-vs-# distinction
 *  is enforced consistently across wizard, indexer, and bot. */
export async function stepMatrixSurfaces(): Promise<MatrixSurfacesResult> {
	step(TOTAL_STEPS, TOTAL_STEPS, 'Matrix surfaces (optional)');
	explain(
		'Morphit can use Matrix for two distinct purposes:\n\n' +
			'  1. PRIVATE alerts to you (the operator) — low balance,\n' +
			'     squatter attack detected, stale price feed, etc.\n' +
			'     The matrix-bot sidecar DMs these to your personal\n' +
			'     MXID over end-to-end-encrypted private chat.\n\n' +
			'  2. PUBLIC user→operator contact — a Matrix group room\n' +
			'     where users browsing your /support page can ask\n' +
			'     questions, request voucher codes, report issues.\n' +
			'     Linked from /support, /about-this-instance, and\n' +
			'     the site footer.\n\n' +
			'IMPORTANT: keep these two SEPARATE.  The MXID is private,\n' +
			'the room alias is public.  Routing a security alert to a\n' +
			'public room would be a privacy violation, which is why\n' +
			'the bot validates the @ vs # prefix at startup and the\n' +
			'frontend only exposes the room (never the MXID) via the\n' +
			'public /v1/instance API.\n\n' +
			'Skip either or both with Enter if you don\'t use Matrix.'
	);

	// MXID prompt
	console.log(
		'\n  Matrix admin address (MXID) — PRIVATE alert destination.\n' +
			`  Example: ${MATRIX_EXAMPLE_MXID}\n`
	);
	let alertMxid: string | null = null;
	while (true) {
		const v = await ask('Matrix admin address (optional, Enter to skip)');
		if (v.length === 0) {
			alertMxid = null;
			break;
		}
		const parsed = parseMxid(v);
		if (parsed === null) {
			console.log(
				`  ✗ Not a valid MXID.  Must start with @, contain one : separating\n` +
					`    the local part from the server.  Example: ${MATRIX_EXAMPLE_MXID}\n`
			);
			continue;
		}
		// Defense in depth — if a copy-paste accidentally produced
		// a room alias starting with #, reject explicitly.  The
		// regex above already excludes this but a clearer error
		// helps the operator notice the mistake.
		if (v.startsWith('#')) {
			console.log(
				'  ✗ That looks like a room alias (#room:server), not an MXID.\n' +
					'    The admin address MUST be a private MXID (@user:server).\n'
			);
			continue;
		}
		alertMxid = parsed;
		console.log(`\n  ✓ Admin MXID: ${parsed}  (PRIVATE — alerts only)\n`);
		break;
	}

	// Room alias prompt
	console.log(
		`  Matrix group chat address — PUBLIC user→operator contact.\n` +
			`  Example: ${MATRIX_EXAMPLE_ROOM_ALIAS}\n`
	);
	let groupRoomAlias: string | null = null;
	while (true) {
		const v = await ask('Matrix group chat address (optional, Enter to skip)');
		if (v.length === 0) {
			groupRoomAlias = null;
			break;
		}
		const parsed = parseRoomAlias(v);
		if (parsed === null) {
			console.log(
				`  ✗ Not a valid room alias.  Must start with #, contain one : separating\n` +
					`    the local part from the server.  Example: ${MATRIX_EXAMPLE_ROOM_ALIAS}\n`
			);
			continue;
		}
		// Defense in depth — reject @-prefixed input here.
		if (v.startsWith('@')) {
			console.log(
				'  ✗ That looks like an MXID (@user:server), not a room alias.\n' +
					'    The group chat MUST be a public room (#room:server).\n'
			);
			continue;
		}
		// Hard guard against typing the same value into both
		// fields.  If groupRoomAlias and alertMxid had the same
		// localpart, that wouldn't be a security issue per se
		// (they start with different sigils so they're different
		// addresses), but the operator might be confused; flag it.
		groupRoomAlias = parsed;
		console.log(`\n  ✓ Group chat: ${parsed}  (PUBLIC — user contact)\n`);
		break;
	}

	if (alertMxid !== null && groupRoomAlias !== null) {
		console.log(
			'  ⓘ Both surfaces configured.  The matrix-bot will DM\n' +
				`    alerts to ${alertMxid} (private), and the frontend\n` +
				`    will link to ${groupRoomAlias} (public) on /support,\n` +
				'    /about-this-instance, and footer.  These two NEVER\n' +
				'    cross — that\'s enforced by typed validators + smokes.\n'
		);
	} else if (alertMxid !== null) {
		console.log(
			'  ⓘ Operator alerts via Matrix configured.  Users will\n' +
				'    not see a Matrix contact link on the frontend (no\n' +
				'    group room set).\n'
		);
	} else if (groupRoomAlias !== null) {
		console.log(
			'  ⓘ Public user contact via Matrix configured.  You will\n' +
				'    NOT receive operator alerts via Matrix (no admin\n' +
				'    MXID set) — alerts will only go to the structured\n' +
				'    logger.  Run a journalctl-based monitoring setup, or\n' +
				'    re-run `morphit ops init` to add an admin MXID.\n'
		);
	}

	return { alertMxid, groupRoomAlias };
}
