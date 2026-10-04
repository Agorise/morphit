/**
 * Morphit indexer — is any onion fee explorer answering right now?
 *
 * A zero-clearnet node takes BTC / XMR fees only through onion explorers, so it
 * advertises a method (its treasury address on /v1/instance) only while at
 * least one of that method's onion explorers has answered recently. This probe
 * asks each one, in the background, every PROBE_INTERVAL_MS, over the same
 * transport as the verifier (a fresh Tor circuit per request, no redirects,
 * capped and shape-checked answers):
 *   - an Esplora base (BTC): `GET /blocks/tip/height` → a block height;
 *   - an onion-monero-blockchain-explorer (XMR): `GET /api/networkinfo` →
 *     `{status: 'success', data: {height, …}}`, not a testnet / stagenet one.
 * A source is healthy when its latest probe answered and is not older than
 * HEALTHY_FOR_MS. Until a source has answered once it is not healthy: the node
 * never offers a method it has not seen it can verify.
 */
import { logger } from '$log';
import { explorerInit, readExplorerJson, readExplorerText } from './explorerHttp';
import { parseXmrExplorer } from '../../config/xmrExplorers';
import { SOURCE_HIDDEN_REQUEST_TIMEOUT_MS } from '$indexer/sourceFetch';

const log = logger('fee-source-health');

/** How often each source is probed. */
export const PROBE_INTERVAL_MS = 10 * 60 * 1000;
/** How long one good answer keeps a source healthy. */
export const HEALTHY_FOR_MS = 30 * 60 * 1000;

export interface FeeSourceTarget {
	readonly method: 'btc' | 'xmr';
	/** The explorer entry as configured. */
	readonly spec: string;
}

interface SourceState {
	lastProbeAt: number | null;
	lastOkAt: number | null;
	ok: boolean;
}

export class FeeSourceHealth {
	private readonly state = new Map<string, SourceState>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private inFlight: Promise<void> | null = null;
	private readonly now: () => number;

	constructor(
		private readonly targets: readonly FeeSourceTarget[],
		private readonly fetchImpl: typeof fetch,
		opts: { readonly now?: () => number } = {}
	) {
		this.now = opts.now ?? (() => Date.now());
		for (const t of targets) {
			this.state.set(key(t), { lastProbeAt: null, lastOkAt: null, ok: false });
		}
	}

	/** Probe every source now, then every PROBE_INTERVAL_MS. Non-blocking. */
	start(): void {
		if (this.timer !== null || this.targets.length === 0) return;
		void this.probeOnce();
		this.timer = setInterval(() => void this.probeOnce(), PROBE_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
	}

	/** One round over every source, in parallel. Never throws. */
	probeOnce(): Promise<void> {
		if (this.inFlight !== null) return this.inFlight;
		this.inFlight = Promise.all(this.targets.map((t) => this.probe(t))).then(
			() => undefined,
			() => undefined
		);
		const p = this.inFlight;
		void p.finally(() => {
			if (this.inFlight === p) this.inFlight = null;
		});
		return p;
	}

	/** Sources of `method` that are healthy now. */
	healthyCount(method: 'btc' | 'xmr'): number {
		const now = this.now();
		return this.targets.filter((t) => {
			const s = this.state.get(key(t));
			return (
				t.method === method &&
				s !== undefined &&
				s.ok &&
				s.lastOkAt !== null &&
				now - s.lastOkAt <= HEALTHY_FOR_MS
			);
		}).length;
	}

	/** For the operator's health view: one row per probed source. */
	snapshot(): {
		method: string;
		source: string;
		ok: boolean;
		lastOkAt: Date | null;
		lastProbeAt: Date | null;
	}[] {
		return this.targets.map((t) => {
			const s = this.state.get(key(t))!;
			return {
				method: t.method,
				source: t.spec,
				ok: s.ok,
				lastOkAt: s.lastOkAt === null ? null : new Date(s.lastOkAt),
				lastProbeAt: s.lastProbeAt === null ? null : new Date(s.lastProbeAt)
			};
		});
	}

	private async probe(t: FeeSourceTarget): Promise<void> {
		const s = this.state.get(key(t))!;
		const ok = await this.ask(t).catch(() => false);
		const at = this.now();
		if (ok !== s.ok) {
			log.info(ok ? 'fee_source_answering' : 'fee_source_not_answering', {
				method: t.method,
				source: originOf(t.spec)
			});
		}
		s.lastProbeAt = at;
		s.ok = ok;
		if (ok) s.lastOkAt = at;
	}

	private async ask(t: FeeSourceTarget): Promise<boolean> {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), SOURCE_HIDDEN_REQUEST_TIMEOUT_MS);
		try {
			if (t.method === 'btc') {
				const base = t.spec.trim().replace(/\/+$/, '');
				const res = await this.fetchImpl(
					`${base}/blocks/tip/height`,
					explorerInit({ method: 'GET', accept: 'text/plain' }, ac.signal)
				);
				if (!res.ok) return false;
				const h = Number((await readExplorerText(res, ac, 64)).trim());
				return Number.isSafeInteger(h) && h > 0;
			}
			const ex = parseXmrExplorer(t.spec);
			if (ex === null || ex.kind !== 'txprove') return false;
			const res = await this.fetchImpl(
				`${ex.base}/api/networkinfo`,
				explorerInit({ method: 'GET', accept: 'application/json' }, ac.signal)
			);
			if (!res.ok) return false;
			const b = (await readExplorerJson(res, ac)) as {
				status?: unknown;
				data?: { height?: unknown; testnet?: unknown; stagenet?: unknown } | null;
			} | null;
			return (
				b !== null &&
				typeof b === 'object' &&
				b.status === 'success' &&
				typeof b.data === 'object' &&
				b.data !== null &&
				typeof b.data.height === 'number' &&
				Number.isSafeInteger(b.data.height) &&
				b.data.height > 0 &&
				b.data.testnet !== true &&
				b.data.stagenet !== true
			);
		} finally {
			clearTimeout(timer);
		}
	}
}

function key(t: FeeSourceTarget): string {
	return `${t.method}|${t.spec}`;
}

function originOf(spec: string): string {
	try {
		return new URL(spec.replace(/^(raw-tx|node)\+/, '')).origin;
	} catch {
		return '(unparseable)';
	}
}
