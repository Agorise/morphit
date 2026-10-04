/**
 * Switching an installed clearnet node to tor-only.
 *
 * A clearnet node publishes its domain, its .onion, its I2P address and its
 * operator account side by side (the on-chain operator registration, the
 * Onion-Location header). Re-installing it as tor-only kept the same onion and
 * I2P keys and the same account, so the "maximum privacy" node stayed publicly
 * linked to its old domain — and through it to the server's address.
 *
 * When the wizard is asked for tor-only on a box that was set up with a
 * clearnet domain, it says so plainly and offers fresh onion and I2P
 * addresses: the old key directories are moved aside (kept, renamed), so Tor
 * and i2pd make new ones on the install run. A fresh operator account cannot
 * be made from here; the operator is told why it matters.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';

export interface PriorIdentityPaths {
	readonly configEnvFiles: readonly string[];
	readonly torHsDir: string;
	readonly i2pKeyFile: string;
}

export const DEFAULT_PRIOR_IDENTITY_PATHS: PriorIdentityPaths = {
	configEnvFiles: ['/opt/morphit/morphit.config.env', '/etc/morphit/morphit.config.env'],
	torHsDir: '/var/lib/tor/morphit',
	i2pKeyFile: '/var/lib/i2pd/morphit-web.dat'
};

/** What a previous install left that ties this box to a clearnet identity. */
export interface PriorIdentity {
	/** The clearnet origin it served (https://…), or null. */
	readonly origin: string | null;
	readonly operatorAccount: string | null;
	readonly onionKeys: boolean;
	readonly i2pKey: boolean;
}

function envValue(files: readonly string[], key: string): string | null {
	for (const f of files) {
		try {
			const m = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*["']?([^"'\\n]*)["']?[ \\t]*$`, 'm').exec(
				readFileSync(f, 'utf8')
			);
			if (m && m[1]!.trim() !== '') return m[1]!.trim();
		} catch {
			/* next */
		}
	}
	return null;
}

export function readPriorIdentity(
	paths: PriorIdentityPaths = DEFAULT_PRIOR_IDENTITY_PATHS
): PriorIdentity {
	const origin = envValue(paths.configEnvFiles, 'MORPHIT_INSTANCE_ORIGIN');
	return {
		origin:
			origin !== null && /^https?:\/\/(?![^/]*\.onion(?:[/:]|$))/i.test(origin) ? origin : null,
		operatorAccount: envValue(paths.configEnvFiles, 'MORPHIT_OPERATOR_ACCOUNT'),
		onionKeys: existsSync(paths.torHsDir),
		i2pKey: existsSync(paths.i2pKeyFile)
	};
}

export interface RekeyDeps {
	readonly print: (s: string) => void;
	readonly askYesNo: (q: string, defaultYes: boolean) => Promise<boolean>;
	readonly now?: () => Date;
}

/**
 * On a tor-only install over a box that served a clearnet origin: warn, and
 * offer to move the old onion / I2P keys aside. Returns what was done.
 */
export async function offerTorOnlyRekey(
	prior: PriorIdentity,
	deps: RekeyDeps,
	paths: PriorIdentityPaths = DEFAULT_PRIOR_IDENTITY_PATHS
): Promise<'not-needed' | 'rekeyed' | 'kept' | 'rekey-failed'> {
	if (prior.origin === null) return 'not-needed';
	deps.print(
		`\n  This server was set up as a clearnet node (${prior.origin}). Its .onion and I2P\n` +
			'  addresses and its operator account were published next to that domain (in the\n' +
			'  on-chain operator registration and the site itself), so anyone can link them to\n' +
			'  it — and through it to this server. Switching to tor-only does not undo that.\n' +
			'  For a node that cannot be linked to the old one, use fresh .onion and I2P\n' +
			`  addresses and a NEW Blurt operator account${prior.operatorAccount ? ` (not @${prior.operatorAccount})` : ''}.\n`
	);
	if (!prior.onionKeys && !prior.i2pKey) return 'kept';
	const yes = await deps.askYesNo(
		'Make fresh .onion and I2P addresses for the tor-only node?',
		true
	);
	if (!yes) {
		deps.print('  Kept the old addresses; this node stays linkable to its clearnet past.\n');
		return 'kept';
	}
	const tag = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
	let ok = true;
	for (const [p, present] of [
		[paths.torHsDir, prior.onionKeys],
		[paths.i2pKeyFile, prior.i2pKey]
	] as const) {
		if (!present) continue;
		try {
			renameSync(p, `${p}.linked-${tag}`);
		} catch (e) {
			ok = false;
			deps.print(
				`  ✗ Could not move ${p} aside (${e instanceof Error ? e.message : String(e)}).\n`
			);
		}
	}
	if (!ok || existsSync(paths.torHsDir) || existsSync(paths.i2pKeyFile)) return 'rekey-failed';
	deps.print(
		`  ✓ The old keys were moved aside (…linked-${tag}); Tor and i2pd make new addresses during the install.\n` +
			'    Delete the old ones once you no longer need them.\n'
	);
	return 'rekeyed';
}
