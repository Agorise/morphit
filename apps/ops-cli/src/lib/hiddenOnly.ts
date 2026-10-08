/**
 * Is this node hidden-only? And, when it is, the ONE way ops-cli may reach the
 * Blurt chain: through this node's own indexer.
 *
 * WHAT WAS WRONG. ops-cli never asked this question. Every interactive launch
 * fetched the latest version from git.agorise.net and read the relay balance
 * from the six clearnet Blurt RPCs, and `register` / `payment-method` signed and
 * broadcast straight to those RPCs. On a tor-only node that put the box's home
 * IP in the logs of a code host and six RPC operators every time the operator
 * opened the menu, and `register` sent the node's own .onion from its home IP in
 * the same request.
 *
 * THE ANSWER comes from root-owned config only, never from an HTTP reply: the
 * node is hidden-only when indexer.env carries an EMPTY clearnet RPC pool
 * (`MORPHIT_INDEXER_RPC_ENDPOINTS=`), which is exactly what the tor-only install
 * writes. It is the same rule the upgrade path uses (isHiddenOnlyFromEnvFile).
 *
 * THE ROUTE when it is: the local indexer's `/v1/chain/condenser` (a whitelist
 * of read methods) and `/v1/broadcast` (a whitelist of Morphit ops). The indexer
 * carries those calls over its hidden transport router, so nothing here opens a
 * clearnet connection or asks the system resolver for a public name. When the
 * indexer does not answer, callers refuse calmly; they never fall back.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isHiddenOnlyFromEnvFile } from '../init/hiddenUpgradeResolve.ts';

/** MORPHIT_ENV_ROOT relocates the env files under a directory, as the
 *  post-upgrade heals already allow, so tests drive the real code against
 *  scratch files. Unset on a real box. */
function envRoot(): string {
	return process.env.MORPHIT_ENV_ROOT ?? '';
}

/** Where the indexer's config lives, most authoritative first. */
export function indexerEnvFiles(): string[] {
	const root = envRoot();
	return [`${root}/etc/morphit/indexer.env`, `${root}/opt/morphit/indexer.env`];
}

/** True when this node reads the chain only over Tor/I2P (empty clearnet RPC
 *  pool in indexer.env). Reads files only; never throws. */
export function isHiddenOnlyNode(files: readonly string[] = indexerEnvFiles()): boolean {
	try {
		return isHiddenOnlyFromEnvFile(files);
	} catch {
		return false;
	}
}

/** The standard local indexer addresses (loopback first, then the docker
 *  bridges some boxes answer on). Same list the hidden upgrade uses. */
const STANDARD_LOCAL_INDEXER_BASES = [
	'http://127.0.0.1:8081',
	'http://172.18.0.1:8081',
	'http://172.17.0.1:8081'
];

function readEnvValue(files: readonly string[], key: string): string | null {
	for (const f of files) {
		try {
			if (!existsSync(f)) continue;
			const m = readFileSync(f, 'utf8').match(
				new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, 'm')
			);
			if (!m) continue;
			const v = (m[1] ?? '')
				.trim()
				.replace(/^["']|["']$/g, '')
				.trim();
			if (v !== '') return v;
		} catch {
			/* unreadable: try the next file */
		}
	}
	return null;
}

/** The node's configured CLEARNET Blurt RPC list — the OS environment first,
 *  then indexer.env (the same key the indexer reads) — or null when none is
 *  configured (callers then use the shipped default list). Never throws. */
export function configuredClearnetRpcEndpoints(
	files: readonly string[] = indexerEnvFiles()
): string[] | null {
	const raw =
		(process.env.MORPHIT_INDEXER_RPC_ENDPOINTS ?? '').trim() ||
		readEnvValue(files, 'MORPHIT_INDEXER_RPC_ENDPOINTS') ||
		'';
	const list = raw
		.split(',')
		.map((s) => s.trim())
		.filter((s) => /^https?:\/\//i.test(s));
	return list.length > 0 ? list : null;
}

/** Local indexer base URLs: the address indexer.env says it listens on (a
 *  wildcard bind is reached on loopback), then the standard ones. Every entry
 *  is a loopback or private-bridge literal, never a name. */
export function localIndexerBases(files: readonly string[] = indexerEnvFiles()): string[] {
	const out: string[] = [];
	const host = readEnvValue(files, 'MORPHIT_INDEXER_LISTEN_HOST');
	const port = Number(readEnvValue(files, 'MORPHIT_INDEXER_LISTEN_PORT') ?? '');
	if (Number.isInteger(port) && port > 0 && port < 65536) {
		const h =
			host === null || host === '0.0.0.0' || host === '::' || host === 'localhost'
				? '127.0.0.1'
				: host;
		// Only an IP literal: a configured NAME would send the lookup to the
		// system resolver, which is the thing this module exists to avoid.
		if (/^[0-9.]+$/.test(h)) out.push(`http://${h}:${port}`);
		else if (/^[0-9a-f:]+$/i.test(h)) out.push(`http://[${h}]:${port}`);
	}
	for (const b of STANDARD_LOCAL_INDEXER_BASES) if (!out.includes(b)) out.push(b);
	return out;
}

/** The local indexer could not be reached at all. */
export class LocalIndexerUnreachableError extends Error {
	/** What went wrong, without the hidden-only wording around it. */
	readonly detail: string;
	/** True when an address took the connection and then gave no answer in
	 *  time (an indexer that is there but slow), not when none could be
	 *  reached at all. */
	readonly timedOut: boolean;
	constructor(detail: string, timedOut = false) {
		super(
			`could not reach this node's own indexer (hidden-only node, so nothing else is asked): ${detail}`
		);
		this.name = 'LocalIndexerUnreachableError';
		this.detail = detail;
		this.timedOut = timedOut;
	}
}

/** The local indexer answered, with an error. `message` is its reason, e.g.
 *  the chain's rejection of a broadcast. */
export class LocalIndexerAnswerError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'LocalIndexerAnswerError';
	}
}

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * One JSON request to the local indexer. Tries each local base while the
 * connection itself fails; stops at the first ANSWER (a 4xx/5xx is an answer,
 * not a reason to ask again). A POST also stops at a timeout, because the
 * request may already have been acted on and repeating a broadcast is wrong.
 */
export async function localIndexerJson<T>(
	path: string,
	init: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {},
	opts: { readonly timeoutMs?: number; readonly bases?: readonly string[] } = {}
): Promise<T> {
	const bases = opts.bases ?? localIndexerBases();
	const method = init.method ?? 'GET';
	let lastErr = 'no local address answered';
	let timedOutAny = false;
	for (const base of bases) {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
		let res: Response;
		try {
			res = await fetch(`${base}${path}`, {
				method,
				redirect: 'manual',
				signal: ctrl.signal,
				headers:
					init.body === undefined
						? { accept: 'application/json' }
						: { accept: 'application/json', 'content-type': 'application/json' },
				body: init.body === undefined ? undefined : JSON.stringify(init.body)
			});
		} catch (err) {
			clearTimeout(t);
			const timedOut = ctrl.signal.aborted;
			if (timedOut) timedOutAny = true;
			lastErr = timedOut
				? `no answer within ${Math.round((opts.timeoutMs ?? 10_000) / 1000)}s`
				: String(err);
			if (timedOut && method === 'POST') break;
			continue;
		}
		let text: string;
		try {
			text = await res.text();
		} catch (err) {
			clearTimeout(t);
			throw new LocalIndexerUnreachableError(`the answer was cut off (${String(err)})`);
		}
		clearTimeout(t);
		if (text.length > MAX_BODY_BYTES) {
			throw new LocalIndexerUnreachableError('the answer was too large to be a real one');
		}
		let body: unknown = null;
		try {
			body = text === '' ? null : JSON.parse(text);
		} catch {
			body = null;
		}
		if (res.ok) return body as T;
		const msg =
			body !== null &&
			typeof body === 'object' &&
			typeof (body as { message?: unknown }).message === 'string'
				? (body as { message: string }).message
				: `HTTP ${res.status}`;
		throw new LocalIndexerAnswerError(res.status, msg);
	}
	throw new LocalIndexerUnreachableError(lastErr, timedOutAny);
}

/** A read-only condenser call relayed by the local indexer (its whitelist:
 *  get_accounts, get_account_history, get_dynamic_global_properties,
 *  get_block, get_transaction, get_key_references). */
export async function localCondenser<T>(
	method: string,
	params: readonly unknown[],
	opts: { readonly timeoutMs?: number; readonly bases?: readonly string[] } = {}
): Promise<T> {
	const r = await localIndexerJson<{ result?: unknown }>(
		'/v1/chain/condenser',
		{ method: 'POST', body: { method, params } },
		{ timeoutMs: opts.timeoutMs ?? 60_000, bases: opts.bases }
	);
	return (r?.result ?? null) as T;
}

/** The release the chain says is current, as this node's own indexer serves
 *  it: `{ tag, cid }`, or null when the indexer has none. Never throws. */
export async function readLocalRelease(
	opts: { readonly timeoutMs?: number; readonly bases?: readonly string[] } = {}
): Promise<{ readonly tag: string; readonly cid: string | null } | null> {
	try {
		const rel = await localIndexerJson<{
			version?: unknown;
			distribution?: { ipfs_cid?: unknown } | null;
		}>('/v1/release', {}, { timeoutMs: opts.timeoutMs ?? 4000, bases: opts.bases });
		const v = typeof rel?.version === 'string' ? rel.version.trim() : '';
		if (v === '') return null;
		const rawCid = rel.distribution?.ipfs_cid;
		const cid =
			typeof rawCid === 'string' && /^[a-z0-9]{46,}$/i.test(rawCid.trim()) ? rawCid.trim() : null;
		return { tag: v.startsWith('v') ? v : `v${v}`, cid };
	} catch {
		return null;
	}
}
