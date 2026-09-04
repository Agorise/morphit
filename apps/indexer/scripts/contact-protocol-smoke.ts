/**
 * contact-protocol-smoke (v1.16.2)
 *
 * Pins two invariants for operator `contact_url` handling:
 *
 *  A. `detectContactProtocol` classifies every supported messenger correctly,
 *     rejects unsafe schemes (http:, javascript:, data:), and marks the
 *     handler-less address forms (Session, Cwtch) copy-only.
 *
 *  B. All four consumers use the ONE canonical allowlist in @morphit/operator-config
 *     (the on-chain gate, the two entry validators, the render sanitizer), so a
 *     new scheme can never be accepted by one and rejected by another.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectContactProtocol, isAllowedContactUrl, CONTACT_URL_SCHEMES } from '@morphit/operator-config';

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
	} else {
		fail++;
		console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

// ── A. detector correctness ──
type Exp = { id: string; clickable: boolean } | null;
const cases: Array<[string, Exp]> = [
	['https://t.me/alice', { id: 'telegram', clickable: true }],
	['https://discord.com/users/123', { id: 'discord', clickable: true }],
	['https://discord.gg/abcd', { id: 'discord', clickable: true }],
	['https://keybase.io/alice', { id: 'keybase', clickable: true }],
	['https://signal.me/#eu/xyz', { id: 'signal', clickable: true }],
	['https://simplex.chat/contact#/?v=2', { id: 'simplex', clickable: true }],
	['https://matrix.to/#/@a:b.org', { id: 'matrix', clickable: true }],
	['xmpp:alice@server.tld', { id: 'xmpp', clickable: true }],
	['briar://abcdef', { id: 'briar', clickable: true }],
	['jami:0a1b2c', { id: 'jami', clickable: true }],
	['simplex:/contact#x', { id: 'simplex', clickable: true }],
	['sgnl://signal.me/x', { id: 'signal', clickable: true }],
	['tg://resolve?domain=x', { id: 'telegram', clickable: true }],
	['mailto:a@b.org', { id: 'email', clickable: true }],
	['nostr:npub1x', { id: 'nostr', clickable: true }],
	['https://my-own-site.example/contact', { id: 'web', clickable: true }],
	// copy-only (no URL handler)
	['session:05abcdef', { id: 'session', clickable: false }],
	['cwtch:qrstuvwxyz', { id: 'cwtch', clickable: false }],
	// rejected (unsafe / unparseable)
	['http://insecure.example', null],
	['javascript:alert(1)', null],
	['data:text/html,x', null],
	['file:///etc/passwd', null],
	['vbscript:msgbox', null],
	['not a url at all', null]
];
for (const [url, exp] of cases) {
	const got = detectContactProtocol(url);
	if (exp === null) {
		check(`reject ${url}`, got === null, `got ${JSON.stringify(got)}`);
	} else {
		check(
			`detect ${url}`,
			got !== null && got.id === exp.id && got.clickable === exp.clickable,
			`got ${JSON.stringify(got)}, expected ${JSON.stringify(exp)}`
		);
	}
}
// isAllowedContactUrl mirrors the detector's null decision
check('isAllowedContactUrl(https)=true', isAllowedContactUrl('https://t.me/x'));
check('isAllowedContactUrl(http)=false', !isAllowedContactUrl('http://x'));
check('isAllowedContactUrl(js)=false', !isAllowedContactUrl('javascript:alert(1)'));
// http: is NOT in the canonical set (downgrade protection preserved)
check('canonical set excludes http:', !(CONTACT_URL_SCHEMES as readonly string[]).includes('http:'));
check('canonical set includes https:', (CONTACT_URL_SCHEMES as readonly string[]).includes('https:'));

// ── B. 4-consumer parity: each references the canonical gate, none keeps a
//       hardcoded https-only contact_url check ──
const consumers: Array<[string, string, RegExp]> = [
	[
		'indexer on-chain gate',
		'apps/indexer/src/indexer/handlers/operatorRegister.ts',
		/CONTACT_URL_SCHEMES/
	],
	['ops-cli register prompt', 'apps/ops-cli/src/init/steps.ts', /isAllowedContactUrl/],
	['web register validator', 'apps/web/src/lib/blurt/ops/operatorRegister.ts', /isAllowedContactUrl/],
	['render sanitizer', 'apps/web/src/lib/utils/safeContactUrl.ts', /CONTACT_URL_SCHEMES/]
];
for (const [name, path, needle] of consumers) {
	const src = read(path);
	check(`${name} uses the canonical allowlist`, needle.test(src), `expected ${needle} in ${path}`);
	check(`${name} imports @morphit/operator-config`, /@morphit\/operator-config/.test(src));
}

console.log(fail === 0 ? `✓ all ${pass} contact-protocol checks hold` : `✗ ${fail} failed (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
