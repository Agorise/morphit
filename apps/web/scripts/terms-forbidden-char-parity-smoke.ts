/**
 * terms-forbidden-char-parity — cp422.
 *
 * The frontend blocks submit on terms the indexer would reject, using
 * `FORBIDDEN_TERMS_CHARS` in `src/lib/orders/termsForbiddenChars.ts`. That is
 * only a safety net if it stays BYTE-IDENTICAL to the indexer's terms gate,
 * `FORBIDDEN_MULTILINE_TEXT_CHARS`, defined in BOTH
 * `apps/indexer/src/indexer/handlers/order.ts` and `orderReplace.ts`. If they
 * drift, the frontend would again let a user broadcast (and pay the listing
 * fee for) an order the indexer silently drops. This smoke fails loudly on any
 * divergence.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');

/** Pull the character-class body out of `const NAME =\n  /[...]/;`. */
function extractClass(file: string, constName: string): string {
	const src = readFileSync(join(repo, file), 'utf8');
	const re = new RegExp(`const\\s+${constName}\\s*=\\s*\\n?\\s*/\\[([\\s\\S]*?)\\]/`, 'm');
	const m = src.match(re);
	if (!m) throw new Error(`could not find ${constName} regex in ${file}`);
	return m[1]!.trim();
}

const frontend = extractClass(
	'apps/web/src/lib/orders/termsForbiddenChars.ts',
	'FORBIDDEN_TERMS_CHARS'
);
const indexerCreate = extractClass(
	'apps/indexer/src/indexer/handlers/order.ts',
	'FORBIDDEN_MULTILINE_TEXT_CHARS'
);
const indexerReplace = extractClass(
	'apps/indexer/src/indexer/handlers/orderReplace.ts',
	'FORBIDDEN_MULTILINE_TEXT_CHARS'
);

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
		failures++;
	}
}

check(
	'frontend FORBIDDEN_TERMS_CHARS matches indexer order.ts FORBIDDEN_MULTILINE_TEXT_CHARS',
	frontend === indexerCreate,
	`frontend: ${frontend}\n      order.ts: ${indexerCreate}`
);
check(
	'indexer order.ts and orderReplace.ts FORBIDDEN_MULTILINE_TEXT_CHARS match',
	indexerCreate === indexerReplace,
	`order.ts:        ${indexerCreate}\n      orderReplace.ts: ${indexerReplace}`
);

// Sanity: the class must PERMIT tab/newline and BLOCK a control + a bidi char,
// so a copy-paste that accidentally re-adds \u0000-\u001F is caught here too.
const rx = new RegExp(`[${frontend}]`);
check('permits LF (multi-line markdown)', !rx.test('\u000A'));
check('permits TAB', !rx.test('\u0009'));
check('permits CR', !rx.test('\u000D'));
check('blocks a C0 control (BEL)', rx.test('\u0007'));
check('blocks a bidi override (RLO)', rx.test('\u202E'));
check('blocks a zero-width char (ZWSP)', rx.test('\u200B'));

const scenarios = 8;
console.log(`\n${'─'.repeat(56)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} terms-forbidden-char-parity scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} terms-forbidden-char-parity scenarios failed`);
	process.exit(1);
}
