#!/usr/bin/env tsx
/**
 * profile-link-glyphs-single-home — v1.8.9.
 *
 * A user's three profile links — website (globe), streaming (play), Nostr —
 * belong in exactly ONE place: the profile hero, beside the large avatar.
 *
 * They had quietly grown a second home. `IdentityLabel` carried its own
 * `nostrUrl` / `streamingUrl` / `websiteUrl` props and rendered the same three
 * glyphs at 14px — and IdentityLabel appears in chat messages, conversation
 * headers, order-poster identity, payment badges, the feedback form, reminder
 * banners and the orders list. It never actually showed, because no call site
 * ever passed the props, so it sat as a fully-wired feature one prop away from
 * appearing across nine surfaces. Removed; this keeps it removed.
 *
 * NOT in scope: the footer's and the instances page's `nostr` glyph. Those are
 * an INSTANCE's own reachability ("also reachable via"), a different feature
 * that happens to share an icon — which is exactly why this smoke keys on the
 * validated-URL identifiers rather than on the icon name.
 *
 * Tamper tests (each must turn this red):
 *   - Re-add a link glyph to IdentityLabel → fails.
 *   - Render the profile glyphs from any second component → fails.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SRC = join(REPO, 'apps/web/src');
const PROFILE_PAGE = 'apps/web/src/routes/[lang]/[x+40][account=account]/+page.svelte';

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

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (full.endsWith('.svelte')) out.push(full);
	}
	return out;
}

console.log('\n── profile-link-glyphs-single-home (v1.8.9) ──────────\n');

const files = walk(SRC);
check('svelte components were scanned', files.length > 0);

// The three validated-URL identifiers are the feature's fingerprint.
const MARKERS = ['validatedNostrUrl', 'validatedStreamingUrl', 'validatedWebsiteUrl'];
const homes = files.filter((f) => {
	const src = readFileSync(f, 'utf8');
	return MARKERS.some((m) => src.includes(m));
});
const rels = homes.map((f) => relative(REPO, f).split('\\').join('/'));

check(
	`the profile link glyphs live in exactly ONE component (found ${rels.length})`,
	rels.length === 1,
	rels.length === 0 ? 'none found — did the profile hero lose them?' : `also in: ${rels.join(', ')}`
);
check(
	'and that component is the profile hero page',
	rels.length === 1 && rels[0] === PROFILE_PAGE,
	`found in ${rels[0] ?? 'nothing'}`
);

// IdentityLabel is the one that regrew it before, so name it explicitly.
const identity = readFileSync(join(SRC, 'lib/components/IdentityLabel.svelte'), 'utf8');
check(
	'IdentityLabel carries no nostr/streaming/website props',
	!/\bnostrUrl\?:/.test(identity) &&
		!/\bstreamingUrl\?:/.test(identity) &&
		!/\bwebsiteUrl\?:/.test(identity),
	'it appears on ~9 surfaces; a prop here puts the glyphs on all of them'
);
check(
	'IdentityLabel renders no AltNetworkIcon at all',
	!/<AltNetworkIcon/.test(identity)
);

// The profile hero must still actually render all three.
const hero = readFileSync(join(REPO, PROFILE_PAGE), 'utf8');
for (const [label, net] of [
	['streaming (play)', 'play'],
	['website (globe)', 'globe'],
	['nostr', 'nostr']
] as const) {
	check(
		`the profile hero still renders the ${label} glyph`,
		new RegExp(`<AltNetworkIcon network="${net}"`).test(hero)
	);
}

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} profile-link-glyphs-single-home checks passed` : '✗ profile-link-glyphs-single-home FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
