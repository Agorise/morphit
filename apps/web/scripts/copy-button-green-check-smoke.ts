#!/usr/bin/env tsx
/**
 * Smoke: copy buttons show a GREEN "✓ Copied" state everywhere (Ken #6).
 * Anchor 2026-07-08.
 *
 * Guards the shared <CopyButton> + the copied-state treatment across the
 * copy controls: fee address (migrated to CopyButton), key backup, identity
 * key, FAQ share, the three chat pills (address/memo/txid), the 2FA secret,
 * and the setup-wizard command copies.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const comp = (n: string) => readFileSync(join(WEB, 'src', 'lib', 'components', `${n}.svelte`), 'utf8');
const route = (p: string) => readFileSync(join(WEB, 'src', 'routes', '[lang]', p), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

// ── Shared component ────────────────────────────────────────────────────────
const cb = comp('CopyButton');
check('CopyButton owns the clipboard write', /navigator\.clipboard\.writeText\(value\)/.test(cb));
check('CopyButton copied state is green', /copied \?\s*'text-green-600 dark:text-green-400'/.test(cb));
check('CopyButton copied state shows a ✓', /aria-hidden="true">\s*✓/.test(cb));
check('CopyButton reverts the flash on a timer', /setTimeout\([\s\S]*copied = false/.test(cb));

// ── Fee address migrated (Ken's example) ────────────────────────────────────
const fee = comp('ListingFeeAddressPanel');
check('fee-address panel uses <CopyButton>', /<CopyButton/.test(fee) && /value=\{resolved\.address\}/.test(fee));
check('fee-address panel dropped its old copyAddress/copyAddrFlash', !/copyAddrFlash/.test(fee) && !/async function copyAddress/.test(fee));

// ── Icon copy buttons go green when copied ──────────────────────────────────
const kb = comp('KeyBackupPanel');
check('key-backup copy goes green when copied', /copiedId ===\s*\n?\s*id[\s\S]{0,80}text-green-600/.test(kb));
const il = comp('IdentityLabel');
check('identity-key copy goes green when copied', /copied\s*\?\s*\n?\s*'text-green-600/.test(il));
const faq = comp('FaqSearch');
check('faq share buttons go green when copied', (faq.match(/justCopied\s*\n?\s*\?\s*'?[^']*text-green-600|justCopied\n\s*\?\s*'border-green/g)?.length ?? 0) >= 1 && /text-green-600/.test(faq));

// ── Chat pills: solid green + ✓ (readable on the emerald bubble) ─────────────
const cm = comp('ChatMessage');
for (const kind of ['address', 'memo', 'txid']) {
	const re = new RegExp(`copiedKind ===\\s*\\n?\\s*'${kind}'[\\s\\S]{0,120}bg-green-600`);
	check(`chat ${kind} pill turns solid green when copied`, re.test(cm));
}
check('chat pills show a ✓ when copied', (cm.match(/aria-hidden="true">✓/g)?.length ?? 0) >= 3);

// ── 2FA + setup-wizard ──────────────────────────────────────────────────────
const twofa = route('settings/security/2fa/+page.svelte');
check('2FA copied label shows ✓ (bg already green via .copy-btn.copied)', /copied \? `✓ \$\{\$_\('common\.copied'\)\}`/.test(twofa) && /\.copy-btn\.copied[\s\S]{0,80}var\(--morphit-emerald\)/.test(twofa));
const wiz = route('admin/setup-wizard/+page.svelte');
check('setup-wizard copies go green + ✓', (wiz.match(/!bg-green-600 !text-white/g)?.length ?? 0) >= 3 && (wiz.match(/`✓ \$\{\$_\('common\.copied'\)\}`/g)?.length ?? 0) >= 3);

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} copy-button-green-check scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} copy-button-green-check checks FAILED`);
	process.exit(1);
}
