/**
 * Morphit ops CLI — `init` subcommand orchestrator.
 *
 * The first-time setup wizard.  Walks the operator through:
 *   1. Pre-flight system check (CPU, RAM, disk, OS, network)
 *   2. 19 ELI5-style configuration prompts (instance name,
 *      tagline, database URL, relay account + posting key,
 *      fees account, daily ceiling, contact URL, origin,
 *      alt-networks, fee explorers, chat-link explorers,
 *      disabled assets, listing fee, SEO copy, backup config,
 *      operator tag, Matrix surfaces, Blurt RPC endpoint list
 *      — exact count drifts as we add operator-config
 *      surface; check steps.ts for the authoritative list)
 *   3. Review and confirmation
 *   4. Write morphit.config.env + keystore
 *   5. Print next-steps with backup hint
 *
 * Flags:
 *   --check-only   Run the system check and exit (no prompts)
 *   --out=PATH     Write to PATH instead of the repo root
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { runSystemCheck, renderSystemCheck } from '../init/systemCheck.ts';
import { sanitizeForTerm } from '../render/term.ts';
import {
	stepInstanceName,
	stepTagline,
	stepDatabase,
	stepRelayAccount,
	stepPostingKey,
	stepFeesAccount,
	stepDailyCeiling,
	stepContactUrl,
	stepOrigin,
	stepAltNetworks,
	stepFeeExplorers,
	stepChatLinkExplorers,
	stepDisabledAssets,
	stepListingFee,
	stepSeo,
	stepBackup,
	stepOperatorTag,
	stepMatrixSurfaces,
	stepRpcEndpoints
} from '../init/steps.ts';
import { writeWizardOutput, resolveOutputPath } from '../init/render.ts';
import type { WizardAnswers } from '../init/render.ts';
import { ask, askYesNo } from '../init/prompt.ts';

export interface InitCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

export async function runInit(ctx: InitCtx): Promise<number> {
	printGreeting();

	// ─── System check ────
	const checkResult = await runSystemCheck();
	renderSystemCheck(checkResult, ctx.colorEnabled);

	if (ctx.flags['check-only'] === 'true') {
		console.log('--check-only: exiting after system check.');
		return checkResult.hasErrors ? 1 : 0;
	}

	if (checkResult.hasErrors) {
		console.log(
			'Some checks failed.  You can continue anyway, but be aware\n' +
				'Morphit may be unstable on underspecced hardware.\n'
		);
		const proceed = await askYesNo('Continue with the setup anyway?', false);
		if (!proceed) {
			console.log('\nAborted.  Address the failures above and re-run.');
			return 1;
		}
	}

	// ─── Existing config detection ────
	const repoRoot = resolveOutputPath(ctx.flags.out, defaultRepoRoot());
	const existingConfig = `${repoRoot}/morphit.config.env`;
	if (existsSync(existingConfig)) {
		console.log(`\nA morphit.config.env already exists at ${existingConfig}.`);
		const overwrite = await askYesNo(
			'Overwrite it? (a backup of the existing file will be made)',
			false
		);
		if (!overwrite) {
			console.log('\nAborted.  Existing config left unchanged.');
			return 1;
		}
		// Backup with a timestamped suffix.
		const backupPath = `${existingConfig}.bak-${Date.now()}`;
		try {
			const fs = await import('node:fs');
			fs.copyFileSync(existingConfig, backupPath);
			console.log(`  ✓ Backed up existing config to ${backupPath}\n`);
		} catch (err) {
			console.log(
				`  ⚠ Could not back up existing config: ${sanitizeForTerm(err instanceof Error ? err.message : String(err))}\n`
			);
			const stillProceed = await askYesNo('Proceed anyway (existing config will be lost)?', false);
			if (!stillProceed) {
				console.log('\nAborted.');
				return 1;
			}
		}
	}

	// ─── Run the 19 steps ────
	const instanceName = await stepInstanceName();
	const tagline = await stepTagline();
	const databaseUrl = await stepDatabase();
	const relayAccount = await stepRelayAccount();
	const postingKey = await stepPostingKey(relayAccount.name);
	const feesAccount = await stepFeesAccount(relayAccount.name);
	const dailyCeiling = await stepDailyCeiling(relayAccount.account);
	const contactUrl = await stepContactUrl();
	const origin = await stepOrigin();
	const altNetworks = await stepAltNetworks();
	const feeExplorers = await stepFeeExplorers();
	const chatLinkExplorers = await stepChatLinkExplorers();
	const disabledAssets = await stepDisabledAssets();
	const listingFee = await stepListingFee();
	const seo = await stepSeo();
	const backup = await stepBackup();
	const operatorTag = await stepOperatorTag();
	const matrix = await stepMatrixSurfaces();
	// 19th step (F-2 from the cp136 walkthrough): RPC endpoints.
	// Defaults to DEFAULT_BLURT_RPC_ENDPOINTS — operators with a
	// witness preference or self-hosted RPC override here.  Pressing
	// Enter accepts the defaults; this is opt-in customization,
	// not mandatory configuration.
	const blurtRpcEndpoints = await stepRpcEndpoints(null);

	const answers: WizardAnswers = {
		instanceName,
		tagline,
		databaseUrl,
		blurtRpcEndpoints,
		relayAccount,
		postingKey,
		feesAccount,
		dailyCeiling,
		contactUrl,
		origin,
		altNetworks,
		listingFee,
		feeExplorers,
		chatLinkExplorers,
		disabledAssets,
		seo,
		backup,
		operatorTag,
		matrix
	};

	// ─── Review ────
	printReview(answers);
	const confirmed = await askYesNo('Write configuration?', true);
	if (!confirmed) {
		console.log('\nAborted.  No files written.');
		return 1;
	}

	// ─── Write ────
	let result;
	try {
		result = writeWizardOutput(answers, repoRoot);
	} catch (err) {
		// cp139-C-5: err.message could be filesystem error text
		// containing an attacker-influenced path component (e.g.
		// operator typed `--out=$'\x1b[2J'`).  Sanitize.
		console.log(
			`\n✗ Failed to write config: ${sanitizeForTerm(err instanceof Error ? err.message : String(err))}`
		);
		return 3;
	}

	console.log(`\n  ✓ wrote ${result.configBytes} bytes to ${sanitizeForTerm(result.configPath)}`);
	console.log(`  ✓ wrote ${result.envBytes} bytes to ${sanitizeForTerm(result.envPath)}`);
	console.log(`  ✓ wrote ${result.keystoreBytes} bytes to ${sanitizeForTerm(result.keystorePath)}`);
	if (result.backupEnvPath) {
		console.log(`  ✓ wrote ${result.backupEnvBytes} bytes to ${sanitizeForTerm(result.backupEnvPath)}`);
		console.log('  ✓ permissions set to 600 on all four (only you can read them)');
	} else {
		console.log('  ✓ permissions set to 600 on all three (only you can read them)');
	}

	printNextSteps(answers, result);

	return 0;
}

// ─── Helpers ─────────────────────────────────────────────────────

function printGreeting(): void {
	const rule = '━'.repeat(58);
	console.log('');
	console.log(rule);
	console.log('Morphit setup wizard');
	console.log(rule);
	console.log('');
	console.log(
		'Welcome.  This wizard will walk you through setting up your\n' +
			'Morphit instance — about 5-10 minutes of prompts.\n' +
			'\n' +
			"First we'll check your system, then we'll ask 9 questions to\n" +
			'configure your relay and instance identity.\n' +
			'\n' +
			'You can press Ctrl+C at any time to cancel without writing\n' +
			'anything to disk.\n'
	);
}

function printReview(answers: WizardAnswers): void {
	const rule = '━'.repeat(58);
	console.log('');
	console.log(rule);
	console.log('Review');
	console.log(rule);
	console.log('');
	console.log("Here's what we'll write to morphit.config.env:");
	console.log('');
	console.log(`  Instance name:        ${sanitizeForTerm(answers.instanceName)}`);
	console.log(`  Tagline:              ${sanitizeForTerm(answers.tagline)}`);
	console.log(`  Database URL:         ${sanitizeForTerm(maskDatabasePassword(answers.databaseUrl))}`);
	console.log(`  Relay account:        @${sanitizeForTerm(answers.relayAccount.name)}`);
	const keyDesc =
		answers.postingKey.mode === 'encrypted'
			? 'encrypted (passphrase prompted at startup)'
			: 'plaintext (consider switching to encrypted later)';
	console.log(`  Posting key:          ${keyDesc}`);
	console.log(`  Fees account:         @${sanitizeForTerm(answers.feesAccount)}`);
	console.log(`  Daily ceiling:        ${answers.dailyCeiling}`);
	console.log(`  Contact URL:          ${answers.contactUrl !== null ? sanitizeForTerm(answers.contactUrl) : '(skipped)'}`);
	console.log(`  Public origin:        ${answers.origin !== null ? sanitizeForTerm(answers.origin) : '(skipped — federation-invisible)'}`);
	console.log(`  Tor address:          ${answers.altNetworks.tor !== null ? sanitizeForTerm(answers.altNetworks.tor) : '(skipped)'}`);
	console.log(`  Lokinet address:      ${answers.altNetworks.lokinet !== null ? sanitizeForTerm(answers.altNetworks.lokinet) : '(skipped)'}`);
	console.log(`  I2P address:          ${answers.altNetworks.i2p !== null ? sanitizeForTerm(answers.altNetworks.i2p) : '(skipped)'}`);
	console.log(`  Nostr pubkey:         ${answers.altNetworks.nostr !== null ? sanitizeForTerm(answers.altNetworks.nostr) : '(skipped)'}`);
	console.log(
		`  BTC fee explorers:    ${answers.feeExplorers.btc.length} URL${answers.feeExplorers.btc.length === 1 ? '' : 's'}`
	);
	console.log(
		`  XMR fee explorers:    ${answers.feeExplorers.xmr.length} URL${answers.feeExplorers.xmr.length === 1 ? '' : 's'}`
	);
	console.log(`  BTC chat-link URL:    ${answers.chatLinkExplorers.btc}`);
	console.log(`  XMR chat-link URL:    ${answers.chatLinkExplorers.xmr}`);
	console.log(`  BCH chat-link URL:    ${answers.chatLinkExplorers.bch}`);
	console.log(`  LTC chat-link URL:    ${answers.chatLinkExplorers.ltc}`);
	console.log(`  DASH chat-link URL:   ${answers.chatLinkExplorers.dash}`);
	console.log(`  DOGE chat-link URL:   ${answers.chatLinkExplorers.doge}`);
	console.log(`  ZEC chat-link URL:    ${answers.chatLinkExplorers.zec}`);
	console.log(`  ARRR chat-link URL:   ${answers.chatLinkExplorers.arrr}`);
	console.log(`  DCR chat-link URL:    ${answers.chatLinkExplorers.dcr}`);
	console.log(`  SOL chat-link URL:    ${answers.chatLinkExplorers.sol}`);
	console.log(`  ETH chat-link URL:    ${answers.chatLinkExplorers.eth}`);
	console.log(`  XRP chat-link URL:    ${answers.chatLinkExplorers.xrp}`);
	// Part 122 cp30-DD — multi-network chat-link URLs.  Each
	// asset spans 4 chains; summarize as "all defaults" if every
	// URL matches its bundled default, otherwise "customized".
	const usdtAllDefault =
		answers.chatLinkExplorers.usdt.erc20 === 'https://etherscan.io/tx/{txid}' &&
		answers.chatLinkExplorers.usdt.trc20 === 'https://tronscan.org/#/transaction/{txid}' &&
		answers.chatLinkExplorers.usdt.spl === 'https://solscan.io/tx/{txid}' &&
		answers.chatLinkExplorers.usdt.bep20 === 'https://bscscan.com/tx/{txid}';
	const usdcAllDefault =
		answers.chatLinkExplorers.usdc.erc20 === 'https://etherscan.io/tx/{txid}' &&
		answers.chatLinkExplorers.usdc.spl === 'https://solscan.io/tx/{txid}' &&
		answers.chatLinkExplorers.usdc.base === 'https://basescan.org/tx/{txid}' &&
		answers.chatLinkExplorers.usdc.polygon === 'https://polygonscan.com/tx/{txid}';
	// Part 122 cp31 — DAI per-network defaults.  All 4 EVM
	// networks (no SPL); arbiscan is the new explorer name.
	const daiAllDefault =
		answers.chatLinkExplorers.dai.erc20 === 'https://etherscan.io/tx/{txid}' &&
		answers.chatLinkExplorers.dai.polygon === 'https://polygonscan.com/tx/{txid}' &&
		answers.chatLinkExplorers.dai.base === 'https://basescan.org/tx/{txid}' &&
		answers.chatLinkExplorers.dai.arbitrum === 'https://arbiscan.io/tx/{txid}';
	console.log(
		`  USDT chat-link URLs:  ${usdtAllDefault ? 'all 4 defaults (ERC-20/TRC-20/SPL/BEP-20)' : 'customized — see env file'}`
	);
	console.log(
		`  USDC chat-link URLs:  ${usdcAllDefault ? 'all 4 defaults (ERC-20/SPL/Base/Polygon)' : 'customized — see env file'}`
	);
	console.log(
		`  DAI chat-link URLs:   ${daiAllDefault ? 'all 4 defaults (ERC-20/Polygon/Base/Arbitrum)' : 'customized — see env file'}`
	);
	if (answers.disabledAssets.disabledTickers.length === 0) {
		console.log(`  Trade-only assets:    all enabled (default)`);
	} else {
		console.log(
			`  Trade-only assets:    DISABLED: ${answers.disabledAssets.disabledTickers.join(', ')}`
		);
	}
	console.log(
		`  Listing fee target:   $${answers.listingFee.targetUsd.toFixed(2)} ` +
			`(${answers.listingFee.source}) → ${answers.listingFee.btcSatoshis} sats / ` +
			`${answers.listingFee.xmrPiconero} piconero`
	);
	console.log(
		`  Fallback BLURT/USD:   $${answers.listingFee.fallbackBlurtPriceUsd}`
	);
	console.log(`  Operator tag:         ${sanitizeForTerm(answers.operatorTag.tag)}`);
	const seoOverridden =
		answers.seo.title !== null || answers.seo.description !== null || answers.seo.keywords !== null;
	console.log(`  SEO override:         ${seoOverridden ? 'yes' : '(using i18n defaults)'}`);
	if (answers.backup.enabled) {
		console.log(
			`  Daily DB backup:      enabled → ${answers.backup.backupDir !== null ? sanitizeForTerm(answers.backup.backupDir) : '(default)'}, ${answers.backup.retainDays}-day retention`
		);
	} else {
		console.log('  Daily DB backup:      disabled');
	}
	console.log('');
}

function maskDatabasePassword(url: string): string {
	try {
		const u = new URL(url);
		if (u.password) u.password = '***';
		return u.toString();
	} catch {
		return url;
	}
}

function printNextSteps(
	answers: WizardAnswers,
	result: {
		configPath: string;
		envPath: string;
		keystorePath: string;
		backupEnvPath: string | null;
	}
): void {
	const rule = '━'.repeat(58);
	console.log('');
	console.log(rule);
	console.log('Next steps');
	console.log(rule);
	console.log('');
	console.log("You're ready to bring up your instance.  In order:");
	console.log('');
	console.log('  1. Install dependencies:');
	console.log('       npm install');
	console.log('');
	console.log('  2. Source the critical-infra env file (sets database URL,');
	console.log('     account names, posting key path):');
	console.log(`       set -a; . ${result.envPath}; set +a`);
	console.log('     (or configure systemd to do it via EnvironmentFile= — see');
	console.log('     docs/OPERATOR-RUN-BOOK.md)');
	console.log('');
	console.log('  3. Run database migrations:');
	console.log('       npm run migrate -w apps/indexer');
	console.log('');
	console.log('  4. Start the indexer (foreground for first run):');
	console.log('       npm start -w apps/indexer');
	console.log('');
	console.log('  5. In another terminal (also source morphit.env), start the relay:');
	console.log('       npm start -w apps/relay');
	if (answers.postingKey.mode === 'encrypted') {
		console.log("       (it'll prompt for your unlock passphrase)");
	}
	console.log('');
	console.log('  6. In another terminal, build and serve the frontend:');
	console.log('       npm run build -w apps/web');
	console.log('       npm run preview -w apps/web');
	console.log('');
	console.log('  7. Verify everything is healthy:');
	console.log('       npx tsx apps/ops-cli/src/main.ts status');
	console.log('');

	let stepNum = 8;
	if (answers.origin !== null) {
		console.log(`  ${stepNum}. Once your indexer + frontend are reachable at your public origin,`);
		console.log('     publish your operator registration on-chain:');
		console.log('       npx tsx apps/ops-cli/src/main.ts register');
		console.log('     This makes your instance discoverable by every other Morphit');
		console.log("     instance's /instances directory.");
		console.log('');
		stepNum++;
	}

	// ─── Backup enable instructions ─────────────────────────────
	if (answers.backup.enabled && result.backupEnvPath) {
		console.log(`  ${stepNum}. Enable the daily DB backup timer (runs as root once;`);
		console.log('     installs script + config + systemd units, then enables');
		console.log('     the timer):');
		console.log(
			`       sudo install -m 600 -o root -g root ${result.backupEnvPath} /etc/morphit/backup.env`
		);
		console.log('       sudo install -d -m 755 /usr/local/lib/morphit');
		console.log('       sudo install -m 755 ops/backup/morphit-backup.sh /usr/local/lib/morphit/');
		console.log(
			'       sudo install -m 644 ops/systemd/morphit-backup.service /etc/systemd/system/'
		);
		console.log('       sudo install -m 644 ops/systemd/morphit-backup.timer /etc/systemd/system/');
		console.log('       sudo systemctl daemon-reload');
		console.log('       sudo systemctl enable --now morphit-backup.timer');
		console.log('');
		console.log('     The script gets installed to /usr/local/lib/morphit/ so the');
		console.log('     systemd unit works regardless of where you checked out this');
		console.log('     repo.  When you `git pull` and the script changes, re-run');
		console.log('     just the third command above to update the installed copy.');
		console.log('');
		console.log('     Verify the next scheduled run with:');
		console.log('       systemctl list-timers morphit-backup.timer');
		console.log('');

		// Heads-up if the operator picked a non-default backup
		// dir.  The shipped systemd unit has
		// `ReadWritePaths=/home/morphit/backups`; a different
		// dir means systemd will block the script from creating
		// it.  Tell the operator how to override without
		// editing the shipped unit.
		if (answers.backup.backupDir !== null && answers.backup.backupDir !== '/home/morphit/backups') {
			console.log(`     ⚠  You picked a non-default backup directory`);
			console.log(`        (${sanitizeForTerm(answers.backup.backupDir)}).  The shipped systemd unit`);
			console.log(`        is wired to /home/morphit/backups; you need to add an`);
			console.log(`        override so the dump isn't blocked by ProtectSystem:`);
			console.log('');
			console.log('          sudo systemctl edit morphit-backup.service');
			console.log('');
			console.log('        Then paste these two lines and save:');
			console.log('');
			console.log('          [Service]');
			console.log(`          ReadWritePaths=${sanitizeForTerm(answers.backup.backupDir)}`);
			console.log('');
		}
		stepNum++;
	}

	console.log(
		'For systemd unit files and reverse-proxy configs, see\n' + 'docs/OPERATOR-RUN-BOOK.md.'
	);
	console.log('');

	// Backup hint.
	console.log('━'.repeat(58));
	console.log('Backup');
	console.log('━'.repeat(58));
	console.log('');
	console.log(`Your posting key is now stored at:`);
	console.log(`  ${sanitizeForTerm(result.keystorePath)}`);
	console.log('');
	if (answers.postingKey.mode === 'encrypted') {
		console.log(
			'Back up this file along with your unlock passphrase.\n' +
				'Without BOTH, you cannot restart your relay.'
		);
	} else {
		console.log(
			'Back up this file securely.  It is your raw posting key —\n' +
				'anyone with read access can post on behalf of your account.\n' +
				"Don't email it, don't put it in a public git repo, don't\n" +
				'paste it into a chat.  A USB stick stored offline is good.'
		);
	}
	console.log('');
	if (answers.backup.enabled) {
		console.log(
			'Note: the backup automation you just configured covers the\n' +
				'database, NOT the posting key.  Back up the keystore\n' +
				'separately as described above.'
		);
		console.log('');
	}

	// ─── Optional hardening pointer ─────────────────────────────
	console.log('━'.repeat(58));
	console.log('Optional next layer — recommended hardening');
	console.log('━'.repeat(58));
	console.log('');
	console.log('Your instance is secure as-is for typical traffic.  If');
	console.log('you want extra layers (none required, all optional)');
	console.log('see docs/RUN-A-MORPHIT-NODE.md §10c, which covers:');
	console.log('');
	console.log('  • BunkerWeb — open-source WAF in front of (or instead of)');
	console.log('    Caddy, with OWASP Top-10 + bot detection + DDoS rules');
	console.log('    pre-configured.');
	console.log('  • Docker — running indexer/relay/web/Postgres in containers');
	console.log('    if your fleet is already containerized.');
	console.log('  • Stronger UFW + fail2ban — SSH rate-limiting, a Morphit-');
	console.log('    relay-specific filter that bans repeat 429s on signup.');
	console.log('  • TLS auto-renewal — quarterly verification + how to');
	console.log('    troubleshoot when auto-renewal silently breaks.');
	console.log('');
	console.log('All four are cross-referenced from docs/OPERATIONS.md');
	console.log('§32-35 with full install commands and Morphit-specific tuning.');
	console.log('');

	console.log('Have fun.');
	console.log('');
}

/** Find the repo root.  We assume cwd is somewhere in the repo
 *  and walk up looking for the package.json with name="morphit".
 *  Falls back to cwd. */
function defaultRepoRoot(): string {
	let dir = process.cwd();
	for (let i = 0; i < 8; i++) {
		const pkg = `${dir}/package.json`;
		if (existsSync(pkg)) {
			try {
				// We don't need to parse — the existence of any package.json
				// climbing up is good enough; the topmost one is the repo
				// root.  Continue climbing in case we're in a sub-package.
				const parent = resolve(dir, '..');
				if (parent === dir) break;
				const parentPkg = `${parent}/package.json`;
				if (!existsSync(parentPkg)) {
					return dir;
				}
				dir = parent;
				continue;
			} catch {
				return dir;
			}
		}
		const parent = resolve(dir, '..');
		if (parent === dir) break;
		dir = parent;
	}
	return process.cwd();
}
