/**
 * What the docs and the shipped env files tell an operator about BunkerWeb,
 * held to what Morphit really ships and does (v1.21.1 review D-1, D-7, I-1,
 * I-5). A documented configuration is RUN through the same planner the
 * upgrade uses: copying it must need no privacy change.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHONE_HOME_JOBS } from '../src/lib/bunkerwebJobsHeal.ts';
import {
	BUNKERWEB_PRIVACY_SETTINGS,
	effectiveSetting,
	envValues,
	planBunkerwebPrivacy
} from '../src/lib/bunkerwebPrivacy.ts';

const yaml = createRequire(import.meta.url)('js-yaml') as { load(s: string): unknown };
const REPO = resolve(__dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');
const OPS = read('docs/OPERATIONS.md');

/** The first fenced block after `heading`. */
function fenceAfter(text: string, heading: string): string {
	const at = text.indexOf(heading);
	expect(at, heading).toBeGreaterThanOrEqual(0);
	const m = /```[a-z]*\n([\s\S]*?)```/.exec(text.slice(at));
	expect(m, heading).not.toBeNull();
	return m![1]!;
}

/** The `environment:` of a compose snippet's first service, as env-file text. */
function composeEnvironment(text: string): string {
	const doc = yaml.load(text) as {
		services: Record<string, { environment?: Record<string, string> }>;
	};
	const svc = Object.values(doc.services)[0]!;
	return Object.entries(svc.environment ?? {})
		.map(([k, v]) => `${k}=${String(v)}`)
		.join('\n');
}

function expectMorphitSettings(name: string, env: string): void {
	const v = envValues(env);
	expect(effectiveSetting(v, 'AUTO_LETS_ENCRYPT'), `${name}: AUTO_LETS_ENCRYPT`).toBe('no');
	for (const s of BUNKERWEB_PRIVACY_SETTINGS)
		expect(effectiveSetting(v, s.key), `${name}: ${s.key}`).toBe(s.value);
	expect(planBunkerwebPrivacy(env).changes, name).toEqual([]);
}

describe("OPERATIONS.md's BunkerWeb configurations are Morphit's (D-7)", () => {
	it('§32 Linux variables.env: copied as shown, nothing for the upgrade to turn off; certbot, not BunkerWeb’s ACME', () => {
		expectMorphitSettings('Linux', fenceAfter(OPS, '### Linux install (Option A)'));
	});
	it('§32 Docker compose snippet: the same', () => {
		expectMorphitSettings('Docker', composeEnvironment(fenceAfter(OPS, '### Docker install')));
	});
	it('§35 "If you used BunkerWeb": the host certbot renews; nothing says AUTO_LETS_ENCRYPT=yes handles it', () => {
		const at = OPS.indexOf('### If you used BunkerWeb');
		const sec = OPS.slice(at, OPS.indexOf('### Quarterly verification', at));
		expect(sec).not.toMatch(/AUTO_LETS_ENCRYPT=yes/);
		expect(sec).toMatch(/AUTO_LETS_ENCRYPT=no/);
		expect(sec).toMatch(/certbot renew --dry-run/);
	});
});

describe('the shipped env files describe the jobs Morphit removes (I-1)', () => {
	const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
	for (const rel of [
		'ops/bunkerweb/bunkerweb.env.example',
		'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2'
	])
		it(`${rel}: as many jobs as PHONE_HOME_JOBS, at the three hosts`, () => {
			const t = read(rel);
			const m = /^# (\w+) of BunkerWeb's daily jobs/im.exec(t);
			expect(m, rel).not.toBeNull();
			expect(WORDS.indexOf(m![1]!.toLowerCase())).toBe(PHONE_HOME_JOBS.length);
			for (const host of ['db-ip.com', 'api.github.com', 'assets.bunkerity.com'])
				expect(t).toContain(host);
		});
});

describe("ops/bunkerweb/README.md's bad-behavior codes are the shipped ones (I-5)", () => {
	it('the codes the README says Morphit counts = BAD_BEHAVIOR_STATUS_CODES in the template and the example', () => {
		const readme = read('ops/bunkerweb/README.md').replace(/\s+/g, ' ');
		const said = /Morphit narrows the counted set to `([0-9 ]+)`/.exec(readme)?.[1];
		for (const rel of [
			'ops/bunkerweb/bunkerweb.env.example',
			'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2'
		])
			expect(said, rel).toBe(envValues(read(rel)).get('BAD_BEHAVIOR_STATUS_CODES'));
	});
});

// D-1: the upgrade empties a country list in BunkerWeb's settings file and
// removes one saved in BunkerWeb's web UI; one set elsewhere is named. No
// doc may say more than that ("empties any country list").
describe('what the docs promise about country lists is what the upgrade does (D-1)', () => {
	const FILES = [
		'docs/SECURITY.md',
		'docs/OPERATIONS.md',
		'ops/bunkerweb/README.md',
		'ops/bunkerweb/bunkerweb.env.example',
		'ops/ansible/roles/bunkerweb/templates/bunkerweb.env.j2'
	];
	for (const rel of FILES)
		it(rel, () => {
			const paras = read(rel)
				.split(/\n\s*\n/)
				.map((p) => p.replace(/\s*\n\s*#?\s*/g, ' '));
			const about = paras.filter(
				(p) => /country list|_COUNTRY/i.test(p) && /(morphit-ops upgrade|the upgrade)/.test(p)
			);
			expect(about.length, rel).toBeGreaterThan(0);
			for (const p of about) {
				expect(p).not.toMatch(/empties any (BLACKLIST_COUNTRY|country list)/);
				expect(p).not.toMatch(/empties any it finds/);
				expect(p, rel).toMatch(/web UI/);
			}
		});
});
