/**
 * Upgrade self-heal: publish this node's fees account in its on-chain operator
 * registration when the chain does not have it (v1.20.0, G1).
 *
 * WHY. From v1.20.0 every Morphit indexer accepts the 90 % leg of a BLURT fee
 * paid through ANOTHER instance — but only to the fee account that instance's
 * operator registered on chain (`fee_recipient` on
 * morphit_operator_register_v1). Every registration made before v1.20.0 lacks
 * it, so until the operator re-registers, the orders their users pay in BLURT
 * stay hidden on every other instance and their first-contact DMs are dropped
 * there. Re-registering needs the relay's active key, which on a standard
 * install the box can unlock unattended (the relay's host-sealed credential —
 * what morphit-first-online uses), so the upgrade does it.
 *
 * WHAT IT DOES (the heal mandate: check → act → VERIFY by observing → say
 * which strategy worked → degrade to one calm line with the exact command):
 *   1. Nothing when the resolved fees account IS the canonical treasury (a
 *      single 100 % leg verifies everywhere), or this account never registered
 *      (not in the federation directory — first-online's opt-in owns that).
 *   2. Reads what the chain has: this node's indexer's own verdict when it
 *      reports one (v1.20+), else the newest register op in the relay
 *      account's chain history (read through this node's indexer — the full
 *      RPC pool — which is what a v1.19 indexer still running during the
 *      upgrade offers). Equal to the resolved account → done, one ✓ line.
 *   3. Otherwise re-publishes the registration the chain ACCEPTED — verbatim,
 *      only fee_recipient added or changed (V3-4) — read from this node's
 *      indexer's event log (v1.20+), or, under an older indexer, the newest
 *      register op in the chain history when it matches what the indexer
 *      applied. Differences between the config and the chain are printed as
 *      advice, never published. It unlocks the key unattended, broadcasts, then
 *      polls, with a spinner and a bound, until the local indexer (v1.20+)
 *      reports the account registered or the chain history shows THIS
 *      transaction carrying it.
 *   4. When the accepted payload cannot be read reliably, the key cannot be
 *      unlocked unattended, the tag differs, the broadcast fails, or there is
 *      not enough of the heal phase left: ONE calm line naming
 *      `sudo morphit-ops register` on this server — and nothing broadcast.
 *   Once REGISTERED, other upgraded instances accept the account; `status`
 *   reports it.
 * Every condition it reports was observed; "could not check" says exactly that.
 */
import { sanitizeForTerm } from '../render/term.ts';
import { loadInstanceEnv } from './instanceEnv.ts';
import { defaultRepoRoot } from './repoRoot.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import {
	CANONICAL_BLURT_TREASURY,
	acceptedRegistration,
	latestChainRegistration,
	localFeeView,
	otherRegistrationChanges,
	localRegistration,
	type AcceptedRegistration,
	type ChainRegistration,
	type LocalFeeView,
	type LocalRegistration
} from './operatorFeeRecipient.ts';
import {
	broadcastRegistration,
	buildRegisterPayload,
	loadRelayKeyUnattended,
	readRegisterEnv,
	type ValidEnv
} from '../commands/register.ts';

export type FeeRecipientHealOutcome =
	| 'not_needed_canonical'
	| 'not_registered'
	| 'already_registered'
	| 'published_verified'
	| 'published_unverified'
	| 'needs_operator'
	| 'unknown';

export interface FeeRecipientHealDeps {
	readonly info: (line: string) => void;
	readonly warn: (line: string) => void;
	readonly spinner: (label: string) => () => void;
	// ── Seams (tests). Defaults are the real thing. ──
	readonly env?: () => ValidEnv | { error: string };
	readonly localRegistration?: (account: string) => Promise<LocalRegistration>;
	readonly localFeeView?: () => Promise<LocalFeeView | null>;
	readonly chainRegistration?: (account: string) => Promise<ChainRegistration>;
	readonly acceptedRegistration?: (
		account: string,
		applied: { tag: string; displayName: string | null; contactUrl: string | null }
	) => Promise<AcceptedRegistration>;
	readonly loadKey?: (keyFile: string) => Promise<string>;
	readonly broadcast?: (
		account: string,
		wif: string,
		payload: Record<string, unknown>,
		maxLimitMs?: number
	) => Promise<{ trx_id: string }>;
	readonly hiddenOnly?: () => boolean;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	/** Absolute time the heal must be finished by (the self-heal child's kill
	 *  minus a margin). Default: derived from the child's start when running as
	 *  `__post-upgrade-selfheal`, else none. */
	readonly hardStopAt?: number;
	readonly pollMs?: number;
}

/** How long to wait for the published registration to be read back. */
export const VERIFY_WINDOW_MS = { clearnet: 120_000, hidden: 240_000 } as const;
/** Don't start a broadcast with less than this left before the hard stop. */
export const MIN_TIME_TO_START_MS = { clearnet: 45_000, hidden: 120_000 } as const;
/** Matches upgrade.ts's SELF_HEAL_CHILD_TIMEOUT_MS (the child is killed then). */
const SELF_HEAL_CHILD_TIMEOUT_MS = 300_000;

const COMMAND_LINE = 'sudo morphit-ops register';

export async function healFeeRecipientRegistration(
	deps: FeeRecipientHealDeps
): Promise<FeeRecipientHealOutcome> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const hidden = (deps.hiddenOnly ?? (() => isHiddenOnlyNode()))();
	const hardStopAt =
		deps.hardStopAt ??
		(process.argv.includes('__post-upgrade-selfheal')
			? now() - process.uptime() * 1000 + SELF_HEAL_CHILD_TIMEOUT_MS - 20_000
			: Number.POSITIVE_INFINITY);

	if (deps.env === undefined) loadInstanceEnv(defaultRepoRoot());
	const env = (deps.env ?? readRegisterEnv)();
	// Not a node that can register at all (no relay account / origin set).
	if ('error' in env) return 'unknown';
	const acct = sanitizeForTerm(env.account);
	const fees = sanitizeForTerm(env.feeRecipient);

	// 1. The canonical treasury needs no registration.
	if (env.feeRecipient === CANONICAL_BLURT_TREASURY) return 'not_needed_canonical';

	const calm = (why: string): FeeRecipientHealOutcome => {
		deps.info(
			`  Your fees account @${fees} is not in your on-chain operator registration yet${why}. ` +
				`Until it is, other Morphit instances hide the orders your users pay to it. ` +
				`To publish it, run on this server:  ${COMMAND_LINE}`
		);
		return 'needs_operator';
	};

	// 1b. Registered at all? (this node's indexer, authoritative for the tag)
	let stop = deps.spinner('Checking your on-chain operator registration…');
	const reg = await (deps.localRegistration ?? ((a: string) => localRegistration(a)))(env.account);
	stop();
	if (reg.state === 'unknown') {
		deps.info(
			`  Could not check whether your fees account @${fees} is in your on-chain registration ` +
				`(this node's indexer did not answer). \`sudo morphit-ops status\` shows it once the ` +
				`indexer is up; if it says it is not registered, run on this server:  ${COMMAND_LINE}`
		);
		return 'unknown';
	}
	if (reg.state === 'not_registered') return 'not_registered';
	const tag = reg.tag;

	// 2. What does the chain have?
	stop = deps.spinner('Reading the fees account in your on-chain registration…');
	let already: boolean | null = null;
	let via = '';
	try {
		const view = await (deps.localFeeView ?? (() => localFeeView()))();
		if (
			view !== null &&
			view.reportsRegistration &&
			view.registered !== null &&
			view.feeRecipient === env.feeRecipient
		) {
			already = view.registered;
			via = "this node's indexer";
		} else {
			const chain = await (deps.chainRegistration ?? ((a: string) => latestChainRegistration(a)))(
				env.account
			);
			already = chain.found && chain.feeRecipient === env.feeRecipient;
			via = "your account's chain history";
		}
	} catch {
		already = null;
	} finally {
		stop();
	}
	if (already === null) {
		deps.info(
			`  Could not read your on-chain registration right now to check the fees account @${fees}. ` +
				`\`sudo morphit-ops status\` shows it; if it says it is not registered, run on this server:  ${COMMAND_LINE}`
		);
		return 'unknown';
	}
	if (already) {
		deps.info(
			`  ✓ Your fees account @${fees} is in your on-chain registration (checked via ${via}).`
		);
		return 'already_registered';
	}

	// 3. Publish it — under the REGISTERED tag only (a different configured tag
	//    would be refused on chain as tag_immutable), and only with time for
	//    the broadcast AND the read-back.
	if (env.operatorTag === null || env.operatorTag !== tag) {
		return calm(
			` (and your configured operator tag does not match the registered one "${sanitizeForTerm(tag)}", ` +
				'which `register` explains how to fix)'
		);
	}
	if (hardStopAt - now() < (hidden ? MIN_TIME_TO_START_MS.hidden : MIN_TIME_TO_START_MS.clearnet)) {
		return calm(' (the upgrade had no time left to publish it)');
	}
	// The payload (V3-4): the registration the chain ACCEPTED for this account,
	// verbatim, with only fee_recipient added or changed. Rebuilding it from the
	// config would revert a display name or contact set later (the web form
	// re-registers too) and wipe fields the config lacks; peers on an older
	// indexer overwrite every field with what the op carries. If the accepted
	// payload cannot be read reliably, nothing is broadcast.
	stop = deps.spinner('Reading the registration the chain accepted…');
	let accepted: Awaited<ReturnType<typeof acceptedRegistration>>;
	try {
		accepted = await (
			deps.acceptedRegistration ?? ((a: string, r: typeof reg) => acceptedRegistration(a, r))
		)(env.account, reg);
	} finally {
		stop();
	}
	if (accepted.state !== 'ok' || accepted.payload.tag !== tag) {
		return calm(
			` (this server could not read the registration the chain accepted reliably${
				accepted.state !== 'ok' ? `: ${sanitizeForTerm(accepted.why.slice(0, 120))}` : ''
			}, so it did not publish anything)`
		);
	}
	const payload: Record<string, unknown> = { ...accepted.payload, fee_recipient: env.feeRecipient };
	let wif: string;
	try {
		wif = await (deps.loadKey ?? loadRelayKeyUnattended)(env.keyFile);
	} catch {
		return calm(' (this server cannot unlock the relay key without you)');
	}
	deps.info(
		`  Publishing your fees account @${fees} in your on-chain operator registration for @${acct} ` +
			`(your accepted registration, read from ${accepted.source}, unchanged otherwise; other ` +
			'Morphit instances need it to show your users’ BLURT-paid orders)…'
	);
	// Differences between the config and the chain are ADVICE, never published here.
	const other = otherRegistrationChanges(accepted.payload, buildRegisterPayload(env, tag));
	if (other.length > 0) {
		deps.info(
			'  Your config also differs from your on-chain registration (' +
				other
					.map(
						([f, a, b]) => `${f}: ${sanitizeForTerm(a)} on chain, ${sanitizeForTerm(b)} in config`
					)
					.join('; ') +
				`). That was left as it is on chain; to publish your config, run on this server:  ${COMMAND_LINE}`
		);
	}
	let trxId: string;
	try {
		const r = await (deps.broadcast ?? broadcastRegistration)(
			env.account,
			wif,
			payload,
			Math.max(5_000, hardStopAt - now() - 30_000)
		);
		trxId = r.trx_id;
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return calm(` (publishing it failed: ${sanitizeForTerm(why.slice(0, 160))})`);
	} finally {
		wif = '';
	}

	// 4. VERIFY: read it back — this node's indexer when it reports the field
	//    (v1.20+), else the chain history must show THIS transaction carrying it.
	const deadline = Math.min(
		now() + (hidden ? VERIFY_WINDOW_MS.hidden : VERIFY_WINDOW_MS.clearnet),
		hardStopAt
	);
	stop = deps.spinner(
		`Waiting for the registration to be included and read back (up to ${Math.max(1, Math.round((deadline - now()) / 60_000))} min)…`
	);
	let confirmedVia: string | null = null;
	try {
		while (now() < deadline) {
			try {
				const view = await (deps.localFeeView ?? (() => localFeeView()))();
				if (view !== null && view.reportsRegistration) {
					if (view.registered === true && view.feeRecipient === env.feeRecipient) {
						confirmedVia = "this node's indexer";
						break;
					}
				} else {
					const chain = await (
						deps.chainRegistration ?? ((a: string) => latestChainRegistration(a))
					)(env.account);
					if (chain.found && chain.trxId === trxId && chain.feeRecipient === env.feeRecipient) {
						confirmedVia = `your account's chain history (block ${chain.block})`;
						break;
					}
				}
			} catch {
				/* a failed read is retried until the deadline */
			}
			await sleep(Math.min(deps.pollMs ?? 5_000, Math.max(0, deadline - now())));
		}
	} finally {
		stop();
	}
	if (confirmedVia !== null) {
		deps.info(
			`  ✓ Fees account @${fees} published in your operator registration (transaction ${sanitizeForTerm(trxId)}; ` +
				`confirmed via ${confirmedVia}).`
		);
		return 'published_verified';
	}
	deps.info(
		`  Your registration with the fees account @${fees} was broadcast (transaction ${sanitizeForTerm(trxId)}) ` +
			'but was not seen on chain in time. `sudo morphit-ops status` shows whether it landed; if it ' +
			`says the fees account is not registered, run on this server:  ${COMMAND_LINE}`
	);
	return 'published_unverified';
}
