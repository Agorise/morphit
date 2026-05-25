/**
 * Morphit ops CLI — Blurt chain account lookup.
 *
 * Single-purpose: during the wizard, when the operator types
 * their relay account name, look it up on-chain to confirm it
 * exists and report the current balance.  Catches typos
 * before they cause confusing errors at relay startup.
 *
 * Tries multiple public RPC endpoints; first response wins.
 * 5-second hard timeout per endpoint.  Returns null on
 * "account doesn't exist" (Blurt returns an empty array, not
 * an error).  Throws on network/RPC failure so the caller
 * can decide whether to abort or let the operator proceed.
 */

const DEFAULT_ENDPOINTS: readonly string[] = [
	'https://rpc.blurt.blog',
	'https://blurt-rpc.saboin.com',
	'https://rpc.beblurt.com',
	'https://rpc.blurt.one'
];

export interface AccountInfo {
	readonly name: string;
	readonly balance: string; // e.g. "412.500 BLURT"
	readonly balanceBlurt: number; // parsed numeric value
}

interface BlurtAccountRow {
	name: string;
	balance: string;
}

/** Look up an account by name.  Returns AccountInfo on hit,
 *  null on "no such account", throws on transport failure. */
export async function lookupBlurtAccount(
	accountName: string,
	endpoints: readonly string[] = DEFAULT_ENDPOINTS
): Promise<AccountInfo | null> {
	let lastError: unknown = null;
	for (const endpoint of endpoints) {
		try {
			const result = await callRpc(endpoint, 'condenser_api.get_accounts', [[accountName]]);
			if (!Array.isArray(result) || result.length === 0) return null;
			const first = result[0];
			// cp139-C-2: runtime type guard before the cast.  If a
			// rogue RPC endpoint returns `[null]` (or any non-object)
			// as the first row, `first.balance` would TypeError on
			// the null path.  The catch below would absorb it and
			// fall through to the next endpoint, but a hostile
			// upstream serving all 4 fallbacks the same garbage
			// would yield an opaque "Could not reach any Blurt RPC"
			// error instead of a clean "account doesn't exist"
			// return.  Treat non-object as same-as-empty (account
			// not found).
			if (typeof first !== 'object' || first === null) return null;
			const row = first as BlurtAccountRow;
			const balanceStr = row.balance ?? '0.000 BLURT';
			const m = /^([\d.]+)\s+BLURT$/.exec(balanceStr);
			const balanceBlurt = m !== null ? parseFloat(m[1]!) : 0;
			return {
				name: row.name ?? accountName,
				balance: balanceStr,
				balanceBlurt
			};
		} catch (err) {
			lastError = err;
			continue;
		}
	}
	throw new Error(
		`Could not reach any Blurt RPC endpoint.  Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
	);
}

async function callRpc(endpoint: string, method: string, params: unknown[]): Promise<unknown> {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), 5000);
	try {
		const resp = await fetch(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method,
				params,
				id: 1
			}),
			signal: controller.signal
		});
		if (!resp.ok) {
			throw new Error(`HTTP ${resp.status} from ${endpoint}`);
		}
		const json = (await resp.json()) as { result?: unknown; error?: unknown };
		if (json.error !== undefined) {
			throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
		}
		return json.result;
	} finally {
		clearTimeout(t);
	}
}

/** Validate a Blurt account name format.  Same rules as the chain:
 *  3-16 chars, lowercase, alphanumeric + dashes, must start with
 *  a letter, no consecutive dashes. */
export function validateBlurtAccountName(name: string): {
	ok: boolean;
	message?: string;
} {
	if (name.length < 3) {
		return { ok: false, message: 'Too short — minimum 3 characters.' };
	}
	if (name.length > 16) {
		return { ok: false, message: 'Too long — maximum 16 characters.' };
	}
	if (!/^[a-z]/.test(name)) {
		return {
			ok: false,
			message: 'Must start with a lowercase letter.'
		};
	}
	if (!/^[a-z0-9-]+$/.test(name)) {
		return {
			ok: false,
			message: 'Only lowercase letters, numbers, and dashes are allowed.'
		};
	}
	if (name.includes('--')) {
		return {
			ok: false,
			message: 'No consecutive dashes.'
		};
	}
	if (name.endsWith('-')) {
		return {
			ok: false,
			message: 'Cannot end with a dash.'
		};
	}
	return { ok: true };
}
