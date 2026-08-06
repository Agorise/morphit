#!/usr/bin/env tsx
/**
 * Profile website_url field — end-to-end smoke.
 *
 * Guards the new on-chain `website_url` profile field. A field-name drift
 * between the layers (buildProfileBody writing website_url but the indexer's
 * closed key-set or the props extractor spelling it differently) would
 * silently drop the link with no type error, so this pins the wire name
 * across every layer:
 *   1. validateWebUrl        — behavior (runtime): any http/https host, XSS-safe.
 *   2. ProfilePayload + buildProfileBody  — website_url reaches json_metadata.
 *   3. indexer PROFILE_METADATA_KEYS      — the closed merge set admits it.
 *   4. profileProps extractor + primeProfile — website_url -> websiteUrl.
 *
 * webUrl.ts is pure so it's exercised for real; the other layers pull
 * SvelteKit ($app) / $lib aliases that bare tsx can't resolve, so they're
 * guarded by source-text assertions instead — which IS the drift risk.
 *
 * Usage (from apps/web):
 *   npx tsx --tsconfig tsconfig.smoke.json scripts/profile-website-url-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { validateWebUrl, validateWebUrlForRender } from '../src/lib/utils/webUrl';

const HERE = dirname(fileURLToPath(import.meta.url));
const rd = (rel: string): string => readFileSync(resolve(HERE, rel), 'utf-8');

let failures = 0;
let scenarios = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  \u2713 ${name}`);
	} catch (e) {
		failures++;
		console.log(`  \u2717 ${name}`);
		console.log(`      ${e instanceof Error ? e.message : String(e)}`);
	}
}
function eq(a: unknown, b: unknown, label: string): void {
	const x = JSON.stringify(a);
	const y = JSON.stringify(b);
	if (x !== y) throw new Error(`${label}: expected ${y}, got ${x}`);
}
function ok(c: boolean, label: string): void {
	if (!c) throw new Error(label);
}
function has(src: string, needle: string, label: string): void {
	if (!src.includes(needle)) throw new Error(`${label}: source is missing \`${needle}\``);
}

// 1. validator behavior (pure module — run for real)
scenario('validateWebUrl accepts any https host (youtube, rumble, personal)', () => {
	for (const u of ['https://youtube.com/@me', 'https://rumble.com/c/me', 'https://my.blog/']) {
		const r = validateWebUrl(u);
		ok(!!r && 'ok' in r && r.ok, `${u} should be ok`);
	}
});
scenario('validateWebUrl accepts http (onion / i2p / legacy)', () => {
	const r = validateWebUrl('http://example.i2p/blog');
	ok(!!r && 'ok' in r && r.ok, 'http should be ok');
});
scenario('validateWebUrl treats empty / whitespace as null (not an error)', () => {
	eq(validateWebUrl(''), null, 'empty');
	eq(validateWebUrl('   '), null, 'whitespace');
});
scenario('validateWebUrl rejects javascript: (XSS)', () => {
	const r = validateWebUrl('javascript:alert(1)');
	ok(!!r && 'ok' in r && !r.ok, 'javascript: must be rejected');
});
scenario('validateWebUrl rejects a non-web scheme with // (ftp)', () => {
	const r = validateWebUrl('ftp://files.example/x');
	ok(!!r && 'ok' in r && !r.ok && r.reason === 'invalid_scheme', 'ftp -> invalid_scheme');
});
scenario('validateWebUrl rejects a bare word', () => {
	const r = validateWebUrl('notaurl');
	ok(!!r && 'ok' in r && !r.ok && r.reason === 'malformed', 'bare word -> malformed');
});
scenario('validateWebUrl rejects an over-long URL', () => {
	const r = validateWebUrl('https://x.com/' + 'a'.repeat(600));
	ok(!!r && 'ok' in r && !r.ok && r.reason === 'too_long', 'long -> too_long');
});
scenario('validateWebUrlForRender returns cleaned string or null', () => {
	ok(typeof validateWebUrlForRender('https://blurt.media/@me') === 'string', 'valid -> string');
	eq(validateWebUrlForRender('javascript:x'), null, 'unsafe -> null');
});

// 2. broadcast body: ProfilePayload + buildProfileBody
scenario('ProfilePayload declares website_url, buildProfileBody writes it', () => {
	const src = rd('../src/lib/blurt/ops/profile.ts');
	has(src, 'website_url?: string;', 'ProfilePayload');
	has(src, 'jsonMetadata.website_url', 'buildProfileBody json_metadata');
	has(src, 'payload.website_url', 'buildProfileBody reads payload.website_url');
});

// 3. indexer closed metadata key set admits website_url
scenario('indexer PROFILE_METADATA_KEYS includes website_url', () => {
	const src = rd('../../indexer/src/indexer/handlers/profile.ts');
	has(src, 'PROFILE_METADATA_KEYS', 'indexer handler');
	has(src, "'website_url'", 'indexer closed key set');
});

// 4. props extractor + cache prime map website_url -> websiteUrl
scenario('profileProps extractor maps website_url -> websiteUrl', () => {
	const src = rd('../src/lib/indexer/profileProps.ts');
	has(src, 'readonly websiteUrl', 'IdentityLabelProfileProps');
	has(src, "websiteUrl: str('website_url')", 'extractor main return');
});
scenario('primeProfile carries websiteUrl into json_metadata.website_url', () => {
	const src = rd('../src/lib/indexer/profileCache.ts');
	has(src, 'websiteUrl?: string | null;', 'primeProfile props');
	has(src, 'jsonMetadata.website_url = props.websiteUrl', 'primeProfile writes it');
});

console.log(`\n${'\u2500'.repeat(54)}`);
if (failures === 0) {
	console.log(`\u2713 all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`\u2717 ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
