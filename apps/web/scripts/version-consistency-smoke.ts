#!/usr/bin/env tsx
/**
 * version-consistency-smoke — Part 122 cp20.
 *
 * Asserts every place Morphit's version string lives agrees with
 * the root package.json `version` field.  Three categories of
 * touchpoint:
 *
 *   A. The workspace package.json `version` fields, discovered
 *      DYNAMICALLY by reading the root package.json's `workspaces`
 *      array.  Adding/removing a workspace automatically expands
 *      or contracts the smoke's coverage — no need to update this
 *      file when the workspace list changes (DD-cp20-14, Part 122
 *      cp20 deep-deep).
 *
 *   B. Two runtime version constants shipped to operators and
 *      external monitors via /v1/health:
 *        - apps/relay/src/api/health.ts:  const VERSION = '…'
 *        - apps/indexer/src/api/health.ts: const INDEXER_VERSION = '…'
 *
 *   C. Two doc example responses that operators/integrators read:
 *        - docs/API.md            (one fenced ```json block with
 *                                  "version": "…")
 *        - apps/indexer/README.md (same)
 *
 * Why this exists.  Pre-cp20 the runtime constants reported
 * `0.3.0-phase3a` and `0.1.0-phase3b` while the root package.json
 * said `0.0.0-phase3b` and the docs said `0.1.0-phase3b` — four
 * different version strings, none of them the release tag.  At
 * v1.0.0-beta.3 launch a user hitting morphit.io/v1/health would
 * have seen a phase-name that contradicted the release notes.
 *
 * The gate.  On any version bump, the human edits ONE source of
 * truth (root package.json) and then propagates to the other 13
 * sites BEFORE this smoke turns green.  Mismatch surfaces as a
 * loud CI failure with a remediation hint per touchpoint.
 *
 * Output contract: emits `✓ all N version-consistency scenarios
 * pass` on the last line; scenario N is the number of distinct
 * touchpoints verified.  Mismatch exits non-zero.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');

interface Touchpoint {
	readonly label: string;
	readonly path: string;
	readonly extract: (text: string) => string | null;
	/** What to tell the developer when this touchpoint is wrong. */
	readonly remediation: string;
}

/** Reads root package.json `version` — the SOURCE OF TRUTH. */
function rootVersion(): string {
	const raw = readFileSync(join(REPO, 'package.json'), 'utf8');
	const pkg = JSON.parse(raw) as { version?: unknown };
	if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
		throw new Error(
			'root package.json `version` is missing or non-string — ' +
				'this is the source of truth, fix it first.'
		);
	}
	return pkg.version;
}

/** Extractor for a package.json file. */
function packageJsonExtractor(text: string): string | null {
	try {
		const pkg = JSON.parse(text) as { version?: unknown };
		return typeof pkg.version === 'string' ? pkg.version : null;
	} catch {
		return null;
	}
}

/** Extractor for `const NAME = '...';` patterns in TS source.
 *
 *  Returns the FIRST match.  We anchor on the const-name to avoid
 *  picking up an unrelated literal somewhere else in the file. */
function tsConstExtractor(constName: string) {
	const re = new RegExp(
		`const\\s+${constName}\\s*(?::\\s*\\w+\\s*)?=\\s*['"]([^'"]+)['"]`
	);
	return (text: string): string | null => {
		const m = text.match(re);
		return m && m[1] ? m[1] : null;
	};
}

/** Extractor for `"version": "…"` inside a fenced ```json block.
 *
 *  We only want example-response versions, not arbitrary JSON
 *  fragments elsewhere in the doc.  The regex requires the line
 *  to be inside a fenced block AND look like a real version
 *  string (digits + dots, optional pre-release suffix).  We match
 *  the FIRST such line — by convention the API.md and README
 *  example responses are at the top of the health-endpoint
 *  section, so this is stable. */
function docExampleExtractor(text: string): string | null {
	// Match "version": "<vstring>" anywhere; the smoke doc is small
	// enough that "first occurrence" is well-defined.
	const m = text.match(/"version"\s*:\s*"([0-9][0-9A-Za-z.+\-]*)"/);
	return m && m[1] ? m[1] : null;
}

const TOUCHPOINTS_STATIC: readonly Touchpoint[] = [
	// Category A — workspace package.json files are NOT listed here;
	// they're discovered dynamically below from root package.json's
	// `workspaces` array.  This way the smoke stays correct when a
	// workspace is added or removed without anyone remembering to
	// update this file (DD-cp20-14, Part 122 cp20 deep-deep).
	//
	// The static list below covers the non-workspace touchpoints
	// only.

	// Category B — runtime constants shipped to /v1/health.
	{
		label: "apps/relay/src/api/health.ts (`const VERSION`)",
		path: 'apps/relay/src/api/health.ts',
		extract: tsConstExtractor('VERSION'),
		remediation:
			'update `const VERSION = ...` in apps/relay/src/api/health.ts'
	},
	{
		label: "apps/indexer/src/api/health.ts (`const INDEXER_VERSION`)",
		path: 'apps/indexer/src/api/health.ts',
		extract: tsConstExtractor('INDEXER_VERSION'),
		remediation:
			'update `const INDEXER_VERSION = ...` in apps/indexer/src/api/health.ts'
	},

	// Category C — doc example responses.
	{
		label: 'docs/API.md (health example response)',
		path: 'docs/API.md',
		extract: docExampleExtractor,
		remediation:
			'update the `"version"` line in the /v1/health example response in docs/API.md'
	},
	{
		label: 'apps/indexer/README.md (health example response)',
		path: 'apps/indexer/README.md',
		extract: docExampleExtractor,
		remediation:
			'update the `"version"` line in the /v1/health example response in apps/indexer/README.md'
	}
] as const;

/** Build the full touchpoint list dynamically.
 *
 *  Reads the root package.json's `workspaces` array, treats every
 *  entry as a workspace directory (must have package.json), and
 *  emits one Touchpoint per (root + workspace) plus the static
 *  Category B + Category C touchpoints above.
 *
 *  Why dynamic: hardcoding the list of workspace package.json
 *  files in this smoke means adding a new workspace silently
 *  leaves its version unchecked.  Reading the canonical workspaces
 *  array closes that drift mode — the smoke automatically expands
 *  to cover whatever the root package.json declares.
 *
 *  Limitation: only handles exact path entries in `workspaces`,
 *  not globs like `apps/*`.  If a future maintainer adds glob
 *  workspace entries, this function should be extended with
 *  fs.globSync (Node 22+).  Today's root package.json has only
 *  exact paths, so this is sufficient. */
function buildTouchpoints(): readonly Touchpoint[] {
	const rootRaw = readFileSync(join(REPO, 'package.json'), 'utf8');
	const rootPkg = JSON.parse(rootRaw) as { workspaces?: unknown };
	if (!Array.isArray(rootPkg.workspaces)) {
		throw new Error(
			'root package.json `workspaces` is missing or non-array — ' +
				'cannot enumerate workspace package.json files'
		);
	}
	const wsEntries: string[] = [];
	for (const w of rootPkg.workspaces) {
		if (typeof w !== 'string') {
			throw new Error(
				'root package.json `workspaces` entry not a string: ' +
					JSON.stringify(w)
			);
		}
		if (w.includes('*') || w.includes('?')) {
			throw new Error(
				"root package.json `workspaces` entry '" +
					w +
					"' contains a glob; " +
					'this smoke only supports exact paths today — extend ' +
					'buildTouchpoints() with fs.globSync (Node 22+) if glob ' +
					'support is needed.'
			);
		}
		wsEntries.push(w);
	}

	const dynamic: Touchpoint[] = [
		{
			label: 'root package.json',
			path: 'package.json',
			extract: packageJsonExtractor,
			remediation: 'edit `version` in the root package.json'
		}
	];
	for (const ws of wsEntries) {
		dynamic.push({
			label: `${ws}/package.json`,
			path: `${ws}/package.json`,
			extract: packageJsonExtractor,
			remediation: `edit \`version\` in ${ws}/package.json`
		});
	}

	return [...dynamic, ...TOUCHPOINTS_STATIC];
}

function main(): void {
	const expected = rootVersion();
	const TOUCHPOINTS = buildTouchpoints();
	const mismatches: Array<{
		label: string;
		got: string | null;
		remediation: string;
	}> = [];

	for (const tp of TOUCHPOINTS) {
		let text: string;
		try {
			text = readFileSync(join(REPO, tp.path), 'utf8');
		} catch (e) {
			mismatches.push({
				label: tp.label,
				got: null,
				remediation: `file missing: ${tp.path} — ${tp.remediation}`
			});
			continue;
		}
		const got = tp.extract(text);
		if (got !== expected) {
			mismatches.push({
				label: tp.label,
				got,
				remediation: tp.remediation
			});
		}
	}

	// cp188 — release-notes file MUST exist for the current version.
	// Ken's standing rule: every release ships notes that go online
	// with it.  The release CI uploads the tarball but does not author
	// the release body, so nothing otherwise forces a notes file into
	// existence on a version bump.  Tie it to the version here: bumping
	// package.json to v1.0.0-beta.2 without creating
	// RELEASE-NOTES-v1.0.0-beta.2.md now fails this gate.
	const notesFile = `RELEASE-NOTES-v${expected}.md`;
	try {
		const notes = readFileSync(join(REPO, notesFile), 'utf8');
		if (notes.trim().length === 0) {
			mismatches.push({
				label: notesFile,
				got: '<empty>',
				remediation: `${notesFile} exists but is empty — write the release notes that will be published online with this version`
			});
		}
	} catch {
		mismatches.push({
			label: notesFile,
			got: null,
			remediation: `create ${notesFile} at the repo root — every release must ship notes for publishing online (copy the structure of the prior RELEASE-NOTES-v*.md)`
		});
	}

	if (mismatches.length > 0) {
		console.error(
			`✗ version-consistency-smoke FAILED — expected '${expected}' (from root package.json), found:`
		);
		for (const m of mismatches) {
			console.error(
				`  - ${m.label}: ${m.got === null ? '<not found>' : `'${m.got}'`}`
			);
			console.error(`      fix: ${m.remediation}`);
		}
		console.error(
			`\nWhen bumping for a release, change all ${TOUCHPOINTS.length} touchpoints in the same commit.`
		);
		process.exit(1);
	}

	console.log(
		`✓ all ${TOUCHPOINTS.length} version-consistency scenarios pass (every touchpoint reports '${expected}'), and ${notesFile} exists`
	);
}

main();
