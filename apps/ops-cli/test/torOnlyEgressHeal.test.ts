/**
 * The tor-only egress heal's decisions against a simulated node. The rule
 * itself, the i2pd / Docker / unit changes and egress-probe run for real in
 * apps/ops-cli/scripts/tor-egress-smoke.ts (a private network namespace).
 */
import { describe, expect, it } from 'vitest';
import { healTorOnlyEgress, type EgressRuntime } from '../src/lib/torOnlyEgressHeal.ts';

class Node {
	torOnly = true;
	torUp = true;
	/** The rule breaks Tor (say a wrong uid in it). */
	ruleBreaksTor = false;
	nftRefuses = false;
	/** /etc/morphit/matrix-bot.tor-only-decision, or null. */
	matrixDecision: string | null = null;
	state = { units: false, i2pd: false, docker: false, rule: false, enabled: false };
	calls: string[] = [];
	readonly rt: EgressRuntime = {
		torOnly: () => this.torOnly,
		torWorks: async () => this.torUp && !(this.state.rule && this.ruleBreaksTor),
		install: () => true,
		script: (mode) => {
			this.calls.push(mode);
			const [part, what] = mode.split('-') as [string, string];
			const key = (part === 'egress' ? 'rule' : part) as keyof Node['state'];
			if (what === 'check') return this.state[key] ? 0 : 1;
			if (what === 'apply') {
				if (part === 'egress' && this.nftRefuses) return 1;
				this.state[key] = true;
				return 0;
			}
			if (what === 'revert') {
				this.state[key] = false;
				return 0;
			}
			if (what === 'probe') return this.state.rule ? 0 : 1;
			return 2;
		},
		systemctl: (args) => {
			this.calls.push(`systemctl ${args.join(' ')}`);
			if (args[0] === 'enable') this.state.enabled = true;
			if (args[0] === 'disable') this.state.enabled = false;
			if (args[0] === 'is-enabled')
				return { ok: this.state.enabled, out: this.state.enabled ? 'enabled\n' : 'disabled\n' };
			return { ok: true, out: '' };
		},
		sleep: async () => {},
		matrixDecision: () => this.matrixDecision
	};
	run() {
		return healTorOnlyEgress(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
			{ runtime: this.rt }
		);
	}
}

describe('a tor-only node: only Tor and i2pd reach the internet (egress heal)', () => {
	it('applies all four, then sees the rule refuse a test connection while Tor still works', async () => {
		const n = new Node();
		const out = await n.run();
		expect(out).toMatchObject({ strategy: 'applied', verified: true });
		expect(n.state).toEqual({ units: true, i2pd: true, docker: true, rule: true, enabled: true });
		expect(n.calls).toContain('egress-probe');
		expect(out.detail).toMatch(/only Tor and i2pd reach the internet/);
		const again = await n.run();
		expect(again).toMatchObject({ strategy: 'already', verified: true });
		expect(again.detail).toMatch(/a test connection by an ordinary user was refused/);
	});

	it('a node that is not tor-only is never touched', async () => {
		const n = new Node();
		n.torOnly = false;
		expect((await n.run()).strategy).toBe('skipped');
		expect(n.calls).toEqual([]);
	});

	it('Tor not working now: nothing changes (the rule could not be checked)', async () => {
		const n = new Node();
		n.torUp = false;
		const out = await n.run();
		expect(out).toMatchObject({ strategy: 'deferred', verified: false });
		expect(n.calls).toEqual([]);
	});

	it('Tor stops working with the rule: the rule is lifted again, said calmly', async () => {
		const n = new Node();
		n.ruleBreaksTor = true;
		const out = await n.run();
		expect(out).toMatchObject({ strategy: 'reverted', verified: false });
		expect(n.state.rule).toBe(false);
		expect(n.state.enabled).toBe(false);
		expect(out.detail).toMatch(/lifted again and this server is as before/);
	});

	it('a Matrix bot the operator kept on its clearnet homeserver: the rule is not loaded, and it says why', async () => {
		const n = new Node();
		n.matrixDecision = 'kept-clearnet 2026-10-02T00:00:00.000Z https://matrix.org\n';
		const out = await n.run();
		expect(out.verified).toBe(false);
		expect(n.state.rule).toBe(false);
		expect(n.calls).not.toContain('egress-apply');
		// the rest (masked jobs, i2pd and Docker through Tor) still applies
		expect(n.state).toMatchObject({ units: true, i2pd: true, docker: true });
		expect(out.detail).toMatch(/Matrix bot/);
		expect(out.detail).toMatch(/KEEP-CLEARNET/);
		expect(out.detail).toMatch(/not zero-clearnet/);
	});

	it('the rule already loaded and a bot kept on clearnet: the rule stays, and it says the bot is cut off', async () => {
		const n = new Node();
		n.state = { units: true, i2pd: true, docker: true, rule: true, enabled: true };
		n.matrixDecision = 'kept-clearnet 2026-10-02T00:00:00.000Z https://matrix.org\n';
		const out = await n.run();
		expect(out.verified).toBe(false);
		expect(n.state.rule).toBe(true);
		expect(out.detail).toMatch(/refuses the Matrix bot/);
	});

	it('a bot that was stopped (not kept) does not hold the rule back', async () => {
		const n = new Node();
		n.matrixDecision = 'stopped 2026-10-02T00:00:00.000Z https://matrix.org (not kept)\n';
		const out = await n.run();
		expect(out).toMatchObject({ strategy: 'applied', verified: true });
	});

	it('nftables refuses the rule: nothing loaded, not reported as done', async () => {
		const n = new Node();
		n.nftRefuses = true;
		const out = await n.run();
		expect(out.verified).toBe(false);
		expect(n.state.rule).toBe(false);
		expect(n.state.enabled).toBe(false);
	});
});
