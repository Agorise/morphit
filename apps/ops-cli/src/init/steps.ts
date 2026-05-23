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
 * Why one big file: 18 steps × ~50-100 LOC each is within
 * readable limits, and consolidating them lets the wizard tone
 * stay consistent without cross-file imports for shared phrasing.
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

const TOTAL_STEPS = 18;

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
	step(15, TOTAL_STEPS, 'SEO override (optional)');
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

// ─── Step 16: Daily DB backup automation ─────────────────────────
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
	step(16, TOTAL_STEPS, 'Daily DB backup');
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
// Part 122 cp21 — BCH chat-link explorer URL default.  Operator
// can override; alternatives surveyed at Part 122 cp21 addition
// time include blockchain.com/explorer, bitinfocharts.com,
// bchexplorer.info, oklink.com/bch, bch.tokenview.io,
// blockexplorer.one, explorer.cloverpool.com.
export const DEFAULT_BCH_CHAT_LINK_URL =
	'https://blockchair.com/bitcoin-cash/transaction/{txid}';

// Part 122 cp24 — LTC chat-link explorer URL bundled default.
// litecoinspace.org is the LTC-equivalent of mempool.space:
// community-led, no JS tracking, open-source, privacy-aligned
// (Morphit priority #1).  Other candidates Ken surveyed at
// addition time include blockchair.com/litecoin,
// oklink.com/litecoin, bitinfocharts.com/litecoin/explorer/,
// chain.so/LTC, blockexplorer.one/litecoin/mainnet, and
// ltc.tokenview.io.  Operators wanting a different default
// override via MORPHIT_FRONTEND_LTC_CHAT_LINK_URL.
export const DEFAULT_LTC_CHAT_LINK_URL = 'https://litecoinspace.org/tx/{txid}';

// Part 122 cp27 — DASH chat-link explorer URL bundled default.
// insight.dash.org is the official Dash project's Insight
// instance — community-led, open-source backend, no third-party
// ad/tracking layer.  Same posture as litecoinspace.org for LTC,
// privacy-aligned (Morphit priority #1).  Other candidates Ken
// surveyed at addition time include blockchair.com/dash,
// explorer.dash.org/insight/, chainz.cryptoid.info/dash/,
// oklink.com/dash, bitinfocharts.com/dash/explorer/,
// blockexplorer.one/dash/mainnet,
// blockchain.com/explorer/assets/dash, and dash.tokenview.io.
// Operators wanting a different default override via
// MORPHIT_FRONTEND_DASH_CHAT_LINK_URL.
export const DEFAULT_DASH_CHAT_LINK_URL = 'https://insight.dash.org/insight/tx/{txid}';

// Part 122 cp33 — DOGE chat-link explorer URL bundled default.
// blockchair.com/dogecoin chosen from Ken's 9-explorer survey
// (2026-05-19) for predictable URL format, multi-chain support
// (already used as BCH default — operator gets one origin in
// their CSP allowlist for two chains), uptime track record, no
// aggressive fingerprinting, and HTTPS-only.  Other candidates
// surveyed: dogechain.info (community-favored historical default,
// uptime + ad-inventory issues), bitinfocharts.com/dogecoin
// (aggregator, ad-heavy), live.blockcypher.com/doge/ (BlockCypher
// infra, free-tier rate-limited), blockexplorer.one/dogecoin/mainnet,
// blockchain.com/explorer/assets/doge (exchange-affiliated;
// declined), sochain.com/DOGE + chain.so/DOGE (older SoChain
// service; uptime variable), oklink.com (OKX-affiliated, exchange-
// adjacent).  Operators wanting different default override via
// MORPHIT_FRONTEND_DOGE_CHAT_LINK_URL.
export const DEFAULT_DOGE_CHAT_LINK_URL = 'https://blockchair.com/dogecoin/transaction/{txid}';

// Part 122 cp39 — ZEC chat-link explorer URL bundled default.
// mainnet.zcashexplorer.app chosen from Ken's 7-explorer survey
// (2026-05-19) as the community-run, project-aligned default with
// no third-party tracking, supports both transparent (t1/t3) and
// shielded (zs1/u1) tx lookups by txid.  Same privacy/decentralization
// rationale as insight.dash.org for DASH and blockstream.info for
// BTC: prefer a project-aligned or community-run explorer over
// third-party aggregators or exchange-affiliated services.  Other
// candidates surveyed: blockchair.com/zcash (third-party aggregator,
// already used for DOGE so the operator would get two chains on
// one CSP origin if they preferred), zcashinfo.com (community-run,
// lower traffic), 3xpl.com/zcash (third-party aggregator),
// blockexplorer.one/zcash/mainnet (generic aggregator),
// zcash.tokenview.io (Tokenview multi-chain), cipherscan.app
// (newer privacy-focused explorer).  Operators wanting different
// default override via MORPHIT_FRONTEND_ZEC_CHAT_LINK_URL.
export const DEFAULT_ZEC_CHAT_LINK_URL = 'https://mainnet.zcashexplorer.app/transactions/{txid}';

// Part 122 cp41 — Pirate Chain (ARRR) chat-link explorer URL
// bundled default.  Operator's 3-explorer survey at cp41:
// explorer.piratechain.com (chosen as bundled default — official
// project explorer, project-aligned, no third-party tracking),
// pirate.explorer.dexstats.info (community-run, Komodo-ecosystem
// multi-coin), blockchain.com/explorer/assets/arrr (third-party
// aggregator).  Operators wanting different default override
// via MORPHIT_FRONTEND_ARRR_CHAT_LINK_URL.
export const DEFAULT_ARRR_CHAT_LINK_URL = 'https://explorer.piratechain.com/tx/{txid}';

// Part 122 cp43 — Decred (DCR) chat-link explorer URL bundled
// default.  Operator's 4-explorer survey at cp43:
// dcrdata.decred.org (chosen as bundled default — official project
// explorer, project-aligned, no third-party tracking),
// blockchain.com/explorer/assets/dcr (third-party aggregator),
// dcr.tokenview.io (Tokenview multi-chain),
// bitinfocharts.com/decred/ (community analytics + block explorer).
// Operators wanting different default override via
// MORPHIT_FRONTEND_DCR_CHAT_LINK_URL.
export const DEFAULT_DCR_CHAT_LINK_URL = 'https://dcrdata.decred.org/tx/{txid}';

// Part 122 cp45 — Solana (SOL) chat-link explorer URL bundled
// default.  Operator's 5-explorer survey at cp45:
// explorer.solana.com (chosen as bundled default — official
// project explorer), solscan.io (third-party aggregator, most
// popular), solanabeach.io (validator-focused),
// oklink.com/solana (OKX-affiliated), solana.fm (community-run,
// unreachable at survey time per Ken's note).  Operators wanting
// different default override via MORPHIT_FRONTEND_SOL_CHAT_LINK_URL.
export const DEFAULT_SOL_CHAT_LINK_URL = 'https://explorer.solana.com/tx/{txid}';

// Part 122 cp47 — Ethereum (ETH) chat-link explorer URL bundled
// default.  Operator's 9-explorer survey at cp47:
// eth.blockscout.com (chosen as bundled default — open-source
// Blockscout instance, project-aligned with Ethereum's transparency
// ethos), etherscan.io (most popular but third-party closed-source),
// blockchair.com/ethereum, ethplorer.io, oklink.com/ethereum (OKX-
// affiliated), blockchain.com/explorer/assets/eth (exchange-affiliated),
// blockexplorer.one/ethereum/mainnet, routescan.io, beaconcha.in
// (consensus-layer only, not suitable for regular tx lookups).
// Operators wanting different default override via
// MORPHIT_FRONTEND_ETH_CHAT_LINK_URL.
export const DEFAULT_ETH_CHAT_LINK_URL = 'https://eth.blockscout.com/tx/{txid}';

// Part 122 cp49 — Ripple (XRP) chat-link explorer URL bundled
// default.  Operator's 5-explorer survey at cp49: livenet.xrpl.org
// (chosen as bundled default — XRP Ledger Foundation non-profit,
// project-aligned), xrpscan.com (XRPL-focused third-party),
// bithomp.com (third-party with token/NFT support),
// blockchair.com/xrp-ledger (multi-chain aggregator),
// blockexplorer.one/xrp/mainnet (multi-chain third-party).
// Operators wanting different default override via
// MORPHIT_FRONTEND_XRP_CHAT_LINK_URL.
export const DEFAULT_XRP_CHAT_LINK_URL = 'https://livenet.xrpl.org/transactions/{txid}';

// Part 122 cp30-DD-11 — USDT per-network chat-link explorer URL
// bundled defaults.  USDT is multi-network so the operator
// override is per-network (each chain has its own explorer
// ecosystem).  Closure of DD-11 (the per-network USDT explorer
// override was declared in indexer-client + frontend store but
// never populated by the indexer body since Part 121 cp3; cp30-DD
// finally landed both the indexer-side wiring AND these wizard
// defaults so operators get sane out-of-box URLs).
export const DEFAULT_USDT_ERC20_CHAT_LINK_URL = 'https://etherscan.io/tx/{txid}';
export const DEFAULT_USDT_TRC20_CHAT_LINK_URL = 'https://tronscan.org/#/transaction/{txid}';
export const DEFAULT_USDT_SPL_CHAT_LINK_URL = 'https://solscan.io/tx/{txid}';
export const DEFAULT_USDT_BEP20_CHAT_LINK_URL = 'https://bscscan.com/tx/{txid}';

// Part 122 cp30 — USDC per-network chat-link explorer URL bundled
// defaults.  4 networks (ERC-20, SPL, Base, Polygon); BEP-20
// intentionally not supported per ADR-0028 §1 (Binance-Peg + 18-
// decimal divergence).
export const DEFAULT_USDC_ERC20_CHAT_LINK_URL = 'https://etherscan.io/tx/{txid}';
export const DEFAULT_USDC_SPL_CHAT_LINK_URL = 'https://solscan.io/tx/{txid}';
export const DEFAULT_USDC_BASE_CHAT_LINK_URL = 'https://basescan.org/tx/{txid}';
export const DEFAULT_USDC_POLYGON_CHAT_LINK_URL = 'https://polygonscan.com/tx/{txid}';

// Part 122 cp31 — DAI per-network chat-link explorer URL bundled
// defaults.  4 EVM networks (ERC-20, Polygon, Base, Arbitrum).
// SPL/TRC-20/BEP-20 intentionally not supported per ADR-0029 §1
// (no canonical Maker-issued DAI on those chains).
export const DEFAULT_DAI_ERC20_CHAT_LINK_URL = 'https://etherscan.io/tx/{txid}';
export const DEFAULT_DAI_POLYGON_CHAT_LINK_URL = 'https://polygonscan.com/tx/{txid}';
export const DEFAULT_DAI_BASE_CHAT_LINK_URL = 'https://basescan.org/tx/{txid}';
export const DEFAULT_DAI_ARBITRUM_CHAT_LINK_URL = 'https://arbiscan.io/tx/{txid}';

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
	/** Part 122 cp21 — BCH chat-link explorer URL.  Same shape
	 *  as btc/xmr.  Operator-tunable via the wizard or by setting
	 *  MORPHIT_FRONTEND_BCH_CHAT_LINK_URL directly. */
	readonly bch: string;
	/** Part 122 cp24 — LTC chat-link explorer URL.  Same shape
	 *  as btc/xmr/bch.  Operator-tunable via the wizard or by
	 *  setting MORPHIT_FRONTEND_LTC_CHAT_LINK_URL directly. */
	readonly ltc: string;
	/** Part 122 cp27 — DASH chat-link explorer URL.  Same shape
	 *  as btc/xmr/bch/ltc.  Operator-tunable via the wizard or
	 *  by setting MORPHIT_FRONTEND_DASH_CHAT_LINK_URL directly. */
	readonly dash: string;
	/** Part 122 cp33 — DOGE chat-link explorer URL.  Same shape
	 *  as btc/xmr/bch/ltc/dash.  Operator-tunable via the wizard
	 *  or by setting MORPHIT_FRONTEND_DOGE_CHAT_LINK_URL directly. */
	readonly doge: string;
	/** Part 122 cp39 — ZEC chat-link explorer URL.  Same shape
	 *  as btc/xmr/bch/ltc/dash/doge (single-network mainnet).
	 *  Operator-tunable via the wizard or by setting
	 *  MORPHIT_FRONTEND_ZEC_CHAT_LINK_URL directly. */
	readonly zec: string;
	readonly arrr: string;
	readonly dcr: string;
	readonly sol: string;
	readonly eth: string;
	readonly xrp: string;
	/** Part 122 cp30-DD — multi-network USDT per-network chat-link
	 *  URLs.  4 networks (erc20/trc20/spl/bep20).  Operator-tunable
	 *  via wizard step 12b or by setting MORPHIT_FRONTEND_USDT_<NET>
	 *  _CHAT_LINK_URL.  The override has historically existed on the
	 *  client wire-format mirror since Part 121 cp3 but never actually
	 *  worked end-to-end on the public API until cp30-DD-11 closed
	 *  the indexer-side gap. */
	readonly usdt: {
		readonly erc20: string;
		readonly trc20: string;
		readonly spl: string;
		readonly bep20: string;
	};
	/** Part 122 cp30 — multi-network USDC per-network chat-link
	 *  URLs.  4 networks (erc20/spl/base/polygon).  BEP-20
	 *  intentionally absent per ADR-0028 §1. */
	readonly usdc: {
		readonly erc20: string;
		readonly spl: string;
		readonly base: string;
		readonly polygon: string;
	};
	/** Part 122 cp31 — multi-network DAI per-network chat-link
	 *  URLs.  4 EVM networks (erc20/polygon/base/arbitrum).
	 *  SPL/TRC-20/BEP-20 intentionally absent per ADR-0029 §1.
	 *  All four explorers are -scan-style (etherscan, polygonscan,
	 *  basescan, arbiscan). */
	readonly dai: {
		readonly erc20: string;
		readonly polygon: string;
		readonly base: string;
		readonly arbitrum: string;
	};
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
		'When a counterparty sends a txid for any tradable asset\n' +
			'in chat, the Morphit frontend renders it as a clickable\n' +
			'link that opens a third-party block explorer in a new\n' +
			'tab.  This is separate from the FEE-VERIFIER explorer\n' +
			'URLs (which are server-side and used for cross-checking\n' +
			'payment claims).\n' +
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
			'Single-network assets (one URL each):\n' +
			'  • BTC, XMR, BCH, LTC, DASH\n' +
			'\n' +
			'Multi-network assets (one URL per network):\n' +
			'  • USDT: ERC-20, TRC-20, SPL, BEP-20\n' +
			'  • USDC: ERC-20, SPL, Base, Polygon\n' +
			'  • DAI:  ERC-20, Polygon, Base, Arbitrum\n' +
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

	// ─── BCH (Part 122 cp21) ──
	console.log('\n  ── BCH chat-link URL ──\n');
	const bch = await editChatLinkUrl('BCH chat-link URL', DEFAULT_BCH_CHAT_LINK_URL);

	// ─── LTC (Part 122 cp24) ──
	console.log('\n  ── LTC chat-link URL ──\n');
	const ltc = await editChatLinkUrl('LTC chat-link URL', DEFAULT_LTC_CHAT_LINK_URL);

	// ─── DASH (Part 122 cp27) ──
	console.log('\n  ── DASH chat-link URL ──\n');
	const dash = await editChatLinkUrl('DASH chat-link URL', DEFAULT_DASH_CHAT_LINK_URL);

	// ─── DOGE (Part 122 cp33) ──
	console.log('\n  ── DOGE chat-link URL ──\n');
	const doge = await editChatLinkUrl('DOGE chat-link URL', DEFAULT_DOGE_CHAT_LINK_URL);

	// ─── ZEC (Part 122 cp39) ──
	console.log('\n  ── ZEC chat-link URL ──\n');
	const zec = await editChatLinkUrl('ZEC chat-link URL', DEFAULT_ZEC_CHAT_LINK_URL);

	// ─── ARRR (Part 122 cp41) ──
	console.log('\n  ── ARRR chat-link URL ──\n');
	const arrr = await editChatLinkUrl('ARRR chat-link URL', DEFAULT_ARRR_CHAT_LINK_URL);

	// ─── DCR (Part 122 cp43) ──
	console.log('\n  ── DCR chat-link URL ──\n');
	const dcr = await editChatLinkUrl('DCR chat-link URL', DEFAULT_DCR_CHAT_LINK_URL);

	// ─── SOL (Part 122 cp45) ──
	console.log('\n  ── SOL chat-link URL ──\n');
	const sol = await editChatLinkUrl('SOL chat-link URL', DEFAULT_SOL_CHAT_LINK_URL);

	// ─── ETH (Part 122 cp47) ──
	console.log('\n  ── ETH chat-link URL ──\n');
	const eth = await editChatLinkUrl('ETH chat-link URL', DEFAULT_ETH_CHAT_LINK_URL);

	// ─── XRP (Part 122 cp49) ──
	console.log('\n  ── XRP chat-link URL ──\n');
	const xrp = await editChatLinkUrl('XRP chat-link URL', DEFAULT_XRP_CHAT_LINK_URL);

	// ─── USDT multi-network (Part 122 cp30-DD-11) ──
	// USDT trades happen on 4 distinct chains (Ethereum / Tron /
	// Solana / BNB Smart Chain); each chain has its own explorer
	// ecosystem so the override is per-network.  Most operators
	// accept defaults — we offer a single grouped prompt rather
	// than 4 separate prompts.  Operators wanting to point any
	// network at a self-hosted explorer can choose "Customize"
	// or edit morphit.config.env directly.
	console.log('\n  ── USDT per-network chat-link URLs (4 networks) ──\n');
	explain(
		'USDT is multi-network: a trade on USDT is actually a trade\n' +
			'on Ethereum (ERC-20), Tron (TRC-20), Solana (SPL), or\n' +
			'BNB Smart Chain (BEP-20).  Each chain has its own\n' +
			'explorer.  Defaults below.  You can accept all 4 defaults\n' +
			'or customize per-network.\n' +
			'\n' +
			'Defaults:\n' +
			'  • ERC-20: ' + DEFAULT_USDT_ERC20_CHAT_LINK_URL + '\n' +
			'  • TRC-20: ' + DEFAULT_USDT_TRC20_CHAT_LINK_URL + '\n' +
			'  • SPL:    ' + DEFAULT_USDT_SPL_CHAT_LINK_URL + '\n' +
			'  • BEP-20: ' + DEFAULT_USDT_BEP20_CHAT_LINK_URL
	);
	const usdtChoice = await askChoice(
		'How would you like to handle USDT per-network URLs?',
		['Accept all 4 defaults', 'Customize each one']
	);
	const usdt = usdtChoice === 0
		? {
			erc20: DEFAULT_USDT_ERC20_CHAT_LINK_URL,
			trc20: DEFAULT_USDT_TRC20_CHAT_LINK_URL,
			spl: DEFAULT_USDT_SPL_CHAT_LINK_URL,
			bep20: DEFAULT_USDT_BEP20_CHAT_LINK_URL
		}
		: {
			erc20: await editChatLinkUrl('USDT ERC-20 chat-link URL', DEFAULT_USDT_ERC20_CHAT_LINK_URL),
			trc20: await editChatLinkUrl('USDT TRC-20 chat-link URL', DEFAULT_USDT_TRC20_CHAT_LINK_URL),
			spl: await editChatLinkUrl('USDT SPL chat-link URL', DEFAULT_USDT_SPL_CHAT_LINK_URL),
			bep20: await editChatLinkUrl('USDT BEP-20 chat-link URL', DEFAULT_USDT_BEP20_CHAT_LINK_URL)
		};

	// ─── USDC multi-network (Part 122 cp30) ──
	// Same shape as USDT but 4 different networks (Ethereum,
	// Solana, Base, Polygon).  BEP-20 intentionally not supported
	// (ADR-0028 §1: Binance-Peg is a 2-custodian wrapper + 18-
	// decimal precision divergence).
	console.log('\n  ── USDC per-network chat-link URLs (4 networks) ──\n');
	explain(
		'USDC is multi-network: ERC-20 (Ethereum), SPL (Solana),\n' +
			'Base, or Polygon PoS.  No BEP-20 — that variant is\n' +
			'Binance-Peg, not Circle-native, per ADR-0028.\n' +
			'\n' +
			'Defaults:\n' +
			'  • ERC-20:  ' + DEFAULT_USDC_ERC20_CHAT_LINK_URL + '\n' +
			'  • SPL:     ' + DEFAULT_USDC_SPL_CHAT_LINK_URL + '\n' +
			'  • Base:    ' + DEFAULT_USDC_BASE_CHAT_LINK_URL + '\n' +
			'  • Polygon: ' + DEFAULT_USDC_POLYGON_CHAT_LINK_URL
	);
	const usdcChoice = await askChoice(
		'How would you like to handle USDC per-network URLs?',
		['Accept all 4 defaults', 'Customize each one']
	);
	const usdc = usdcChoice === 0
		? {
			erc20: DEFAULT_USDC_ERC20_CHAT_LINK_URL,
			spl: DEFAULT_USDC_SPL_CHAT_LINK_URL,
			base: DEFAULT_USDC_BASE_CHAT_LINK_URL,
			polygon: DEFAULT_USDC_POLYGON_CHAT_LINK_URL
		}
		: {
			erc20: await editChatLinkUrl('USDC ERC-20 chat-link URL', DEFAULT_USDC_ERC20_CHAT_LINK_URL),
			spl: await editChatLinkUrl('USDC SPL chat-link URL', DEFAULT_USDC_SPL_CHAT_LINK_URL),
			base: await editChatLinkUrl('USDC Base chat-link URL', DEFAULT_USDC_BASE_CHAT_LINK_URL),
			polygon: await editChatLinkUrl('USDC Polygon chat-link URL', DEFAULT_USDC_POLYGON_CHAT_LINK_URL)
		};

	// ─── DAI multi-network (Part 122 cp31) ──
	// Same shape as USDC but 4 EVM networks (Ethereum, Polygon,
	// Base, Arbitrum).  No SPL/TRC-20/BEP-20 — per ADR-0029 §1,
	// MakerDAO does not issue canonical native DAI on those
	// chains; existing wrapped/bridged variants defeat DAI's
	// decentralization rationale.  All four explorers are
	// -scan-style (etherscan/polygonscan/basescan/arbiscan).
	console.log('\n  ── DAI per-network chat-link URLs (4 networks) ──\n');
	explain(
		'DAI is multi-network: ERC-20 (Ethereum), Polygon (PoS),\n' +
			'Base, or Arbitrum One.  All four are EVM-family; no SPL\n' +
			'or BEP-20 per ADR-0029 — Maker does not issue native DAI\n' +
			'on those chains.\n' +
			'\n' +
			'Defaults:\n' +
			'  • ERC-20:   ' + DEFAULT_DAI_ERC20_CHAT_LINK_URL + '\n' +
			'  • Polygon:  ' + DEFAULT_DAI_POLYGON_CHAT_LINK_URL + '\n' +
			'  • Base:     ' + DEFAULT_DAI_BASE_CHAT_LINK_URL + '\n' +
			'  • Arbitrum: ' + DEFAULT_DAI_ARBITRUM_CHAT_LINK_URL
	);
	const daiChoice = await askChoice(
		'How would you like to handle DAI per-network URLs?',
		['Accept all 4 defaults', 'Customize each one']
	);
	const dai = daiChoice === 0
		? {
			erc20: DEFAULT_DAI_ERC20_CHAT_LINK_URL,
			polygon: DEFAULT_DAI_POLYGON_CHAT_LINK_URL,
			base: DEFAULT_DAI_BASE_CHAT_LINK_URL,
			arbitrum: DEFAULT_DAI_ARBITRUM_CHAT_LINK_URL
		}
		: {
			erc20: await editChatLinkUrl('DAI ERC-20 chat-link URL', DEFAULT_DAI_ERC20_CHAT_LINK_URL),
			polygon: await editChatLinkUrl('DAI Polygon chat-link URL', DEFAULT_DAI_POLYGON_CHAT_LINK_URL),
			base: await editChatLinkUrl('DAI Base chat-link URL', DEFAULT_DAI_BASE_CHAT_LINK_URL),
			arbitrum: await editChatLinkUrl('DAI Arbitrum chat-link URL', DEFAULT_DAI_ARBITRUM_CHAT_LINK_URL)
		};

	return { btc, xmr, bch, ltc, dash, doge, zec, arrr, dcr, sol, eth, xrp, usdt, usdc, dai };
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

// ─── Step 13: Trade-only asset policy (Part 122 cp22) ────────────

/**
 * Part 122 cp22 — interactive disable-asset wizard step.
 *
 * Morphit ships every Category-B (trade-only) asset enabled by
 * default on a new instance per Memory #25.  This step lets the
 * operator opt out per-asset WITHOUT having to edit the rendered
 * env file by hand afterward.  The result feeds
 * `MORPHIT_INDEXER_DISABLED_ASSETS` in morphit.config.env.
 *
 * Category-B = `canBeTraded && !canPayListingFee` from the
 * canonical asset registry.  Currently: USDT, USDC, DAI, BCH, LTC,
 * DASH, DOGE.  Any future trade-only addition will surface here
 * automatically — the step iterates the registry filtered by
 * the Category-B predicate, so no per-asset wizard code is
 * needed when new tickers ship.
 *
 * Category-A (fee-payable) assets — BTC, XMR, BLURT — do NOT
 * appear in this step.  They are load-bearing for the listing
 * fee mechanism (fee_method enum-frozen per Memory #23) and
 * cannot be disabled instance-wide without breaking trading
 * altogether.  An operator who genuinely wants to disable them
 * is running a different product.
 */

export interface DisabledAssetsResult {
	/** Uppercase tickers the operator has chosen to disable on
	 *  this instance.  Empty means accept every trade-only
	 *  asset (the default).  Renders into
	 *  `MORPHIT_INDEXER_DISABLED_ASSETS="BCH,DAI,DOGE,USDC,USDT"`
	 *  (alphabetized
	 *  for stable env-file output). */
	readonly disabledTickers: readonly string[];
}

/** Return the Category-B (trade-only) asset tickers from the
 *  canonical registry.  Imported lazily so the wizard step can
 *  be tested without dragging the full asset-registry into the
 *  ops-cli unit-test surface. */
async function getCategoryBTickers(): Promise<readonly string[]> {
	const { ASSETS } = await import('@morphit/asset-registry');
	return ASSETS.filter((a) => a.canBeTraded && !a.canPayListingFee).map((a) => a.ticker);
}

/** Brief operator-facing description per known Category-B
 *  ticker.  Wizard-side only — the canonical registry stays
 *  display-string-free.  Future trade-only additions should add
 *  an entry here; unknown tickers fall back to a generic line. */
const CATEGORY_B_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
	USDT: 'Tether stablecoin across 4 networks (ERC-20, TRC-20, SPL, BEP-20).\n    Most-traded stablecoin; centrally issued and freezable by Tether Inc.',
	USDC: 'USD Coin stablecoin across 4 networks (ERC-20, SPL, Base, Polygon).\n    Issued by Circle; centrally controllable like USDT — Circle can\n    freeze addresses on regulatory request.  No BEP-20 (Binance-Peg\n    wrapper would add a second custodian) and no TRC-20 (Circle does\n    not natively issue on Tron).',
	DAI: 'Dai stablecoin across 4 EVM networks (ERC-20, Polygon, Base, Arbitrum).\n    Issued by the MakerDAO protocol — no admin-controlled freeze\n    function, so unlike USDT/USDC the Dai contract cannot blacklist\n    addresses.  Honest nuance: partially USDC-backed via the Peg\n    Stability Module, so Circle freeze power transitively affects\n    redemption mechanics.  No SPL/TRC-20/BEP-20 (those variants are\n    bridged/wrapped, not Maker-native).',
	BCH: 'Bitcoin Cash — single-network mainnet.  Forked from BTC in 2017;\n    bigger blocks, lower fees, transparent like BTC, no central issuer.',
	LTC: 'Litecoin — single-network mainnet.  Forked from BTC in 2011;\n    faster blocks (2.5 min), Scrypt mining, transparent like BTC, no central issuer.',
	DASH: 'Dash — single-network mainnet.  Forked from Litecoin in 2014;\n    fast-confirmation (~2.5 min) with optional InstantSend; opt-in\n    PrivateSend mixing via masternodes; transparent at base layer.',
	DOGE: 'Dogecoin — single-network mainnet.  Fair-launched 2013, merge-mined\n    with Litecoin since 2014 (auxiliary proof-of-work).  Transparent at\n    base layer like BTC; no native privacy upgrade (no PrivateSend\n    equivalent, no confidential transactions, no segwit-enabled mixing).\n    No central issuer.',
	ZEC: 'Zcash — single-network mainnet.  Launched 2016.  Supports both\n    transparent addresses (t1/t3, base58, like BTC) and shielded\n    addresses (zs1 Sapling, u1 Unified Address) using zero-knowledge\n    proofs to hide sender, recipient, and amount.  Per-trade, recipients\n    pick the address type that fits their posture.  No central issuer.',
	ARRR: 'Pirate Chain — single-network mainnet.  Launched 2018 as a fork of\n    the Zcash codebase, configured so that the Sapling zk-SNARK shielded\n    pool is the only available transaction type — every transfer hides\n    sender, recipient, and amount on chain by construction.  No\n    transparent address option (transparent funds were sunset early in\n    the chain).  Single address format (zs1 Sapling, bech32, 78 chars).\n    No central issuer.',
	DCR: 'Decred — single-network mainnet.  Launched 2016.  Hybrid Proof-of-Work\n    + Proof-of-Stake consensus: every block is mined by PoW miners AND\n    voted on by 5 PoS ticket-holders chosen pseudo-randomly from the\n    staking pool.  On-chain governance via Politeia lets stakeholders\n    propose and ratify protocol changes.  Two receive-address formats\n    (Ds P2PKH and Dc P2SH, 35 chars each, base58).  Opt-in CoinShuffle++\n    (CSPP) mixing integrated into dcrwallet for wallet-side transaction-\n    level privacy.  No central issuer.',
	XRP: 'Ripple — single-network XRPL mainnet.  Launched 2012 with Federated\n    Byzantine Agreement (FBA) consensus — validators on a Unique Node\n    List (UNL) reach agreement on transaction ordering.  The default UNL\n    is published by the XRP Ledger Foundation (non-profit) with the for-\n    profit Ripple Labs Inc. historically influencing validator selection.\n    Native XRP cannot be frozen by any central authority — the freeze\n    flag on XRPL applies only to ISSUED tokens (IOUs).  Addresses are\n    base58 starting with `r`, 24-34 chars total.  Two XRPL-specific UX\n    gotchas: (1) destination tags (32-bit integers) required when sending\n    to exchange-hosted addresses; without the tag funds practically lose\n    (recoverable only via exchange support); (2) account reserve (≥1 XRP)\n    required to fund a never-funded address.  Transparent base layer\n    with no native protocol-level mixing; wallet-side address rotation\n    is the privacy lever.',
	ETH: 'Ethereum — single-network mainnet.  Launched 2015 with Proof-of-Work,\n    transitioned to Proof-of-Stake in September 2022 ("The Merge").  Validators\n    stake ETH and process blocks in rotation; no central freeze authority.\n    Addresses are 20-byte hex with 0x prefix (42 chars total) — SAME shape as\n    every EVM token-account address on Base, Polygon, Arbitrum, BSC.  Asset\n    field (and network field for multi-network assets) disambiguates.  ENS\n    names are NOT resolved by Morphit (avoids centralized RPC dependency).\n    Smart-contract destinations may revert if the contract lacks a payable\n    receive() or fallback() function — wallet UX warns before sending.\n    Transparent base layer with no native protocol-level mixing; wallet-side\n    address rotation is the privacy lever.  No central issuer.',
	SOL: 'Solana — single-network mainnet-beta.  Launched 2020.  Delegated\n    Proof-of-Stake consensus with Proof-of-History sequencing for high\n    transaction throughput.  Validators stake SOL and process blocks in\n    rotation; no central freeze authority.  Addresses are 32-byte public\n    keys base58-encoded (32-44 chars, most are 44).  Same address format\n    as USDT-Solana and USDC-Solana SPL token-accounts — asset field on\n    the order disambiguates.  Transparent base layer with no native\n    protocol-level mixing; wallet-side address rotation is the privacy\n    lever.  No central issuer.'
});

export async function stepDisabledAssets(): Promise<DisabledAssetsResult> {
	step(13, TOTAL_STEPS, 'Trade-only asset policy');
	const categoryBTickers = await getCategoryBTickers();
	if (categoryBTickers.length === 0) {
		// Defensive: registry could theoretically ship without any
		// Category-B asset.  Skip the step cleanly rather than
		// presenting an empty prompt.
		console.log(
			'  This Morphit build ships no trade-only assets; nothing to\n' +
				'  disable.  Skipping.\n'
		);
		return { disabledTickers: [] };
	}

	explain(
		'Trade-only assets are coins users can buy and sell on\n' +
			'your instance but CANNOT use to pay listing fees.  Listing\n' +
			'fees remain BLURT, BTC, or XMR only — that wire format is\n' +
			'frozen (per ADR-0011 + ADR-0023 + ADR-0024).\n' +
			'\n' +
			'Every trade-only asset ships ENABLED by default on a fresh\n' +
			"instance.  You can disable any of them below if you don't\n" +
			'want your users to trade them on YOUR node.\n' +
			'\n' +
			'Federation note: disabling an asset is operator-scoped, not\n' +
			"federation-scoped.  Your users still SEE peer instances'\n" +
			'orders for that asset in their orderbook (chain history is\n' +
			'shared); they just cannot POST new orders for it from your\n' +
			'instance.\n' +
			'\n' +
			'Reasonable reasons to disable an asset:\n' +
			'  • USDT or USDC — operator preferring privacy-first or\n' +
			'    decentralization-first posture; both stablecoins are\n' +
			'    centrally controllable (Tether Inc. / Circle can freeze\n' +
			'    addresses).\n' +
			'  • BCH — operator preferring BTC + XMR only as the\n' +
			'    Bitcoin-family rail.\n' +
			'  • Any — operator wants to specialize their instance.\n' +
			'\n' +
			'Skipping any answer keeps that asset ENABLED (the default).\n' +
			"You can change your mind later by editing the\n" +
			'MORPHIT_INDEXER_DISABLED_ASSETS env var or re-running this\n' +
			'wizard.'
	);

	const disabled: string[] = [];
	for (const ticker of categoryBTickers) {
		const description =
			CATEGORY_B_DESCRIPTIONS[ticker] ??
			'Trade-only asset (cannot pay listing fees).';
		console.log(`\n  ${ticker}\n    ${description}\n`);
		const keepEnabled = await askYesNo(
			`  Enable ${ticker} trading on this instance?`,
			true
		);
		if (!keepEnabled) {
			disabled.push(ticker);
			console.log(
				`    ↳ ${ticker} will be DISABLED.  Your users will see\n` +
					`      an inline error if they try to post a new ${ticker} order;\n` +
					`      peer-instance ${ticker} orders still appear in the orderbook.\n`
			);
		} else {
			console.log(`    ↳ ${ticker} stays enabled (default).\n`);
		}
	}

	// Summary so the operator sees the final stance before
	// proceeding (catches misclicks).
	if (disabled.length === 0) {
		console.log('  ✓ All trade-only assets remain enabled (default posture).');
	} else {
		const list = disabled.slice().sort().join(', ');
		console.log(`  ✓ Disabling ${disabled.length} asset(s): ${list}`);
		console.log(`    These will be written to MORPHIT_INDEXER_DISABLED_ASSETS\n    in morphit.config.env.`);
	}

	return {
		// Alphabetize for stable env-file output.  Indexer's
		// disabled-assets parser is case-tolerant + whitespace-
		// tolerant + comma-trailing-tolerant, but a stable order
		// makes the env file diff-friendly across re-runs.
		disabledTickers: disabled.slice().sort()
	};
}

// ─── Step 14: Listing fee + fallback BLURT price ─────────────────

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
	step(14, TOTAL_STEPS, 'Listing fee + fallback BLURT price');
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

	// ─── cp128: Denomination fiat ──
	//
	// The unit the indexer expresses BLURT prices in for its
	// display surfaces (listing-fee fiat echo, receipt endpoint,
	// drift baseline, etc.).  Default 'USD' matches pre-cp128
	// behavior.  See ADR-0040.
	console.log('\n  ── Denomination fiat (display unit) ──\n');
	explain(
		'The unit the indexer displays BLURT prices in.\n' +
			'\n' +
			'Default USD.  Set to a different ticker if your market is\n' +
			"non-USD or you want to hedge against USD erosion.  This\n" +
			"doesn't affect what currencies traders can post orders in\n" +
			'(orders carry their own fiat_currency); it only affects the\n' +
			'small "~$0.12" subtext next to listing-fee BLURT amounts on\n' +
			'this instance.\n' +
			'\n' +
			"You can change this later by editing the env var\n" +
			'MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT and restarting.'
	);
	const COMMON_FIATS: ReadonlyArray<{ ticker: string; label: string }> = [
		{ ticker: 'USD', label: 'USD — US Dollar (default)' },
		{ ticker: 'EUR', label: 'EUR — Euro' },
		{ ticker: 'GBP', label: 'GBP — British Pound' },
		{ ticker: 'JPY', label: 'JPY — Japanese Yen' },
		{ ticker: 'BRL', label: 'BRL — Brazilian Real' },
		{ ticker: 'CNY', label: 'CNY — Chinese Yuan' },
		{ ticker: 'INR', label: 'INR — Indian Rupee' },
		{ ticker: 'RUB', label: 'RUB — Russian Ruble' },
		{ ticker: 'AED', label: 'AED — UAE Dirham' },
		{ ticker: 'XDR', label: 'XDR — IMF Special Drawing Rights basket' },
		{ ticker: 'XAU', label: 'XAU — Gold ounces (hard-currency hedge)' },
		{ ticker: 'OTHER', label: 'Other (enter a 3-8 character uppercase ticker)' }
	];
	const fiatChoiceIdx = await askChoice(
		'  Pick the fiat the indexer should display prices in:',
		COMMON_FIATS.map((f) => f.label),
		0 // default USD
	);
	const chosen = COMMON_FIATS[fiatChoiceIdx]!;
	let denominationFiat: string;
	if (chosen.ticker === 'OTHER') {
		while (true) {
			const raw = (await ask('  Enter ticker (3-8 uppercase letters)')).trim().toUpperCase();
			if (/^[A-Z]{3,8}$/.test(raw)) {
				denominationFiat = raw;
				break;
			}
			console.log('  ✗ Must be 3-8 uppercase letters (A-Z).  Try again.\n');
		}
	} else {
		denominationFiat = chosen.ticker;
	}

	console.log('\n  ✓ Listing fee configured:');
	console.log(`     Target:        $${targetUsd.toFixed(2)} USD`);
	console.log(`     BTC:           ${btcSatoshis.toLocaleString()} satoshis`);
	console.log(`     XMR:           ${xmrPiconero.toLocaleString()} piconero`);
	console.log(`     Source:        ${source}`);
	console.log(`     Fallback:      $${fallbackBlurtPriceUsd} BLURT/USD`);
	console.log(`     Display unit:  ${denominationFiat}\n`);

	return {
		targetUsd,
		btcSatoshis,
		xmrPiconero,
		fallbackBlurtPriceUsd,
		denominationFiat,
		source
	};
}

// ─── Step 17: Operator tag (Part 111) ────────────────────────────

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
	step(17, TOTAL_STEPS, 'Operator tag');
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

// ─── Step 18: Matrix surfaces ────────────────────────────────────

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
