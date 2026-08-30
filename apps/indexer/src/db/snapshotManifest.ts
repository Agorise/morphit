/**
 * apps/indexer/src/db/snapshotManifest.ts  (cp764)
 *
 * Indexer-DB snapshot bootstrap — the SAFETY CORE.
 *
 * WHY: syncing a fresh indexer by replaying ~3.5M blocks over hidden RPC (the
 * only transport a max-privacy tor-only box may use — it must not run a local
 * blurtd, whose p2p sync would leak its clearnet IP) takes days. A tor-only
 * operator who already runs a synced instance can instead RESTORE that instance's
 * indexer Postgres DB onto the new box and let it catch up only the small gap —
 * days → minutes, over any transport, with zero p2p footprint.
 *
 * TRUST MODEL (read this before widening it): restoring a snapshot means TRUSTING
 * the snapshot's derived state (orderbook, registrations, balances) instead of
 * re-deriving it from the chain. That is safe ONLY between an operator's OWN
 * boxes — you are trusting your own synced instance. This module deliberately
 * does NOT verify a third party's snapshot; a PUBLIC/federated snapshot would
 * need a signature + a trust decision about whose chain-view you accept, which is
 * a separate, deliberate step (tracked, not built here). The bootstrap script
 * refuses to run unless the operator explicitly acknowledges this (--i-trust-this-source).
 *
 * This file is PURE (no DB, no fs, no pg) so the compatibility rules that decide
 * whether a restore is SAFE are unit-tested exhaustively. A wrong "compatible"
 * verdict here could load a different chain's data or a schema this build can't
 * run — so every rule fails CLOSED.
 */

/** Bump when the on-disk snapshot layout changes incompatibly. Emitted by
 *  buildManifest(). v2 adds the fields a STRANGER needs to trust a federated
 *  snapshot (dumpSha256, indexerVersion, opCoverage); v1 (own-box) omitted them. */
export const SNAPSHOT_FORMAT_VERSION = 2;
/** Every format version this BUILD can still read + restore. We keep reading v1
 *  (legacy own-box snapshots) so an upgrade never orphans an operator's existing
 *  snapshot; only unknown/newer versions are refused. Fail-closed: not in the set
 *  → refuse. */
export const SUPPORTED_SNAPSHOT_FORMAT_VERSIONS: ReadonlySet<number> = new Set([1, 2]);
export const MANIFEST_FILENAME = 'manifest.json';
export const DUMP_FILENAME = 'indexer.sql.gz';

/** Lowercase 64-hex SHA-256, shared with the on-chain snapshot op validators. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/** How much of the indexed history a snapshot carries. 'full' = the whole DB
 *  (cumulative reputation/loyalty/earnings need it); 'orderbook-only' reserved
 *  for a future recent-window variant. v1 manifests are implicitly 'full'. */
export type SnapshotOpCoverage = 'full' | 'orderbook-only';
const OP_COVERAGE_VALUES: ReadonlySet<string> = new Set(['full', 'orderbook-only']);

/** What an exported snapshot records about the SOURCE DB it was taken from. */
export interface SnapshotManifest {
	readonly snapshotFormatVersion: number;
	/** Blurt chain id the source indexed. A mismatch is FATAL — the derived state
	 *  is meaningless (or dangerous) against a different chain. */
	readonly chainId: string;
	/** max(schema_migrations.version) on the source at export time. */
	readonly schemaVersion: number;
	/** indexer_state.last_applied_block on the source — where the target resumes. */
	readonly lastAppliedBlock: number;
	/** Postgres server major version of the source (dump portability guard). */
	readonly pgMajor: number;
	/** ISO timestamp of export. */
	readonly createdAt: string;
	/** Human label for provenance (e.g. the source instance origin). Advisory only. */
	readonly sourceLabel: string;
	// ── v2 fields (federated snapshots). Optional so a legacy v1 manifest still
	//    parses + restores via the own-box path; the FEDERATED path requires them
	//    (see manifestFederationReadiness). ────────────────────────────────────
	/** The indexer BUILD version that produced the dump. Advisory (schemaVersion
	 *  remains the compat gate); surfaced so an operator sees what they're taking. */
	readonly indexerVersion?: string;
	/** Lowercase 64-hex SHA-256 of indexer.sql.gz. Lets the manifest be
	 *  self-describing and lets the importer prove file == on-chain sha256 ==
	 *  manifest, all three, before trusting any of it. */
	readonly dumpSha256?: string;
	/** History coverage. Absent (v1) ⇒ treated as 'full'. */
	readonly opCoverage?: SnapshotOpCoverage;
}

/** Facts about the TARGET box, read from its config + code at bootstrap time. */
export interface TargetFacts {
	/** MORPHIT_INDEXER_CHAIN_ID configured on the target. */
	readonly chainId: string;
	/** latestSchemaVersion() of the target's indexer BUILD. */
	readonly codeSchemaVersion: number;
	/** Postgres server major version on the target. */
	readonly pgMajor: number;
}

export interface VerifyResult {
	readonly ok: boolean;
	/** One line per failed rule, safe to print. Empty when ok. */
	readonly reasons: readonly string[];
	/** Non-fatal advisories (printed, don't block). */
	readonly warnings: readonly string[];
}

function isFiniteInt(n: unknown): n is number {
	return typeof n === 'number' && Number.isInteger(n) && Number.isFinite(n);
}

/** Parse + shape-validate a manifest read from disk. Returns null (never throws)
 *  on anything malformed, so the bootstrap treats a bad manifest as "refuse". */
export function parseManifest(raw: string): SnapshotManifest | null {
	let o: Record<string, unknown>;
	try {
		o = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!o || typeof o !== 'object') return null;
	const m = o as Partial<SnapshotManifest>;
	if (
		!isFiniteInt(m.snapshotFormatVersion) ||
		typeof m.chainId !== 'string' ||
		m.chainId.length === 0 ||
		!isFiniteInt(m.schemaVersion) ||
		m.schemaVersion < 0 ||
		!isFiniteInt(m.lastAppliedBlock) ||
		m.lastAppliedBlock < 0 ||
		!isFiniteInt(m.pgMajor) ||
		m.pgMajor <= 0 ||
		typeof m.createdAt !== 'string' ||
		typeof m.sourceLabel !== 'string'
	) {
		return null;
	}
	// v2 optional fields: if PRESENT they must be well-formed (fail closed on a
	// malformed value); if ABSENT it's a legacy v1 manifest and that's fine.
	if (m.indexerVersion !== undefined && typeof m.indexerVersion !== 'string') return null;
	if (
		m.dumpSha256 !== undefined &&
		(typeof m.dumpSha256 !== 'string' || !SHA256_RE.test(m.dumpSha256))
	) {
		return null;
	}
	if (m.opCoverage !== undefined && !OP_COVERAGE_VALUES.has(m.opCoverage as string)) {
		return null;
	}
	return {
		snapshotFormatVersion: m.snapshotFormatVersion,
		chainId: m.chainId,
		schemaVersion: m.schemaVersion,
		lastAppliedBlock: m.lastAppliedBlock,
		pgMajor: m.pgMajor,
		createdAt: m.createdAt,
		sourceLabel: m.sourceLabel,
		...(m.indexerVersion !== undefined ? { indexerVersion: m.indexerVersion } : {}),
		...(m.dumpSha256 !== undefined ? { dumpSha256: m.dumpSha256 } : {}),
		...(m.opCoverage !== undefined ? { opCoverage: m.opCoverage as SnapshotOpCoverage } : {})
	};
}

export function buildManifest(facts: {
	chainId: string;
	schemaVersion: number;
	lastAppliedBlock: number;
	pgMajor: number;
	sourceLabel: string;
	indexerVersion: string;
	dumpSha256: string;
	opCoverage?: SnapshotOpCoverage;
	now?: Date;
}): SnapshotManifest {
	if (!SHA256_RE.test(facts.dumpSha256)) {
		throw new Error(`buildManifest: dumpSha256 must be 64 lowercase hex, got "${facts.dumpSha256}"`);
	}
	return {
		snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
		chainId: facts.chainId,
		schemaVersion: facts.schemaVersion,
		lastAppliedBlock: facts.lastAppliedBlock,
		pgMajor: facts.pgMajor,
		createdAt: (facts.now ?? new Date()).toISOString(),
		sourceLabel: facts.sourceLabel,
		indexerVersion: facts.indexerVersion,
		dumpSha256: facts.dumpSha256,
		opCoverage: facts.opCoverage ?? 'full'
	};
}

/**
 * Gate for the FEDERATED path only: a snapshot fetched from a STRANGER (via the
 * on-chain anchor) must be v2 AND carry the fields that make it verifiable —
 * dumpSha256 (to prove the download) and indexerVersion (provenance). The own-box
 * path deliberately does NOT require this (a v1 manifest is fine there). Pure +
 * fail-closed. `expectedSha256`, when given (the on-chain sha256), must match the
 * manifest's dumpSha256 — the manifest and the anchor must agree.
 */
export function manifestFederationReadiness(
	manifest: SnapshotManifest,
	expectedSha256?: string
): VerifyResult {
	const reasons: string[] = [];
	const warnings: string[] = [];
	if (manifest.snapshotFormatVersion < 2) {
		reasons.push(
			`federated restore requires snapshot format v2+, got v${manifest.snapshotFormatVersion} (a legacy own-box snapshot cannot be trusted from a third party).`
		);
	}
	if (!manifest.dumpSha256 || !SHA256_RE.test(manifest.dumpSha256)) {
		reasons.push('manifest is missing a valid dumpSha256 — cannot prove the download.');
	}
	if (!manifest.indexerVersion) {
		warnings.push('manifest has no indexerVersion (provenance advisory only).');
	}
	if (
		expectedSha256 !== undefined &&
		manifest.dumpSha256 !== undefined &&
		manifest.dumpSha256 !== expectedSha256.toLowerCase()
	) {
		reasons.push(
			`sha256 disagreement: manifest says ${manifest.dumpSha256}, on-chain anchor says ${expectedSha256.toLowerCase()}.`
		);
	}
	return { ok: reasons.length === 0, reasons, warnings };
}

/**
 * Decide whether `manifest` may be restored onto a box described by `target`.
 * Every rule fails CLOSED. Rules:
 *   - format version must be one this build understands;
 *   - chain id MUST match exactly (else the derived state is for another chain);
 *   - schema version must be <= the target build's version. A NEWER snapshot
 *     schema can't be run by this (older) code → refuse. An OLDER snapshot schema
 *     is fine: the indexer's own runMigrations forward-migrates it after restore
 *     (surfaced as a warning so the operator expects the migrate step);
 *   - a NEWER source Postgres major than the target's is refused (a dump from a
 *     newer server may not restore into an older one); older/equal is fine.
 */
export function verifyManifestCompatible(
	manifest: SnapshotManifest,
	target: TargetFacts
): VerifyResult {
	const reasons: string[] = [];
	const warnings: string[] = [];

	if (!SUPPORTED_SNAPSHOT_FORMAT_VERSIONS.has(manifest.snapshotFormatVersion)) {
		reasons.push(
			`snapshot format v${manifest.snapshotFormatVersion} — this build reads only v${[
				...SUPPORTED_SNAPSHOT_FORMAT_VERSIONS
			].join('/')}.`
		);
	}
	if (manifest.chainId !== target.chainId) {
		reasons.push(
			`chain mismatch: snapshot is for chain '${manifest.chainId}', this node indexes '${target.chainId}'. Restoring would load another chain's state.`
		);
	}
	if (manifest.schemaVersion > target.codeSchemaVersion) {
		reasons.push(
			`snapshot schema v${manifest.schemaVersion} is newer than this build's v${target.codeSchemaVersion} — upgrade this node before restoring.`
		);
	} else if (manifest.schemaVersion < target.codeSchemaVersion) {
		warnings.push(
			`snapshot schema v${manifest.schemaVersion} < build v${target.codeSchemaVersion}; the indexer will forward-migrate on first start.`
		);
	}
	if (manifest.pgMajor > target.pgMajor) {
		reasons.push(
			`snapshot came from PostgreSQL ${manifest.pgMajor}; this host runs ${target.pgMajor}. A dump from a newer server may not restore into an older one.`
		);
	}

	return { ok: reasons.length === 0, reasons, warnings };
}
