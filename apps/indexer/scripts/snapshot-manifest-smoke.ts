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
	buildManifest,
	parseManifest,
	verifyManifestCompatible,
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

const TARGET: TargetFacts = { chainId: 'BLURT-MAINNET', codeSchemaVersion: 40, pgMajor: 16 };
const base = buildManifest({
	chainId: 'BLURT-MAINNET',
	schemaVersion: 40,
	lastAppliedBlock: 62_000_000,
	pgMajor: 16,
	sourceLabel: 'https://morphit.io',
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
	check('unknown snapshot format version is REFUSED', !r.ok && r.reasons.some((x) => /snapshot format/i.test(x)));
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
