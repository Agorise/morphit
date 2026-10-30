/**
 * Morphit ops CLI — `edit` subcommand orchestrator.
 *
 * Re-prompts only the post-launch-tunable sections of an
 * existing morphit.config.env.  Used when:
 *
 *   - Your morphit.io domain gets seized and you need to switch
 *     to a backup primary origin (task #8).
 *   - You generated a Tor / Lokinet / I2P address after first
 *     setup and want to add it without re-running the whole
 *     wizard (task #2).
 *   - You want to tweak SEO copy for your audience (task #4).
 *
 * What this command does NOT touch:
 *   - apps/relay/keystore.* (the relay's active key — use the
 *     dedicated `edit-active-key` subcommand for rotation; that
 *     ceremony has its own atomic rename + relay-restart
 *     reminder).
 *   - morphit.env (the critical-infra env file — database URL,
 *     account names, active-key path don't change post-launch).
 *   - Any allowlisted key not covered by the menu (signup
 *     ceiling, fee floors, etc. — edit morphit.config.env by
 *     hand for those).
 *
 * The file is rewritten atomically: we write to a sibling
 * `.tmp` file, fsync, then rename.  Backup of the previous
 * version is written to `.bak-<timestamp>`.
 */

import { resolve } from 'node:path';
import { resolveOutputPath } from '../init/render.ts';
import {
	DEFAULT_BRAND_NAME,
	normalizeContactUrl,
	sanitizeBrandName
} from '@morphit/operator-config';
import { brandNameProblem } from '../lib/branding.ts';
import { resolveFeeRecipientValue } from '../lib/operatorFeeRecipient.ts';
import { isHiddenOnlyNode } from '../lib/hiddenOnly.ts';
import { runBranding } from './branding.ts';
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import { keepOwnerAndMode } from '../lib/keepOwner.ts';
import {
	existsSync,
	readFileSync,
	writeFileSync,
	chmodSync,
	renameSync,
	copyFileSync,
	openSync,
	fsyncSync,
	closeSync,
	statSync
} from 'node:fs';
import {
	ask,
	askYesNo,
	askChoice,
	step,
	explain,
	isAbortError,
	beginSteps,
	endSteps
} from '../init/prompt.ts';
import { REGISTER_DECLINED, registerOrigin, runRegister } from './register.ts';
import { fetchRegisteredTag } from '../lib/operatorTagGuard.ts';
import { reportHosting } from '../lib/altAddressHosted.ts';
import {
	validateAltAddress,
	validateI2pName,
	validateEnsName,
	validateNostr,
	fieldProblem,
	type ValidateResult
} from '../lib/altAddressValidate.ts';
import { sanitizeForTerm } from '../render/term.ts';
import {
	effectiveSettings,
	filesSetting,
	liveServiceEnvs,
	restartAndCheck,
	settingsFilesFor,
	unreadableFiles,
	type ServiceUnit
} from '../lib/laterEnvShadow.ts';
import { offerRestart } from '../lib/restartServices.ts';
import { syncInstanceOrigin } from '../lib/instanceOrigin.ts';
import { startDotsSpinner, withSpinner } from '../init/spinner.ts';
import { resolveWebRoot } from './upgrade.ts';
import {
	stepOrigin,
	stepListingFee,
	stepOperatorTag,
	stepFeesAccount,
	stepRpcEndpoints,
	parseRpcEndpoints,
	DEFAULT_BLURT_RPC_ENDPOINTS,
	INDEXER_LISTING_FEE_DEFAULTS,
	TOTAL_STEPS,
	type AltNetworkResult,
	type SeoResult
} from '../init/steps.ts';

export interface EditCtx {
	readonly flags: Readonly<Record<string, string>>;
	readonly positional: readonly string[];
	readonly colorEnabled: boolean;
}

interface ExistingConfig {
	readonly path: string;
	readonly text: string;
	readonly origin: string | null;
	/** displayed branding (name / tagline / contact).  Set at
	 *  init time but previously NOT re-editable here, so an operator who
	 *  wanted to rename their instance had to hand-edit the env file
	 *  (and hit the unquoted-space shell-source trap).  Now editable in
	 *  the "Branding & SEO" section. */
	readonly name: string | null;
	/** Per-instance SITE brand (docs/BRANDING.md) — the name the UI uses for
	 *  the site ("Sign in to …"); applied by `morphit-ops branding apply`. */
	readonly brandName: string | null;
	readonly tagline: string | null;
	readonly contactUrl: string | null;
	readonly altNetworks: AltNetworkResult;
	/** The legacy single MORPHIT_INSTANCE_I2P_ADDRESS, if present, so the
	 *  alt-network editor can clear it when migrating to the split
	 *  b32 / vanity keys. */
	readonly legacyI2pAddress: string | null;
	readonly seo: SeoResult;
	/** listing-fee + fallback-price slice.  Optional
	 *  fields (any may be null if the operator has hand-edited
	 *  the config to remove a key). */
	readonly listingFee: {
		readonly btcSatoshis: string | null;
		readonly xmrPiconero: string | null;
		readonly fallbackBlurtPriceUsd: string | null;
	};
	/** operator tag for federation-scoped payouts. */
	readonly operatorTag: string | null;
}

/** The settings in force: every setting this command shows, as the services
 *  get it — all their settings files in order, the last one wins. A server
 *  set up with Ansible keeps several of them (the Blurt node list, the
 *  operator tag) in /etc/morphit/indexer.env, read AFTER morphit.config.env;
 *  an older one keeps install-time copies there. What morphit.config.env says
 *  alone is not what runs. */
interface InForce {
	/** As the indexer gets it; undefined: no file sets it. */
	readonly indexer: ReadonlyMap<string, string | undefined>;
	/** As the relay gets it (its Blurt node list). */
	readonly relay: ReadonlyMap<string, string | undefined>;
	/** The files each reads, in order. */
	readonly indexerFiles: readonly string[];
	readonly relayFiles: readonly string[];
	/** Whether the relay runs from these files on this server. */
	readonly relayHere: boolean;
	/** Whether these are the installed settings (not another copy, --out). */
	readonly live: boolean;
}

/** Just the slice of morphit.env that this command can edit.
 *  Everything else (DB URL, account names, active key path)
 *  stays manual-edit-only by design — those keys are critical
 *  infrastructure and the operator-config package excludes them
 *  from the allowlist on purpose. */
interface ExistingEnv {
	readonly path: string;
	readonly text: string;
	/** Parsed comma-separated list, or null if the env file
	 *  doesn't have the key (e.g., older deployments that
	 *  predate init writing it).  In the null case the editor
	 *  shows the canonical default + uses it as the prompt's
	 *  suggested value. */
	readonly rpcEndpoints: readonly string[] | null;
}

/** Allowlisted keys this command can touch — anything else
 *  the operator wants to change must be edited by hand or via
 *  re-running init.  This list lives at the top of the file
 *  for documentation; the actual editing logic enumerates the
 *  same keys via the menu structure below. */
const EDITABLE_KEYS = [
	'MORPHIT_INSTANCE_ORIGIN',
	'MORPHIT_INSTANCE_NAME',
	'MORPHIT_INSTANCE_BRAND_NAME',
	'MORPHIT_INSTANCE_TAGLINE',
	'MORPHIT_INSTANCE_CONTACT_URL',
	'MORPHIT_INSTANCE_TOR_ADDRESS',
	'MORPHIT_INSTANCE_LOKINET_ADDRESS',
	'MORPHIT_INSTANCE_I2P_ADDRESS',
	'MORPHIT_INSTANCE_NOSTR_PUBKEY',
	'MORPHIT_INSTANCE_ENS_NAME',
	'MORPHIT_INSTANCE_SEO_TITLE',
	'MORPHIT_INSTANCE_SEO_DESCRIPTION',
	'MORPHIT_INSTANCE_SEO_KEYWORDS',
	// RPC list lives in morphit.env (not morphit.config.env) per the
	// operator-config package's intentional whitelist exclusion of
	// "critical infrastructure" keys.  The edit command opens
	// morphit.env in a tightly-scoped second pass for THIS key only;
	// other morphit.env keys (DB URL, account names, active key path)
	// stay manual-edit-only.
	'MORPHIT_INDEXER_RPC_ENDPOINTS',
	// …and its twin. `morphit-ops init` writes the SAME list to the relay
	// (render.ts, "beta5 item D": the asymmetry behind the firefight — one
	// survived, the other froze). Editing only the indexer's re-created exactly
	// that asymmetry the first time anyone changed their nodes.
	'MORPHIT_RELAY_BLURT_RPC'
] as const;

/** Every setting this command shows or writes, plus the accounts it reads. */
const SHOWN_KEYS: readonly string[] = [
	...EDITABLE_KEYS,
	'MORPHIT_INSTANCE_I2P_B32_ADDRESS',
	'MORPHIT_INSTANCE_I2P_NAME_ADDRESS',
	'MORPHIT_INDEXER_BTC_FEE_SATOSHIS',
	'MORPHIT_INDEXER_XMR_FEE_PICONERO',
	'MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR',
	'MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT',
	'MORPHIT_INDEXER_FEE_RECIPIENT',
	'MORPHIT_INSTANCE_OPERATOR_TAG',
	'MORPHIT_RELAY_ACCOUNT'
];

// The indexer's text limits live with the alt-address checks (init uses them
// too); re-exported here for the callers and tests that import them from edit.
export { INDEXER_TEXT_LIMITS, fieldProblem } from '../lib/altAddressValidate.ts';

/** What applies when no settings file sets these (shown instead of a bare
 *  "not set"). */
const UNSET_MEANS: Readonly<Record<string, string>> = {
	MORPHIT_INDEXER_RPC_ENDPOINTS: 'the shipped list of Blurt nodes',
	MORPHIT_RELAY_BLURT_RPC: 'the shipped list of Blurt nodes',
	MORPHIT_INDEXER_BTC_FEE_SATOSHIS: `the indexer uses ${INDEXER_LISTING_FEE_DEFAULTS.btcSatoshis}`,
	MORPHIT_INDEXER_XMR_FEE_PICONERO: `the indexer uses ${INDEXER_LISTING_FEE_DEFAULTS.xmrPiconero}`,
	MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR: `the indexer uses ${INDEXER_LISTING_FEE_DEFAULTS.fallbackBlurtPriceUsd}`,
	MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT: `the indexer uses ${INDEXER_LISTING_FEE_DEFAULTS.denominationFiat}`,
	MORPHIT_INDEXER_FEE_RECIPIENT: 'the fees go to the Morphit treasury'
};

/** Plain names for the settings, for the Review screen. */
const KEY_LABEL: Readonly<Record<string, string>> = {
	MORPHIT_INSTANCE_ORIGIN: 'Primary origin',
	MORPHIT_INSTANCE_NAME: 'Instance name',
	MORPHIT_INSTANCE_BRAND_NAME: 'Site brand name',
	MORPHIT_INSTANCE_TAGLINE: 'Tagline',
	MORPHIT_INSTANCE_CONTACT_URL: 'Contact URL',
	MORPHIT_INSTANCE_TOR_ADDRESS: 'Tor .onion address',
	MORPHIT_INSTANCE_LOKINET_ADDRESS: 'Lokinet .loki address',
	MORPHIT_INSTANCE_I2P_B32_ADDRESS: 'I2P b32 address',
	MORPHIT_INSTANCE_I2P_NAME_ADDRESS: 'I2P vanity name',
	MORPHIT_INSTANCE_I2P_ADDRESS: 'I2P address (old single setting)',
	MORPHIT_INSTANCE_NOSTR_PUBKEY: 'Nostr pubkey',
	MORPHIT_INSTANCE_ENS_NAME: 'ENS .eth name',
	MORPHIT_INSTANCE_SEO_TITLE: 'SEO title',
	MORPHIT_INSTANCE_SEO_DESCRIPTION: 'SEO description',
	MORPHIT_INSTANCE_SEO_KEYWORDS: 'SEO keywords',
	MORPHIT_INDEXER_BTC_FEE_SATOSHIS: 'BTC listing fee (satoshis)',
	MORPHIT_INDEXER_XMR_FEE_PICONERO: 'XMR listing fee (piconero)',
	MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR: 'Fallback BLURT/USD price',
	MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT: 'Price display unit',
	MORPHIT_INDEXER_FEE_RECIPIENT: 'Fees account',
	MORPHIT_INSTANCE_OPERATOR_TAG: 'Operator tag',
	MORPHIT_INDEXER_RPC_ENDPOINTS: 'Blurt nodes (indexer)',
	MORPHIT_RELAY_BLURT_RPC: 'Blurt nodes (relay)'
};

type SectionKey =
	| 'origin'
	| 'alt-networks'
	| 'seo'
	| 'listing-fee'
	| 'fees-account'
	| 'operator-tag'
	| 'rpc';

/** "Permission denied" from reading or writing the settings: say how to run it. */
function needsSudo(err: unknown): boolean {
	const code = (err as { code?: unknown } | null)?.code;
	const msg = err instanceof Error ? err.message : String(err);
	return code === 'EACCES' || code === 'EPERM' || /EACCES|EPERM/.test(msg);
}
const SUDO_HINT = 'Run it with sudo: sudo morphit-ops edit';

export async function runEdit(ctx: EditCtx): Promise<number> {
	printGreeting();

	// A relative --out is relative to where the operator ran the command (the
	// launcher runs this CLI from inside the install), as for `init`.
	const repoRoot = resolveOutputPath(ctx.flags.out, defaultRepoRoot());
	const configPath = `${repoRoot}/morphit.config.env`;
	const envPath = `${repoRoot}/morphit.env`;

	if (!existsSync(configPath)) {
		console.log(
			`No morphit.config.env found at ${configPath}.\n` +
				"Run 'morphit-ops init' first to set up your instance."
		);
		return 1;
	}

	// Every file the services read is part of what is in force: one this user
	// cannot read would make a setting look unset (and Enter would then
	// replace it).
	const where = settingsFilesFor(configPath, envPath);
	const unreadable = unreadableFiles([...new Set([...where.indexer, ...where.relay])]);
	if (unreadable.length > 0) {
		console.log(`✗ Can't read your settings (${unreadable.join(', ')}) as this user.`);
		console.log(`  ${SUDO_HINT}`);
		return 1;
	}

	let existing: ExistingConfig;
	let existingEnv: ExistingEnv | null = null;
	let inForce: InForce;
	try {
		inForce = {
			indexer: effectiveSettings(where.indexer, SHOWN_KEYS),
			relay: effectiveSettings(where.relay, ['MORPHIT_RELAY_BLURT_RPC']),
			indexerFiles: where.indexer,
			relayFiles: where.relay,
			relayHere: where.relayHere,
			live: where.live
		};
		existing = loadExisting(configPath, (k) => inForce.indexer.get(k) ?? null);
		// morphit.env is OPTIONAL — operators who deploy via SystemD's
		// `Environment=` directives or Docker compose env may not have
		// a morphit.env file at all.  The RPC editor is reachable only
		// when the file exists; we surface this state in printCurrent.
		if (existsSync(envPath)) existingEnv = loadExistingEnv(envPath);
		// The relay reads these settings here when it has its own file on this
		// server, or when this morphit.env carries its line (init writes both).
		if (existingEnv !== null && parseKvLines(existingEnv.text).has('MORPHIT_RELAY_BLURT_RPC'))
			inForce = { ...inForce, relayHere: true };
	} catch (err) {
		if (needsSudo(err)) {
			console.log(`✗ Can't read your settings (${configPath}) as this user.`);
			console.log(`  ${SUDO_HINT}`);
			return 1;
		}
		throw err;
	}
	console.log(`Loaded ${configPath}`);
	if (existingEnv !== null) {
		console.log(`Loaded ${envPath}`);
	} else {
		console.log(`(no morphit.env at ${envPath} — RPC edit unavailable)`);
	}
	console.log('');
	printCurrent(existing, inForce, existingEnv !== null, configPath);

	const choice = await pickSection(existingEnv !== null);
	if (choice === 'cancel') {
		console.log('\nNothing changed.');
		return 0;
	}
	const sections: readonly SectionKey[] =
		choice === 'all' ? allSections(existingEnv !== null) : [choice];

	// The steps this reuses from the 23-step setup wizard each carry their own
	// "Step N of 23"; count this run's sections instead.
	beginSteps(sections.length);
	try {
		return await editSections(sections, {
			repoRoot,
			configPath,
			envPath,
			existing,
			existingEnv,
			inForce
		});
	} finally {
		endSteps();
	}
}

/** A comma-separated node list as a list (blanks dropped). PURE. */
function nodeList(raw: string): string[] {
	return raw
		.split(',')
		.map((u) => u.trim())
		.filter((u) => u.length > 0);
}

/** The node list a service uses: its setting, or the shipped list when none of
 *  its files sets one (both services default to the same list). PURE. */
function nodesInUse(raw: string | undefined): readonly string[] {
	return raw === undefined ? DEFAULT_BLURT_RPC_ENDPOINTS : nodeList(raw);
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);

async function editSections(
	sections: readonly SectionKey[],
	c: {
		readonly repoRoot: string;
		readonly configPath: string;
		readonly envPath: string;
		readonly existing: ExistingConfig;
		readonly existingEnv: ExistingEnv | null;
		readonly inForce: InForce;
	}
): Promise<number> {
	const { repoRoot, configPath, envPath, existing, existingEnv, inForce } = c;
	/** A setting as the indexer gets it now (null: no file sets it). */
	const cur = (key: string): string | null => inForce.indexer.get(key) ?? null;
	const configUpdates: Map<string, string | null> = new Map();
	const envUpdates: Map<string, string | null> = new Map();
	/** Record a setting only when it really differs from the one in force. */
	const setIfChanged = (key: string, value: string | null): boolean => {
		if (cur(key) === value) return false;
		configUpdates.set(key, value);
		return true;
	};
	/** The origin after this run's answers so far (Primary origin comes first). */
	const originNow = (): string =>
		(configUpdates.has('MORPHIT_INSTANCE_ORIGIN')
			? (configUpdates.get('MORPHIT_INSTANCE_ORIGIN') ?? '')
			: (existing.origin ?? '')
		).trim();
	// Whether the operator changed anything that lives in the ON-CHAIN
	// operator-register record (origin, tag, display name, contact, fees
	// account, the alt-network addresses). Those reach other instances only
	// after a fresh `morphit-ops register`, so they drive the re-publish step.
	let originChanged = false;
	let tagChanged = false;
	let nameChanged = false;
	let brandChanged = false;
	let contactChanged = false;
	let feesChanged = false;
	let altChanged = false;
	let newFeesAccount: string | null = null;

	for (const choice of sections) {
		if (choice === 'origin') {
			const origin = await stepOrigin({ current: existing.origin });
			if (setIfChanged('MORPHIT_INSTANCE_ORIGIN', origin)) originChanged = true;
		}
		if (choice === 'alt-networks') {
			step(10, TOTAL_STEPS, 'Alt-network addresses');
			// Each address uses keep-current / clear semantics (Enter keeps the
			// current value, "-" clears it), and is checked like `alt-address`
			// checks it — a wrong or over-long one would stop the indexer.
			explain(
				'Press Enter to keep an address, "-" to remove it, or paste a new one.\n' +
					'To make a new Tor/I2P address (and have this server serve it), use\n' +
					'sudo morphit-ops alt-address instead.'
			);
			// With no public web address, the alt addresses are how people
			// reach the site — and the Tor one is what the registration lists
			// as its address. Removing one then asks first (default No).
			const noOrigin = originNow() === '';
			const reachClear: { confirmClear?: string } = noOrigin
				? {
						confirmClear:
							'Your site has no public web address: this is one of the few ways\n' +
							'    people can reach it.'
					}
				: {};
			const torR = await editField(
				'Tor .onion address',
				'Your v3 hidden-service address (56 chars then ".onion").',
				existing.altNetworks.tor,
				{
					validate: (v) => validateAltAddress('tor', v),
					...(noOrigin
						? {
								confirmClear:
									'Your site has no public web address: this Tor address is how people\n' +
									'    reach it, and what your on-chain registration lists as its address.\n' +
									'    Without it, the registration cannot be re-published.'
							}
						: {})
				}
			);
			// `changed` is true only for a value that differs from the one set now.
			if (torR.changed) {
				configUpdates.set('MORPHIT_INSTANCE_TOR_ADDRESS', torR.value);
				altChanged = true;
			}

			const lokinetR = await editField(
				'Lokinet .loki address',
				'Full .loki address or your ONS name (e.g. "yourbrand.loki").',
				existing.altNetworks.lokinet,
				{
					validate: (v) => validateAltAddress('lokinet', v),
					...reachClear
				}
			);
			if (lokinetR.changed) {
				configUpdates.set('MORPHIT_INSTANCE_LOKINET_ADDRESS', lokinetR.value);
				altChanged = true;
			}

			// I2P has two independent slots — always-resolvable b32 + optional
			// vanity name.  Writing either modern key also clears the legacy single
			// MORPHIT_INSTANCE_I2P_ADDRESS so it can't shadow them.
			const i2pB32R = await editField(
				'I2P b32 address (DOMAIN.b32.i2p)',
				'Your always-resolvable <base32>.b32.i2p address.',
				existing.altNetworks.i2pB32,
				{
					validate: (v) => validateAltAddress('i2p', v),
					...reachClear
				}
			);
			if (i2pB32R.changed) {
				configUpdates.set('MORPHIT_INSTANCE_I2P_B32_ADDRESS', i2pB32R.value);
				if (existing.legacyI2pAddress !== null)
					configUpdates.set('MORPHIT_INSTANCE_I2P_ADDRESS', null);
				altChanged = true;
			}

			const i2pNameR = await editField(
				'I2P vanity name (DOMAIN.i2p)',
				'Optional pretty alias like "yourbrand.i2p" (needs an i2p address-book entry).',
				existing.altNetworks.i2pName,
				{
					validate: validateI2pName,
					...reachClear
				}
			);
			if (i2pNameR.changed) {
				configUpdates.set('MORPHIT_INSTANCE_I2P_NAME_ADDRESS', i2pNameR.value);
				if (existing.legacyI2pAddress !== null)
					configUpdates.set('MORPHIT_INSTANCE_I2P_ADDRESS', null);
				altChanged = true;
			}

			const nostrR = await editField(
				'Nostr pubkey',
				'Your npub… public key for cross-network discovery.',
				existing.altNetworks.nostr,
				{ validate: validateNostr }
			);
			if (nostrR.changed) configUpdates.set('MORPHIT_INSTANCE_NOSTR_PUBKEY', nostrR.value);

			const ensR = await editField(
				'ENS .eth name',
				'A registered .eth name (DOMAIN.eth) pointing at this instance.',
				existing.altNetworks.ens,
				{
					validate: validateEnsName,
					...reachClear
				}
			);
			if (ensR.changed) {
				configUpdates.set('MORPHIT_INSTANCE_ENS_NAME', ensR.value);
				altChanged = true;
			}
		}
		if (choice === 'seo') {
			step(16, TOTAL_STEPS, 'Branding & SEO');
			// All fields use keep-current / clear semantics (Enter keeps, "-"
			// clears), so editing one (e.g. the instance name) never silently
			// wipes the others. Each is checked against what the indexer accepts.
			explain('Press Enter to keep a value, "-" to remove it, or type a new one.');
			const limited =
				(key: string) =>
				(v: string): ValidateResult => {
					const p = fieldProblem(key, v);
					return p === null ? { ok: true, value: v } : { ok: false, reason: p };
				};
			const nameR = await editField(
				'Instance name',
				'The bold name on your directory card — how other instances list you. Keep it the same as the site brand name below unless you have a reason not to.',
				existing.name,
				{
					validate: limited('MORPHIT_INSTANCE_NAME'),
					// Without a name the registration cannot be re-published
					// (register needs MORPHIT_INSTANCE_NAME) — a dead end.
					confirmClear:
						'Without a name your site shows "Morphit", and your on-chain registration\n' +
						'    cannot be re-published until you set one again.'
				}
			);
			if (nameR.changed && setIfChanged('MORPHIT_INSTANCE_NAME', nameR.value)) nameChanged = true;

			// Per-instance SITE brand (docs/BRANDING.md) — distinct from the
			// directory-card name above: this is what the UI calls the site itself
			// ("Sign in to …", "Your … password"). Validated here so a bad value is
			// caught at the prompt, not at apply time.
			const brandR = await editField(
				'Site brand name',
				'What your site calls itself ("Sign in to …", page titles). Unset = "Morphit". Mentions of the Morphit software stay.',
				existing.brandName,
				{
					validate: (v) => {
						const problem = brandNameProblem(v);
						return problem === null ? { ok: true, value: v } : { ok: false, reason: problem };
					}
				}
			);
			if (brandR.changed) {
				// Store the SANITIZED name (’ for ', whitespace collapsed); plain
				// "Morphit" is the unbranded default, so it clears the setting.
				const clean = brandR.value === null ? null : sanitizeBrandName(brandR.value);
				if (
					setIfChanged('MORPHIT_INSTANCE_BRAND_NAME', clean === DEFAULT_BRAND_NAME ? null : clean)
				)
					brandChanged = true;
			}

			const taglineR = await editField(
				'Tagline',
				'One-line subtitle shown on your homepage under the name.',
				existing.tagline,
				{ validate: limited('MORPHIT_INSTANCE_TAGLINE') }
			);
			if (taglineR.changed) setIfChanged('MORPHIT_INSTANCE_TAGLINE', taglineR.value);

			const contactR = await editField(
				'Contact URL',
				'Footer "contact the operator" link — Matrix room, mailto:, Mastodon, etc.',
				existing.contactUrl,
				{
					// v1.16.7 — validate + repair before writing. A bare email (the
					// common mistake) has no scheme, so it is NOT a URL; writing it
					// verbatim used to fail the indexer's config validation and
					// crash-loop the whole instance. Normalize `x@y` → `mailto:x@y`.
					validate: (rawContact) => {
						const normalized = normalizeContactUrl(rawContact);
						if (!normalized)
							return {
								ok: false,
								reason:
									"that isn't a usable contact link. Use a full link with a scheme: mailto:you@example.com,\n" +
									'    https://…, matrix:…, xmpp:…, nostr:…  (a bare email alone is not a URL)'
							};
						if (normalized !== rawContact)
							console.log(
								`  → repaired "${sanitizeForTerm(rawContact)}" to "${sanitizeForTerm(normalized)}"`
							);
						return { ok: true, value: normalized };
					}
				}
			);
			// Removed: an empty value (the indexer then shows no contact link).
			if (contactR.changed && setIfChanged('MORPHIT_INSTANCE_CONTACT_URL', contactR.value ?? ''))
				contactChanged = true;

			const seoTitleR = await editField(
				'SEO <title>',
				'Homepage browser-tab / search-result title. Leave unset for the default.',
				existing.seo.title,
				{ validate: limited('MORPHIT_INSTANCE_SEO_TITLE') }
			);
			if (seoTitleR.changed) setIfChanged('MORPHIT_INSTANCE_SEO_TITLE', seoTitleR.value);

			const seoDescR = await editField(
				'SEO <meta description>',
				'One sentence (~150 chars) for search results + social link previews.',
				existing.seo.description,
				{ validate: limited('MORPHIT_INSTANCE_SEO_DESCRIPTION') }
			);
			if (seoDescR.changed) setIfChanged('MORPHIT_INSTANCE_SEO_DESCRIPTION', seoDescR.value);

			const seoKwR = await editField(
				'SEO <meta keywords>',
				'Comma-separated keywords. Optional; most search engines ignore these now.',
				existing.seo.keywords,
				{ validate: limited('MORPHIT_INSTANCE_SEO_KEYWORDS') }
			);
			if (seoKwR.changed) setIfChanged('MORPHIT_INSTANCE_SEO_KEYWORDS', seoKwR.value);
		}
		if (choice === 'listing-fee') {
			// What the indexer runs with now: the settings files, else its own
			// defaults — so Enter keeps exactly that, and only a real change is
			// written.
			const d = INDEXER_LISTING_FEE_DEFAULTS;
			const num = (k: string): number | null => {
				const v = cur(k);
				const n = v === null ? NaN : Number(v);
				return Number.isFinite(n) ? n : null;
			};
			const now = {
				btcSatoshis: num('MORPHIT_INDEXER_BTC_FEE_SATOSHIS') ?? d.btcSatoshis,
				xmrPiconero: num('MORPHIT_INDEXER_XMR_FEE_PICONERO') ?? d.xmrPiconero,
				fallbackBlurtPriceUsd:
					num('MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR') ?? d.fallbackBlurtPriceUsd,
				denominationFiat: cur('MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT') ?? d.denominationFiat
			};
			// The USD target is not a setting: init keeps it only as a comment
			// ("# Target was: $0.25 USD"), shown when new amounts are worked out.
			const target = /^#\s*Target was:\s*\$([0-9.]+)\s*USD/m.exec(existing.text);
			const fee = await stepListingFee({
				current: { targetUsd: target ? Number(target[1]) : null, ...now }
			});
			const setNum = (k: string, n: number, was: number): void => {
				if (n !== was) configUpdates.set(k, String(n));
			};
			setNum('MORPHIT_INDEXER_BTC_FEE_SATOSHIS', fee.btcSatoshis, now.btcSatoshis);
			setNum('MORPHIT_INDEXER_XMR_FEE_PICONERO', fee.xmrPiconero, now.xmrPiconero);
			setNum(
				'MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR',
				fee.fallbackBlurtPriceUsd,
				now.fallbackBlurtPriceUsd
			);
			if (fee.denominationFiat !== now.denominationFiat)
				configUpdates.set('MORPHIT_INDEXER_PRICE_FEED_DENOMINATION_FIAT', fee.denominationFiat);
		}
		if (choice === 'fees-account') {
			// Where BLURT listing fees land (the operator earns 90% of them).
			// Enter keeps the account in force now. With none (or one the
			// indexer cannot use) the fees go to the canonical treasury, and
			// Enter leaves that as it is.
			const currentFees = (cur('MORPHIT_INDEXER_FEE_RECIPIENT') ?? '').trim();
			// The indexer's own rule for a usable account (else: the treasury).
			const usable = !resolveFeeRecipientValue(currentFees).fellBack;
			const feesAccount = await stepFeesAccount(usable ? currentFees : undefined, undefined, {
				keepUnset:
					currentFees === ''
						? 'none is set, so the fees go to the Morphit treasury'
						: `the one set (${sanitizeForTerm(currentFees)}) is not a usable account name, so the fees go to the Morphit treasury`
			});
			if (feesAccount !== '' && feesAccount !== currentFees) {
				configUpdates.set('MORPHIT_INDEXER_FEE_RECIPIENT', feesAccount);
				feesChanged = true;
				newFeesAccount = feesAccount;
			}
		}
		if (choice === 'operator-tag') {
			// The tag is permanent once registered: read the one on chain (from
			// this node's own indexer) so Enter keeps it, and a different one is
			// refused before it can break the relay's earnings.
			const account = cur('MORPHIT_RELAY_ACCOUNT') ?? process.env.MORPHIT_RELAY_ACCOUNT ?? null;
			const registered =
				account !== null && account.length > 0
					? await withSpinner('Checking which tag your account registered on chain…', () =>
							fetchRegisteredTag(account)
						)
					: null;
			const op = await stepOperatorTag(existing.origin ?? null, {
				current: existing.operatorTag,
				registered
			});
			if (op.tag !== '' && setIfChanged('MORPHIT_INSTANCE_OPERATOR_TAG', op.tag)) tagChanged = true;
		}
		if (choice === 'rpc') {
			if (existingEnv === null) {
				console.log(
					'\n✗ Cannot edit RPC endpoints without a morphit.env file.\n' +
						'Re-run morphit-ops init to generate one, or set\n' +
						'MORPHIT_INDEXER_RPC_ENDPOINTS via your SystemD/Docker config.'
				);
				return 1;
			}
			// The lists in force: the indexer's (on an Ansible server it is in
			// /etc/morphit/indexer.env, read last) and the relay's. Unset, each
			// service uses the shipped list.
			const idxRaw = inForce.indexer.get('MORPHIT_INDEXER_RPC_ENDPOINTS');
			const relayRaw = inForce.relay.get('MORPHIT_RELAY_BLURT_RPC');
			const idxNow = nodesInUse(idxRaw);
			const relayNow = nodesInUse(relayRaw);
			const relayHere = inForce.relayHere;
			// `edit` offers the indexer restart itself once the file is written.
			// An empty list in force is how a hidden-only node says "no public
			// nodes": never offer the clearnet defaults there.
			const noPublic = idxRaw !== undefined && idxNow.length === 0;
			const newList = await stepRpcEndpoints(idxRaw === undefined ? null : nodeList(idxRaw), {
				restartOffered: true,
				hiddenOnly: noPublic || (inForce.live && isHiddenOnlyNode())
			});
			if (!sameList(newList, idxNow)) {
				envUpdates.set('MORPHIT_INDEXER_RPC_ENDPOINTS', newList.join(','));
				// One answer for both services: the relay gets the same list, so
				// the two never drift apart.
				if (relayHere && !sameList(newList, relayNow))
					envUpdates.set('MORPHIT_RELAY_BLURT_RPC', newList.join(','));
			} else if (relayHere && idxNow.length > 0 && !sameList(relayNow, idxNow)) {
				// Unchanged here, but the relay already uses a different list.
				console.log('');
				console.log('  The relay uses a different list of Blurt nodes than the indexer:');
				console.log(`    indexer: ${sanitizeForTerm(idxNow.join(','))}`);
				console.log(
					`    relay:   ${relayNow.length > 0 ? sanitizeForTerm(relayNow.join(',')) : '(none)'}`
				);
				if (await askYesNo('  Give the relay the same list as the indexer?', false))
					envUpdates.set('MORPHIT_RELAY_BLURT_RPC', idxNow.join(','));
				else console.log('    Left as it is.');
			}
		}
	}

	if (configUpdates.size === 0 && envUpdates.size === 0) {
		console.log('\nNothing changed.');
		return 0;
	}

	// ─── Review ────
	const rule = '━'.repeat(58);
	console.log('\n' + rule);
	console.log('Review');
	console.log(rule);
	console.log('');
	const show = (v: string | null | undefined): string =>
		v === null || v === undefined ? '(not set)' : v === '' ? '(empty)' : sanitizeForTerm(v);
	// "was": the value in force, as the service gets it (not just this file's
	// line) — with what applies when no file sets it.
	const was = (k: string): string => {
		const v = k === 'MORPHIT_RELAY_BLURT_RPC' ? inForce.relay.get(k) : inForce.indexer.get(k);
		if (v !== undefined) return show(v);
		const dflt = UNSET_MEANS[k];
		return dflt === undefined ? '(not set)' : `(not set: ${dflt})`;
	};
	for (const [k, v] of [...configUpdates, ...envUpdates]) {
		console.log(`  ${KEY_LABEL[k] ?? k}`);
		console.log(`      was: ${was(k)}`);
		console.log(`      now: ${v === null ? '(removed)' : show(v)}`);
	}
	console.log('');
	const confirmed = await askYesNo('Apply these changes?', true);
	if (!confirmed) {
		console.log('\nNothing changed.');
		return 0;
	}

	// ─── Write back ────
	// Two files may be touched: morphit.config.env (origin / alt /
	// SEO updates) and morphit.env (RPC updates only).  Each gets
	// its own atomic backup-and-rename cycle.  If either write
	// fails we surface the error AND the backup path so the
	// operator can recover; the OTHER file's write is still
	// committed if it succeeded first.
	const written: string[] = [];
	if (configUpdates.size > 0) {
		const result = atomicEnvWrite(configPath, existing.text, configUpdates, 'parseEnv');
		if (!result.ok) {
			// result.message includes err.message from
			// the filesystem layer and may reference paths.
			// Sanitize at display.
			console.log(`\n✗ ${sanitizeForTerm(result.message)}`);
			if (needsSudo(result.message)) console.log(`  ${SUDO_HINT}`);
			return 3;
		}
		console.log(`\n  ✓ wrote ${configPath}`);
		console.log(`  ✓ backed up previous version to ${result.backupPath}`);
		written.push(configPath);
	}
	if (envUpdates.size > 0) {
		if (existingEnv === null) {
			// Should be impossible given the guards in pickSection
			// + the choice handler above, but defense-in-depth
			// against future code that sets envUpdates without
			// consulting existingEnv first.
			console.log('\n✗ Internal error: env updates set with no env file loaded.');
			return 3;
		}
		const result = atomicEnvWrite(envPath, existingEnv.text, envUpdates, 'bash');
		if (!result.ok) {
			console.log(`\n✗ ${sanitizeForTerm(result.message)}`);
			if (needsSudo(result.message)) console.log(`  ${SUDO_HINT}`);
			return 3;
		}
		console.log(`\n  ✓ wrote ${envPath}`);
		console.log(`  ✓ backed up previous version to ${result.backupPath}`);
		written.push(envPath);
	}
	// The mode read back from the file, not assumed (it is 0640 on an
	// Ansible install, 0600 on an `init` one).
	for (const p of written) {
		try {
			const mode = (statSync(p).mode & 0o777).toString(8).padStart(4, '0');
			console.log(`  ✓ ${p.split('/').pop()} kept its owner and permissions (mode ${mode})`);
		} catch {
			/* the write itself was confirmed above */
		}
	}
	console.log('');

	// The indexer + relay read these env files ONCE at boot, so a change
	// only goes live after a restart.  Offer to restart the affected
	// service(s) now — default yes — and do it. A file a service reads AFTER
	// these (an old /etc/morphit/indexer.env copy, the Ansible files) is
	// cleared first, so the restart really brings the new values, and the
	// running services are then checked.
	const unitsToRestart: ServiceUnit[] = ['morphit-indexer'];
	if (originChanged || envUpdates.has('MORPHIT_RELAY_BLURT_RPC'))
		unitsToRestart.push('morphit-relay');
	const outcome = await restartAndCheck(
		[...configUpdates.keys(), ...envUpdates.keys()],
		unitsToRestart,
		{
			offer: (units) => offerRestart(units),
			print: (line) => console.log(line === '' ? '' : `  ${sanitizeForTerm(line)}`),
			// Only the installed settings file is what the services read; an edit
			// of another copy (--out) has nothing to clear or check against.
			envs: inForce.live ? liveServiceEnvs() : []
		}
	);

	// The site brand name lives in the SERVED frontend (re-branded in place,
	// docs/BRANDING.md), so it also needs `branding apply` — offer it now.
	if (brandChanged) {
		console.log('');
		const applyNow = await askYesNo('Apply the new site brand name to your live site now?', true);
		if (applyNow) {
			await runBranding({ flags: {}, positional: ['apply'], colorEnabled: false });
		} else {
			console.log(
				'  Later, on this server: sudo morphit-ops branding apply  (every upgrade also re-applies it).'
			);
		}
	}

	// the served pages, sitemap and robots.txt name the instance's
	// origin (or its onion on a hidden-only node); a changed origin or Tor
	// address is put on the live site now.
	if (originChanged || configUpdates.has('MORPHIT_INSTANCE_TOR_ADDRESS')) {
		try {
			const webRoot = resolveWebRoot(process.env);
			const r = syncInstanceOrigin(
				{
					info: (m) => console.log(`  ${m}`),
					warn: (m) => console.log(`  ! ${m}`),
					spinner: (l) => startDotsSpinner(l)
				},
				{ installDir: repoRoot, webRoot: existsSync(webRoot) ? webRoot : null }
			);
			if (r.detail !== '') console.log(`\n  ${r.verified ? '' : '! '}${sanitizeForTerm(r.detail)}`);
		} catch (err) {
			console.log(
				`\n  ! The site's origin was not updated (${sanitizeForTerm(err instanceof Error ? err.message : String(err))}). On this server run: sudo morphit-ops upgrade`
			);
		}
	}

	// A new Tor / I2P address only reaches visitors when this server's Tor /
	// i2pd holds its key: check, and say so when it does not.
	const torNew = configUpdates.get('MORPHIT_INSTANCE_TOR_ADDRESS');
	if (torNew) await reportHosting('tor', torNew);
	const i2pNew = configUpdates.get('MORPHIT_INSTANCE_I2P_B32_ADDRESS');
	if (i2pNew) await reportHosting('i2p', i2pNew);

	// The one easy-to-miss second step: these values are part of the ON-CHAIN
	// operator-register record; editing the local config does NOT update what
	// other Morphit instances show. Offer to re-publish right here — but only
	// when a re-publish can work (register needs a name and a web address).
	if (altChanged || originChanged || tagChanged || nameChanged || contactChanged || feesChanged) {
		const parts: string[] = [];
		if (originChanged) parts.push('origin');
		if (tagChanged) parts.push('operator tag');
		if (nameChanged) parts.push('display name');
		if (contactChanged) parts.push('contact URL');
		if (feesChanged) parts.push('fees account');
		if (altChanged) parts.push('alt-network addresses');
		// `register` reads these from the files just written; make sure no older
		// value in this process's environment stands in for one.
		for (const [k, v] of configUpdates) {
			if (v === null) delete process.env[k];
			else process.env[k] = v;
		}
		if (newFeesAccount !== null) process.env.MORPHIT_INDEXER_FEE_RECIPIENT = newFeesAccount;
		const whatChanged =
			parts.length === 1
				? parts[0]
				: `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
		console.log('');
		console.log(rule);
		console.log('  IMPORTANT — one more step to reach the federation');
		console.log(rule);
		console.log('');
		console.log(`  You changed your ${whatChanged}.  That is part of your`);
		console.log('  on-chain operator registration — the record other Morphit');
		console.log('  instances read to list you in their /instances directory.');
		console.log('');
		console.log('  The local edit above does NOT update that on-chain record.');
		if (feesChanged) {
			console.log('');
			console.log('  Your fees account matters most: other Morphit instances accept the');
			console.log('  90% share of your users’ BLURT fees only at the account in that');
			console.log('  record, so until it is re-published they hide those orders.');
		}
		console.log('');

		// Each as it is in force now: the new value where it was just changed,
		// else what the settings files give (this process's environment only
		// where no file sets it).
		const eff = (k: string): string =>
			(configUpdates.has(k)
				? (configUpdates.get(k) ?? '')
				: (cur(k) ?? process.env[k] ?? '')
			).trim();
		const blockers = registrationBlockers({
			MORPHIT_INSTANCE_NAME: eff('MORPHIT_INSTANCE_NAME'),
			MORPHIT_INSTANCE_ORIGIN: eff('MORPHIT_INSTANCE_ORIGIN'),
			MORPHIT_INSTANCE_TOR_ADDRESS: eff('MORPHIT_INSTANCE_TOR_ADDRESS')
		});
		if (blockers.length > 0) {
			console.log('  It cannot be re-published yet:');
			for (const b of blockers) console.log(`    • ${b}`);
			console.log('');
			console.log('  Set it with  sudo morphit-ops edit  (on this server), then publish with');
			console.log('  sudo morphit-ops register');
		} else {
			if (eff('MORPHIT_INSTANCE_ORIGIN') === '') {
				const onion = eff('MORPHIT_INSTANCE_TOR_ADDRESS').toLowerCase();
				console.log(`  With no public origin set, your registration lists your Tor address`);
				console.log(`  (http://${sanitizeForTerm(onion)}) as your site's address.`);
				console.log('');
			}
			// Offer to re-publish right now — the env + Active key are already
			// resolvable in this context (runRegister loads the same instance env
			// this edit just read), so the operator never has to know the command.
			await offerRepublish({
				askYesNo,
				register: (flags) => runRegister({ flags, positional: [] }),
				print: (l) => console.log(l),
				restarted: outcome.restarted,
				live: outcome.live
			});
		}
	}
	console.log('');

	return 0;
}

/** What stops `morphit-ops register` from publishing (it needs a name and a web
 *  address: the origin, or the Tor address on a hidden-only node), in plain
 *  words. Empty: nothing. PURE. */
export function registrationBlockers(env: {
	readonly MORPHIT_INSTANCE_NAME: string;
	readonly MORPHIT_INSTANCE_ORIGIN: string;
	readonly MORPHIT_INSTANCE_TOR_ADDRESS: string;
}): string[] {
	const out: string[] = [];
	if (env.MORPHIT_INSTANCE_NAME.trim() === '')
		out.push('it has no instance name (Branding & SEO → Instance name)');
	if (registerOrigin(env as unknown as NodeJS.ProcessEnv) === undefined)
		out.push('it has no public web address (Primary origin)');
	return out;
}

/** After an edit of an on-chain field: offer to re-publish the registration,
 *  and say what happened. Declined at register's own question or stopped with
 *  Ctrl+C there is "not published" (both used to read as published). */
export async function offerRepublish(d: {
	askYesNo: (q: string, defaultYes: boolean) => Promise<boolean>;
	register: (flags: Record<string, string>) => Promise<number>;
	print: (s: string) => void;
	restarted: boolean;
	/** Whether the running service was CHECKED to have the new value: true
	 *  confirmed, false found otherwise, null/absent not checked. */
	live?: boolean | null;
}): Promise<'published' | 'not-published' | 'failed' | 'later'> {
	const broadcastNow = await d.askYesNo(
		'Broadcast this change to the chain now so the federation sees it?',
		true
	);
	if (broadcastNow) {
		d.print('');
		// Ctrl+C at one of register's questions: nothing was published.
		let rc: number;
		try {
			// Just answered yes: register's own "Publish this registration?"
			// defaults to yes too (it defaulted to No, so Enter, Enter was "Not
			// published" — review, 2026-10-12).
			rc = await d.register({ 'default-yes': 'true' });
		} catch (err) {
			if (!isAbortError(err)) throw err;
			rc = REGISTER_DECLINED;
		}
		if (rc === REGISTER_DECLINED) {
			d.print('');
			d.print('  Not published. Re-publish it whenever you like with:');
			d.print('');
			d.print('      sudo morphit-ops register');
			return 'not-published';
		}
		if (rc === 0) {
			d.print('');
			d.print('  ✓ Registration re-published. Other instances will show the');
			d.print('    new value once their indexers pick it up (usually minutes).');
			return 'published';
		}
		d.print('');
		d.print('  The broadcast did not complete. You can retry any time with:');
		d.print('');
		d.print('      sudo morphit-ops register');
		return 'failed';
	}
	d.print('');
	d.print('  No problem — re-publish it whenever you like with:');
	d.print('');
	d.print('      sudo morphit-ops register');
	d.print('');
	d.print('  (Until you do, other instances keep showing your old value.');
	if (d.restarted && d.live === true) {
		d.print('  Your own instance already uses the new value — checked after');
		d.print('  the restart above.)');
	} else if (d.restarted && d.live === false) {
		d.print('  Your own instance was restarted but does not use the new value');
		d.print('  yet — see what the check above found.)');
	} else if (d.restarted) {
		d.print('  Your own instance was restarted; whether it uses the new value');
		d.print('  could not be checked from here.)');
	} else {
		d.print('  Your own instance picks up the new value once it is restarted;');
		d.print('  on this server: sudo systemctl restart morphit-indexer)');
	}
	return 'later';
}

/** Atomic env-file write helper.  Backs up the original to a
 *  timestamped sibling, writes the new text to a `.tmp` file with
 *  the original's owner + mode (0600 for a new file) + fsync, then renames.  Used for BOTH
 *  morphit.config.env and morphit.env so the two paths share the
 *  same durability + permissions guarantees.  Returns ok on
 *  success or { ok: false, message } on any failure; the caller
 *  surfaces the message verbatim. */
interface AtomicWriteSuccess {
	readonly ok: true;
	readonly backupPath: string;
}
interface AtomicWriteFailure {
	readonly ok: false;
	readonly message: string;
}
type AtomicWriteResult = AtomicWriteSuccess | AtomicWriteFailure;

// Exported so the alt-address wizard (commands/altAddress.ts) persists its
// one MORPHIT_INSTANCE_*_ADDRESS update through the SAME atomic backup →
// fsync → rename → 600 path, rather than duplicating this delicate write.
export function atomicEnvWrite(
	path: string,
	originalText: string,
	updates: Map<string, string | null>,
	consumer: EnvFileConsumer = 'bash'
): AtomicWriteResult {
	const backupPath = `${path}.bak-${Date.now()}`;
	try {
		copyFileSync(path, backupPath);
		chmodSync(backupPath, 0o600);
	} catch (err) {
		return {
			ok: false,
			message: `Could not back up ${path}: ${err instanceof Error ? err.message : String(err)}`
		};
	}

	const newText = applyUpdates(originalText, updates, consumer);
	const tmpPath = `${path}.tmp`;
	try {
		writeFileSync(tmpPath, newText, { mode: 0o600, flag: 'w' });
		chmodSync(tmpPath, 0o600);
		// Keep the file's owner, group and mode (e.g. root:morphit 0640, which
		// lets the unprivileged services read it); a fresh file stays 0600.
		keepOwnerAndMode(path, tmpPath);
		// Audit 2026-05 finding NEW-9-12: fsync the tmp file before
		// rename so contents are durable on disk. Without this, a
		// power loss between write and rename can leave the renamed
		// file with stale or zero-length contents after reboot.
		// Best-effort — not all filesystems honor fsync semantics
		// (notably some FUSE mounts). Failure here is logged but
		// not fatal: we still rename and let the filesystem do its
		// best.
		try {
			const fd = openSync(tmpPath, 'r');
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		} catch (fsyncErr) {
			console.log(
				`  (note: fsync on ${tmpPath} failed: ${sanitizeForTerm(
					fsyncErr instanceof Error ? fsyncErr.message : String(fsyncErr)
				)}; proceeding anyway)`
			);
		}
		renameSync(tmpPath, path);
	} catch (err) {
		return {
			ok: false,
			message: `Failed to write ${path}: ${
				err instanceof Error ? err.message : String(err)
			}\nBackup at ${backupPath} is intact.`
		};
	}

	return { ok: true, backupPath };
}

/** Read an existing morphit.config.env (its text is rewritten later, lines
 *  that aren't KV-shaped — comments, blanks — kept verbatim by `applyUpdates`)
 *  and the fields this command can edit, each as the services get it now
 *  (`get`: the value in force, null when no file sets it). */
function loadExisting(path: string, get: (key: string) => string | null): ExistingConfig {
	const text = readFileSync(path, 'utf-8');
	const kv = { get: (k: string): string | undefined => get(k) ?? undefined };

	// I2P split keys, with the legacy single key routed by suffix so an
	// operator who configured i2p before the split still sees their value.
	const legacyI2p = kv.get('MORPHIT_INSTANCE_I2P_ADDRESS') ?? null;
	const i2pB32 =
		kv.get('MORPHIT_INSTANCE_I2P_B32_ADDRESS') ??
		(legacyI2p !== null && legacyI2p.endsWith('.b32.i2p') ? legacyI2p : null);
	const i2pName =
		kv.get('MORPHIT_INSTANCE_I2P_NAME_ADDRESS') ??
		(legacyI2p !== null && legacyI2p.endsWith('.i2p') && !legacyI2p.endsWith('.b32.i2p')
			? legacyI2p
			: null);

	return {
		path,
		text,
		origin: kv.get('MORPHIT_INSTANCE_ORIGIN') ?? null,
		name: kv.get('MORPHIT_INSTANCE_NAME') ?? null,
		brandName: kv.get('MORPHIT_INSTANCE_BRAND_NAME') ?? null,
		tagline: kv.get('MORPHIT_INSTANCE_TAGLINE') ?? null,
		contactUrl: kv.get('MORPHIT_INSTANCE_CONTACT_URL') ?? null,
		altNetworks: {
			tor: kv.get('MORPHIT_INSTANCE_TOR_ADDRESS') ?? null,
			lokinet: kv.get('MORPHIT_INSTANCE_LOKINET_ADDRESS') ?? null,
			i2pB32,
			i2pName,
			nostr: kv.get('MORPHIT_INSTANCE_NOSTR_PUBKEY') ?? null,
			ens: kv.get('MORPHIT_INSTANCE_ENS_NAME') ?? null
		},
		legacyI2pAddress: legacyI2p,
		seo: {
			title: kv.get('MORPHIT_INSTANCE_SEO_TITLE') ?? null,
			description: kv.get('MORPHIT_INSTANCE_SEO_DESCRIPTION') ?? null,
			keywords: kv.get('MORPHIT_INSTANCE_SEO_KEYWORDS') ?? null
		},
		listingFee: {
			btcSatoshis: kv.get('MORPHIT_INDEXER_BTC_FEE_SATOSHIS') ?? null,
			xmrPiconero: kv.get('MORPHIT_INDEXER_XMR_FEE_PICONERO') ?? null,
			fallbackBlurtPriceUsd: kv.get('MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR') ?? null
		},
		operatorTag: kv.get('MORPHIT_INSTANCE_OPERATOR_TAG') ?? null
	};
}

/** Parse an existing morphit.env, extracting only the keys this
 *  command can edit.  Currently just MORPHIT_INDEXER_RPC_ENDPOINTS;
 *  other keys in the file are preserved verbatim by applyUpdates
 *  later.  Returns null inside a tuple when the key is absent so
 *  the editor knows whether to surface the canonical default. */
function loadExistingEnv(path: string): ExistingEnv {
	const text = readFileSync(path, 'utf-8');
	const kv = parseKvLines(text);
	const rawRpc = kv.get('MORPHIT_INDEXER_RPC_ENDPOINTS') ?? null;
	let rpcEndpoints: readonly string[] | null = null;
	if (rawRpc !== null && rawRpc.length > 0) {
		const parsed = parseRpcEndpoints(rawRpc);
		// Even if the persisted value is malformed (e.g., manual
		// edit corruption), still load — the operator can fix it
		// via the wizard.  Display "(unparseable)" in printCurrent
		// to flag the issue.
		rpcEndpoints = typeof parsed === 'string' ? null : parsed;
	}
	return { path, text, rpcEndpoints };
}

/** Minimal parser — handles bare `KEY=value` and quoted
 *  `KEY="value with spaces"` forms.  Comment lines (starting
 *  with #) and blank lines are skipped.  Doesn't try to handle
 *  multi-line values; the wizard's writer never emits those. */
function parseKvLines(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		if (line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		out.set(key, value);
	}
	return out;
}

/** Apply key→value-or-null updates to the original file text.
 *  Strategy:
 *    - For each updated key, if it already appears in the file:
 *      replace the matching line in place (preserves position,
 *      comments above it, etc.).
 *    - If the key doesn't appear and the new value is non-null:
 *      append it to the end with a section header.
 *    - If the new value is null and the key doesn't appear: no-op.
 *    - If the new value is null and the key DOES appear: remove
 *      that line. */
type EnvFileConsumer = 'parseEnv' | 'bash';

function applyUpdates(
	original: string,
	updates: Map<string, string | null>,
	consumer: EnvFileConsumer = 'bash'
): string {
	const lines = original.split('\n');
	const seen = new Set<string>();
	const newLines: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith('#')) {
			newLines.push(line);
			continue;
		}
		const eq = trimmed.indexOf('=');
		if (eq <= 0) {
			newLines.push(line);
			continue;
		}
		const key = trimmed.slice(0, eq).trim();
		if (!updates.has(key)) {
			newLines.push(line);
			continue;
		}
		const newValue = updates.get(key);
		seen.add(key);
		if (newValue === null || newValue === undefined) {
			// Remove the line entirely.  The surrounding heading
			// comment may end up orphaned, but that's harmless and
			// less surprising than aggressive comment-deletion.
			continue;
		}
		newLines.push(`${key}=${quoteValue(newValue, consumer)}`);
	}

	// Append any updates that didn't appear in the original.
	const toAppend: Array<[string, string]> = [];
	for (const [k, v] of updates) {
		if (seen.has(k)) continue;
		if (v === null) continue;
		toAppend.push([k, v]);
	}
	if (toAppend.length > 0) {
		// Make sure there's exactly one blank line before our
		// appended section.
		while (newLines.length > 0 && newLines[newLines.length - 1]!.trim() === '') {
			newLines.pop();
		}
		newLines.push('');
		newLines.push('# ──────────────────────────────────────────────────────');
		newLines.push("# Added by 'morphit-ops edit'");
		newLines.push('# ──────────────────────────────────────────────────────');
		for (const [k, v] of toAppend) {
			newLines.push(`${k}=${quoteValue(v, consumer)}`);
		}
		newLines.push('');
	}

	// Ensure trailing newline.
	let joined = newLines.join('\n');
	if (!joined.endsWith('\n')) joined += '\n';
	return joined;
}

/** Quote a value for the env file.  v2: prefers single-
 *  quoted form in BOTH consumer modes since single-quoted handles
 *  `$`/`(`/`"`/etc. literally in both parseEnv and bash.  Differs
 *  only in apostrophe handling:
 *
 *  - 'bash' consumer: POSIX close-escape-reopen idiom `'\''` for
 *    embedded apostrophes (bash understands; parseEnv doesn't).
 *  - 'parseEnv' consumer (morphit.config.env — read by node's parseEnv
 *    AND sourced by bash in the systemd units): double-quoted when the
 *    value contains `'` but nothing bash would expand inside double
 *    quotes; otherwise `'` → `’` and single-quoted (v1.19.0).
 *
 *  Symmetric with init/render.ts:quote() — both write paths must
 *  produce identical env-file output for the same (value, consumer)
 *  pair. */
function quoteValue(v: string, consumer: EnvFileConsumer = 'bash'): string {
	if (v.length === 0) return "''";
	if (/^[A-Za-z0-9_./:@\-+]+$/.test(v)) return v;
	if (consumer === 'parseEnv') {
		if (!v.includes("'")) {
			return `'${v}'`;
		}
		// morphit.config.env is NOT parseEnv-only — the
		// indexer/relay/matrix-bot systemd units SOURCE it with bash (as root).
		// Inside double quotes bash still expands `$…`, `$(…)` and backticks, so
		// the double-quoted fallback is only safe when none of those can occur.
		// Otherwise the ASCII apostrophe becomes the typographic ’ (reads the
		// same) and the value is single-quoted, which both readers take
		// literally.
		if (!/[$`\\"!]/.test(v)) return `"${v}"`;
		return `'${v.replace(/'/g, '\u2019')}'`;
	}
	// Bash consumer.
	const esc = v.replace(/'/g, "'\\''");
	return `'${esc}'`;
}

/** Test-only export.  Smoke runner imports this to verify the
 *  parser+applier without needing real file I/O. */
/**
 * The env keys an RPC-list edit writes. PURE. The indexer's always; the
 * relay's too whenever the file carries it — which every `init`-rendered file
 * does, because init writes both from one answer. A file without the relay line
 * (a hand-rolled one, or a split deployment) is left without it: adding a key
 * the operator never had is not this edit's call.
 */
export function rpcEnvUpdates(
	existingText: string,
	newList: readonly string[]
): Map<string, string> {
	const out = new Map<string, string>([['MORPHIT_INDEXER_RPC_ENDPOINTS', newList.join(',')]]);
	if (parseKvLines(existingText).has('MORPHIT_RELAY_BLURT_RPC')) {
		out.set('MORPHIT_RELAY_BLURT_RPC', newList.join(','));
	}
	return out;
}

export { applyUpdates as _testApplyUpdates };
export { loadExistingEnv as _testLoadExistingEnv };
export { atomicEnvWrite as _testAtomicEnvWrite };

/** Every section, in order — what "All of the above" runs. */
function allSections(rpcAvailable: boolean): SectionKey[] {
	return [
		'origin',
		'alt-networks',
		'seo',
		'listing-fee',
		'fees-account',
		'operator-tag',
		...(rpcAvailable ? (['rpc'] as const) : [])
	];
}

async function pickSection(rpcAvailable: boolean): Promise<SectionKey | 'all' | 'cancel'> {
	const rule = '━'.repeat(58);
	console.log('');
	console.log(rule);
	console.log('What do you want to edit?');
	console.log(rule);
	console.log('');

	// Built from one list so adding a section touches one place. RPC is
	// offered only when morphit.env exists (a managed deployment may have none).
	const sections: ReadonlyArray<{
		key: SectionKey | 'all' | 'cancel';
		label: string;
		description: string;
	}> = [
		{
			key: 'origin',
			label: 'Primary origin',
			description:
				'The public HTTPS address people use to reach your\n' +
				'     instance.  Pick this if your domain was seized or you\n' +
				'     moved hosts.'
		},
		{
			key: 'alt-networks',
			label: 'Alt-network addresses',
			description: 'Tor / Lokinet / I2P / Nostr / ENS addresses shown in\n' + '     your footer.'
		},
		{
			key: 'seo',
			label: 'Branding & SEO',
			description:
				'Instance name, site brand name, tagline, contact URL,\n' +
				'     and the homepage title/description/keywords.'
		},
		{
			key: 'listing-fee',
			label: 'Listing fee + fallback BLURT price',
			description:
				'The BTC/XMR listing-fee amounts, the fallback\n' +
				'     BLURT/USD price (used during price-feed outages) and\n' +
				'     the unit prices are shown in.'
		},
		{
			key: 'fees-account',
			label: 'Fees account (where BLURT listing fees land)',
			description:
				'The Blurt account your BLURT listing fees are paid\n' +
				'     into (you earn 90% of them).  It must be a valid\n' +
				'     Blurt account name.'
		},
		{
			key: 'operator-tag',
			label: 'Operator tag (federation attribution)',
			description:
				"Your instance's permanent federation identity.  Once\n" +
				'     registered on chain it cannot change; pick this to\n' +
				'     put a drifted setting back to your registered tag.'
		},
		...(rpcAvailable
			? [
					{
						key: 'rpc' as const,
						label: 'Blurt RPC endpoints',
						description:
							'The Blurt nodes the indexer and relay connect to.\n' +
							'     Pick this when a node went offline or a new one\n' +
							'     came online.'
					}
				]
			: []),
		{
			key: 'all',
			label: 'All of the above',
			description: `Every section above, one after another (${allSections(rpcAvailable).length} sections).`
		},
		{ key: 'cancel', label: 'Cancel', description: 'Leave without changing anything.' }
	];

	explain(
		'Each option re-asks only its own questions; everything else in\n' +
			'your settings stays exactly as it is.  Press Ctrl+C at any time\n' +
			'to stop without writing anything.\n' +
			'\n' +
			sections.map((s, i) => `  ${i + 1}. ${s.label}\n     ${s.description}`).join('\n')
	);

	// The list is printed once, above, with its descriptions.
	const idx = await askChoice(
		'Pick a number',
		sections.map((s) => s.label),
		sections.length - 1,
		{ showList: false }
	);
	return sections[idx]?.key ?? 'cancel';
}

/** Edit one optional text field with keep-current / clear semantics. Shows
 *  the current value, then interprets the answer:
 *    - empty (just Enter) → keep current, report no change
 *    - "-"                → clear (after a confirmation, when the caller
 *                           says removing it has a consequence)
 *    - anything else      → the trimmed typed value, once `validate` accepts
 *                           it (a refused one is asked again)
 *  Quoting (spaces etc.) is handled later by quoteValue at write time, so the
 *  operator can type a value with spaces safely — unlike a raw hand-edit. */
async function editField(
	label: string,
	hint: string,
	current: string | null,
	opts: {
		readonly validate?: (v: string) => ValidateResult;
		readonly confirmClear?: string;
	} = {}
): Promise<{ readonly changed: boolean; readonly value: string | null }> {
	console.log('');
	console.log(`  ${label}`);
	if (hint.length > 0) console.log(`    ${hint}`);
	console.log(`    Current: ${current !== null ? sanitizeForTerm(current) : '(unset)'}`);
	for (;;) {
		const ans = (await ask('    New value ([Enter] to keep, "-" to clear)', '')).trim();
		if (ans.length === 0) return { changed: false, value: current };
		if (ans === '-') {
			if (current === null) return { changed: false, value: null };
			if (opts.confirmClear !== undefined) {
				console.log(`    ${opts.confirmClear}`);
				const sure = await askYesNo(`    Really remove your ${label.toLowerCase()}?`, false);
				if (!sure) {
					console.log('    Kept it.');
					return { changed: false, value: current };
				}
			}
			return { changed: true, value: null };
		}
		let value = ans;
		if (opts.validate !== undefined) {
			const r = opts.validate(ans);
			if (!r.ok) {
				console.log(`    ✗ ${r.reason}.`);
				console.log('    Try again, or press Enter to keep the current value.');
				continue;
			}
			value = r.value;
		}
		return { changed: value !== current, value };
	}
}

function printCurrent(
	c: ExistingConfig,
	inForce: InForce,
	rpcAvailable: boolean,
	configPath: string
): void {
	console.log('Current values (as your services get them):\n');
	// every value here comes from file-system read of the settings files.  An
	// operator who pasted a hostile blob into one (or a process that wrote
	// there with elevated privilege) could plant ANSI escapes that fire at
	// next `morphit-ops edit` invocation.  Sanitize on display.
	const read = (p: string): string | null => {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			return null;
		}
	};
	/** Where a value comes from, when it is not morphit.config.env: a file
	 *  read later wins, and the operator should know which one. */
	const from = (key: string, files: readonly string[] = inForce.indexerFiles): string => {
		const set = filesSetting(files, key, read);
		const last = set[set.length - 1];
		return last === undefined || resolve(last) === resolve(configPath) ? '' : `  (from ${last})`;
	};
	const line = (label: string, key: string, v: string | null, unset: string, max?: number): void =>
		console.log(
			`  ${label.padEnd(Math.max(19, label.length + 1))}${v !== null ? sanitizeForTerm(max === undefined ? v : truncate(v, max)) + from(key) : unset}`
		);
	line('Primary origin:', 'MORPHIT_INSTANCE_ORIGIN', c.origin, '(unset)');
	line(
		'Instance name:',
		'MORPHIT_INSTANCE_NAME',
		c.name,
		'(unset — falls back to "Morphit" / your operator account)'
	);
	line('Site brand name:', 'MORPHIT_INSTANCE_BRAND_NAME', c.brandName, '(unset — "Morphit")');
	line('Tagline:', 'MORPHIT_INSTANCE_TAGLINE', c.tagline, '(unset)', 50);
	line('Contact URL:', 'MORPHIT_INSTANCE_CONTACT_URL', c.contactUrl, '(unset)');
	line('Tor address:', 'MORPHIT_INSTANCE_TOR_ADDRESS', c.altNetworks.tor, '(unset)');
	line('Lokinet address:', 'MORPHIT_INSTANCE_LOKINET_ADDRESS', c.altNetworks.lokinet, '(unset)');
	line('I2P b32:', 'MORPHIT_INSTANCE_I2P_B32_ADDRESS', c.altNetworks.i2pB32, '(unset)');
	line('I2P vanity name:', 'MORPHIT_INSTANCE_I2P_NAME_ADDRESS', c.altNetworks.i2pName, '(unset)');
	line('Nostr pubkey:', 'MORPHIT_INSTANCE_NOSTR_PUBKEY', c.altNetworks.nostr, '(unset)');
	line('ENS .eth name:', 'MORPHIT_INSTANCE_ENS_NAME', c.altNetworks.ens, '(unset)');
	line('SEO title:', 'MORPHIT_INSTANCE_SEO_TITLE', c.seo.title, '(default)');
	line('SEO description:', 'MORPHIT_INSTANCE_SEO_DESCRIPTION', c.seo.description, '(default)', 50);
	line('SEO keywords:', 'MORPHIT_INSTANCE_SEO_KEYWORDS', c.seo.keywords, '(default)', 50);
	const d = INDEXER_LISTING_FEE_DEFAULTS;
	line(
		'BTC fee:',
		'MORPHIT_INDEXER_BTC_FEE_SATOSHIS',
		c.listingFee.btcSatoshis === null ? null : `${c.listingFee.btcSatoshis} satoshis`,
		`${d.btcSatoshis} satoshis (not set: the indexer's own amount)`
	);
	line(
		'XMR fee:',
		'MORPHIT_INDEXER_XMR_FEE_PICONERO',
		c.listingFee.xmrPiconero === null ? null : `${c.listingFee.xmrPiconero} piconero`,
		`${d.xmrPiconero} piconero (not set: the indexer's own amount)`
	);
	line(
		'Fallback BLURT/USD:',
		'MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR',
		c.listingFee.fallbackBlurtPriceUsd,
		`${d.fallbackBlurtPriceUsd} (not set: the indexer's own price)`
	);
	line(
		'Operator tag:',
		'MORPHIT_INSTANCE_OPERATOR_TAG',
		c.operatorTag,
		'(unset — relay queues nothing)'
	);
	if (rpcAvailable) {
		const list = (raw: string | undefined): string => {
			if (raw === undefined) return '(unset — the shipped list applies)';
			const l = nodeList(raw);
			return l.length === 0
				? '(empty — no public Blurt nodes)'
				: l.length === 1
					? sanitizeForTerm(l[0]!)
					: `${sanitizeForTerm(l[0]!)} +${l.length - 1} more`;
		};
		const idx = inForce.indexer.get('MORPHIT_INDEXER_RPC_ENDPOINTS');
		console.log(
			`  ${'Blurt RPC list:'.padEnd(19)}${list(idx)}${idx === undefined ? '' : from('MORPHIT_INDEXER_RPC_ENDPOINTS')}`
		);
		const rly = inForce.relay.get('MORPHIT_RELAY_BLURT_RPC');
		if (inForce.relayHere && !sameList(nodesInUse(rly), nodesInUse(idx)))
			console.log(
				`  ${'  relay uses:'.padEnd(19)}${list(rly)}${rly === undefined ? '' : from('MORPHIT_RELAY_BLURT_RPC', inForce.relayFiles)}`
			);
	}
	console.log('');
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return `${s.slice(0, n - 1)}…`;
}

function printGreeting(): void {
	const rule = '━'.repeat(58);
	console.log('');
	console.log(rule);
	console.log('Morphit edit wizard');
	console.log(rule);
	console.log('');
	console.log(
		'This re-asks the settings you can change after launch: primary\n' +
			'origin, alt-network addresses, branding & SEO, listing fee,\n' +
			'fees account, operator tag and Blurt RPC endpoints.  It will\n' +
			"NOT touch your relay's active key, database URL, or any other\n" +
			'critical infra.\n' +
			'\n' +
			'A backup of the existing settings is written before any\n' +
			'changes are applied.\n'
	);
}
