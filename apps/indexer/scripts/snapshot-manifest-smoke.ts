#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/snapshot-manifest-smoke.ts (cp764)
 *
 * Locks the SAFETY core of the indexer-DB snapshot bootstrap: the pure rules
 * that decide whether a snapshot may be restored onto a box. A wrong "compatible"
 * verdict could load another chain's derived state or a schema this build can't
 * run, so every rule must fail CLOSED. Exhaustive, no DB/fs needed.
 */
import {
	SNAPSHOT_FORMAT_VERSION,
	SUPPORTED_SNAPSHOT_FORMAT_VERSIONS,
	buildManifest,
	parseManifest,
	verifyManifestCompatible,
	manifestFederationReadiness,
	type SnapshotManifest,
	type TargetFacts
} from '../src/db/snapshotManifest.ts';

let pass = 0;
const fails: string[] = [];
function check(desc: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${desc}`);
	} else {
		fails.push(desc);
		console.log(`  ✗ ${desc}`);
	}
}

console.log('\n── snapshot manifest safety smoke (cp764) ─────────────\n');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const TARGET: TargetFacts = { chainId: 'BLURT-MAINNET', codeSchemaVersion: 40, pgMajor: 16 };
const base = buildManifest({
	chainId: 'BLURT-MAINNET',
	schemaVersion: 40,
	lastAppliedBlock: 62_000_000,
	pgMajor: 16,
	sourceLabel: 'https://morphit.io',
	indexerVersion: '1.14.0',
	dumpSha256: SHA_A,
	now: new Date('2026-08-18T00:00:00Z')
});

// ── happy path ────────────────────────────────────────────────────
{
	const r = verifyManifestCompatible(base, TARGET);
	check('matching chain + equal schema + equal pg → OK', r.ok && r.reasons.length === 0);
}

// ── chain mismatch is FATAL ───────────────────────────────────────
{
	const r = verifyManifestCompatible({ ...base, chainId: 'BLURT-TESTNET' }, TARGET);
	check('different chain id is REFUSED', !r.ok && r.reasons.some((x) => /chain mismatch/i.test(x)));
}

// ── schema: newer snapshot than code is refused; older only warns ─
{
	const r = verifyManifestCompatible({ ...base, schemaVersion: 41 }, TARGET);
	check('schema NEWER than this build is REFUSED', !r.ok && r.reasons.some((x) => /newer than this build/i.test(x)));
}
{
	const r = verifyManifestCompatible({ ...base, schemaVersion: 38 }, TARGET);
	check('schema OLDER than build is allowed (forward-migrate warning, not refusal)', r.ok && r.warnings.some((x) => /forward-migrate/i.test(x)));
}

// ── postgres major: newer source refused, older/equal fine ────────
{
	const r = verifyManifestCompatible({ ...base, pgMajor: 17 }, TARGET);
	check('snapshot from a NEWER Postgres major is REFUSED', !r.ok && r.reasons.some((x) => /PostgreSQL 17/.test(x)));
}
{
	const r = verifyManifestCompatible({ ...base, pgMajor: 15 }, TARGET);
	check('snapshot from an OLDER Postgres major is allowed', r.ok);
}

// ── snapshot format version guard ─────────────────────────────────
{
	const r = verifyManifestCompatible({ ...base, snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION + 1 }, TARGET);
	check('unknown (newer) snapshot format version is REFUSED', !r.ok && r.reasons.some((x) => /snapshot format/i.test(x)));
}
{
	// A legacy v1 manifest (no v2 fields) must STILL restore via the own-box path —
	// an upgrade never orphans an operator's existing snapshot.
	const v1: SnapshotManifest = {
		snapshotFormatVersion: 1,
		chainId: 'BLURT-MAINNET',
		schemaVersion: 40,
		lastAppliedBlock: 62_000_000,
		pgMajor: 16,
		createdAt: '2026-08-18T00:00:00Z',
		sourceLabel: 'own-box'
	};
	const r = verifyManifestCompatible(v1, TARGET);
	check('legacy v1 manifest is STILL accepted (backward compatible)', r.ok);
	check('v1 is in the supported set', SUPPORTED_SNAPSHOT_FORMAT_VERSIONS.has(1));
}

// ── federation readiness gate (public/third-party path only) ──────
{
	const r = manifestFederationReadiness(base, SHA_A);
	check('v2 manifest with sha256 + matching anchor is federation-ready', r.ok);
}
{
	const v1: SnapshotManifest = { ...base, snapshotFormatVersion: 1, dumpSha256: undefined, indexerVersion: undefined };
	const r = manifestFederationReadiness(v1);
	check('v1 manifest is REFUSED for the federated path (needs v2)', !r.ok && r.reasons.some((x) => /v2/i.test(x)));
}
{
	const noHash: SnapshotManifest = { ...base, dumpSha256: undefined };
	const r = manifestFederationReadiness(noHash);
	check('federated path REFUSES a manifest with no dumpSha256', !r.ok && r.reasons.some((x) => /dumpSha256/i.test(x)));
}
{
	const r = manifestFederationReadiness(base, SHA_B);
	check('federated path REFUSES a manifest whose sha256 disagrees with the anchor', !r.ok && r.reasons.some((x) => /disagreement/i.test(x)));
}

// ── v2 field validation in parseManifest ──────────────────────────
check('parseManifest rejects a malformed dumpSha256', parseManifest(JSON.stringify({ ...base, dumpSha256: 'nothex' })) === null);
check('parseManifest rejects an unknown opCoverage', parseManifest(JSON.stringify({ ...base, opCoverage: 'bogus' })) === null);
{
	const round = parseManifest(JSON.stringify(base));
	check('parseManifest round-trips v2 fields', round !== null && round.dumpSha256 === SHA_A && round.opCoverage === 'full');
}
{
	// v1 JSON without the v2 fields must still parse (own-box legacy on disk).
	const v1json = JSON.stringify({
		snapshotFormatVersion: 1,
		chainId: 'BLURT-MAINNET',
		schemaVersion: 40,
		lastAppliedBlock: 62_000_000,
		pgMajor: 16,
		createdAt: '2026-08-18T00:00:00Z',
		sourceLabel: 'own-box'
	});
	const round = parseManifest(v1json);
	check('parseManifest still parses a legacy v1 manifest (no v2 fields)', round !== null && round.dumpSha256 === undefined);
}
{
	let threw = false;
	try {
		buildManifest({ chainId: 'x', schemaVersion: 1, lastAppliedBlock: 1, pgMajor: 16, sourceLabel: 's', indexerVersion: '1', dumpSha256: 'bad' });
	} catch {
		threw = true;
	}
	check('buildManifest THROWS on a bad dumpSha256 (fail closed at creation)', threw);
}

// ── several problems at once → all reported, still refused ────────
{
	const r = verifyManifestCompatible({ ...base, chainId: 'X', schemaVersion: 99, pgMajor: 99 }, TARGET);
	check('multiple mismatches all surface and it is refused', !r.ok && r.reasons.length >= 3);
}

// ── parseManifest fails CLOSED on anything malformed ──────────────
check('parseManifest rejects non-JSON', parseManifest('not json') === null);
check('parseManifest rejects an empty object', parseManifest('{}') === null);
check('parseManifest rejects a missing chainId', parseManifest(JSON.stringify({ ...base, chainId: undefined })) === null);
check('parseManifest rejects a negative lastAppliedBlock', parseManifest(JSON.stringify({ ...base, lastAppliedBlock: -1 })) === null);
check('parseManifest rejects a non-integer schemaVersion', parseManifest(JSON.stringify({ ...base, schemaVersion: 1.5 })) === null);
{
	const round = parseManifest(JSON.stringify(base));
	check('parseManifest round-trips a valid manifest', round !== null && round.chainId === 'BLURT-MAINNET' && round.lastAppliedBlock === 62_000_000);
}

// ── buildManifest stamps the current format version ───────────────
check('buildManifest stamps the current snapshot format version', (base as SnapshotManifest).snapshotFormatVersion === SNAPSHOT_FORMAT_VERSION);

const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} snapshot-manifest checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} snapshot-manifest scenarios passed`);
