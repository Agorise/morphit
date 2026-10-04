/**
 * The installed-box heal: a tor-only node whose Matrix alert bot was
 * set up with a clearnet homeserver. Real heal; the box (files, systemd,
 * terminal) is a stand-in that keeps state.
 */
import { describe, expect, it } from 'vitest';
import {
	healMatrixBotTorOnly,
	recheckStoppedMatrixBot,
	KEEP_CLEARNET_ANSWER,
	type MatrixTorOnlyRuntime
} from '../src/lib/matrixTorOnlyHeal.ts';
import { matrixBotReadiness, parseMatrixBotEnvText } from '../src/lib/matrixBot.ts';

const ONION = `http://${'b'.repeat(56)}.onion`;
const SET_UP =
	'MORPHIT_MATRIX_BOT_ALERT_MXID=@me:example.org\nMORPHIT_MATRIX_BOT_ACCESS_TOKEN=syt_x\n';

function box(o: {
	env: string | null;
	hidden?: boolean;
	active?: boolean;
	answer?: string | null;
	decision?: string;
}) {
	const st = {
		env: o.env,
		active: o.active ?? true,
		enabled: o.active ?? true,
		decision: o.decision ?? (null as string | null),
		asked: [] as string[],
		restarts: 0
	};
	const rt: MatrixTorOnlyRuntime = {
		hiddenOnly: () => o.hidden ?? true,
		readEnv: () => st.env,
		writeEnv: (t) => ((st.env = t), true),
		socks: () => '127.0.0.1:9050',
		unitActive: () => st.active,
		unitEnabled: () => st.enabled,
		restart: () => (st.restarts++, true),
		disableNow: () => ((st.active = false), (st.enabled = false), true),
		enableNow: () => ((st.active = true), (st.enabled = true), true),
		ask: async (q) => (st.asked.push(q), o.answer === undefined ? null : o.answer),
		readDecision: () => st.decision,
		writeDecision: (t) => void (st.decision = t),
		now: () => new Date('2026-10-02T00:00:00Z')
	};
	const warned: string[] = [];
	const ctx = { info: () => {}, warn: (m: string) => void warned.push(m), spinner: () => () => {} };
	return { st, rt, ctx, warned };
}
const envOf = (t: string | null) => parseMatrixBotEnvText(t ?? '');

describe('Matrix bot on an installed tor-only node', () => {
	it('a running clearnet bot, no terminal: stopped, disabled, flagged, decision recorded', async () => {
		const b = box({ env: `${SET_UP}MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n` });
		const r = await healMatrixBotTorOnly(b.ctx, b.rt);
		expect(r.strategy).toBe('stopped');
		expect(r.verified).toBe(true);
		expect(b.st.active || b.st.enabled).toBe(false);
		expect(envOf(b.st.env).torOnlyRaw).toBe('1');
		expect(b.st.decision).toMatch(/^stopped .*matrix\.org.*not asked during the upgrade/);
		expect(b.warned.join(' ')).toMatch(/clearnet homeserver https:\/\/matrix\.org/);
		// …and an upgrade's lifecycle step will not start it again
		expect(matrixBotReadiness({ exists: true, ...envOf(b.st.env) }).run).toBe(false);
	});

	it('the operator types KEEP-CLEARNET: left running, decision recorded, not asked again', async () => {
		const env = `${SET_UP}MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n`;
		const b = box({ env, answer: KEEP_CLEARNET_ANSWER });
		const r = await healMatrixBotTorOnly(b.ctx, b.rt);
		expect(r.strategy).toBe('kept-by-operator');
		expect(b.st.active).toBe(true);
		expect(b.st.env).toBe(env);
		expect(b.st.decision).toMatch(/^kept-clearnet /);
		const again = await healMatrixBotTorOnly(b.ctx, b.rt);
		expect(again.strategy).toBe('kept-by-operator');
		expect(b.st.asked).toHaveLength(1);
	});

	it('no answer during the upgrade: stopped, and it says how to keep it on clearnet later', async () => {
		const b = box({ env: `${SET_UP}MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n` });
		const r = await healMatrixBotTorOnly(b.ctx, b.rt);
		expect(r.strategy).toBe('stopped');
		expect(r.detail).toMatch(/sudo morphit-ops upgrade --questions/);
	});

	it('the question says the tor-only egress rule will not let a kept bot out', async () => {
		const b = box({ env: `${SET_UP}MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n` });
		await healMatrixBotTorOnly(b.ctx, b.rt);
		expect(b.st.asked[0]).toMatch(/egress rule/);
	});

	it('KEEP-CLEARNET typed later (upgrade --questions) after a stop: the Tor-only flag is lifted and the bot runs again', async () => {
		const env = `${SET_UP}MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n`;
		const first = box({ env });
		await healMatrixBotTorOnly(first.ctx, first.rt);
		expect(first.st.active).toBe(false);
		const later = box({ env: first.st.env, answer: KEEP_CLEARNET_ANSWER, active: false });
		later.st.decision = first.st.decision;
		const r = await healMatrixBotTorOnly(later.ctx, later.rt);
		expect(r.strategy).toBe('kept-by-operator');
		expect(envOf(later.st.env).torOnlyRaw.trim()).not.toBe('1');
		expect(later.st.active && later.st.enabled).toBe(true);
		expect(later.st.decision).toMatch(/^kept-clearnet /);
	});

	it('a bot this heal stopped that an older upgrader enabled again afterwards is disabled again (after the restarts)', async () => {
		const env = `${SET_UP}MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n`;
		const b = box({ env });
		await healMatrixBotTorOnly(b.ctx, b.rt);
		// v1.20.2's lifecycle step: `enable` + `restart` whenever MXID and token are set
		b.st.enabled = true;
		const r = await recheckStoppedMatrixBot(b.ctx, b.rt);
		expect(r.strategy).toBe('disabled-again');
		expect(b.st.enabled || b.st.active).toBe(false);
		expect((await recheckStoppedMatrixBot(b.ctx, b.rt)).strategy).toBe('already');
		// a kept bot is left alone
		const k = box({ env, answer: KEEP_CLEARNET_ANSWER });
		await healMatrixBotTorOnly(k.ctx, k.rt);
		expect((await recheckStoppedMatrixBot(k.ctx, k.rt)).strategy).toBe('not-stopped');
		expect(k.st.active).toBe(true);
	});

	it('any other answer stops it', async () => {
		const b = box({
			env: `${SET_UP}MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n`,
			answer: 'yes'
		});
		expect((await healMatrixBotTorOnly(b.ctx, b.rt)).strategy).toBe('stopped');
		expect(b.st.active).toBe(false);
	});

	it('a .onion homeserver gets the Tor route and a restart', async () => {
		const b = box({ env: `${SET_UP}MORPHIT_MATRIX_BOT_HOMESERVER=${ONION}\n` });
		const r = await healMatrixBotTorOnly(b.ctx, b.rt);
		expect(r).toMatchObject({ strategy: 'tor-route-set', verified: true });
		expect(envOf(b.st.env)).toMatchObject({
			torOnlyRaw: '1',
			socksRaw: 'socks5h://127.0.0.1:9050'
		});
		expect(b.st.restarts).toBe(1);
		expect((await healMatrixBotTorOnly(b.ctx, b.rt)).strategy).toBe('already');
	});

	it('a clearnet node is left alone', async () => {
		const env = `${SET_UP}MORPHIT_MATRIX_BOT_HOMESERVER=https://matrix.org\n`;
		const b = box({ env, hidden: false });
		expect((await healMatrixBotTorOnly(b.ctx, b.rt)).strategy).toBe('not-tor-only');
		expect(b.st.env).toBe(env);
		expect(b.st.active).toBe(true);
	});
});
