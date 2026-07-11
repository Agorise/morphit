#!/usr/bin/env tsx
/**
 * Smoke: the block-explorer + download polish from t.txt (cp450, items 1–4).
 *
 *   1. The explorer ACCOUNT page loads its four independent fetches
 *      CONCURRENTLY (balance/keys/avatar/history), not as four serial
 *      round-trips — otherwise the page only appears after the slowest chain.
 *   2. The "Loading account…" transient text animates its trailing dots via
 *      the shared LoadingDots component (typewriter), and LoadingDots is
 *      reduced-motion-safe + fixed-width (no layout shift).
 *   3. Each "Recent operations" row tints the dim FAQ emerald on hover.
 *   4. The download mirror cards show the pointer cursor (they are full <a>
 *      links but .card-interactive forces cursor-default).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const strip = (s: string): string =>
	s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const account = strip(
	readFileSync(
		join(WEB, 'src', 'routes', '[lang]', 'explorer', 'account', '[name=account]', '+page.svelte'),
		'utf8'
	)
);
const download = strip(
	readFileSync(join(WEB, 'src', 'routes', '[lang]', 'download', '+page.svelte'), 'utf8')
);
const loadingDots = strip(
	readFileSync(join(WEB, 'src', 'lib', 'components', 'LoadingDots.svelte'), 'utf8')
);

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean): void => {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
};

// ── item 1: concurrent fetches + PROGRESSIVE render ─────────────────
check(
	'loadInitial fires balance + keys + avatar concurrently up front',
	/const balanceP = fetchAccountBalance\(/.test(account) &&
		/const keysP = fetchAccountKeys\(/.test(account) &&
		/const avatarP = getProfilesBatch\(/.test(account)
);
check(
	'the page reveals on BALANCE (progressive) — not after the heaviest fetch',
	/applyBalanceData\(r\.data\);[\s\S]{0,160}status = 'ok';/.test(account)
);
check(
	'keys + avatar stream in without gating the page',
	/void keysP\.then\(/.test(account) &&
		/void avatarP\.then\(/.test(account) &&
		!/await keysP/.test(account) &&
		!/await avatarP/.test(account)
);
check(
	'history streams into the ops list with its own loading/error state',
	/void fetchHistory\(-1\)/.test(account) &&
		/historyError = true;/.test(account) &&
		/historyLoading = false;/.test(account)
);
check(
	'…NOT the old serial chain (no inline await of keys/avatar/history)',
	!/await fetchAccountKeys\(/.test(account) &&
		!/await getProfilesBatch\(/.test(account) &&
		!/const historyP = /.test(account)
);

// ── item 2: typewriter loading dots ─────────────────────────────────
check(
	'the "Loading account…" text renders through LoadingDots',
	/import LoadingDots from '\$components\/LoadingDots\.svelte'/.test(account) &&
		/<LoadingDots label=\{\$_\('explorer\.account\.loading'\)\}/.test(account)
);
check(
	'LoadingDots strips the trailing ellipsis and animates the dots',
	/replace\(\/\[\\s\.\\u2026\]\+\$\/u, ''\)/.test(loadingDots) &&
		/@keyframes loading-dots-typewriter/.test(loadingDots)
);
check(
	'LoadingDots is fixed-width (no layout shift) + reduced-motion-safe',
	/width: 1\.5ch/.test(loadingDots) &&
		/@media \(prefers-reduced-motion: reduce\)/.test(loadingDots)
);
check(
	'the streaming-history placeholder also animates via LoadingDots (loading_ops)',
	/<LoadingDots label=\{\$_\('explorer\.account\.loading_ops'\)\}/.test(account)
);

// ── item 3: recent-operations hover green ───────────────────────────
check(
	'each Recent-operations row tints the dim FAQ emerald on hover',
	/hover:bg-emerald-50\/30/.test(account) &&
		/dark:hover:bg-morphit-emerald\/\[0\.05\]/.test(account)
);

// ── item 4: download mirror-card pointer cursor ─────────────────────
check(
	'download mirror cards use cursor-pointer (override .card-interactive)',
	/card-interactive card-hover-emerald flex cursor-pointer/.test(download)
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} explorer-download-polish scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} explorer-download-polish checks FAILED`);
	process.exit(1);
}
