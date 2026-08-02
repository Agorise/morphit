/**
 * collect-install-inputs-smoke.ts (cp600) — pins the home/VPS branch: the
 * per-field validators, and the collectInstallInputs flow driven with SCRIPTED
 * answers (home path asks DDNS + generates two different DB passwords; vps path
 * skips DDNS; a bad answer re-prompts).  Every prompt must show an example and
 * validate — Ken's rule — so this checks both.
 */
import {
	validateDomain,
	validateAcmeEmail,
	validateDdnsUrl,
	validateMatrixAddress,
	matrixToContactUrl,
	validateInstallInputs
} from '../apps/ops-cli/src/init/ansibleVars.ts';
import { collectInstallInputs, type CollectDeps } from '../apps/ops-cli/src/init/collectInstallInputs.ts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${name}`);
	} else {
		failed++;
		console.log(`  \u2717 ${name}`);
	}
}

interface DriverState {
	prompts: string[];
	printed: string[];
	exampleSets: number;
}
function driver(opts: { choice: number; answers: string[] }): { deps: CollectDeps; state: DriverState } {
	const answers = [...opts.answers];
	const state: DriverState = { prompts: [], printed: [], exampleSets: 0 };
	const deps: CollectDeps = {
		askChoice: (async () => opts.choice) as unknown as CollectDeps['askChoice'],
		ask: (async (q: string) => {
			state.prompts.push(q);
			return answers.shift() ?? '';
		}) as unknown as CollectDeps['ask'],
		examples: ((_items: readonly string[]) => {
			state.exampleSets += 1;
		}) as unknown as CollectDeps['examples'],
		print: (str: string) => {
			state.printed.push(str);
		}
	};
	return { deps, state };
}

async function main(): Promise<void> {
	console.log('\u2500\u2500 collect-install-inputs smoke (cp600) \u2500\u2500\u2500\u2500');

	// ── per-field validators ──────────────────────────────────────
	check('domain: accepts a bare domain', validateDomain('trade.example.com') === true);
	check('domain: rejects a URL', validateDomain('https://trade.example.com') !== true);
	check('domain: rejects a bare hostname (no TLD)', validateDomain('localhost') !== true);
	check('email: accepts a normal address', validateAcmeEmail('you@example.com') === true);
	check('email: rejects nonsense', validateAcmeEmail('nope') !== true);
	check('ddns: accepts https + {ip}', validateDdnsUrl('https://njal.la/update/?a={ip}') === true);
	check('ddns: ACCEPTS missing {ip} (provider auto-detects, e.g. Namecheap)', validateDdnsUrl('https://njal.la/update/?a=1.2.3.4') === true);
	check('ddns: rejects non-https', validateDdnsUrl('http://njal.la/update/?a={ip}') !== true);

	// Matrix account (optional contact link on the /instances card).
	check('matrix: empty is OK (optional \u2014 operator may have none yet)', validateMatrixAddress('') === true);
	check('matrix: accepts @you:matrix.org', validateMatrixAddress('@you:matrix.org') === true);
	check('matrix: rejects a bare handle (no @)', validateMatrixAddress('you:matrix.org') !== true);
	check('matrix: rejects @you (no server)', validateMatrixAddress('@you') !== true);
	check('matrix: rejects a server with no TLD', validateMatrixAddress('@you:localhost') !== true);
	check('matrix: converts to a matrix.to URL', matrixToContactUrl('@you:matrix.org') === 'https://matrix.to/#/@you:matrix.org');

	const known = { operatorAccount: 'my-operator', operatorTag: 'myoperator', feesAccount: 'my-operator', keystorePath: '/etc/morphit/relay.keystore' };

	// HOME path: choice 0 → asks domain, title, description, email, ddns.
	{
		const d = driver({ choice: 0, answers: ['trade.example.com', 'Morphit Berlin', 'Berlin node, no KYC.', '@berlin:matrix.org', 'me@example.com', 'https://njal.la/update/?h=trade.example.com&k=K&a={ip}'] });
		const out = await collectInstallInputs(known, d.deps);
		check('home: mode is home', out.mode === 'home');
		check('home: carries the DDNS url', out.ddnsUpdateUrl === 'https://njal.la/update/?h=trade.example.com&k=K&a={ip}');
		check('home: domain + email captured', out.domain === 'trade.example.com' && out.acmeEmail === 'me@example.com');
		check('home: instance title + description captured', out.instanceName === 'Morphit Berlin' && out.instanceTagline === 'Berlin node, no KYC.');
		check('home: Matrix account \u2192 matrix.to contactUrl', out.contactUrl === 'https://matrix.to/#/@berlin:matrix.org');
		check('home: two DIFFERENT strong DB passwords generated', out.indexerDbPassword !== out.relayDbPassword && out.indexerDbPassword.length >= 43);
		check('home: an example shown for every free-form prompt (domain, title, description, matrix, email, ddns = 6)', d.state.exampleSets === 6);
		check('home: the whole result passes validateInstallInputs', validateInstallInputs(out).length === 0);
		check('home: carries operator account/tag from the wizard', out.operatorAccount === 'my-operator' && out.operatorTag === 'myoperator');
	}

	// VPS path: choice 1 → asks domain, title, description, email; NO ddns.
	{
		const d = driver({ choice: 1, answers: ['trade.example.com', 'Morphit Test', '', '', 'me@example.com'] });
		const out = await collectInstallInputs(known, d.deps);
		check('vps: mode is vps', out.mode === 'vps');
		check('vps: NO DDNS url', out.ddnsUpdateUrl === undefined);
		check('vps: empty description → undefined tagline (title still captured)', out.instanceTagline === undefined && out.instanceName === 'Morphit Test');
		check('vps: empty Matrix → undefined contactUrl (link omitted, no failure)', out.contactUrl === undefined);
		check('vps: 5 example sets (domain, title, description, matrix, email — no ddns)', d.state.exampleSets === 5);
		check('vps: passes validateInstallInputs', validateInstallInputs(out).length === 0);
	}

	// RE-PROMPT: a bad domain then a good one → domain asked twice, printed an error.
	{
		const d = driver({ choice: 1, answers: ['not a domain', 'trade.example.com', 'Morphit Test', '', '', 'me@example.com'] });
		const out = await collectInstallInputs(known, d.deps);
		const domainPrompts = d.state.prompts.filter((p) => /domain/i.test(p)).length;
		check('re-prompt: a bad domain makes the domain question repeat', domainPrompts >= 2);
		check('re-prompt: an error line was printed', d.state.printed.some((s) => /Try again/.test(s)));
		check('re-prompt: still ends with valid inputs', validateInstallInputs(out).length === 0 && out.domain === 'trade.example.com');
	}
}

main()
	.then(() => {
		console.log('');
		if (failed === 0) {
			console.log(`\u2713 all ${passed} collect-install-inputs checks passed`);
			process.exit(0);
		} else {
			console.log(`\u2717 ${failed} of ${passed + failed} collect-install-inputs checks failed`);
			process.exit(1);
		}
	})
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
