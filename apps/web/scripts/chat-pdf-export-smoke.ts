#!/usr/bin/env tsx
/**
 * apps/web/scripts/chat-pdf-export-smoke.ts (cp404)
 *
 * Invariants over the LOCKED, courtroom-grade chat PDF export in
 * ConversationView.svelte:
 *   • Built entirely client-side from decrypted in-memory messages — no
 *     plaintext leaves the browser, no server round-trip.
 *   • jsPDF is DYNAMICALLY imported (await import('jspdf')) so it is
 *     code-split and only fetched when a user actually exports — the
 *     footprint stays lean and it honours the lazy-load posture. There
 *     must be NO static top-level `import ... from 'jspdf'`.
 *   • The PDF is LOCKED: an owner password + a permission set that omits
 *     modification (view/print/copy only).
 *   • The REAL tamper-evidence: every message cites its on-chain
 *     transaction id (LocalMessage.trxId → "Blockchain proof"), with a
 *     "pending confirmation" fallback for not-yet-anchored messages.
 *   • Plain-language verification explainer + both parties' posting keys
 *     + the order it regards are included (legal-document structure).
 *   • Failed-decrypt messages render the encrypted placeholder.
 *   • The kebab exposes the export item.
 *   • source_trx_id is plumbed end-to-end so trxId can be populated.
 * Plus i18n parity for the 15 chat.export.* keys across all 10 locales.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const read = (p: string) => readFileSync(resolve(WEB, p), 'utf8');

let total = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
	total++;
	if (cond) console.log(`  \u2713 ${name}`);
	else {
		failed++;
		console.log(`  \u2717 ${name}`);
		if (detail) console.log(`      ${detail}`);
	}
};

const cv = read('src/lib/components/ConversationView.svelte');

check('1 exportChatToPdf function exists (async)', /async function exportChatToPdf\(/.test(cv));
check(
	'2 jsPDF is dynamically imported (code-split / lazy)',
	/await import\(['"]jspdf['"]\)/.test(cv)
);
check(
	'3 NO static top-level jspdf import (would defeat code-splitting)',
	!/^\s*import\s+.*from\s+['"]jspdf['"]/m.test(cv),
	'jspdf must be dynamically imported only'
);
check(
	'4 PDF is locked (owner password + restricted permissions, no modify)',
	/encryption:\s*\{[\s\S]*ownerPassword[\s\S]*userPermissions:\s*\[['"]print['"],\s*['"]copy['"]\]/.test(cv)
);
check(
	'5 owner password is randomly generated (crypto.getRandomValues)',
	/crypto\.getRandomValues/.test(cv) && /ownerPassword/.test(cv)
);
check(
	'6 every message cites its on-chain transaction id (proof)',
	/m\.trxId/.test(cv) && /chat\.export\.proof_label/.test(cv)
);
check(
	'7 pending fallback for not-yet-anchored messages',
	/chat\.export\.pending_label/.test(cv)
);
check(
	'8 legal structure: verify explainer + parties + posting keys + regarding',
	/chat\.export\.verify_body/.test(cv) &&
		/chat\.export\.parties_heading/.test(cv) &&
		/chat\.export\.posting_key_label/.test(cv) &&
		/(myPostingKey|peerPostingKey)/.test(cv) &&
		/chat\.export\.regarding/.test(cv)
);
check('9 timestamps use the canonical UTC formatter', /formatDayMonthTime\(m\.createdAt\.toISOString\(\)\)/.test(cv));
check(
	'10 failed-decrypt renders the encrypted placeholder',
	/m\.decryptFailed \?[\s\S]*chat\.export\.encrypted/.test(cv)
);
check('11 kebab menu exposes the export item', /chat\.export\.menu_label/.test(cv) && /onclick=\{exportChatToPdf\}/.test(cv));
check('12 triggers a real download (doc.save)', /doc\.save\(/.test(cv));

// ─── source_trx_id plumbed end-to-end ─────────────────────────────
const rec = read('../../packages/indexer-client/src/index.ts');
check('13 ChatMessageRecord carries source_trx_id', /source_trx_id\?:\s*string/.test(rec));
const svc = read('src/lib/chat/chatService.ts');
check(
	'14 LocalMessage.trxId populated from source_trx_id',
	/trxId:\s*string \| null/.test(svc) && /source_trx_id \|\| null/.test(svc)
);
const helpers = read('../indexer/src/api/chatStreamHelpers.ts');
check('15 indexer wire row exposes source_trx_id', /source_trx_id:\s*string/.test(helpers));

// ─── jspdf present as a dependency (intentional, for the dynamic import) ─
const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
check(
	'16 jspdf is a pinned dependency',
	typeof pkg.dependencies?.jspdf === 'string',
	'the dynamic import needs jspdf installed'
);

// ─── i18n parity for the 15 chat.export keys ──────────────────────
const LOCALES_DIR = resolve(WEB, 'src/lib/i18n/locales');
const KEYS = [
	'menu_label', 'title', 'regarding', 'exported_at', 'you', 'encrypted', 'no_messages',
	'subtitle', 'parties_heading', 'posting_key_label', 'verify_heading', 'verify_body',
	'proof_label', 'pending_label', 'footer'
];
const files = readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));
check('17 found the 10 expected locales', files.length === 10, `found ${files.length}`);

for (const lf of files) {
	const loc = lf.replace('.json', '');
	const d = JSON.parse(readFileSync(join(LOCALES_DIR, lf), 'utf8')) as {
		chat?: { export?: Record<string, string> };
	};
	const e = d.chat?.export ?? {};
	const missing = KEYS.filter((k) => typeof e[k] !== 'string' || e[k].length === 0);
	check(`18.${loc} has all 15 chat.export keys`, missing.length === 0, `missing: ${missing.join(', ')}`);
	check(`19.${loc} title keeps {peer}`, (e['title'] ?? '').includes('{peer}'), e['title'] ?? '');
	check(`20.${loc} regarding keeps {summary}`, (e['regarding'] ?? '').includes('{summary}'), e['regarding'] ?? '');
	check(`21.${loc} exported_at keeps {datetime}`, (e['exported_at'] ?? '').includes('{datetime}'), e['exported_at'] ?? '');
}

console.log('');
if (failed > 0) {
	console.log(`\u2717 ${failed}/${total} chat-pdf-export scenarios failed`);
	process.exit(1);
}
console.log(`\u2713 all ${total} chat-pdf-export scenarios passed`);
