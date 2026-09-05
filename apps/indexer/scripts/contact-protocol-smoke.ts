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
import { readFileSync, readdirSync } from 'node:fs';
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
	['not a url at all', null],
	// v16-2 — userinfo phishing rejected (visible host impersonates a trusted one
	// while navigation goes to the real host). Matches the on-chain gate's O1.2.
	['https://matrix.to@evil.com', null],
	['https://user:pw@evil.com/', null],
	['https://t.me@phish.example/x', null]
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
//       hardcoded https-only contact_url check. The two Node consumers import
//       the package root; the two web consumers MUST import the browser-safe
//       ./contact subpath (importing the root drags index.ts's node:fs/path/util
//       env-loader into the browser bundle — a build break, v1.16.2). ──
const consumers: Array<[string, string, RegExp, 'root' | 'contact']> = [
	[
		'indexer on-chain gate',
		'apps/indexer/src/indexer/handlers/operatorRegister.ts',
		/CONTACT_URL_SCHEMES/,
		'root'
	],
	['ops-cli register prompt', 'apps/ops-cli/src/init/steps.ts', /isAllowedContactUrl/, 'root'],
	[
		'web register validator',
		'apps/web/src/lib/blurt/ops/operatorRegister.ts',
		/isAllowedContactUrl/,
		'contact'
	],
	['render sanitizer', 'apps/web/src/lib/utils/safeContactUrl.ts', /CONTACT_URL_SCHEMES/, 'contact']
];
for (const [name, path, needle, entry] of consumers) {
	const src = read(path);
	check(`${name} uses the canonical allowlist`, needle.test(src), `expected ${needle} in ${path}`);
	if (entry === 'contact')
		check(
			`${name} imports the browser-safe @morphit/operator-config/contact`,
			/@morphit\/operator-config\/contact/.test(src)
		);
	else check(`${name} imports @morphit/operator-config`, /@morphit\/operator-config/.test(src));
}

// ── C. browser-safety invariant: NO apps/web/src file may import the package
//       ROOT (only the ./contact subpath), or the Node-only env-loader lands in
//       the browser bundle and `vite build` fails (v1.16.2 regression guard). ──
function walk(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
		const rel = `${dir}/${e.name}`;
		if (e.isDirectory()) out.push(...walk(rel));
		else if (/\.(ts|svelte|js)$/.test(e.name)) out.push(rel);
	}
	return out;
}
const rootImport = /from\s+['"]@morphit\/operator-config['"]/;
const offenders = walk('apps/web/src').filter((f) => rootImport.test(read(f)));
check(
	'no apps/web file imports the node-deps operator-config root (browser-safety)',
	offenders.length === 0,
	offenders.length ? `root import in: ${offenders.join(', ')}` : ''
);

console.log(fail === 0 ? `✓ all ${pass} contact-protocol checks hold` : `✗ ${fail} failed (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
