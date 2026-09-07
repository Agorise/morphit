/**
 * contact-url-resilience-smoke (v1.16.7)
 *
 * A cosmetic branding field must NEVER be able to brick an instance. timeapp set
 * a bare email as the contact URL; the indexer validated it with z.string().url(),
 * failed, and crash-looped → whole instance unreachable. This pins the fixes:
 *   1. normalizeContactUrl repairs a bare email → mailto: and drops anything
 *      it can't make into an allowlisted contact URL (never throws);
 *   2. the indexer's contact-URL schema is non-fatal (any string) + normalized;
 *   3. `edit → branding` validates/normalizes before writing;
 *   4. the upgrade auto-repairs a bare-email contact URL already on disk;
 *   5. readConfigEnvValue (verify.json) resolves the install-root config so a
 *      set operator_tag can't read as null;
 *   6. bunkerweb exempts the /v1/ + /relay/ JSON APIs from ModSecurity CRS.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeContactUrl } from '../../../packages/operator-config/src/contact.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');
let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
	if (c) pass++;
	else {
		fail++;
		console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`);
	}
};

// ── 1. normalizeContactUrl behaviour ──
const norm = normalizeContactUrl;
check('bare email → mailto:', norm('timeapp.foundation@proton.me') === 'mailto:timeapp.foundation@proton.me');
check('already-valid mailto kept', norm('mailto:a@b.com') === 'mailto:a@b.com');
check('https kept', norm('https://matrix.to/#/#x:y.org') === 'https://matrix.to/#/#x:y.org');
check('matrix kept', typeof norm('matrix:r/x:y.org') === 'string');
check('empty → undefined', norm('') === undefined && norm('   ') === undefined);
check('non-url junk → undefined', norm('just some text') === undefined);
check('dangerous scheme → undefined', norm('javascript:alert(1)') === undefined);
check('bare email never throws (returns, not raises)', (() => { try { norm('x@y.z'); return true; } catch { return false; } })());

// ── 2. indexer: non-fatal schema + normalized ──
const idxCfg = read('apps/indexer/src/config/index.ts');
check('indexer contact-URL schema is NON-fatal (no .url())', /MORPHIT_INSTANCE_CONTACT_URL:\s*z\.string\(\)\.optional\(\)/.test(idxCfg));
check('indexer normalizes the contact URL at load', /normalizeContactUrl\(e\.MORPHIT_INSTANCE_CONTACT_URL\)/.test(idxCfg));

// ── 3. edit → branding validates before writing ──
const editSrc = read('apps/ops-cli/src/commands/edit.ts');
check('edit-branding normalizes the contact URL', /normalizeContactUrl\(rawContact\)/.test(editSrc));
check('edit-branding refuses an unusable contact link', /isn't a usable contact link/.test(editSrc));

// ── 4. upgrade auto-repair ──
const upSrc = read('apps/ops-cli/src/commands/upgrade.ts');
check('upgrade auto-repairs a bad contact URL in config', /normalizeContactUrl\(rawVal\)/.test(upSrc) && /MORPHIT_INSTANCE_CONTACT_URL/.test(upSrc));

// ── 5. verify.json operator_tag resolution ──
const vj = read('scripts/build-verify-json.mjs');
check('readConfigEnvValue checks the install-root config', /\/opt\/morphit\/morphit\.config\.env/.test(vj));
check('readConfigEnvValue walks up from REPO_ROOT', /walkUp/.test(vj));
check('upgrade stamps operator_tag into verify.json BEFORE deploy (v1.16.9)', /readOperatorTagFromConfig\(\)/.test(upSrc) && /patchVerifyJsonOperatorTag\(buildDir/.test(upSrc) && upSrc.indexOf('patchVerifyJsonOperatorTag(buildDir') < upSrc.indexOf('deployFrontendBuild(buildDir, webRoot)'));

// ── 6. bunkerweb WAF exemption for the JSON APIs ──
const ops = read('apps/web/src/routes/[lang]/operators/+page.svelte');
check('operators page uses the shared scheme-aware contact policy (all schemes, not https-only)', /normalizeContactUrl\(op\.contact_url\)/.test(ops) && /detectContactProtocol/.test(ops));
check('operators page no longer https-only-rejects contacts', !/u\.protocol !== 'https:'/.test(ops));
const bw = read('ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2');
check('bunkerweb exempts /v1/ + /relay/ from ModSecurity', /CUSTOM_CONF_MODSEC_/.test(bw) && /ruleEngine=Off/.test(bw) && /v1\|relay/.test(bw));
check('upgrade self-heals the bunkerweb WAF exemption (no ansible re-run)', /CUSTOM_CONF_MODSEC_morphit_json_api_off=/.test(upSrc) && /\/etc\/bunkerweb\/bunkerweb\.env/.test(upSrc) && /compose[\s\S]{0,40}up.{0,6}-d/.test(upSrc));

console.log(fail === 0 ? `✓ all ${pass} contact-url-resilience checks hold` : `✗ ${fail} failed (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
