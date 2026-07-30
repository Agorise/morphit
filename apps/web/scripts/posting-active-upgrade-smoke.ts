#!/usr/bin/env tsx
/**
 * Smoke: tt.txt #11 — "Keep my Active key on this device".
 *
 * The gate in front of the money changed shape, so the invariants get pinned:
 *
 *  • `origin` is PROVENANCE. Capability is `activePublicKey !== null`. Every
 *    money path must ask the second question. Asking the first is what made the
 *    wallet hide its own Send button from users who could have used it.
 *  • The upgrade is never silent: it needs an explicit choice, and the DEFAULT
 *    is "forget it".
 *  • The password is the gate — an Active key alone must not rewrite a keystore.
 *  • Owner and memo stay null. An Active key cannot derive them.
 *  • Disk only if disk: a memory-only session must not silently start writing.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(WEB, ...p), 'utf8');
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);
const loc = (c: string) => JSON.parse(read('src', 'lib', 'i18n', 'locales', `${c}.json`));

const code = (src: string): string =>
	src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
		.join('\n');

const core = read('src', 'lib', 'crypto', 'identity-core.ts');
const keystore = read('src', 'lib', 'crypto', 'keystore.ts');
const keep = read('src', 'lib', 'crypto', 'keepActiveKey.ts');
const modal = read('src', 'lib', 'components', 'UnlockActiveKeyModal.svelte');
const pay = read('src', 'lib', 'components', 'PayBlurtModal.svelte');
const send = read('src', 'lib', 'components', 'SendBlurtModal.svelte');
const wallet = read('src', 'lib', 'components', 'MyBalanceCard.svelte');
const post = read('src', 'routes', '[lang]', 'post', '+page.svelte');
const avatar = read('src', 'lib', 'components', 'AvatarMenu.svelte');
const backup = read('src', 'routes', '[lang]', 'backup-keys', '+page.svelte');
const store = read('src', 'lib', 'stores', 'identity.ts');

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

// ─── identity model ──────────────────────────────────────────────────
check("origin gained 'posting-active'", /'morphit-seed' \| 'posting-only' \| 'posting-active'/.test(core));
check('toLiveIdentity promotes only the active PUBLIC key', /origin: 'posting-active'/.test(core) && /sodium\.memzero\(activeKp\.privateKey\)/.test(code(core)));

// ─── capability, not provenance ──────────────────────────────────────
for (const [name, src] of [['PayBlurtModal', pay], ['SendBlurtModal', send], ['MyBalanceCard', wallet]] as const) {
	check(`${name} gates on activePublicKey, not origin`, /activePublicKey \?\? null\) !== null/.test(code(src)) && !/origin === 'morphit-seed'/.test(code(src)));
}
check('/post gates on activePublicKey too', /live\.activePublicKey !== null/.test(code(post)) && !/live\.origin === 'morphit-seed'/.test(code(post)));
check('the wallet no longer HIDES Send from posting-only users', !/\{#if hasActiveKey\}/.test(wallet));

// ─── the upgrade itself ──────────────────────────────────────────────
check('upgradeToPostingActive refuses a non-posting-only keystore', /refusing to upgrade a \$\{full\.origin\} keystore/.test(keystore));
check('the password is the gate (decrypt precedes any write)', /const full = await decryptIdentity\(env, password\);/.test(code(keystore)));
check('owner and memo stay null', /owner: null,[\s\S]{0,400}memo: null/.test(code(keystore)));
check('seedBytes stays null (a seed cannot be built backwards)', /origin: 'posting-active',\s*\n\s*seedBytes: null,/.test(code(keystore)));
check('every decrypted private key is zeroed in a finally', /finally \{[\s\S]{0,400}sodium\.memzero\(kp\.privateKey\)/.test(code(keystore)));
check('the schema now rejects UNEXPECTED roles, not just missing ones', /Unexpected key role in \$\{origin\} keystore/.test(keystore));
check('a stale build gets an actionable error, not "corrupt"', /saved by a newer version of Morphit/.test(keystore));

// ─── never silent, disk only if disk ─────────────────────────────────
check("the retention default is 'once' (never promote silently)", /let retention = \$state<'once' \| 'keep'>\('once'\)/.test(modal));
check('the keep branch demands the Morphit password', /device_password_label/.test(modal) && /retention === 'keep'/.test(code(modal)));
check('keepActiveKeyOnThisDevice writes to disk ONLY if a keystore is already persisted', /if \(hasPersistedKeystore\(\)\) writeEnvelope\(nextEnv\);/.test(code(keep)));
check('it refuses unless the session is a posting-only one', /origin !== 'posting-only'/.test(code(keep)));
check('the scalar is wiped on EVERY path out', /finally \{[\s\S]{0,160}sodium\.memzero\(activeScalar\)/.test(code(keep)));
check('envelope and live capability move together', /export function updateUnlockedIdentity/.test(store) && /updateUnlockedIdentity\(nextEnv, \{/.test(code(keep)));

// ─── cp445 deep-deep: refusal paths must not leak key material ───────
const unlock = read('src', 'lib', 'crypto', 'activeKeyUnlock.ts');
check('a REFUSED wif (incl. the owner key) is wiped, not left in memory', /finally \{\s*\n\s*if \(!handedOff\) scalar\.fill\(0\);/.test(unlock));
check('only the success path hands the scalar to the caller', /handedOff = true;\s*\n\s*return \{ ok: true, scalar/.test(unlock));

// ─── the red dot + backup page ───────────────────────────────────────
check('keeping a key marks backup material pending', /markBackupMaterialPending\(\);/.test(code(keep)));
check('the avatar shows a RED dot (not the emerald unread colour)', /backupMaterialPending[\s\S]{0,400}bg-red-500/.test(avatar));
check('"Back up my keys" carries the dot too', /avatar_menu\.backup_keys[\s\S]{0,220}bg-red-500/.test(avatar));
check('visiting /backup-keys clears it', /clearBackupMaterialPending\(\);/.test(code(backup)));
check('/backup-keys offers a keyfile but NO seed for posting-active', /isPostingActive/.test(backup) && /no_seed_posting_active/.test(backup));
check('all 10 locales explain why there is no seed', LOCALES.every((c) => typeof loc(c).backup_keys.show_seed.error.no_seed_posting_active === 'string'));
check('all 10 locales have the retention choice', LOCALES.every((c) => {
	const u = loc(c).unlock_active;
	return typeof u.retention_keep === 'string' && typeof u.retention_once === 'string' && typeof u.error.bad_device_password === 'string';
}));

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} posting-active-upgrade scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} posting-active-upgrade checks FAILED`);
	process.exit(1);
}
