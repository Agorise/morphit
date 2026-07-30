/**
 * collectInstallInputs.ts (cp600) — the home/VPS branch of the grandma install.
 *
 * Both a home box and a VPS get the SAME full hardened stack; the only
 * difference is networking, so this asks the few install-specific questions and
 * returns the `AnsibleInstallInputs` the bridge (ansibleVars.ts) maps to the
 * playbook.  It does NOT re-ask the operator's account/tag (the wizard already
 * has those) and it does NOT ask for a database URL — Ansible PROVISIONS the
 * database, so we generate two independent, maximally-strong passwords here.
 *
 * Every prompt shows an example and validates the answer (re-prompting on a bad
 * one).  Interactive, but every dependency is injectable so the flow is
 * unit-tested with scripted answers.
 */
import { ask as realAsk, askChoice as realAskChoice, examples as realExamples } from './prompt.ts';
import {
	randomSecret,
	validateDomain,
	validateAcmeEmail,
	validateDdnsUrl,
	type AnsibleInstallInputs,
	type InstallMode
} from './ansibleVars.ts';

export interface CollectDeps {
	readonly ask?: typeof realAsk;
	readonly askChoice?: typeof realAskChoice;
	readonly examples?: typeof realExamples;
	readonly print?: (s: string) => void;
}

/** Ask one free-form question with an example list + a validator, re-prompting
 *  until the answer passes. */
async function askValidated(
	question: string,
	exampleList: readonly string[],
	validate: (v: string) => true | string,
	deps: Required<Pick<CollectDeps, 'ask' | 'examples' | 'print'>>
): Promise<string> {
	deps.examples(exampleList);
	while (true) {
		const raw = await deps.ask(question);
		const verdict = validate(raw);
		if (verdict === true) return raw.trim();
		deps.print(`  \u2717 That ${verdict}.  Try again.\n`);
	}
}

/** Collect the install-specific answers.  `known` carries what the wizard has
 *  already gathered (the operator's account + tag). */
export async function collectInstallInputs(
	known: {
		readonly operatorAccount: string;
		readonly operatorTag: string;
		readonly feesAccount: string;
		readonly keystorePath: string;
	},
	deps: CollectDeps = {}
): Promise<AnsibleInstallInputs> {
	const ask = deps.ask ?? realAsk;
	const askChoice = deps.askChoice ?? realAskChoice;
	const examples = deps.examples ?? realExamples;
	const print = deps.print ?? ((s: string): void => console.log(s));
	const req = { ask, examples, print };

	// Where will it run?  This drives the ONE difference (DDNS on home).
	const modeIdx = await askChoice('Where will this node run?', [
		'This computer, on my home internet (address can change)',
		'A rented server / VPS (has a fixed public address)'
	]);
	const mode: InstallMode = modeIdx === 0 ? 'home' : 'vps';

	const domain = await askValidated(
		'What web address (domain) will people use to reach your marketplace?',
		['trade.example.com', 'morphit.mydomain.org'],
		validateDomain,
		req
	);

	const acmeEmail = await askValidated(
		'Your email address (only used to get + renew your free HTTPS certificate)',
		['you@example.com'],
		validateAcmeEmail,
		req
	);

	let ddnsUpdateUrl: string | undefined;
	if (mode === 'home') {
		print(
			'\n  Because a home connection\u2019s address can change, Morphit will keep your\n' +
				'  domain pointed at it automatically. Paste the "dynamic DNS update URL"\n' +
				'  from wherever you bought your domain, with {ip} where it wants the address.\n'
		);
		ddnsUpdateUrl = await askValidated(
			'Your domain provider\u2019s dynamic-DNS update URL (must contain {ip})',
			[
				'https://njal.la/update/?h=trade.example.com&k=YOURKEY&a={ip}',
				'https://dynamicdns.park-your-domain.com/update?host=@&domain=mydomain.org&password=YOURPW&ip={ip}'
			],
			validateDdnsUrl,
			req
		);
	}

	// Ansible provisions the DB → generate two INDEPENDENT strong passwords.
	// crypto RNG makes a collision astronomically impossible, but loop to be
	// certain they differ (validateInstallInputs also enforces it).
	const indexerDbPassword = randomSecret();
	let relayDbPassword = randomSecret();
	while (relayDbPassword === indexerDbPassword) relayDbPassword = randomSecret();

	return {
		mode,
		domain,
		operatorAccount: known.operatorAccount,
		operatorTag: known.operatorTag,
		feesAccount: known.feesAccount,
		keystorePath: known.keystorePath,
		acmeEmail,
		indexerDbPassword,
		relayDbPassword,
		ddnsUpdateUrl
	};
}
