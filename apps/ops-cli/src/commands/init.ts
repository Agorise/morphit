/**
 * Morphit ops CLI — `init` subcommand orchestrator.
 *
 * The first-time setup wizard.  Walks the operator through:
 *   1. Pre-flight system check (CPU, RAM, disk, OS, network)
 *   2. 23 ELI5-style configuration prompts (instance name,
 *      tagline, database URL, relay account + active key,
 *      fees account, daily ceiling, contact URL, origin,
 *      alt-networks, fee explorers, chat-link explorers,
 *      disabled assets, listing fee, SEO copy, backup config,
 *      operator tag, Matrix surfaces, Blurt RPC endpoints,
 *      MCP server, BunkerWeb WAF, hardening checklist — exact
 *      count drifts as we add operator-config surface;
 *      check steps.ts for the authoritative list)
 *   3. Review and confirmation
 *   4. Write morphit.config.env + keystore
 *   5. Print next-steps with backup hint
 *
 * Flags:
 *   --check-only   Run the system check and exit (no prompts)
 *   --out=PATH     Write to PATH instead of the repo root
 */

import { resolve } from 'node:path';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { existsSync, readFileSync } from 'node:fs';
import { runSystemCheck, renderSystemCheck } from '../init/systemCheck.ts';
import { generateOnionV3, type OnionV3 } from '../init/torOnion.ts';
import {
	generateI2pDestination,
	i2pdAvailable,
	type I2pDestinationResult
} from '../init/i2pGenerate.ts';
import { startDotsSpinner } from '../init/spinner.ts';
import { validateAltAddress } from '../lib/altAddressValidate.ts';
import { sanitizeForTerm } from '../render/term.ts';
import {
	stepInstanceName,
	stepTagline,
	stepDatabase,
	stepRelayAccount,
	stepActiveKey,
	stepFeesAccount,
	stepDailyCeiling,
	stepContactUrl,
	stepOrigin,
	stepAltNetworks,
	stepFeeExplorers,
	stepChatLinkExplorers,
	stepDisabledAssets,
	stepDisabledPaymentMethods,
	stepListingFee,
	stepSeo,
	stepBackup,
	stepOperatorTag,
	stepMatrixSurfaces,
	stepRpcEndpoints,
	stepMcpServer,
	stepBunkerWeb,
	stepHardening,
	TOTAL_STEPS
} from '../init/steps.ts';
import { writeWizardOutput, resolveOutputPath } from '../init/render.ts';
import type { WizardAnswers } from '../init/render.ts';
import {
	type WizardProgress,
	loadProgress,
	loadProgressSavedAt,
	saveProgress,
	clearProgress,
	describeAge
} from '../init/progress.ts';
import { ask, askYesNo, askChoice } from '../init/prompt.ts';
import { runEdit } from './edit.ts';

export interface InitCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

/** Resolve an EXISTING Tor onion address the operator already set, so we
 *  never overwrite a manual one: first the env var (the "value in that env
 *  variable" case), then a manual line in an existing config (the overwrite
 *  path).  Returns the validated address, or null → the wizard generates a
 *  fresh basic onion. */
function resolveExistingTorAddress(existingConfigPath: string): string | null {
	const envVal = (process.env.MORPHIT_INSTANCE_TOR_ADDRESS ?? '').trim();
	if (envVal) {
		const v = validateAltAddress('tor', envVal);
		if (v.ok) return v.value;
	}
	try {
		if (existsSync(existingConfigPath)) {
			const txt = readFileSync(existingConfigPath, 'utf8');
			const m = txt.match(/^\s*MORPHIT_INSTANCE_TOR_ADDRESS\s*=\s*"?([^"\n#]+?)"?\s*$/m);
			const cap = m?.[1];
			if (cap) {
				const v = validateAltAddress('tor', cap.trim());
				if (v.ok) return v.value;
			}
		}
	} catch {
		/* unreadable → treat as none */
	}
	return null;
}

/** Resolve an EXISTING I2P b32 address the operator already set, so we never
 *  overwrite / regenerate over an operable one (Ken's rule: a saved, operable
 *  b32 is preserved).  First the env var, then a manual line in an existing
 *  config.  Returns the validated address, or null → the wizard generates a
 *  fresh basic destination (default-on). */
function resolveExistingI2pAddress(existingConfigPath: string): string | null {
	const envVal = (process.env.MORPHIT_INSTANCE_I2P_B32_ADDRESS ?? '').trim();
	if (envVal) {
		const v = validateAltAddress('i2p', envVal);
		if (v.ok) return v.value;
	}
	try {
		if (existsSync(existingConfigPath)) {
			const txt = readFileSync(existingConfigPath, 'utf8');
			const m = txt.match(/^\s*MORPHIT_INSTANCE_I2P_B32_ADDRESS\s*=\s*"?([^"\n#]+?)"?\s*$/m);
			const cap = m?.[1];
			if (cap) {
				const v = validateAltAddress('i2p', cap.trim());
				if (v.ok) return v.value;
			}
		}
	} catch {
		/* unreadable → treat as none */
	}
	return null;
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
		// cp186 — re-running the full setup wizard on a configured
		// instance is almost never what the operator wants: it walks
		// all ~23 steps and overwrites the whole config.  The common
		// real intent ("I just want to change my RPC URLs / description
		// / origin") is served by `morphit-ops edit`, which re-prompts
		// only the safe post-launch sections and preserves everything
		// else.  So instead of a bare overwrite y/N, recognize this as
		// an already-configured instance, steer toward `edit`, and let
		// the operator launch it without leaving this screen.
		console.log('');
		console.log('━'.repeat(58));
		console.log('  This instance is already set up');
		console.log('━'.repeat(58));
		console.log('');
		console.log(`  A configuration already exists at:`);
		console.log(`    ${existingConfig}`);
		console.log('');
		console.log('  Re-running the full setup wizard walks all the setup');
		console.log('  questions again and OVERWRITES this config.  Most of the');
		console.log('  time you only want to change a few things — for that, use');
		console.log('  "Edit", which changes just the section you pick (RPC URLs,');
		console.log('  description/SEO, origin, fees, …) and leaves the rest alone.');
		console.log('');
		const choice = await askChoice('What would you like to do?', [
			'Edit a few settings (recommended) — opens the edit menu now',
			'Overwrite EVERYTHING — re-run the full setup wizard from scratch',
			'Cancel — leave everything as it is'
		]);

		if (choice === 0) {
			// Hand off to the edit flow in-process; its exit code
			// becomes ours.  No second command to look up or type.
			return await runEdit({
				flags: ctx.flags,
				positional: ctx.positional,
				colorEnabled: ctx.colorEnabled
			});
		}
		if (choice === 2) {
			console.log('\nCancelled.  Existing config left unchanged.');
			return 0;
		}

		// choice === 1 — overwrite.  Confirm once more (this is the
		// destructive path), then back up before proceeding.
		console.log('');
		const reallyOverwrite = await askYesNo(
			'Are you sure? This replaces your entire instance config (a backup will be made first)',
			false
		);
		if (!reallyOverwrite) {
			console.log('\nAborted.  Existing config left unchanged.');
			return 0;
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

	// ─── Resume? (save-as-you-go) ────────────────────────────────────
	// The wizard remembers your NON-SECRET answers as you go (see
	// init/progress.ts).  If a previous run was interrupted, offer to
	// pick up where you left off — reusing those answers and re-asking
	// only the two things never written to disk: the database connection
	// and the relay's active key.
	const saved = loadProgress();
	let progress: WizardProgress = {};
	let resuming = false;
	if (saved && Object.keys(saved).length > 0) {
		console.log('');
		console.log('━'.repeat(58));
		console.log('  Found a setup already in progress');
		console.log('━'.repeat(58));
		console.log('');
		console.log(`  It looks like you started setting up before (${describeAge(loadProgressSavedAt())}).`);
		if (saved.instanceName) console.log(`    Instance:      ${sanitizeForTerm(saved.instanceName)}`);
		if (saved.relayAccount?.name) console.log(`    Relay account: @${sanitizeForTerm(saved.relayAccount.name)}`);
		console.log('');
		console.log('  I can pick up where you left off — your answers are remembered,');
		console.log('  and you only re-enter the two things that are NEVER saved to disk:');
		console.log('  the database connection and your relay account\u2019s active key.');
		console.log('');
		const resume = await askYesNo('Resume from your saved answers?', true);
		if (resume) {
			resuming = true;
			progress = { ...saved };
			console.log('\n  \u2713 Resuming. I\u2019ll reuse your saved answers below.\n');
		} else {
			clearProgress();
			console.log('\n  Starting fresh.\n');
		}
	}

	// Friendly labels for the "reusing your saved …" lines on resume.
	const SAVED_LABELS: Partial<Record<keyof WizardProgress, string>> = {
		instanceName: 'instance name',
		tagline: 'tagline',
		relayAccount: 'relay account',
		feesAccount: 'fees account',
		dailyCeiling: 'daily signup ceiling',
		contactUrl: 'contact URL',
		origin: 'public address (origin)',
		altNetworks: 'alt-network settings',
		feeExplorers: 'fee block-explorer choices',
		chatLinkExplorers: 'block-explorer choices',
		disabledAssets: 'asset choices',
		disabledPaymentMethods: 'payment-method choices',
		listingFee: 'listing-fee settings',
		seo: 'description / SEO',
		backup: 'backup settings',
		operatorTag: 'operator tag',
		matrix: 'Matrix alert settings',
		blurtRpcEndpoints: 'Blurt RPC endpoints',
		mcpServer: 'MCP server choice',
		bunkerWeb: 'BunkerWeb choice',
		hardening: 'hardening checklist choice'
	};
	function usedSaved(key: keyof WizardProgress): void {
		console.log(`  \u2713 Using your saved ${SAVED_LABELS[key] ?? String(key)} from last time.`);
	}

	// `recall` wraps a NON-SECRET step: on resume it returns the saved
	// answer (skipping the prompt); otherwise it runs the step and then
	// persists progress.  The two SECRET steps (database, active key) are
	// called directly below — always asked, never saved.
	async function recall<K extends keyof WizardProgress>(
		key: K,
		run: () => Promise<Exclude<WizardProgress[K], undefined>>
	): Promise<Exclude<WizardProgress[K], undefined>> {
		if (resuming && progress[key] !== undefined) {
			usedSaved(key);
			return progress[key] as Exclude<WizardProgress[K], undefined>;
		}
		const result = await run();
		Object.assign(progress, { [key]: result });
		saveProgress(progress);
		return result;
	}

	// On resume, a one-line reminder before each re-asked secret so the
	// operator understands why it isn't pre-filled.
	function secretResumeNote(what: string): void {
		if (resuming) {
			console.log(`\n  \u2139 Re-enter your ${what} (secrets are never saved to disk).`);
		}
	}

	// Tor onion: every instance gets a basic .onion by default (privacy is
	// the first priority).  If the operator already set one (env var or an
	// existing config) we keep it; otherwise generate one in the BACKGROUND
	// now so they never wait at the end.  Basic, non-vanity — instant.
	const existingTorAddress = resolveExistingTorAddress(existingConfig);
	const onionPromise: Promise<OnionV3> | null = existingTorAddress
		? null
		: Promise.resolve().then(() => generateOnionV3());

	// ─── Run the configuration steps (see TOTAL_STEPS in steps.ts) ────
	const instanceName = await recall('instanceName', () => stepInstanceName());
	const tagline = await recall('tagline', () => stepTagline());
	secretResumeNote('database connection');
	const databaseUrl = await stepDatabase(); // SECRET — always asked, never saved
	const relayAccount = await recall('relayAccount', () => stepRelayAccount());
	secretResumeNote("relay account\u2019s active key");
	const activeKey = await stepActiveKey(relayAccount.name); // SECRET — always asked, never saved
	const feesAccount = await recall('feesAccount', () => stepFeesAccount(relayAccount.name));
	const dailyCeiling = await recall('dailyCeiling', () => stepDailyCeiling(relayAccount.account));
	const contactUrl = await recall('contactUrl', () => stepContactUrl());
	const origin = await recall('origin', () => stepOrigin());
	const altNetworks = await recall('altNetworks', () => stepAltNetworks());
	const feeExplorers = await recall('feeExplorers', () => stepFeeExplorers());
	const chatLinkExplorers = await recall('chatLinkExplorers', () => stepChatLinkExplorers());
	const disabledAssets = await recall('disabledAssets', () => stepDisabledAssets());
	const disabledPaymentMethods = await recall('disabledPaymentMethods', () =>
		stepDisabledPaymentMethods()
	);
	const listingFee = await recall('listingFee', () => stepListingFee());
	const seo = await recall('seo', () => stepSeo());
	const backup = await recall('backup', () => stepBackup(databaseUrl));
	const operatorTag = await recall('operatorTag', () => stepOperatorTag(origin));
	const matrix = await recall('matrix', () => stepMatrixSurfaces());
	// 19th step (F-2 from the cp136 walkthrough): RPC endpoints.
	// Defaults to DEFAULT_BLURT_RPC_ENDPOINTS — operators with a
	// witness preference or self-hosted RPC override here.  Pressing
	// Enter accepts the defaults; this is opt-in customization,
	// not mandatory configuration.
	const blurtRpcEndpoints = await recall('blurtRpcEndpoints', () => stepRpcEndpoints(null));

	// Step 20 — opt-out for MCP installation (Model Context Protocol).
	// Default-on so AI agents (Claude Desktop, Cursor, etc.) can
	// discover the operator's instance and surface it in user queries.
	const mcpServer = await recall('mcpServer', () => stepMcpServer());

	// Step 21 — BunkerWeb WAF / reverse-proxy decision.  Drives
	// MORPHIT_RELAY_TRUSTED_PROXY_IPS (set only when opted in).
	const bunkerWeb = await recall('bunkerWeb', () => stepBunkerWeb());

	// Step 22 — host hardening checklist.  Tailored to the BunkerWeb
	// choice; optionally writes a personalized morphit-hardening-checklist.md.
	const hardening = await recall('hardening', () => stepHardening(bunkerWeb.enabled));

	// Resolve the Tor onion: an existing manual address, or our background-
	// generated one.  The address rides in altNetworks.tor (→ the env var,
	// pill + Onion-Location); the HS key files ride in torOnion and are
	// written by writeWizardOutput on the success path only (an aborted
	// wizard leaves no orphan keys).
	let torOnion: OnionV3 | null = null;
	let torAddress: string | null = existingTorAddress;
	if (!existingTorAddress && onionPromise) {
		torOnion = await onionPromise;
		torAddress = torOnion.address;
	}
	const altNetworksWithTor = { ...altNetworks, tor: torAddress };

	// Resolve the I2P b32 (default-on, like the onion): a value the operator
	// typed in the alt-network step wins; else an existing operable address is
	// PRESERVED (never regenerated over); else — for a fresh instance — we
	// generate a basic destination via i2pd if it's installed.  The address
	// rides in altNetworks.i2pB32 (→ env var + footer pill); the keyfile +
	// tunnel stanza ride in i2pDestination and are written on the success path
	// only.  Generation failure is never fatal.
	let i2pDestination: I2pDestinationResult | null = null;
	let i2pB32 = altNetworksWithTor.i2pB32;
	if (i2pB32 === null) {
		const existingI2p = resolveExistingI2pAddress(existingConfig);
		if (existingI2p) {
			i2pB32 = existingI2p;
		} else if (i2pdAvailable()) {
			console.log('');
			const stopSpinner = startDotsSpinner(
				'Stand by, generating alt-dns addresses (this might take a few minutes)\u2026'
			);
			try {
				i2pDestination = await generateI2pDestination();
				stopSpinner();
				i2pB32 = i2pDestination.b32;
			} catch (e) {
				stopSpinner();
				console.log(
					`  \u2139 Could not auto-generate an I2P address (${
						e instanceof Error ? e.message : 'unknown error'
					}); skipping \u2014 you can add one later from the main menu.`
				);
			}
		}
		// else: i2pd not installed → leave I2P unset for now.
	}
	const altNetworksFinal = { ...altNetworksWithTor, i2pB32 };

	const answers: WizardAnswers = {
		instanceName,
		tagline,
		databaseUrl,
		blurtRpcEndpoints,
		relayAccount,
		activeKey,
		feesAccount,
		dailyCeiling,
		contactUrl,
		origin,
		altNetworks: altNetworksFinal,
		listingFee,
		feeExplorers,
		chatLinkExplorers,
		disabledAssets,
		disabledPaymentMethods,
		seo,
		backup,
		operatorTag,
		matrix,
		mcpServer,
		bunkerWeb,
		hardening,
		torOnion,
		i2pDestination
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
	if (result.hardeningChecklistPath) {
		console.log(
			`  ✓ wrote ${result.hardeningChecklistBytes} bytes to ${sanitizeForTerm(result.hardeningChecklistPath)} (0644 — readable runbook, no secrets)`
		);
	}

	// Setup completed — remove the save-as-you-go resume file so a future
	// `init` starts clean rather than offering to resume a done setup.
	clearProgress();

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
			`First we'll check your system, then we'll walk through about\n` +
			`${TOTAL_STEPS} short questions to configure your relay, instance identity,\n` +
			'and optional services (Matrix alerts, MCP, BunkerWeb).\n' +
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
	console.log(
		`  Tagline:              ${answers.tagline === '' ? '(none)' : sanitizeForTerm(answers.tagline)}`
	);
	console.log(`  Database URL:         ${sanitizeForTerm(maskDatabasePassword(answers.databaseUrl))}`);
	console.log(`  Relay account:        @${sanitizeForTerm(answers.relayAccount.name)}`);
	const keyDesc =
		answers.activeKey.mode === 'encrypted'
			? 'encrypted (passphrase prompted at startup)'
			: 'plaintext (consider switching to encrypted later)';
	console.log(`  Active key:           ${keyDesc}`);
	console.log(`  Fees account:         @${sanitizeForTerm(answers.feesAccount)}`);
	console.log(`  Daily ceiling:        ${answers.dailyCeiling}`);
	console.log(`  Contact URL:          ${answers.contactUrl !== null ? sanitizeForTerm(answers.contactUrl) : '(skipped)'}`);
	console.log(`  Public origin:        ${answers.origin !== null ? sanitizeForTerm(answers.origin) : '(skipped — federation-invisible)'}`);
	console.log(`  Tor address:          ${answers.altNetworks.tor !== null ? sanitizeForTerm(answers.altNetworks.tor) : '(skipped)'}`);
	console.log(`  Lokinet address:      ${answers.altNetworks.lokinet !== null ? sanitizeForTerm(answers.altNetworks.lokinet) : '(skipped)'}`);
	console.log(`  I2P b32:              ${answers.altNetworks.i2pB32 !== null ? sanitizeForTerm(answers.altNetworks.i2pB32) : '(skipped)'}`);
	console.log(`  I2P vanity name:      ${answers.altNetworks.i2pName !== null ? sanitizeForTerm(answers.altNetworks.i2pName) : '(skipped)'}`);
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
		hardeningChecklistPath: string | null;
		torHsDir: string | null;
		torHsAddress: string | null;
		i2pTunnelDir: string | null;
		i2pB32Address: string | null;
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
	console.log('     account names, active key path):');
	console.log(`       set -a; . ${result.envPath}; set +a`);
	console.log('     (or configure systemd to do it via EnvironmentFile= — see');
	console.log('     docs/OPERATIONS.md)');
	console.log('');
	console.log('  3. Run database migrations:');
	console.log('       npm run migrate -w apps/indexer');
	console.log('');
	console.log('  4. Start the indexer (foreground for first run):');
	console.log('       npm start -w apps/indexer');
	console.log('');
	console.log('  5. In another terminal (also source morphit.env), start the relay:');
	console.log('       npm start -w apps/relay');
	if (answers.activeKey.mode === 'encrypted') {
		console.log("       (it'll prompt for your unlock passphrase)");
	}
	console.log('');
	console.log('  6. Build the frontend (it compiles to static files — there is no');
	console.log('     separate web service; your web server serves the build output):');
	console.log('       npm run build -w apps/web');
	console.log('     Then point nginx (or Caddy / BunkerWeb) at apps/web/build and');
	console.log('     reverse-proxy /v1/* to the relay + indexer.  Ready-to-use');
	console.log('     server configs ship in ops/nginx/ and ops/bunkerweb/; see');
	console.log('     docs/RUN-A-MORPHIT-NODE.md §6.');
	console.log('');
	console.log('  7. Verify everything is healthy:');
	console.log('       morphit-ops status');
	console.log('');

	let stepNum = 8;
	if (answers.origin !== null) {
		console.log(`  ${stepNum}. Once your indexer + frontend are reachable at your public origin,`);
		console.log('     publish your operator registration on-chain:');
		console.log('       morphit-ops register');
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
		'For systemd unit files and reverse-proxy configs, see\n' +
			'docs/RUN-A-MORPHIT-NODE.md §6 (web server) and docs/OPERATIONS.md.'
	);
	console.log('');

	// Backup hint.
	console.log('━'.repeat(58));
	console.log('Backup');
	console.log('━'.repeat(58));
	console.log('');
	console.log(`Your active key is now stored at:`);
	console.log(`  ${sanitizeForTerm(result.keystorePath)}`);
	console.log('');
	if (answers.activeKey.mode === 'encrypted') {
		console.log(
			'Back up this file along with your unlock passphrase.\n' +
				'Without BOTH, you cannot restart your relay.'
		);
	} else {
		console.log(
			'Back up this file securely.  It is your raw active key —\n' +
				'anyone with read access can spend BLURT and create accounts\n' +
				"on behalf of your relay account.  Don't email it, don't put\n" +
				'it in a public git repo, don\'t paste it into a chat.  A USB\n' +
				'stick stored offline is good.'
		);
	}
	console.log('');
	if (answers.backup.enabled) {
		console.log(
			'Note: the backup automation you just configured covers the\n' +
				'database, NOT the active key.  Back up the keystore\n' +
				'separately as described above.'
		);
		console.log('');
	}

	// ─── Hardening ──────────────────────────────────────────────
	console.log('━'.repeat(58));
	console.log('Server hardening — do this before going public');
	console.log('━'.repeat(58));
	console.log('');
	if (result.hardeningChecklistPath) {
		console.log('A personalized hardening checklist was written to:');
		console.log(`  ${sanitizeForTerm(result.hardeningChecklistPath)}`);
		console.log('');
		console.log('Work through it before you expose this instance.  It sequences');
		console.log('SSH lockdown (with lockout-safety), UFW + fail2ban, automatic');
		console.log('security updates, TLS, and your web edge —');
		console.log(
			answers.bunkerWeb.enabled
				? '    BunkerWeb in your case —'
				: '    nginx (ops/nginx/) in your case —'
		);
		console.log('with the exact commands and your domain already filled in.');
	} else {
		console.log('You skipped the generated checklist.  Harden the host before');
		console.log('going public: SSH key-only login, UFW + fail2ban, unattended-');
		console.log('upgrades, and TLS.  See docs/OPERATIONS.md §34 (UFW + fail2ban),');
		console.log('§35 (TLS), and §37 (the full hardening reference).');
	}
	console.log('');
	console.log('Fastest fully-automated path either way: the Ansible playbook at');
	console.log('ops/ansible/ applies all of the above idempotently (set the');
	console.log('enable_* flags in ops/ansible/group_vars/all.yml).  Overview in');
	console.log('docs/RUN-A-MORPHIT-NODE.md §11.');
	console.log('');

	// ─── Tor onion ──────────────────────────────────────────────
	if (result.torHsDir && result.torHsAddress) {
		console.log('━'.repeat(58));
		console.log('Your Tor onion address (generated for you)');
		console.log('━'.repeat(58));
		console.log('');
		console.log(`  ${sanitizeForTerm(result.torHsAddress)}`);
		console.log('');
		console.log('Your site already advertises this (footer pill + Onion-Location');
		console.log('auto-redirect for Tor Browser).  To actually SERVE it, install the');
		console.log('generated key directory as Tor\u2019s HiddenServiceDir:');
		console.log(`  ${sanitizeForTerm(result.torHsDir)}/`);
		console.log('  → copy it to e.g. /var/lib/tor/morphit/ (owned by the tor user,');
		console.log('    mode 0700), then in torrc:');
		console.log('      HiddenServiceDir /var/lib/tor/morphit/');
		console.log('      HiddenServicePort 80 127.0.0.1:8080');
		console.log('  and restart Tor.  The Ansible "tor" role (enable_tor in');
		console.log('  group_vars/all.yml) does this for you.  Keep the secret key safe;');
		console.log('  losing it means a new address.');
		console.log('');
		console.log('Want a custom VANITY onion instead? Generate one with');
		console.log('scripts/generate-onion.sh on your own machine and set it via');
		console.log('`morphit-ops alt-address` — that replaces this basic one.');
		console.log('');
	}

	// ─── I2P destination ────────────────────────────────────────
	if (result.i2pTunnelDir && result.i2pB32Address) {
		console.log('━'.repeat(58));
		console.log('Your I2P address (generated for you)');
		console.log('━'.repeat(58));
		console.log('');
		console.log(`  ${sanitizeForTerm(result.i2pB32Address)}`);
		console.log('');
		console.log('Your site already advertises this (footer pill).  To actually SERVE');
		console.log('it, install the generated keyfile into i2pd and add the tunnel:');
		console.log(`  ${sanitizeForTerm(result.i2pTunnelDir)}/`);
		console.log('  → copy morphit-web.dat to i2pd\u2019s datadir, e.g.');
		console.log('    /var/lib/i2pd/morphit-web.dat (owned by the i2pd user, mode 0600),');
		console.log('    then append tunnel.conf\u2019s stanza to i2pd\u2019s tunnels.conf and');
		console.log('    restart i2pd.  The Ansible "i2pd" role (enable_i2pd in');
		console.log('    group_vars/all.yml) does this for you.  Keep the keyfile safe;');
		console.log('    losing it means a new address.');
		console.log('');
		console.log('Want a custom VANITY .b32.i2p instead? Generate one with');
		console.log('scripts/generate-i2p.sh on your own machine and set it via');
		console.log('`morphit-ops alt-address` — that replaces this basic one.');
		console.log('');
	}

	console.log('Have fun.');
	console.log('');
}

/** Find the repo root.  We assume cwd is somewhere in the repo
 *  and walk up looking for the package.json with name="morphit".
 *  Falls back to cwd. */
