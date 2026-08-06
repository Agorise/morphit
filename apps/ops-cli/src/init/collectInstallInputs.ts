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
import { ask as realAsk, askChoice as realAskChoice, examples as realExamples, step } from './prompt.ts';
import {
	randomSecret,
	validateDomain,
	validateAcmeEmail,
	validateDdnsUrl,
	validateInstanceTitle,
	validateMatrixAddress,
	matrixToContactUrl,
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

/** Ask WHERE the node will run — the ONE answer that changes the step count
 *  (home adds DDNS + a router step + desktop notifications).  Asked on its own,
 *  BEFORE the numbered steps begin, so the wizard can show an accurate "Step N of
 *  {total}" from step 1 onward. */
export async function askInstallMode(deps: CollectDeps = {}): Promise<InstallMode> {
	const askChoice = deps.askChoice ?? realAskChoice;
	const modeIdx = await askChoice('Where will this node run?', [
		'This computer, on my home internet (address can change)',
		'A rented server / VPS (has a fixed public address)'
	]);
	return modeIdx === 0 ? 'home' : 'vps';
}

/** Collect the install-specific answers.  `known` carries what the wizard has
 *  already gathered (the operator's account + tag, and the deployment mode). */
export async function collectInstallInputs(
	known: {
		readonly mode: InstallMode;
		readonly operatorAccount: string;
		readonly operatorTag: string;
		readonly feesAccount: string;
		readonly keystorePath: string;
	},
	deps: CollectDeps = {}
): Promise<AnsibleInstallInputs> {
	const ask = deps.ask ?? realAsk;
	const examples = deps.examples ?? realExamples;
	const print = deps.print ?? ((s: string): void => console.log(s));
	const req = { ask, examples, print };

	// Mode was chosen before the numbered steps began (askInstallMode), so the
	// running "Step N of {total}" counter is accurate from the very first step.
	const mode = known.mode;

	step(0, 0, 'Your web address (domain)');
	const domain = await askValidated(
		'What web address (domain) will people use to reach your marketplace?',
		['trade.example.com', 'morphit.mydomain.org'],
		validateDomain,
		req
	);

	// Instance identity — shown on the shared /instances directory (and as the
	// site title). Asked next to the domain, per the operator who noted these
	// were never collected. The title is REQUIRED (register needs it too).
	step(0, 0, 'Your marketplace name');
	print(
		'\n  Give your marketplace a name. It appears as the title at the top of your\n' +
			'  site, and \u2014 once you register \u2014 as your instance\u2019s name on the shared\n' +
			'  /instances directory that traders on other nodes browse.\n'
	);
	const instanceName = await askValidated(
		'Instance title',
		['Morphit Polska', 'Berlin Freimarkt', 'Morphit UK'],
		validateInstanceTitle,
		req
	);

	step(0, 0, 'A one-line description (optional)');
	print(
		'\n  Optionally add a one-line description. It shows right under your title on\n' +
			'  the shared /instances directory (and as your site\u2019s search-result blurb).\n' +
			'  Press Enter to skip.\n'
	);
	examples([
		'Nasza instancja, kt\u00f3ra s\u0142u\u017cy wszystkim osobom m\u00f3wi\u0105cym po polsku na ca\u0142ym \u015bwiecie.',
		'P2P Bitcoin & Monero trading, no KYC.'
	]);
	let instanceTagline = (await ask('Instance description (optional)')).trim();
	if (instanceTagline.length > 200) instanceTagline = instanceTagline.slice(0, 200);

	step(0, 0, 'A Matrix contact (optional)');
	print(
		'\n  Optionally, a Matrix contact \u2014 it powers the "Contact this operator"\n' +
			'  link on your /instances card, so traders can reach you. Use EITHER your\n' +
			'  account  @you:server  (e.g. @you:matrix.org) OR a room  #room:server\n' +
			'  (e.g. #support:matrix.org) if you\u2019d rather send people to a channel than\n' +
			'  a personal account. Press Enter to skip \u2014 the link is simply omitted\n' +
			'  until you add one.\n'
	);
	const matrixAddress = await askValidated(
		'Your Matrix account or room (optional \u2014 @you:matrix.org or #room:matrix.org)',
		['@you:matrix.org', '#support:example.org'],
		validateMatrixAddress,
		req
	);
	const contactUrl = matrixAddress.length > 0 ? matrixToContactUrl(matrixAddress) : undefined;

	step(0, 0, 'Email for your free HTTPS certificate');
	const acmeEmail = await askValidated(
		'Your email address (only used to get + renew your free HTTPS certificate)',
		['you@example.com'],
		validateAcmeEmail,
		req
	);

	let ddnsUpdateUrl: string | undefined;
	if (mode === 'home') {
		step(0, 0, 'Keeping your home address up to date');
		print(
			'\n  Because a home connection\u2019s address can change, Morphit will keep your\n' +
				'  domain pointed at it automatically. Paste the "dynamic DNS update URL"\n' +
				'  from wherever you bought your domain. Put {ip} where it wants the address\n' +
				'  \u2014 or leave it out if your provider fills in the IP itself (Namecheap does).\n'
		);
		ddnsUpdateUrl = await askValidated(
			'Your domain provider\u2019s dynamic-DNS update URL ({ip} optional \u2014 omit it if the provider auto-detects)',
			[
				'https://njal.la/update/?h=trade.example.com&k=YOURKEY&a={ip}',
				'https://dynamicdns.park-your-domain.com/update?host=@&domain=mydomain.org&password=YOURPW  (Namecheap auto-detects the IP)'
			],
			validateDdnsUrl,
			req
		);
	}

	// Whether to list this instance on-chain is NOT asked here — it's offered
	// AFTER the install summary (in runAnsibleInstall), so the operator decides
	// once they can see the node actually came up.  We bake auto-register OFF; the
	// post-summary step arms morphit-first-online if they opt in.
	const autoRegister = false;

	// Ansible provisions the DB → generate two INDEPENDENT strong passwords.
	// crypto RNG makes a collision astronomically impossible, but loop to be
	// certain they differ (validateInstallInputs also enforces it).
	const indexerDbPassword = randomSecret();
	let relayDbPassword = randomSecret();
	while (relayDbPassword === indexerDbPassword) relayDbPassword = randomSecret();

	return {
		mode,
		domain,
		instanceName,
		instanceTagline: instanceTagline.length > 0 ? instanceTagline : undefined,
		contactUrl,
		operatorAccount: known.operatorAccount,
		operatorTag: known.operatorTag,
		feesAccount: known.feesAccount,
		keystorePath: known.keystorePath,
		acmeEmail,
		autoRegister,
		indexerDbPassword,
		relayDbPassword,
		ddnsUpdateUrl
	};
}
