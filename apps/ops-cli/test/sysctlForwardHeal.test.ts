/**
 * IPv4 forwarding on Docker hosts, against a simulated box: the
 * sysctl files, the live value (which a sysctl --system with the old drop-in
 * would put back to 0), Docker's published ports and its NAT rules.
 */
import { describe, expect, it } from 'vitest';
import {
	healForwarding,
	natForwards,
	publicPublishedPorts,
	type ForwardRuntime
} from '../src/lib/sysctlForwardHeal.ts';

const OLD_DROPIN = '# Network\nnet.ipv4.ip_forward = 0\nnet.ipv4.tcp_syncookies = 1\n';
const NAT =
	'-A DOCKER ! -i br-1 -p tcp -m tcp --dport 443 -j DNAT --to-destination 172.20.0.2:8443\n' +
	'-A DOCKER ! -i br-1 -p tcp -m tcp --dport 80 -j DNAT --to-destination 172.20.0.2:8080\n';

class Box {
	forward = '0';
	sticks = true;
	files = new Map<string, string>([['/etc/sysctl.d/99-morphit-hardening.conf', OLD_DROPIN]]);
	ports =
		'0.0.0.0:443->8443/tcp, [::]:443->8443/tcp, 0.0.0.0:80->8080/tcp\n127.0.0.1:8090->80/tcp\n';
	nat = NAT;
	dockerRestarts = 0;
	/** What `sysctl --system` would set now (the drop-ins in order, last wins). */
	systemValue(): string {
		let v = this.forward;
		for (const t of this.files.values())
			for (const m of t.matchAll(/^\s*net\.ipv4\.ip_forward\s*=\s*(\d)\s*$/gm)) v = m[1]!;
		return v;
	}
	readonly rt: ForwardRuntime = {
		dockerPorts: () => this.ports,
		readForward: () => this.forward,
		writeForward: () => {
			if (this.sticks) this.forward = '1';
			return this.sticks;
		},
		sysctlFiles: () => [...this.files].map(([path, text]) => ({ path, text })),
		writeFile: (p, t) => (this.files.set(p, t), true),
		natDump: () => this.nat,
		restartDocker: () => {
			this.dockerRestarts++;
			this.forward = '1';
			return true;
		},
		sleep: async () => {}
	};
	run() {
		return healForwarding(
			{ info: () => {}, warn: () => {}, spinner: () => () => {} },
			{ runtime: this.rt }
		);
	}
}

describe('IPv4 forwarding where Docker publishes public ports', () => {
	it('an installed BunkerWeb box: the drop-in stops turning it off, it is on now, and Docker forwards 80/443', async () => {
		const b = new Box();
		const out = await b.run();
		expect(out.verified).toBe(true);
		expect(b.forward).toBe('1');
		// a reboot / `sysctl --system` no longer puts it back to 0
		expect(b.systemValue()).toBe('1');
		expect(b.files.get('/etc/sysctl.d/99-morphit-hardening.conf')).toContain('tcp_syncookies = 1');
		expect(out.detail).toMatch(/80, 443/);
	});
	it('a hidden-only box (loopback publish only) is left exactly as it is', async () => {
		const b = new Box();
		b.ports = '127.0.0.1:8090->80/tcp\n';
		const out = await b.run();
		expect(out.strategy).toBe('skipped');
		expect(b.forward).toBe('0');
		expect(b.files.get('/etc/sysctl.d/99-morphit-hardening.conf')).toBe(OLD_DROPIN);
	});
	it('a value that will not stick: Docker is restarted (it turns forwarding on) and it is read back', async () => {
		const b = new Box();
		b.sticks = false;
		const out = await b.run();
		expect(b.dockerRestarts).toBe(1);
		expect(out.strategy).toBe('docker-restart');
		expect(out.verified).toBe(true);
	});
	it("an operator's own file that turns it off is named, not edited", async () => {
		const b = new Box();
		b.files.set('/etc/sysctl.d/50-mine.conf', 'net.ipv4.ip_forward = 0\n');
		const out = await b.run();
		expect(b.files.get('/etc/sysctl.d/50-mine.conf')).toBe('net.ipv4.ip_forward = 0\n');
		expect(out.detail).toContain('/etc/sysctl.d/50-mine.conf also sets net.ipv4.ip_forward = 0');
	});
	it("Docker's NAT rule for a published port not seen: not verified, the command is given", async () => {
		const b = new Box();
		b.nat = NAT.split('\n')[0]!;
		const out = await b.run();
		expect(out.verified).toBe(false);
		expect(out.detail).toMatch(/port\(s\) 80 was not seen.*systemctl restart docker/);
	});
	it('reads Docker port lists and both NAT backends', () => {
		expect(
			publicPublishedPorts('0.0.0.0:443->8443/tcp, [::]:443->8443/tcp, 127.0.0.1:8090->80/tcp')
		).toEqual([443]);
		expect(
			natForwards('ip daddr != 127.0.0.0/8 tcp dport 443 counter dnat ip to 172.20.0.2:8443', 443)
		).toBe(true);
		expect(natForwards(NAT, 22)).toBe(false);
	});
});

// v1.21.1 review: Docker that does not answer was reported as "no
// container publishes a public port" and counted as nothing to change.
describe('when Docker cannot be asked', () => {
	const c = { info: () => {}, warn: () => {}, spinner: () => () => {} };
	it('not installed: nothing to do (routine); not answering: a warning with the command', async () => {
		const missing = await healForwarding(c, {
			runtime: { dockerPorts: () => null, docker: () => 'missing' } as never
		});
		expect(missing).toMatchObject({ verified: true, routine: true });
		const down = await healForwarding(c, {
			runtime: { dockerPorts: () => null, docker: () => 'down' } as never
		});
		expect(down.verified).toBe(false);
		expect(down.detail).toMatch(/sudo systemctl status docker/);
	});
});
