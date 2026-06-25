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
import { defaultRepoRoot } from '../lib/repoRoot.ts';
import {
	existsSync,
	readFileSync,
	writeFileSync,
	chmodSync,
	renameSync,
	copyFileSync,
	openSync,
	fsyncSync,
	closeSync
} from 'node:fs';
import { ask, askYesNo, askChoice, step, explain } from '../init/prompt.ts';
import { sanitizeForTerm } from '../render/term.ts';
import { offerRestart } from '../lib/restartServices.ts';
import {
	stepOrigin,
	stepListingFee,
	stepOperatorTag,
	stepRpcEndpoints,
	parseRpcEndpoints,
	DEFAULT_BLURT_RPC_ENDPOINTS,
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
	/** cp311 — displayed branding (name / tagline / contact).  Set at
	 *  init time but previously NOT re-editable here, so an operator who
	 *  wanted to rename their instance had to hand-edit the env file
	 *  (and hit the unquoted-space shell-source trap).  Now editable in
	 *  the "Branding & SEO" section. */
	readonly name: string | null;
	readonly tagline: string | null;
	readonly contactUrl: string | null;
	readonly altNetworks: AltNetworkResult;
	/** The legacy single MORPHIT_INSTANCE_I2P_ADDRESS, if present, so the
	 *  alt-network editor can clear it when migrating to the split
	 *  b32 / vanity keys. */
	readonly legacyI2pAddress: string | null;
	readonly seo: SeoResult;
	/** Part 110 — listing-fee + fallback-price slice.  Optional
	 *  fields (any may be null if the operator has hand-edited
	 *  the config to remove a key). */
	readonly listingFee: {
		readonly btcSatoshis: string | null;
		readonly xmrPiconero: string | null;
		readonly fallbackBlurtPriceUsd: string | null;
	};
	/** Part 111 — operator tag for federation-scoped payouts. */
	readonly operatorTag: string | null;
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
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const EDITABLE_KEYS = [
	'MORPHIT_INSTANCE_ORIGIN',
	'MORPHIT_INSTANCE_NAME',
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
	'MORPHIT_INDEXER_RPC_ENDPOINTS'
] as const;

export async function runEdit(ctx: EditCtx): Promise<number> {
	printGreeting();

	const repoRoot = ctx.flags.out ? resolve(ctx.flags.out) : defaultRepoRoot();
	const configPath = `${repoRoot}/morphit.config.env`;
	const envPath = `${repoRoot}/morphit.env`;

	if (!existsSync(configPath)) {
		console.log(
			`No morphit.config.env found at ${configPath}.\n` +
				"Run 'morphit-ops init' first to set up your instance."
		);
		return 1;
	}

	const existing = loadExisting(configPath);
	console.log(`Loaded ${configPath}`);

	// morphit.env is OPTIONAL — operators who deploy via SystemD's
	// `Environment=` directives or Docker compose env may not have
	// a morphit.env file at all.  The RPC editor is reachable only
	// when the file exists; we surface this state in printCurrent.
	const existingEnv: ExistingEnv | null = existsSync(envPath) ? loadExistingEnv(envPath) : null;
	if (existingEnv !== null) {
		console.log(`Loaded ${envPath}`);
	} else {
		console.log(`(no morphit.env at ${envPath} — RPC edit unavailable)`);
	}
	console.log('');
	printCurrent(existing, existingEnv);

	const choice = await pickSection(existingEnv !== null);
	if (choice === 'cancel') {
		console.log('\nNothing changed.');
		return 0;
	}

	const configUpdates: Map<string, string | null> = new Map();
	const envUpdates: Map<string, string | null> = new Map();
	// cp186 — track whether the operator changed anything that lives
	// in the ON-CHAIN operator-register record (origin / tag).  Those
	// changes only reach other instances' /instances directories after
	// a fresh `morphit-ops register`; a local file edit alone is
	// invisible to the federation.  We use these to print a prominent,
	// conditional re-register reminder at the end.
	let originChanged = false;
	let tagChanged = false;

	if (choice === 'origin' || choice === 'all') {
		const origin = await stepOrigin();
		configUpdates.set('MORPHIT_INSTANCE_ORIGIN', origin);
		originChanged = true;
	}
	if (choice === 'alt-networks' || choice === 'all') {
		// Each address uses keep-current / clear semantics (Enter keeps the
		// current value, "-" clears it), mirroring Branding & SEO above.
		// Editing one address (e.g. adding I2P) therefore never silently
		// wipes the others — previously, skipping a field here meant the
		// wizard returned null for it and we overwrote the existing value
		// with null, dropping a configured Tor onion the operator never
		// touched.  For full validated add/clear of a single network, the
		// dedicated `alt-address` command is still the richer path.
		const torR = await editField(
			'Tor .onion address',
			'Your v3 hidden-service address (56 chars then ".onion").',
			existing.altNetworks.tor
		);
		if (torR.changed) configUpdates.set('MORPHIT_INSTANCE_TOR_ADDRESS', torR.value);

		const lokinetR = await editField(
			'Lokinet .loki address',
			'Full .loki address or your ONS name (e.g. "morphit.loki").',
			existing.altNetworks.lokinet
		);
		if (lokinetR.changed)
			configUpdates.set('MORPHIT_INSTANCE_LOKINET_ADDRESS', lokinetR.value);

		// I2P has two independent slots — always-resolvable b32 + optional
		// vanity name.  Writing either modern key also clears the legacy single
		// MORPHIT_INSTANCE_I2P_ADDRESS so it can't shadow them.
		const i2pB32R = await editField(
			'I2P b32 address (DOMAIN.b32.i2p)',
			'Your always-resolvable <base32>.b32.i2p address.',
			existing.altNetworks.i2pB32
		);
		if (i2pB32R.changed) {
			configUpdates.set('MORPHIT_INSTANCE_I2P_B32_ADDRESS', i2pB32R.value);
			if (existing.legacyI2pAddress !== null)
				configUpdates.set('MORPHIT_INSTANCE_I2P_ADDRESS', null);
		}

		const i2pNameR = await editField(
			'I2P vanity name (DOMAIN.i2p)',
			'Optional pretty alias like "morphit.i2p" (needs an i2p address-book entry).',
			existing.altNetworks.i2pName
		);
		if (i2pNameR.changed) {
			configUpdates.set('MORPHIT_INSTANCE_I2P_NAME_ADDRESS', i2pNameR.value);
			if (existing.legacyI2pAddress !== null)
				configUpdates.set('MORPHIT_INSTANCE_I2P_ADDRESS', null);
		}

		const nostrR = await editField(
			'Nostr pubkey',
			'Your npub… public key for cross-network discovery.',
			existing.altNetworks.nostr
		);
		if (nostrR.changed) configUpdates.set('MORPHIT_INSTANCE_NOSTR_PUBKEY', nostrR.value);

		const ensR = await editField(
			'ENS .eth name',
			'A registered .eth name (DOMAIN.eth) pointing at this instance.',
			existing.altNetworks.ens
		);
		if (ensR.changed) configUpdates.set('MORPHIT_INSTANCE_ENS_NAME', ensR.value);
	}
	if (choice === 'seo' || choice === 'all') {
		// cp311 — "Branding & SEO".  All six fields use keep-current /
		// clear semantics (Enter keeps, "-" clears), so editing one
		// (e.g. the instance name) never silently wipes the others.
		// Branding identity first (what shows on the directory card,
		// title bar, footer), then the search-engine meta tags.
		const nameR = await editField(
			'Instance name',
			'The bold name on your directory card, browser title bar, and footer.',
			existing.name
		);
		if (nameR.changed) configUpdates.set('MORPHIT_INSTANCE_NAME', nameR.value);

		const taglineR = await editField(
			'Tagline',
			'One-line subtitle shown on your homepage under the name.',
			existing.tagline
		);
		if (taglineR.changed) configUpdates.set('MORPHIT_INSTANCE_TAGLINE', taglineR.value);

		const contactR = await editField(
			'Contact URL',
			'Footer "contact the operator" link — Matrix room, mailto:, Mastodon, etc.',
			existing.contactUrl
		);
		if (contactR.changed) configUpdates.set('MORPHIT_INSTANCE_CONTACT_URL', contactR.value);

		const seoTitleR = await editField(
			'SEO <title>',
			'Homepage browser-tab / search-result title. Leave unset for the default.',
			existing.seo.title
		);
		if (seoTitleR.changed) configUpdates.set('MORPHIT_INSTANCE_SEO_TITLE', seoTitleR.value);

		const seoDescR = await editField(
			'SEO <meta description>',
			'One sentence (~150 chars) for search results + social link previews.',
			existing.seo.description
		);
		if (seoDescR.changed)
			configUpdates.set('MORPHIT_INSTANCE_SEO_DESCRIPTION', seoDescR.value);

		const seoKwR = await editField(
			'SEO <meta keywords>',
			'Comma-separated keywords. Optional; most search engines ignore these now.',
			existing.seo.keywords
		);
		if (seoKwR.changed) configUpdates.set('MORPHIT_INSTANCE_SEO_KEYWORDS', seoKwR.value);
	}
	if (choice === 'listing-fee' || choice === 'all') {
		const fee = await stepListingFee();
		configUpdates.set(
			'MORPHIT_INDEXER_BTC_FEE_SATOSHIS',
			String(fee.btcSatoshis)
		);
		configUpdates.set(
			'MORPHIT_INDEXER_XMR_FEE_PICONERO',
			String(fee.xmrPiconero)
		);
		configUpdates.set(
			'MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR',
			String(fee.fallbackBlurtPriceUsd)
		);
	}
	if (choice === 'operator-tag' || choice === 'all') {
		const op = await stepOperatorTag(existing.origin ?? null);
		configUpdates.set('MORPHIT_INSTANCE_OPERATOR_TAG', op.tag);
		tagChanged = true;
	}
	if (choice === 'rpc') {
		// Guarded above by the pickSection helper not offering this
		// when existingEnv === null, but defensive check anyway.
		if (existingEnv === null) {
			console.log(
				'\n✗ Cannot edit RPC endpoints without a morphit.env file.\n' +
					'Re-run morphit-ops init to generate one, or set\n' +
					'MORPHIT_INDEXER_RPC_ENDPOINTS via your SystemD/Docker config.'
			);
			return 1;
		}
		const newList = await stepRpcEndpoints(existingEnv.rpcEndpoints);
		envUpdates.set('MORPHIT_INDEXER_RPC_ENDPOINTS', newList.join(','));
	}

	// ─── Review ────
	console.log('\n━'.repeat(58).replace(/—/g, '━'));
	console.log('Review');
	console.log('━'.repeat(58));
	console.log('');
	for (const [k, v] of configUpdates) {
		const display = v === null ? '(unset/cleared)' : sanitizeForTerm(v);
		console.log(`  ${k.padEnd(36)} ${display}`);
	}
	for (const [k, v] of envUpdates) {
		const display = v === null ? '(unset/cleared)' : sanitizeForTerm(v);
		console.log(`  ${k.padEnd(36)} ${display}`);
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
	if (configUpdates.size > 0) {
		const result = atomicEnvWrite(configPath, existing.text, configUpdates, 'parseEnv');
		if (!result.ok) {
			// cp139-C-6: result.message includes err.message from
			// the filesystem layer and may reference paths.
			// Sanitize at display.
			console.log(`\n✗ ${sanitizeForTerm(result.message)}`);
			return 3;
		}
		console.log(`\n  ✓ wrote ${configPath}`);
		console.log(`  ✓ backed up previous version to ${result.backupPath}`);
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
			return 3;
		}
		console.log(`\n  ✓ wrote ${envPath}`);
		console.log(`  ✓ backed up previous version to ${result.backupPath}`);
	}
	console.log('  ✓ permissions 600 preserved');
	console.log('');

	// The indexer + relay read these env files ONCE at boot, so a change
	// only goes live after a restart.  Don't make the operator remember
	// that and run `systemctl` by hand (grandma-friendly, priority #3):
	// offer to restart the affected service(s) now — default yes — and do
	// it.  e.g. setting the Tor/Lokinet/I2P footer address here lights up
	// the footer pill with no further steps.  Origin changes also touch
	// the relay; RPC changes are indexer-only.
	const unitsToRestart = ['morphit-indexer'];
	if (originChanged) unitsToRestart.push('morphit-relay');
	const restarted = await offerRestart(unitsToRestart);

	// cp186 — the one easy-to-miss second step.  origin + operator tag
	// are part of the ON-CHAIN operator-register record; editing the
	// local config does NOT update what other Morphit instances show in
	// their /instances directory.  Make the re-register step impossible
	// to overlook when (and only when) it actually applies.
	if (originChanged || tagChanged) {
		const whatChanged =
			originChanged && tagChanged
				? 'origin and operator tag'
				: originChanged
					? 'origin'
					: 'operator tag';
		console.log('');
		console.log('━'.repeat(58));
		console.log('  IMPORTANT — one more step to reach the federation');
		console.log('━'.repeat(58));
		console.log('');
		console.log(`  You changed your ${whatChanged}.  That value is part of your`);
		console.log('  on-chain operator registration — the record other Morphit');
		console.log('  instances read to list you in their /instances directory.');
		console.log('');
		console.log('  The local edit above does NOT update that on-chain record.');
		console.log('  Re-publish it so the rest of the federation sees the change:');
		console.log('');
		console.log('      morphit-ops register');
		console.log('');
		console.log('  (Until you do, other instances will keep showing your old');
		if (restarted) {
			console.log(`  ${originChanged ? 'origin' : 'tag'}.  Your own instance is already using the new value —`);
			console.log('  the service restart above applied it locally.)');
		} else {
			console.log(`  ${originChanged ? 'origin' : 'tag'}.  Your own instance picks up the new value once the`);
			console.log('  service restart above runs.)');
		}
	}
	console.log('');

	return 0;
}

/** Atomic env-file write helper.  Backs up the original to a
 *  timestamped sibling, writes the new text to a `.tmp` file with
 *  mode 0600 + fsync, then renames.  Used for BOTH
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

/** Parse an existing morphit.config.env, extracting just the
 *  fields this command can edit.  Lines that aren't KV-shaped
 *  (comments, blanks) are preserved verbatim by `applyUpdates`
 *  later — we don't try to round-trip them through structured
 *  representations. */
function loadExisting(path: string): ExistingConfig {
	const text = readFileSync(path, 'utf-8');
	const kv = parseKvLines(text);

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
			fallbackBlurtPriceUsd:
				kv.get('MORPHIT_INDEXER_PRICE_FEED_STATIC_FLOOR') ?? null
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

/** Quote a value for the env file.  cp139-D-1 v2: prefers single-
 *  quoted form in BOTH consumer modes since single-quoted handles
 *  `$`/`(`/`"`/etc. literally in both parseEnv and bash.  Differs
 *  only in apostrophe handling:
 *
 *  - 'bash' consumer: POSIX close-escape-reopen idiom `'\''` for
 *    embedded apostrophes (bash understands; parseEnv doesn't).
 *  - 'parseEnv' consumer: falls back to double-quoted when value
 *    contains `'`.  Double-quoted in parseEnv doesn't expand
 *    `$`/backtick (dotenv semantics) but does NOT support `\"`
 *    escape, so a value containing both `'` AND `"` is rejected
 *    at quote() time.
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
		if (v.includes('"')) {
			throw new Error(
				`quoteValue(): value contains both ' and " which is unrepresentable in parseEnv ` +
					`env-file format.  Wizard/edit prompt layer must reject this input.`
			);
		}
		return `"${v}"`;
	}
	// Bash consumer.
	const esc = v.replace(/'/g, "'\\''");
	return `'${esc}'`;
}

/** Test-only export.  Smoke runner imports this to verify the
 *  parser+applier without needing real file I/O. */
export { applyUpdates as _testApplyUpdates };
export { loadExistingEnv as _testLoadExistingEnv };
export { atomicEnvWrite as _testAtomicEnvWrite };

async function pickSection(
	rpcAvailable: boolean
): Promise<'origin' | 'alt-networks' | 'seo' | 'listing-fee' | 'operator-tag' | 'rpc' | 'all' | 'cancel'> {
	step(1, 1, 'What do you want to edit?');

	// Build the menu dynamically so adding/removing sections in
	// future parts requires touching only one place.  Each entry
	// is (key, label, descriptionLine).  RPC is conditionally
	// included because it lives in morphit.env (which the operator
	// may not have if they're running a managed deployment).
	type SectionKey =
		| 'origin'
		| 'alt-networks'
		| 'seo'
		| 'listing-fee'
		| 'operator-tag'
		| 'rpc'
		| 'all'
		| 'cancel';
	const sections: ReadonlyArray<{
		key: SectionKey;
		label: string;
		description: string;
	}> = [
		{
			key: 'origin',
			label: 'Primary origin',
			description:
				'Primary origin URL — change the public HTTPS URL\n' +
				'     people use to reach your instance.  Pick this if\n' +
				'     your domain was seized or you migrated hosts.'
		},
		{
			key: 'alt-networks',
			label: 'Alt-network addresses',
			description:
				'Alt-network addresses — Tor / Lokinet / I2P / Nostr.\n' +
				'     Pick this if you generated a new .onion or .loki\n' +
				'     after first setup.'
		},
		{
			key: 'seo',
			label: 'Branding & SEO',
			description:
				'Instance name, tagline, contact URL, and homepage SEO <title>/description/keywords.'
		},
		{
			key: 'listing-fee',
			label: 'Listing fee + fallback BLURT price',
			description:
				'Listing fee target USD + BTC/XMR amounts +\n' +
				'     fallback BLURT/USD price.  Pick this when BTC or\n' +
				'     XMR has drifted significantly and the configured\n' +
				'     amounts no longer match your USD target, or when\n' +
				'     BLURT has drifted enough that the static-floor\n' +
				'     fallback (used during upstream outages) is stale.'
		},
		{
			key: 'operator-tag',
			label: 'Operator tag (federation attribution)',
			description:
				'Operator tag — identifies this instance in the\n' +
				'     federation.  Pick this if you registered a new\n' +
				'     tag on chain and want your indexer to start\n' +
				'     queueing payouts for ops carrying it.  Without a\n' +
				'     correct tag, your relay queues nothing.'
		},
		...(rpcAvailable
			? [
					{
						key: 'rpc' as SectionKey,
						label: 'Blurt RPC endpoints',
						description:
							'Blurt RPC endpoints — change the list of nodes\n' +
							'     the indexer connects to.  Pick this when a\n' +
							'     community RPC went offline or a new one came\n' +
							'     online.'
					}
				]
			: []),
		{
			key: 'all',
			label: rpcAvailable ? 'All five' : 'All four',
			description:
				rpcAvailable
					? 'All five sections in sequence.'
					: 'All four sections in sequence.'
		},
		{ key: 'cancel', label: 'Cancel', description: 'Cancel without changes.' }
	];

	const numbered = sections
		.map((s, i) => `  ${i + 1}. ${s.description}`)
		.join('\n');
	explain(
		'Each option re-prompts the relevant questions; everything\n' +
			'else in your config stays exactly as it is.  Press Ctrl+C\n' +
			'at any time to abort without writing.\n' +
			'\n' +
			numbered
	);

	const idx = await askChoice(
		'Pick one',
		sections.map((s) => s.label),
		sections.length - 1
	);
	return sections[idx]?.key ?? 'cancel';
}

/** cp311 — edit one optional text field with keep-current / clear
 *  semantics, used by the "Branding & SEO" section.  Shows the current
 *  value, then interprets the answer:
 *    - empty (just Enter) → keep current, report no change
 *    - "-"                → clear (write null → key removed from file)
 *    - anything else      → set to the trimmed typed value
 *  Quoting (spaces etc.) is handled later by quoteValue at write time,
 *  so the operator can type a value with spaces safely — unlike a raw
 *  hand-edit of the env file. */
async function editField(
	label: string,
	hint: string,
	current: string | null
): Promise<{ readonly changed: boolean; readonly value: string | null }> {
	console.log('');
	console.log(`  ${label}`);
	if (hint.length > 0) console.log(`    ${hint}`);
	console.log(
		`    Current: ${current !== null ? sanitizeForTerm(current) : '(unset)'}`
	);
	const ans = (await ask('    New value ([Enter] to keep, "-" to clear)', '')).trim();
	if (ans.length === 0) return { changed: false, value: current };
	if (ans === '-') return { changed: current !== null, value: null };
	return { changed: true, value: ans };
}

function printCurrent(c: ExistingConfig, env: ExistingEnv | null): void {
	console.log('Current values:\n');
	// cp139-C-17: every value here comes from file-system read of
	// morphit.config.env / morphit.env.  An operator who pasted a
	// hostile blob into the file (or a process that wrote there
	// with elevated privilege) could plant ANSI escapes that fire
	// at next `morphit-ops edit` invocation.  Sanitize on display.
	console.log(`  Primary origin:    ${c.origin !== null ? sanitizeForTerm(c.origin) : '(unset)'}`);
	console.log(`  Instance name:     ${c.name !== null ? sanitizeForTerm(c.name) : '(unset — falls back to "Morphit" / your operator account)'}`);
	console.log(`  Tagline:           ${c.tagline !== null ? sanitizeForTerm(truncate(c.tagline, 50)) : '(unset)'}`);
	console.log(`  Contact URL:       ${c.contactUrl !== null ? sanitizeForTerm(c.contactUrl) : '(unset)'}`);
	console.log(`  Tor address:       ${c.altNetworks.tor !== null ? sanitizeForTerm(c.altNetworks.tor) : '(unset)'}`);
	console.log(`  Lokinet address:   ${c.altNetworks.lokinet !== null ? sanitizeForTerm(c.altNetworks.lokinet) : '(unset)'}`);
	console.log(`  I2P b32:           ${c.altNetworks.i2pB32 !== null ? sanitizeForTerm(c.altNetworks.i2pB32) : '(unset)'}`);
	console.log(`  I2P vanity name:   ${c.altNetworks.i2pName !== null ? sanitizeForTerm(c.altNetworks.i2pName) : '(unset)'}`);
	console.log(`  Nostr pubkey:      ${c.altNetworks.nostr !== null ? sanitizeForTerm(c.altNetworks.nostr) : '(unset)'}`);
	console.log(`  ENS .eth name:     ${c.altNetworks.ens !== null ? sanitizeForTerm(c.altNetworks.ens) : '(unset)'}`);
	console.log(`  SEO title:         ${c.seo.title !== null ? sanitizeForTerm(c.seo.title) : '(default)'}`);
	console.log(
		`  SEO description:   ${c.seo.description !== null ? sanitizeForTerm(truncate(c.seo.description, 50)) : '(default)'}`
	);
	console.log(
		`  SEO keywords:      ${c.seo.keywords !== null ? sanitizeForTerm(truncate(c.seo.keywords, 50)) : '(default)'}`
	);
	console.log(
		`  BTC fee:           ${c.listingFee.btcSatoshis ?? '(unset)'} satoshis`
	);
	console.log(
		`  XMR fee:           ${c.listingFee.xmrPiconero ?? '(unset)'} piconero`
	);
	console.log(
		`  Fallback BLURT/USD: ${c.listingFee.fallbackBlurtPriceUsd ?? '(unset)'}`
	);
	console.log(
		`  Operator tag:      ${c.operatorTag !== null ? sanitizeForTerm(c.operatorTag) : '(unset — relay queues nothing)'}`
	);
	if (env !== null) {
		const rpc = env.rpcEndpoints;
		const rpcDisplay =
			rpc === null
				? '(unset — defaults will apply)'
				: rpc.length === 0
					? '(empty)'
					: rpc.length === 1
						? sanitizeForTerm(rpc[0]!)
						: `${sanitizeForTerm(rpc[0]!)} +${rpc.length - 1} more`;
		console.log(`  Blurt RPC list:    ${rpcDisplay}`);
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
		'This re-prompts only the launch-tunable sections of your\n' +
			'morphit.config.env: primary origin, alt-network addresses,\n' +
			"and homepage SEO copy.  It will NOT touch your relay's\n" +
			'active key, database URL, or any other critical infra.\n' +
			'\n' +
			'A backup of the existing config is written before any\n' +
			'changes are applied.\n'
	);
}

