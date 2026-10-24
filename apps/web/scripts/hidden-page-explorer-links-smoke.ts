#!/usr/bin/env tsx
/**
 * v1.21.15 — a hidden site (.onion / .i2p / .loki) never shows a link to a
 * clearnet block explorer.
 *
 * The link builders in `$lib/explorer/urls.ts` pick hidden explorers on a
 * hidden page and return null / [] where there is none (hiddenExplorers.test.ts
 * covers that). This smoke covers the PAGES:
 *
 *   1. every use of `blurtWalletExplorerFallbackUrl(...)` sits under an
 *      `{#if}` on that same call — never `href={blurtWalletExplorerFallbackUrl(`
 *      directly, which would render an empty link on a hidden page;
 *   2. the explorer home page's fixed blocks.blurtwallet.com card is shown only
 *      when the page is clearnet, decided after mount (the page is prerendered
 *      once for every host);
 *   3. no page or module writes a clearnet block-explorer address of its
 *      own (every host in the bundled lists, .svelte/.ts/.js under src):
 *      every explorer link goes through the builders.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');
const SRC = join(REPO, 'apps/web/src');

let failures = 0;
let scenarios = 0;
function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

function svelteFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...svelteFiles(p));
		else if (name.endsWith('.svelte')) out.push(p);
	}
	return out;
}
function codeFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...codeFiles(p));
		else if (/\.(svelte|ts|js)$/.test(name)) out.push(p);
	}
	return out;
}
const FILES = svelteFiles(SRC).map((p) => ({
	rel: relative(REPO, p),
	src: readFileSync(p, 'utf8')
}));

scenario('the Blurt explorer fallback link is rendered only when the builder gives one', () => {
	let uses = 0;
	for (const { rel, src } of FILES) {
		assert(
			!/href=\{\s*blurtWalletExplorerFallbackUrl\(/.test(src),
			`${rel}: href={blurtWalletExplorerFallbackUrl(...)} renders an empty link on a hidden page — wrap it in {#if}`
		);
		const calls = [...src.matchAll(/blurtWalletExplorerFallbackUrl\(([^)]*)\)/g)].map((m) => m[1]);
		for (const args of new Set(calls)) {
			uses++;
			assert(
				src.includes(`{#if blurtWalletExplorerFallbackUrl(${args})}`),
				`${rel}: blurtWalletExplorerFallbackUrl(${args}) is used without {#if blurtWalletExplorerFallbackUrl(${args})}`
			);
		}
	}
	assert(uses === 3, `expected the tx, block and account pages to use it (3), found ${uses}`);
});

scenario('the explorer home page shows blocks.blurtwallet.com only on a clearnet page', () => {
	const rel = 'apps/web/src/routes/[lang]/explorer/+page.svelte';
	const src = FILES.find((f) => f.rel === rel)?.src ?? '';
	assert(src !== '', `${rel} not found`);
	const at = src.indexOf('href="https://blocks.blurtwallet.com"');
	assert(at > 0, 'the fallback card moved — update this smoke');
	const gate = src.lastIndexOf('{#if showClearnetFallback}', at);
	assert(
		gate > 0 && src.indexOf('{/if}', gate) > at,
		'the blocks.blurtwallet.com card is not inside {#if showClearnetFallback}'
	);
	assert(
		/let showClearnetFallback = \$state\(false\);/.test(src),
		'showClearnetFallback must start false (prerendered for every host)'
	);
	assert(
		/onMount\(\(\) => \{\s*showClearnetFallback = currentPageNetwork\(\) === 'clearnet';\s*\}\);/.test(
			src
		),
		'showClearnetFallback must be set after mount from currentPageNetwork()'
	);
});

scenario('no page or module writes a clearnet explorer address of its own', () => {
	// Every explorer host the app knows, taken from the lists themselves (so a
	// new bundled explorer is covered without editing this smoke): the
	// clearnet lists in urlsCore.ts and the token defaults in networks.ts.
	const sources = [
		readFileSync(join(SRC, 'lib/explorer/urlsCore.ts'), 'utf8'),
		readFileSync(join(SRC, 'lib/assets/networks.ts'), 'utf8')
	].join('\n');
	const hosts = new Set(
		[...sources.matchAll(/['"`]https?:\/\/([a-z0-9.-]+)[/'"`#]/g)].map((m) => m[1]!.toLowerCase())
	);
	hosts.add('blocks.blurtwallet.com');
	assert(hosts.size > 25, `expected the bundled explorer hosts, found ${hosts.size}`);
	const owners = new Set([
		'apps/web/src/lib/explorer/urlsCore.ts',
		'apps/web/src/lib/explorer/urls.ts',
		'apps/web/src/lib/assets/networks.ts'
	]);
	const files = codeFiles(SRC)
		.map((p) => ({ rel: relative(REPO, p), src: readFileSync(p, 'utf8') }))
		.filter((f) => !owners.has(f.rel) && !/\.(test|spec)\.ts$/.test(f.rel));
	assert(files.length > 100, `expected the web source files, found ${files.length}`);
	for (const { rel, src } of files) {
		const hits = [...src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)]
			.map((m) => m[1]!.toLowerCase())
			.filter((h) => hosts.has(h));
		const allowed =
			rel === 'apps/web/src/routes/[lang]/explorer/+page.svelte'
				? hits.filter((h) => h !== 'blocks.blurtwallet.com')
				: hits;
		assert(
			allowed.length === 0,
			`${rel}: ${allowed.join(', ')} — build explorer links with $lib/explorer/urls`
		);
	}
});

console.log(`\n${'─'.repeat(56)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
