#!/usr/bin/env tsx
/**
 * Smoke: the Pay-BLURT modal surfaces the REAL failure reason, clarifies the
 * password field, and centers its buttons. Anchor 2026-07-08.
 *
 * THE BUGS THIS GUARDS AGAINST:
 *   - A failed transfer showed a generic "Could not send the transfer. Check
 *     your balance or try an external wallet." — actively misleading (a
 *     transfer fails with a full balance when the signature doesn't match the
 *     on-chain active authority, or the instance is unreachable). The modal
 *     now distinguishes ChainRejectedError (shows the chain's own words),
 *     BroadcastUnavailableError, and sign failure, and prints the raw detail.
 *   - The "Active key password" label made users think they had to paste a raw
 *     private key. It's the account password (it decrypts the keystore's active
 *     key locally). A hint now says so.
 *   - Buttons were right-justified; now centered.
 *
 * Tamper tests: reintroduce a bare `catch {}` → generic path fails; drop the
 * classifier / detail rendering → fails; revert to justify-end → fails.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');

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

const modal = readFileSync(join(WEB, 'src', 'lib', 'components', 'PayBlurtModal.svelte'), 'utf8');

// ── Specific error surfacing ────────────────────────────────────────────────
check(
	'imports the typed broadcast errors',
	/import\s*\{[^}]*\bChainRejectedError\b[^}]*\bBroadcastUnavailableError\b[^}]*\}\s*from\s*['"]\$blurt\/broadcastTransport['"]/.test(
		modal
	)
);
check(
	'has a classifyBroadcastError() that maps ChainRejectedError → chain_rejected',
	/function classifyBroadcastError/.test(modal) &&
		/instanceof ChainRejectedError[\s\S]{0,120}chain_rejected/.test(modal)
);
check(
	'classifier maps BroadcastUnavailableError → instance_unreachable',
	/instanceof BroadcastUnavailableError[\s\S]{0,120}instance_unreachable/.test(modal)
);
check(
	'the Phase error variant carries a raw `detail`',
	/kind:\s*'error';\s*messageKey:\s*string;\s*detail\?:\s*string/.test(modal)
);
check(
	'no bare catch {} swallows the broadcast/prepare error',
	!/\}\s*catch\s*\{\s*\n[\s\S]{0,80}broadcast_failed/.test(modal)
);
check(
	'the template renders the raw reason (phase.detail)',
	/\{#if phase\.detail\}/.test(modal) && /\{phase\.detail\}/.test(modal)
);

// ── Field clarity ───────────────────────────────────────────────────────────
check('renders a password hint under the field', /chat\.pay_blurt\.password_hint/.test(modal));

// ── Centering ───────────────────────────────────────────────────────────────
check('no button row is right-justified (justify-end) any more', !/flex justify-end/.test(modal));
check('button rows are centered (justify-center)', /flex justify-center/.test(modal));

// ── Locale parity for the new + changed keys ────────────────────────────────
// Derived from the single source of truth so adding an 11th locale can never
// silently skip this smoke (locale-source-of-truth-smoke enforces this).
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);
const NEW_KEYS = ['chain_rejected', 'instance_unreachable', 'sign_failed'];
let parityOk = true;
for (const loc of LOCALES) {
	const j = JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', `${loc}.json`), 'utf8'));
	const pb = j?.chat?.pay_blurt;
	if (!pb || typeof pb.password_hint !== 'string') parityOk = false;
	if (!pb?.error || !NEW_KEYS.every((k) => typeof pb.error[k] === 'string')) parityOk = false;
}
check('all 10 locales have password_hint + the 3 new error keys', parityOk);

// composer action buttons centered (ConversationView) — #4 + #19 overlap
const conv = readFileSync(join(WEB, 'src', 'lib', 'components', 'ConversationView.svelte'), 'utf8');
check(
	'composer action buttons are centered at all widths (no sm:justify-end grid)',
	/flex max-w-2xl flex-wrap items-center justify-center gap-2/.test(conv)
);

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} pay-blurt-modal-errors scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} pay-blurt-modal-errors checks FAILED`);
	process.exit(1);
}
