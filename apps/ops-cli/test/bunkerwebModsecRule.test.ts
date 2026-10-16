/**
 * The JSON-API exemption: no ModSecurity rules, no audit log, no body
 * inspection for /v1/ and /relay/ — the audit log would otherwise write the
 * body of every 4xx/5xx request, and an offline-notice request carries a
 * user's own address. Shipped the same in both configs, and an upgrade
 * replaces the rule earlier releases shipped (never an operator's own).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODSEC_RULE, OLD_MODSEC_RULES, modsecRuleFix } from '../src/lib/bunkerwebRuleDedupe.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const shipped = (rel: string): string | null =>
	/^CUSTOM_CONF_MODSEC_morphit_json_api_off=(.*)$/m.exec(
		readFileSync(join(REPO, rel), 'utf8')
	)?.[1] ?? null;

describe('the JSON-API ModSecurity exemption', () => {
	it('turns the rules, the audit log and body inspection off', () => {
		expect(MODSEC_RULE).toContain('ctl:ruleEngine=Off');
		expect(MODSEC_RULE).toContain('ctl:auditEngine=Off');
		expect(MODSEC_RULE).toContain('ctl:requestBodyAccess=Off');
	});

	it('both shipped configs carry exactly it', () => {
		expect(shipped('ops/bunkerweb/bunkerweb.env.example')).toBe(MODSEC_RULE);
		expect(shipped('ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2')).toBe(MODSEC_RULE);
	});

	it('an upgrade adds it, replaces an earlier release’s rule, keeps an operator’s own', () => {
		expect(modsecRuleFix(null)).toBe(MODSEC_RULE);
		for (const old of OLD_MODSEC_RULES) expect(modsecRuleFix(old)).toBe(MODSEC_RULE);
		expect(modsecRuleFix(MODSEC_RULE)).toBeNull();
		expect(
			modsecRuleFix('SecRule REQUEST_URI "@rx ^/v1/" "id:1990001,phase:1,pass,nolog"')
		).toBeNull();
	});
});
