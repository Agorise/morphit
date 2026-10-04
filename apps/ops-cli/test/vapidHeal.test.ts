/**
 * The Web Push key heal against a simulated relay box.
 */
import { describe, expect, it } from 'vitest';
import { healVapid, wantedSubject, type VapidRuntime } from '../src/lib/vapidHeal.ts';

const P = '/etc/morphit/relay-vapid.env';
const KEYS = (s: string) =>
	`# managed\nMORPHIT_RELAY_VAPID_PUBLIC_KEY=pub1\nMORPHIT_RELAY_VAPID_PRIVATE_KEY=priv1\nMORPHIT_RELAY_VAPID_SUBJECT=${s}\n`;

class Box {
	file: string | null = '';
	torOnly = false;
	genOk = true;
	pushOnAfterRestart = true;
	push: boolean | null = false;
	restarts = 0;
	readonly rt: VapidRuntime = {
		readFile: () => this.file,
		writeFile: (_p, t) => ((this.file = t), true),
		torOnly: () => this.torOnly,
		domain: () => 'trade.example.org',
		generate: (s) => (this.genOk ? KEYS(s || 'mailto:operator@example.com') : null),
		relayActive: () => true,
		restartRelay: () => {
			this.restarts++;
			this.push =
				this.pushOnAfterRestart &&
				!this.torOnly &&
				/PRIVATE_KEY=\S/.test(this.file ?? '') &&
				/SUBJECT=https/.test(this.file ?? '');
			return true;
		},
		webPush: () => this.push,
		sleep: async () => {}
	};
	run() {
		return healVapid(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
			{ runtime: this.rt, path: P }
		);
	}
}

describe('the relay has its Web Push keys and a real subject (VAPID heal)', () => {
	it('an empty file (a failed first run) gets keys; the relay then reports push on', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out).toMatchObject({ verified: true });
		expect(b.file).toContain('MORPHIT_RELAY_VAPID_SUBJECT=https://trade.example.org');
		expect(b.push).toBe(true);
		expect((await b.run()).strategy).toBe('already');
	});

	it('a placeholder subject on a clearnet node becomes https://<domain>; the keys are kept', async () => {
		const b = new Box();
		b.file = KEYS('mailto:operator@example.com');
		await b.run();
		expect(b.file).toBe(KEYS('https://trade.example.org'));
	});

	it('tor-only: an empty file gets keys with an EMPTY subject (push off), not the placeholder', async () => {
		const b = new Box();
		b.torOnly = true;
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(b.file).toMatch(/^MORPHIT_RELAY_VAPID_SUBJECT=$/m);
		expect(wantedSubject(true, 'x.org')).toBe('');
	});

	it('the generator fails: the file is left as it was, not reported as done', async () => {
		const b = new Box();
		b.genOk = false;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(b.file).toBe('');
		expect(b.restarts).toBe(0);
	});

	it('the relay does not report push on after the restart: not reported as done', async () => {
		const b = new Box();
		b.pushOnAfterRestart = false;
		expect((await b.run()).verified).toBe(false);
	});

	it('no file (push never set up): nothing to do', async () => {
		const b = new Box();
		b.file = null;
		expect((await b.run()).strategy).toBe('skipped');
	});
});
