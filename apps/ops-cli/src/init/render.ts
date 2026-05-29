/**
 * Morphit ops CLI — config file writer.
 *
 * Takes the collected wizard answers, produces THREE files:
 *
 *   1. morphit.config.env       Operator-tunable settings (allowlisted
 *                               by @morphit/operator-config).  This is
 *                               what most operators will edit later.
 *
 *   2. morphit.env              Critical infrastructure (database URL,
 *                               relay/fees account names, active-key
 *                               file path).  These bind a Morphit
 *                               instance to the chain; typos cause data
 *                               corruption.  Operator's systemd unit
 *                               (or shell, or docker-compose) sources
 *                               this file BEFORE running the indexer
 *                               and relay.
 *
 *   3. apps/relay/keystore.{wif,json}   The active key itself.
 *
 * All three are written with 0600 permissions (user-only read/write).
 *
 * Why split morphit.config.env vs morphit.env: the operator-config
 * package uses an allowlist policy.  Critical-infra values are
 * deliberately excluded from the allowlist because typo'ing them
 * causes data corruption (e.g., wrong fees account = fees flow to
 * nowhere).  The operator's deployment automation should set those
 * via OS env, where typos are caught by integration tests rather
 * than discovered when fees go missing.  Generating a separate
 * morphit.env file gives the wizard's first-time-setup convenience
 * without subverting the policy.
 */

import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import type {
	RelayAccountResult,
	ActiveKeyResult,
	AltNetworkResult,
	FeeExplorersResult,
	ChatLinkExplorersResult,
	DisabledAssetsResult,
	SeoResult,
	BackupResult,
	OperatorTagResult,
	McpServerResult
} from './steps.ts';

export interface WizardAnswers {
	readonly instanceName: string;
	readonly tagline: string;
	readonly databaseUrl: string;
	readonly blurtRpcEndpoints: readonly string[];
	readonly relayAccount: RelayAccountResult;
	readonly activeKey: ActiveKeyResult;
	readonly feesAccount: string;
	readonly dailyCeiling: number;
	readonly contactUrl: string | null;
	readonly origin: string | null;
	readonly altNetworks: AltNetworkResult;
	readonly listingFee: ListingFeeResult;
	readonly feeExplorers: FeeExplorersResult;
	readonly chatLinkExplorers: ChatLinkExplorersResult;
	/** Part 122 cp22 — operator-chosen trade-only-asset disable
	 *  set.  Renders into MORPHIT_INDEXER_DISABLED_ASSETS in
	 *  morphit.config.env.  Empty means accept everything
	 *  (default posture). */
	readonly disabledAssets: DisabledAssetsResult;
	readonly seo: SeoResult;
	readonly backup: BackupResult;
	/** Part 111 — operator tag for federation-scoped payouts. */
	readonly operatorTag: OperatorTagResult;
	/** Part 121 cp9 — Matrix surfaces.
	 *
	 *  Two distinct addresses kept separate by design:
	 *    - alertMxid (@user:server)  — PRIVATE E2E DM for operator
	 *      alerts.  Bot-only; never exposed via /v1/instance.
	 *    - groupRoomAlias (#room:server)  — PUBLIC room alias for
	 *      user→operator contact, exposed via /v1/instance.
	 *
	 *  Either or both may be null (operator opted out at the
	 *  wizard step).  Validation of the @user:server vs
	 *  #room:server prefix happens at prompt time + at indexer
	 *  config load time + via persona sentinels.
	 */
	readonly matrix: MatrixSurfacesResult;
	/** cp167 — Model Context Protocol server install opt-in.
	 *  Default is enabled (AI agents become the new search layer;
	 *  read-only, non-custodial, zero abuse surface).  Disabling
	 *  removes the morphit-mcp systemd unit from rendered artifacts. */
	readonly mcpServer: McpServerResult;
}

/** Matrix-surfaces wizard result.  Both fields are optional
 *  (operator can opt out of either or both).  Strict shape
 *  rules enforced at the prompt step:
 *    - alertMxid: starts with @, contains exactly one colon,
 *                 the part before : is 1..255 chars matching
 *                 [a-z0-9._=/+-], the part after : is a valid
 *                 DNS hostname.  Spec: Matrix MXID format.
 *    - groupRoomAlias: starts with #, same shape afterwards.
 *
 *  The starting-character distinction (@ vs #) is what the
 *  persona sentinels + adversarial smoke enforce.  Blanket
 *  @→# replacement would route security alerts to a public
 *  room.
 */
export interface MatrixSurfacesResult {
	readonly alertMxid: string | null;
	readonly groupRoomAlias: string | null;
}

/** Part 110 — operator-configurable listing fee + fallback
 *  BLURT price.  All three BTC/XMR/BLURT amounts plus the
 *  fallback price live here so the env-renderer can write
 *  them in one place.
 *
 *  `targetUsd` is what the operator nominally wanted (we
 *  record it for documentation / round-trip clarity); the
 *  three concrete amounts are what actually goes into env
 *  vars.  Live recompute or manual entry both produce the
 *  same shape. */
export interface ListingFeeResult {
	/** Operator's intended USD target per listing fee.
	 *  Used at the verifier-pricing layer for BTC + XMR.
	 *  Default 0.25.  The BLURT-paid path gets a separate
	 *  50% discount in the indexer (not exposed here). */
	readonly targetUsd: number;
	/** Computed BTC fee amount in satoshis. */
	readonly btcSatoshis: number;
	/** Computed XMR fee amount in piconero. */
	readonly xmrPiconero: number;
	/** Fallback BLURT/USD price used by the indexer's price
	 *  source when both Klingex and Coingecko are unreachable.
	 *  Display-only at the indexer (fee verification is
	 *  BLURT-native); operators set this so quoted USD prices
	 *  during an upstream outage are still in the right
	 *  ballpark.  Default 0.002. */
	readonly fallbackBlurtPriceUsd: number;
	/** cp128: denomination fiat the indexer expresses BLURT
	 *  prices in for display surfaces.  Default 'USD'.
	 *  Operators in non-USD markets (or hedging against USD
	 *  collapse) can set EUR, GBP, JPY, BRL, CNY, INR, RUB, XDR
	 *  (IMF Special Drawing Rights), XAU (gold ounces), or any
	 *  other 3-8 character uppercase ticker.  See ADR-0040. */
	readonly denominationFiat: string;
	/** Where the BTC/XMR amounts came from — 'coingecko' if
	 *  live-fetched at wizard time, 'manual' if the operator
	 *  entered them by hand, 'default' if they kept the
	 *  hardcoded defaults.  Recorded for the post-wizard
	 *  review summary so the operator knows what assumption
	 *  is baked in. */
	readonly source: 'coingecko' | 'manual' | 'default';
}

export interface WriteResult {
	readonly configPath: string;
	readonly envPath: string;
	readonly keystorePath: string;
	readonly backupEnvPath: string | null;
	readonly configBytes: number;
	readonly envBytes: number;
	readonly keystoreBytes: number;
	readonly backupEnvBytes: number;
}

/** Render the wizard answers into the two env files + keystore,
 *  then write all three with 0600 permissions.  Returns paths +
 *  sizes for the post-install summary. */
export function writeWizardOutput(answers: WizardAnswers, repoRoot: string): WriteResult {
	const configPath = join(repoRoot, 'morphit.config.env');
	const envPath = join(repoRoot, 'morphit.env');
	const keystoreDir = join(repoRoot, 'apps', 'relay');
	const keystoreFilename =
		answers.activeKey.mode === 'encrypted' ? 'keystore.json' : 'keystore.wif';
	const keystorePath = join(keystoreDir, keystoreFilename);

	mkdirSync(keystoreDir, { recursive: true });

	// ─── Keystore ──
	let keystoreContent: string;
	if (answers.activeKey.mode === 'encrypted') {
		keystoreContent = JSON.stringify(answers.activeKey.envelope, null, 2);
	} else {
		keystoreContent = answers.activeKey.plaintextWif ?? '';
	}
	writeFileSync(keystorePath, keystoreContent, { mode: 0o600 });
	chmodSync(keystorePath, 0o600);

	// ─── morphit.config.env (operator-tunable) ──
	const configContent = renderConfig(answers);
	writeFileSync(configPath, configContent, { mode: 0o600 });
	chmodSync(configPath, 0o600);

	// ─── morphit.env (critical infrastructure) ──
	const envContent = renderEnv(answers, keystorePath);
	writeFileSync(envPath, envContent, { mode: 0o600 });
	chmodSync(envPath, 0o600);

	// ─── ops/backup/backup.env (per-operator backup config) ──
	// Wizard writes to the repo path; the operator then `sudo
	// install`s it to /etc/morphit/backup.env per the post-
	// install instructions.  We do NOT write directly to /etc
	// because the wizard runs as the operator user (no sudo),
	// and a user-readable /etc/morphit/backup.env would be a
	// permission downgrade.
	let backupEnvPath: string | null = null;
	let backupEnvBytes = 0;
	if (answers.backup.enabled) {
		const backupDir = join(repoRoot, 'ops', 'backup');
		backupEnvPath = join(backupDir, 'backup.env');
		mkdirSync(backupDir, { recursive: true });
		const backupContent = renderBackupEnv(answers);
		writeFileSync(backupEnvPath, backupContent, { mode: 0o600 });
		chmodSync(backupEnvPath, 0o600);
		backupEnvBytes = Buffer.byteLength(backupContent, 'utf8');
	}

	return {
		configPath,
		envPath,
		keystorePath,
		backupEnvPath,
		configBytes: Buffer.byteLength(configContent, 'utf8'),
		envBytes: Buffer.byteLength(envContent, 'utf8'),
		keystoreBytes: Buffer.byteLength(keystoreContent, 'utf8'),
		backupEnvBytes
	};
}

// ─── Allowlisted operator-tunable settings ───────────────────────

function renderConfig(answers: WizardAnswers): string {
	const lines: string[] = [];
	const altNetworks = answers.altNetworks;

	lines.push('# Morphit instance configuration — operator-tunable knobs');
	lines.push(`# Generated by 'morphit-ops init' on ${new Date().toISOString()}.`);
	lines.push('#');
	lines.push('# This file holds settings you MIGHT want to tune over time:');
	lines.push('# instance branding, signup ceiling, fee thresholds, etc.');
	lines.push('# Edit by hand if you want; values you set here override defaults');
	lines.push('# but do not override anything you set in the OS environment.');
	lines.push('#');
	lines.push('# Critical infrastructure (database URL, relay/fees accounts,');
	lines.push('# active-key file path) lives in the SEPARATE morphit.env file');
	lines.push('# generated alongside this one.  See morphit.config.env.example');
	lines.push('# for the full list of allowed keys.');
	lines.push('');

	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Instance branding');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push(`MORPHIT_INSTANCE_NAME=${quote(answers.instanceName, 'parseEnv')}`);
	lines.push(`MORPHIT_INSTANCE_TAGLINE=${quote(answers.tagline, 'parseEnv')}`);
	if (answers.contactUrl !== null) {
		lines.push(`MORPHIT_INSTANCE_CONTACT_URL=${quote(answers.contactUrl, 'parseEnv')}`);
	}
	if (answers.origin !== null) {
		lines.push(`MORPHIT_INSTANCE_ORIGIN=${quote(answers.origin, 'parseEnv')}`);
	}
	lines.push('');

	const hasAlt =
		altNetworks.tor !== null ||
		altNetworks.lokinet !== null ||
		altNetworks.i2p !== null ||
		altNetworks.nostr !== null;
	if (hasAlt) {
		lines.push('# ──────────────────────────────────────────────────────');
		lines.push('# Alt-network reachability');
		lines.push('# ──────────────────────────────────────────────────────');
		if (altNetworks.tor !== null) {
			lines.push(`MORPHIT_INSTANCE_TOR_ADDRESS=${quote(altNetworks.tor, 'parseEnv')}`);
		}
		if (altNetworks.lokinet !== null) {
			lines.push(`MORPHIT_INSTANCE_LOKINET_ADDRESS=${quote(altNetworks.lokinet, 'parseEnv')}`);
		}
		if (altNetworks.i2p !== null) {
			lines.push(`MORPHIT_INSTANCE_I2P_ADDRESS=${quote(altNetworks.i2p, 'parseEnv')}`);
		}
		if (altNetworks.nostr !== null) {
			lines.push(`MORPHIT_INSTANCE_NOSTR_PUBKEY=${quote(altNetworks.nostr, 'parseEnv')}`);
		}
		lines.push('');
	}

	const hasSeo =
		answers.seo.title !== null || answers.seo.description !== null || answers.seo.keywords !== null;
	if (hasSeo) {
		lines.push('# ──────────────────────────────────────────────────────');
		lines.push('# SEO override (homepage only)');
		lines.push('# ──────────────────────────────────────────────────────');
		lines.push('# Override the bundled svelte-i18n SEO copy for / .');
		lines.push('# Empty/unset = use the bundled defaults (10 locales).');
		if (answers.seo.title !== null) {
			lines.push(`MORPHIT_INSTANCE_SEO_TITLE=${quote(answers.seo.title, 'parseEnv')}`);
		}
		if (answers.seo.description !== null) {
			lines.push(`MORPHIT_INSTANCE_SEO_DESCRIPTION=${quote(answers.seo.description, 'parseEnv')}`);
		}
		if (answers.seo.keywords !== null) {
			lines.push(`MORPHIT_INSTANCE_SEO_KEYWORDS=${quote(answers.seo.keywords, 'parseEnv')}`);
		}
		lines.push('');
	}

	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Signup ceiling');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Hard cap on accounts the relay creates per UTC day.');
	lines.push('# Hit-the-cap → signups pause until midnight UTC.');
	lines.push(`MORPHIT_RELAY_SIGNUP_DAILY_CEILING=${answers.dailyCeiling}`);
	lines.push('');

	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Account-creation fee fallback');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# The relay AND indexer read the chain value live via');
	lines.push('# condenser_api.get_chain_properties (relay at every signup,');
	lines.push('# indexer once per 24h for /v1/chain-fee).  This knob is the');
	lines.push('# fallback when chain RPC is unavailable, AND the sanity');
	lines.push("# threshold the relay uses (refuses to broadcast if the chain's");
	lines.push('# fee is more than 10% above this value — protects against a');
	lines.push('# witness emergency raise draining your relay before you notice).');
	lines.push('# Update this value if witnesses durably change the chain fee.');
	lines.push('MORPHIT_INDEXER_ACCOUNT_CREATION_FEE_BLURT=100');
	lines.push('');

	// ─── Matrix surfaces (Part 121 cp9) ──────────────────────
	// Two distinct Matrix addresses, kept separate by design:
	//   - alert MXID (@user:server)  — PRIVATE E2E DM destination
	//     for operator alerts.  Bot-only; never exposed via the
	//     /v1/instance API.
	//   - group room (#room:server)  — PUBLIC room alias for
	//     user→operator contact.  Exposed via /v1/instance and
	//     rendered on /support, /about-this-instance, footer.
	// Memory's @user:server vs #room:server rule: blanket
	// @→# replacement is actively harmful (security disclosures
	// would leak to a public room).  Validate shape at config
	// load time and via persona sentinels.
	if (
		answers.matrix.alertMxid !== null ||
		answers.matrix.groupRoomAlias !== null
	) {
		lines.push('# ──────────────────────────────────────────────────────');
		lines.push('# Matrix surfaces');
		lines.push('# ──────────────────────────────────────────────────────');
		lines.push('# Operator alert routing + user→operator contact.');
		lines.push('#');
		lines.push('# alertMxid is PRIVATE — bot DMs operator alerts to it.');
		lines.push('# Never exposed via the /v1/instance API.');
		lines.push('#');
		lines.push('# groupRoomAlias is PUBLIC — rendered on /support,');
		lines.push('# /about-this-instance, and footer for user→operator');
		lines.push('# contact.  Exposed via /v1/instance.operator_matrix_room.');
		if (answers.matrix.alertMxid !== null) {
			lines.push(
				`MORPHIT_MATRIX_BOT_ALERT_MXID=${quote(answers.matrix.alertMxid, 'parseEnv')}`
			);
		}
		if (answers.matrix.groupRoomAlias !== null) {
			lines.push(
				`MORPHIT_INDEXER_OPERATOR_MATRIX_ROOM=${quote(answers.matrix.groupRoomAlias, 'parseEnv')}`
			);
		}
		lines.push('');
	}

	// ─── MCP server (cp167) ─────────────────────────────────────────
	// Renders the operator's wizard answer about whether to install
	// the morphit-mcp service.  No secret material here — just an
	// enable flag the operator can flip later, plus comments telling
	// them how to start the service.

	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# MCP server (Model Context Protocol for AI agents)');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Set to true to publicly advertise that this instance');
	lines.push('# runs an MCP endpoint (changes /v1/instance.mcp_url so');
	lines.push('# AI agent operators can discover it).  Setting to false');
	lines.push('# does NOT stop the morphit-mcp systemd service — disable');
	lines.push('# the unit if you want to turn it off:');
	lines.push('#   sudo systemctl disable --now morphit-mcp.service');
	lines.push('#');
	lines.push('# Default bind: 127.0.0.1:8124 (loopback).  Reverse-proxy');
	lines.push('# via nginx at /mcp/* if you want public exposure.');
	lines.push('# See docs/OPERATIONS.md §41 for the full setup.');
	if (answers.mcpServer.enabled) {
		lines.push('MORPHIT_MCP_ADVERTISE=true');
		lines.push('');
		lines.push('# To start the MCP service after first install:');
		lines.push('#   sudo systemctl enable --now morphit-mcp.service');
	} else {
		lines.push('MORPHIT_MCP_ADVERTISE=false');
		lines.push('');
		lines.push('# Operator opted out of MCP at wizard time.  To enable later,');
		lines.push('# flip MORPHIT_MCP_ADVERTISE=true above and run:');
		lines.push('#   sudo systemctl enable --now morphit-mcp.service');
	}
	lines.push('');

	return lines.join('\n') + '\n';
}

// ─── Critical infrastructure ─────────────────────────────────────

function renderEnv(answers: WizardAnswers, keystorePath: string): string {
	const lines: string[] = [];

	lines.push('# Morphit critical infrastructure — DO NOT commit to git');
	lines.push(`# Generated by 'morphit-ops init' on ${new Date().toISOString()}.`);
	lines.push('#');
	lines.push('# This file holds settings you should NOT change casually:');
	lines.push('#   - database URL (typo = corrupted state)');
	lines.push('#   - relay/fees account names (typo = chain ops fail)');
	lines.push('#   - active key file path (typo = relay refuses to start)');
	lines.push('#');
	lines.push('# Source this file BEFORE running the indexer and relay.  In a');
	lines.push('# systemd unit:');
	lines.push('#   [Service]');
	lines.push('#   EnvironmentFile=/path/to/morphit.env');
	lines.push('# In a shell:');
	lines.push('#   set -a; . ./morphit.env; set +a; npm start -w apps/indexer');
	lines.push('#');
	lines.push('# These values are operator-tunable too, but only via the OS');
	lines.push('# environment (so deployment automation owns them) — not via');
	lines.push('# the allowlisted morphit.config.env.');
	lines.push('');

	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Database (shared by indexer and relay)');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push(`MORPHIT_INDEXER_DATABASE_URL=${quote(answers.databaseUrl)}`);
	lines.push(`MORPHIT_RELAY_DATABASE_URL=${quote(answers.databaseUrl)}`);
	lines.push('');

	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Chain ID — the network this indexer pins to');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Pinned at first run; the indexer refuses to boot if its');
	lines.push('# recorded chain_id differs from this value.  This is the');
	lines.push('# defense against accidentally pointing a mainnet DB at');
	lines.push('# testnet RPCs (or vice-versa) and silently corrupting');
	lines.push('# state.  To switch networks, see docs/SWITCHING-NETWORKS.md');
	lines.push('# — you must wipe the DB and re-init when changing chains.');
	lines.push('#');
	lines.push('# Default below is Blurt MAINNET.  Operators staging on a');
	lines.push('# self-hosted testnet must set the testnet chain_id by hand');
	lines.push('# (the wizard ships mainnet because that is the launch');
	lines.push('# target for almost every operator).');
	lines.push(
		'MORPHIT_INDEXER_CHAIN_ID=cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f'
	);
	lines.push('');

	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Blurt RPC endpoints (indexer)');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Comma-separated https:// URLs.  The indexer rotates between');
	lines.push('# them.  Update via:');
	lines.push('#   morphit-ops edit  →  Blurt RPC endpoints');
	lines.push('# Restart the indexer service after changes:');
	lines.push('#   sudo systemctl restart morphit-indexer');
	lines.push('# A wrong endpoint here will prevent the indexer from starting,');
	lines.push('# so when adding/removing nodes, edit one at a time and watch');
	lines.push('# the journald log on restart.');
	lines.push(`MORPHIT_INDEXER_RPC_ENDPOINTS=${quote(answers.blurtRpcEndpoints.join(','))}`);
	lines.push('');

	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Fee-verifier explorer URLs (indexer)');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Comma-separated https:// URLs the indexer queries to');
	lines.push('# verify BTC/XMR fee payments.  Multi-explorer cross-check');
	lines.push('# rejects single-source manipulation (a compromised explorer');
	lines.push("# cannot lie undetected if the other configured explorers");
	lines.push('# disagree).  Restart the indexer service after changes:');
	lines.push('#   sudo systemctl restart morphit-indexer');
	lines.push('#');
	lines.push('# BTC: must be Esplora-API-compatible.  Defaults:');
	lines.push('#   blockstream.info/api + mempool.space/api');
	lines.push('# XMR: must run the onion-monero-blockchain-explorer');
	lines.push('# reference codebase exposing /api/outputs?txprove=1.');
	lines.push('# Five defaults: xmrchain.net, localmonero.co/blocks,');
	lines.push('# monerohash.com/explorer, exploremonero.com, moneroexplorer.org.');
	lines.push('#');
	lines.push('# For maximum independence, self-host both — see');
	lines.push('# docs/OPERATIONS.md §40.4 for a docker-compose recipe.');
	lines.push(
		`MORPHIT_INDEXER_BTC_EXPLORER_URLS=${quote(answers.feeExplorers.btc.join(','))}`
	);
	lines.push(
		`MORPHIT_INDEXER_XMR_EXPLORER_URLS=${quote(answers.feeExplorers.xmr.join(','))}`
	);
	lines.push('');

	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Chat-link external explorer URLs (frontend)');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Templates for the "click a txid in chat" feature.  When a');
	lines.push('# counterparty pastes a BTC or XMR txid in chat, the frontend');
	lines.push('# substitutes the txid into the {txid} placeholder and opens');
	lines.push('# the result in a new tab.  These are USER-FACING URLs;');
	lines.push('# privacy-conscious operators may point them at self-hosted');
	lines.push('# explorers to keep user IPs off third-party services.');
	lines.push('#');
	lines.push('# Each template must:');
	lines.push('#   - start with https://');
	lines.push('#   - contain {txid} exactly where the txid should appear');
	lines.push('#');
	lines.push('# Defaults (single-network):');
	lines.push('#   BTC:  https://mempool.space/tx/{txid}');
	lines.push('#   XMR:  https://xmrchain.net/tx/{txid}');
	lines.push('#   BCH:  https://blockchair.com/bitcoin-cash/transaction/{txid}');
	lines.push('#   LTC:  https://litecoinspace.org/tx/{txid}');
	lines.push('#   DASH: https://insight.dash.org/insight/tx/{txid}');
	lines.push('#   DOGE: https://blockchair.com/dogecoin/transaction/{txid}');
	lines.push('#   ZEC:  https://mainnet.zcashexplorer.app/transactions/{txid}');
	lines.push('#   ARRR: https://explorer.piratechain.com/tx/{txid}');
	lines.push('#   DCR:  https://dcrdata.decred.org/tx/{txid}');
	lines.push('#   SOL:  https://explorer.solana.com/tx/{txid}');
	lines.push('#   ETH:  https://eth.blockscout.com/tx/{txid}');
	lines.push('#   XRP:  https://livenet.xrpl.org/transactions/{txid}');
	lines.push('#');
	lines.push('# Defaults (multi-network, per chain):');
	lines.push('#   USDT (ERC-20):  https://etherscan.io/tx/{txid}');
	lines.push('#   USDT (TRC-20):  https://tronscan.org/#/transaction/{txid}');
	lines.push('#   USDT (SPL):     https://solscan.io/tx/{txid}');
	lines.push('#   USDT (BEP-20):  https://bscscan.com/tx/{txid}');
	lines.push('#   USDC (ERC-20):  https://etherscan.io/tx/{txid}');
	lines.push('#   USDC (SPL):     https://solscan.io/tx/{txid}');
	lines.push('#   USDC (Base):    https://basescan.org/tx/{txid}');
	lines.push('#   USDC (Polygon): https://polygonscan.com/tx/{txid}');
	lines.push('#   DAI  (ERC-20):  https://etherscan.io/tx/{txid}');
	lines.push('#   DAI  (Polygon): https://polygonscan.com/tx/{txid}');
	lines.push('#   DAI  (Base):    https://basescan.org/tx/{txid}');
	lines.push('#   DAI  (Arbitrum): https://arbiscan.io/tx/{txid}');
	lines.push(
		`MORPHIT_FRONTEND_BTC_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.btc)}`
	);
	lines.push(
		`MORPHIT_FRONTEND_XMR_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.xmr)}`
	);
	lines.push(
		`MORPHIT_FRONTEND_BCH_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.bch)}`
	);
	lines.push(
		`MORPHIT_FRONTEND_LTC_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.ltc)}`
	);
	lines.push(
		`MORPHIT_FRONTEND_DASH_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.dash)}`,
		// Part 122 cp33 — DOGE single-network chat-link.
		`MORPHIT_FRONTEND_DOGE_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.doge)}`,
		// Part 122 cp39 — ZEC single-network chat-link.
		`MORPHIT_FRONTEND_ZEC_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.zec)}`,
		`MORPHIT_FRONTEND_ARRR_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.arrr)}`,
		`MORPHIT_FRONTEND_DCR_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.dcr)}`,
		`MORPHIT_FRONTEND_SOL_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.sol)}`,
		`MORPHIT_FRONTEND_ETH_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.eth)}`,
		`MORPHIT_FRONTEND_XRP_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.xrp)}`
	);
	// Part 122 cp30-DD-11 — USDT per-network env vars.  These
	// finally route through the indexer body to the frontend's
	// usdtExplorerUrl() lookup after the DD-11 closure.
	lines.push(
		`MORPHIT_FRONTEND_USDT_ERC20_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.usdt.erc20)}`
	);
	lines.push(
		`MORPHIT_FRONTEND_USDT_TRC20_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.usdt.trc20)}`
	);
	lines.push(
		`MORPHIT_FRONTEND_USDT_SPL_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.usdt.spl)}`
	);
	lines.push(
		`MORPHIT_FRONTEND_USDT_BEP20_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.usdt.bep20)}`
	);
	// Part 122 cp30 — USDC per-network env vars.
	lines.push(
		`MORPHIT_FRONTEND_USDC_ERC20_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.usdc.erc20)}`
	);
	lines.push(
		`MORPHIT_FRONTEND_USDC_SPL_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.usdc.spl)}`
	);
	lines.push(
		`MORPHIT_FRONTEND_USDC_BASE_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.usdc.base)}`
	);
	lines.push(
		`MORPHIT_FRONTEND_USDC_POLYGON_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.usdc.polygon)}`
	);
	// Part 122 cp31 — DAI per-network env vars (4 EVM networks).
	lines.push(
		`MORPHIT_FRONTEND_DAI_ERC20_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.dai.erc20)}`
	);
	lines.push(
		`MORPHIT_FRONTEND_DAI_POLYGON_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.dai.polygon)}`
	);
	lines.push(
		`MORPHIT_FRONTEND_DAI_BASE_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.dai.base)}`
	);
	lines.push(
		`MORPHIT_FRONTEND_DAI_ARBITRUM_CHAT_LINK_URL=${quote(answers.chatLinkExplorers.dai.arbitrum)}`
	);
	lines.push('');

	// ─── Trade-only asset policy (Part 122 cp22) ─────────────────
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Trade-only asset policy (indexer)');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Comma-separated list of uppercase tickers your indexer');
	lines.push('# REFUSES to write new orders for.  Empty (or unset)');
	lines.push('# means accept every trade-only asset shipped in this');
	lines.push('# release.  Peer-instance orders for the same asset');
	lines.push('# still appear in your read-only orderbook feeds — the');
	lines.push('# chain history is shared across the federation.');
	lines.push('#');
	lines.push('# Parser is tolerant of whitespace, mixed case, and');
	lines.push('# trailing commas — write it however you like.');
	lines.push('#');
	lines.push('# Examples:');
	lines.push('#   MORPHIT_INDEXER_DISABLED_ASSETS=""        (accept all)');
	lines.push('#   MORPHIT_INDEXER_DISABLED_ASSETS="USDT"    (refuse USDT)');
	lines.push('#   MORPHIT_INDEXER_DISABLED_ASSETS="USDC"    (refuse USDC)');
	lines.push('#   MORPHIT_INDEXER_DISABLED_ASSETS="USDT,USDC,DAI" (refuse all three stablecoins — privacy-pure)');
	lines.push('#   MORPHIT_INDEXER_DISABLED_ASSETS="BCH,LTC,DASH" (refuse BTC-forks)');
	lines.push('#');
	lines.push('# Change your mind later by editing this line and');
	lines.push('# restarting the indexer service.  Browsers see the');
	lines.push('# change at most 5 minutes after restart (the');
	lines.push('# /v1/instance response carries a 5-minute Cache-Control');
	lines.push('# header).  See docs/OPERATIONS.md §"Trade-only asset');
	lines.push('# configuration" for the full operator playbook.');
	lines.push(
		`MORPHIT_INDEXER_DISABLED_ASSETS=${quote(answers.disabledAssets.disabledTickers.join(','))}`
	);
	lines.push('');

	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Listing fee + fallback BLURT price (indexer)');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Fee amounts for the BTC/XMR listing-fee verifiers.  These');
	lines.push('# are denominated in the chain-native units (satoshis,');
	lines.push('# piconero) because fee verification is BLURT-native and');
	lines.push('# does not consult any live USD oracle at verify time.');
	lines.push('# The wizard computed these from a target USD value using');
	lines.push('# live Coingecko prices at wizard-run time.  When prices');
	lines.push('# drift significantly, re-run:');
	lines.push('#   morphit-ops edit  →  Listing fee + fallback BLURT price');
	lines.push('# or manually:');
	lines.push('#   tsx apps/indexer/scripts/recommend-fee-amounts.ts \\');
	lines.push(`#       --target-usd ${answers.listingFee.targetUsd}`);
	lines.push('#');
	lines.push(`# Target was: $${answers.listingFee.targetUsd.toFixed(2)} USD per fee`);
	lines.push(`# Source:     ${answers.listingFee.source}`);
	lines.push('#');
	lines.push('# BLURT-paid listing fee gets a 50% discount in the indexer');
	lines.push('# (MORPHIT_INDEXER_FEE_BASE_BLURT, separate from this block).');
	lines.push(
		`MORPHIT_INDEXER_BTC_FEE_SATOSHIS=${answers.listingFee.btcSatoshis}`
	);
	lines.push(
		`MORPHIT_INDEXER_XMR_FEE_PICONERO=${answers.listingFee.xmrPiconero}`
	);
	lines.push('');
	lines.push('# Fallback BLURT/USD price.  The indexer runs a composite');
	lines.push('# price source: Klingex → Coingecko → static floor (this).');
	lines.push('# Only consulted when both live upstreams have failed AND no');
	lines.push('# value has cached successfully since boot.  Display-only at');
	lines.push("# the indexer; fee verification doesn't touch USD prices.");
	lines.push('# Update when BLURT drifts significantly:');
	lines.push('#   morphit-ops edit  →  Listing fee + fallback BLURT price');
	lines.push(
		`MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR=${answers.listingFee.fallbackBlurtPriceUsd}`
	);
	lines.push('');

	// cp128 — denomination fiat (operator-chosen unit for the
	// indexer's BLURT-price echo on display surfaces).
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# cp128 — Denomination fiat (display unit)');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# The unit the indexer expresses BLURT prices in on its');
	lines.push('# own display surfaces (listing-fee fiat echo, receipt');
	lines.push('# endpoint, etc.).  Default USD.  Set to a different');
	lines.push('# ticker if your market is non-USD (EUR/GBP/JPY/BRL/CNY/');
	lines.push('# INR/RUB/AED/...) or you want to hedge against USD');
	lines.push('# erosion (XDR = IMF basket, XAU = gold ounces).');
	lines.push(
		`MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT=${answers.listingFee.denominationFiat}`
	);
	lines.push('');

	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Operator tag (Part 111 — federation-scoped payouts)');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Identifies this instance in the federation.  Each');
	lines.push('# order op the frontend broadcasts carries this tag;');
	lines.push('# every indexer in the federation uses it to decide');
	lines.push('# whether to queue the resulting payouts (welcome');
	lines.push('# bonus, dust refill, operator 90% share, loyalty BP)');
	lines.push('# to its own relay or skip them.  Without this set');
	lines.push('# correctly, the relay queues nothing — conservative');
	lines.push('# default for "I do not know who I am."');
	lines.push('#');
	lines.push('# Canonical morphit.io uses `morphit`.  Community');
	lines.push('# operators MUST pick a unique tag AND register it on');
	lines.push('# chain via `morphit_operator_register_v1` before any');
	lines.push('# attribution-based payouts can be received.');
	lines.push(
		`MORPHIT_INSTANCE_OPERATOR_TAG=${quote(answers.operatorTag.tag)}`
	);
	lines.push('');

	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Relay (the account that pays signup chain fees)');
	lines.push('# ──────────────────────────────────────────────────────');
	// Both processes need the relay account name; canonical var differs.
	lines.push(`MORPHIT_RELAY_ACCOUNT=${quote(answers.relayAccount.name)}`);
	lines.push(`MORPHIT_INDEXER_RELAY_ACCOUNT=${quote(answers.relayAccount.name)}`);
	lines.push(`MORPHIT_RELAY_ACTIVE_KEY_FILE=${quote(keystorePath)}`);
	if (answers.activeKey.mode === 'encrypted') {
		lines.push('# Active key is in the file above as an encrypted v1 envelope');
		lines.push('# (scrypt + AES-256-GCM).  Relay prompts for the unlock passphrase');
		lines.push('# at startup.');
	} else {
		lines.push('# Active key is in the file above as a plaintext WIF.  Anyone');
		lines.push('# reading the file can spend BLURT and create accounts as your');
		lines.push("# relay.  Consider switching to encrypted via 'morphit-ops init'");
		lines.push('# on a fresh checkout.');
	}
	lines.push('');

	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Fees account (collects listing fees + stranger fees)');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push(`MORPHIT_INDEXER_FEE_RECIPIENT=${quote(answers.feesAccount)}`);
	lines.push('');

	return lines.join('\n') + '\n';
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Render the per-operator backup.env file written when backup
 *  automation is enabled.  This is shell-snippet format, sourced
 *  by ops/backup/morphit-backup.sh on every run.  Mirrors the
 *  shape of ops/backup/backup.env.example. */
function renderBackupEnv(answers: WizardAnswers): string {
	if (!answers.backup.enabled) {
		throw new Error('renderBackupEnv called with backup disabled');
	}
	const dir = answers.backup.backupDir ?? '/home/morphit/backups';
	const days = answers.backup.retainDays ?? 30;

	const lines: string[] = [];
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('# Morphit indexer — backup configuration.');
	lines.push('#');
	lines.push('# Generated by `morphit ops init`.  Hand-edit is fine;');
	lines.push('# the script reads it as a shell snippet on every run.');
	lines.push('# After editing, no restart needed.');
	lines.push('# ──────────────────────────────────────────────────────');
	lines.push('');
	lines.push('# Where to write the backup files.');
	lines.push(`BACKUP_DIR=${quote(dir)}`);
	lines.push('');
	lines.push('# How many days of backups to keep.  Older files are');
	lines.push('# deleted during each run.');
	lines.push(`RETAIN_DAYS=${days}`);
	lines.push('');
	lines.push('# Postgres database name and authenticating user.');
	lines.push('# Defaults match what init.sql creates.');
	lines.push('DB_NAME=morphit_indexer');
	lines.push('DB_USER=morphit_indexer');
	lines.push('');
	return lines.join('\n');
}

/** Quote a value safely for an env-file line.
 *
 *  Strategy depends on which consumer reads the file:
 *
 *  - 'parseEnv' (morphit.config.env, read by Node's
 *    node:util.parseEnv via @morphit/operator-config):
 *      • Prefer single-quoted: `'value'`.  Embedded `$`,
 *        backticks, `$(...)` are literal (no expansion).
 *        Embedded `"` is literal.  parseEnv does NOT support
 *        the POSIX `'\''` close-escape-reopen idiom, so when
 *        value contains `'`, we fall back to double-quoted.
 *      • Fall back to double-quoted: `"value"`.  Embedded `$`
 *        is literal (parseEnv doesn't expand inside double
 *        quotes either, per dotenv semantics).  Embedded `"`
 *        is NOT supported as `\"` — parseEnv terminates at
 *        the first `"`, so a value containing both `'` AND
 *        `"` is unrepresentable.  We throw at quote() time
 *        rather than silently corrupt; the wizard prompt
 *        layer is responsible for rejecting such inputs.
 *
 *  - 'bash' (morphit.env, sourced by `set -a; .` or systemd
 *    `EnvironmentFile=`):
 *      • Single-quoted with POSIX close-escape-reopen idiom
 *        for embedded `'`.  Suppresses every form of bash
 *        expansion.
 *
 *  cp139-C-11 first switched both to single-quoted; cp139-D-1
 *  then discovered parseEnv's apostrophe-handling gap.  This
 *  per-consumer split is the canonical fix.  Symmetric with
 *  apps/ops-cli/src/commands/edit.ts:quoteValue() — both write
 *  paths must produce identical env-file output for the same
 *  (value, consumer) pair. */
export type EnvFileConsumer = 'parseEnv' | 'bash';

function quote(value: string, consumer: EnvFileConsumer = 'bash'): string {
	if (value === '') return "''";
	if (/^[A-Za-z0-9._\/:@-]+$/.test(value)) {
		// Safe characters — no quoting needed.  Works in both
		// parseEnv and bash.
		return value;
	}
	if (consumer === 'parseEnv') {
		// parseEnv consumer: prefer single-quoted.
		if (!value.includes("'")) {
			return `'${value}'`;
		}
		// Apostrophe present.  Fall back to double-quoted.  But
		// embedded `"` is not representable in parseEnv's double-
		// quote form (no \" escape), so reject up front.
		if (value.includes('"')) {
			throw new Error(
				`quote(): value contains both ' and " which is unrepresentable in parseEnv ` +
					`env-file format.  Wizard prompt layer must reject this input.  Value (first 80 chars): ${value.slice(0, 80)}`
			);
		}
		return `"${value}"`;
	}
	// Bash consumer: single-quoted with close-escape-reopen.
	const escaped = value.replace(/'/g, "'\\''");
	return `'${escaped}'`;
}

/** Resolve --out=PATH to an absolute path.  PATH may be relative
 *  (resolved against cwd) or absolute. */
export function resolveOutputPath(outFlag: string | undefined, defaultRoot: string): string {
	if (outFlag === undefined || outFlag === '') return defaultRoot;
	return isAbsolute(outFlag) ? outFlag : resolve(process.cwd(), outFlag);
}
