#!/usr/bin/env tsx
/**
 * settings-visibility-scope — v1.8.11 (Ken, t.txt).
 *
 * WHY THIS EXISTS. The Settings page writes to three different destinations and
 * said so nowhere:
 *
 *   public  → `morphit_profile_v1`, an UNENCRYPTED chain record (name, avatar,
 *             bio, links). Permanent and world-readable.
 *   private → `morphit_settings_v1`, encrypted with a posting-key-derived key
 *             (notifications, hidden/blocked accounts, region, syndication).
 *   device  → never leaves this browser.
 *
 * Ken was caught by that boundary himself: he saved a screenful of fields, and
 * when told "kencode has never broadcast settings" he correctly objected — he
 * HAD saved settings, just to the other record. If the author of the software
 * trips on it, users will.
 *
 * A WRONG label is worse than none: telling someone their bio is private when
 * it is written in clear text to a permanent public ledger would be an actively
 * harmful lie, and privacy is priority #1. So the mapping is pinned here rather
 * than left to whoever next edits the page.
 *
 * Tamper tests (each must turn this red):
 *   - Flip any public section to scope="private".
 *   - Drop the badge from a section that has one.
 *   - Add a new card section without a badge.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const SETTINGS = join(WEB, 'src/routes/[lang]/settings/+page.svelte');
const src = readFileSync(SETTINGS, 'utf8');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── settings-visibility-scope (v1.8.11) ───────────────\n');

/**
 * The authoritative mapping. PUBLIC entries are the fields carried by
 * `broadcastProfile()` — verify against `$blurt/ops/profile.ts` before ever
 * moving one of these, because mislabelling a public field as private is the
 * failure that actually hurts someone.
 */
const EXPECTED: ReadonlyArray<readonly [string, 'public' | 'private' | 'device']> = [
	// morphit_profile_v1 — unencrypted, world-readable.
	['avatar-heading', 'public'],
	['display-name-heading', 'public'],
	['short-bio-heading', 'public'],
	['website-url-heading', 'public'],
	['streaming-heading', 'public'],
	['nostr-heading', 'public'],
	// morphit_settings_v1 — encrypted blob.
	['syndication-heading', 'private'],
	['hidden-accounts-heading', 'private'],
	['blocked-accounts-heading', 'private'],
	['preferences-heading', 'private'],
	// Never leaves the browser.
	['account-name-heading', 'device'],
	['endpoints-heading', 'device'],
	['session-heading', 'device'] // auto-lock + TOTP enrolment are bound to THIS browser
];

for (const [headingId, scope] of EXPECTED) {
	const idx = src.indexOf(`<h2 id="${headingId}"`);
	if (idx === -1) {
		check(`section present: ${headingId}`, false, 'heading id not found — was it renamed?');
		continue;
	}
	// The badge must sit within the heading's immediate vicinity, not merely
	// somewhere in a 2600-line file.
	const window = src.slice(idx, idx + 400);
	const m = /<VisibilityBadge scope="(public|private|device)"/.exec(window);
	check(
		`${headingId} is labelled ${scope}`,
		m !== null && m[1] === scope,
		m === null ? 'no VisibilityBadge near this heading' : `labelled "${m[1]}" instead`
	);
}

// Every public label must correspond to a field the PROFILE op actually
// broadcasts — the check that keeps this mapping honest rather than merely
// self-consistent.
const profileOp = readFileSync(join(WEB, 'src/lib/blurt/ops/profile.ts'), 'utf8');
for (const field of ['display_name', 'short_bio', 'website_url', 'streaming_url', 'nostr_url']) {
	check(
		`"${field}" really is carried by the public profile record`,
		profileOp.includes(field),
		'a field labelled Public must actually be broadcast unencrypted'
	);
}

// And the private ones must be in the encrypted blob's aggregate.
const sync = readFileSync(join(WEB, 'src/lib/settings/settingsSync.ts'), 'utf8');
for (const section of ['syndication', 'hidden', 'notifications', 'preferences']) {
	check(
		`"${section}" really is carried by the ENCRYPTED settings blob`,
		new RegExp(`${section}:`).test(sync),
		'a field labelled Private must actually be in the encrypted aggregate'
	);
}

// No card section should be left unlabelled — that is how the page drifted
// back into silence before.
const cardSections = [...src.matchAll(/<h2 id="([a-z-]+)"/g)].map((m) => m[1]!);
const labelled = new Set(EXPECTED.map(([id]) => id));
/** Sections that STORE NOTHING, so a visibility label would be noise rather
 *  than information. Kept as a named exemption instead of a blanket allowance:
 *  a section is either classified or explicitly declared value-free. */
const NO_STORED_VALUE = new Set([
	'install-heading' // how to install the PWA — instructions, not a setting
]);
const unlabelled = cardSections.filter((id) => !labelled.has(id) && !NO_STORED_VALUE.has(id));
check(
	'every settings section carries a visibility label',
	unlabelled.length === 0,
	unlabelled.length > 0
		? `unlabelled: ${unlabelled.join(', ')} → add to EXPECTED above with the right scope`
		: ''
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} settings-visibility-scope checks passed` : '✗ settings-visibility-scope FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
