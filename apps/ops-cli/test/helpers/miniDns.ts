/**
 * A tiny DNS server for tests (UDP, 127.0.0.1, a free port): answers A and
 * AAAA from a table, NXDOMAIN for a name it does not know, SERVFAIL for a
 * name marked so, and nothing at all (the client times out) for one marked
 * 'silent'. Enough to see what Node's resolver reports for each case.
 */
import { createSocket, type Socket } from 'node:dgram';
import { isIP } from 'node:net';

export type MiniDnsAnswer = readonly string[] | 'servfail' | 'silent';

function readName(buf: Buffer, at: number): { name: string; next: number } {
	const labels: string[] = [];
	let i = at;
	while (buf[i]! !== 0) {
		const len = buf[i]!;
		labels.push(buf.subarray(i + 1, i + 1 + len).toString('latin1'));
		i += 1 + len;
	}
	return { name: labels.join('.').toLowerCase(), next: i + 1 };
}

function ipv6Bytes(a: string): Buffer {
	const [head, tail] = a.includes('::') ? a.split('::') : [a, undefined];
	const h = head ? head.split(':').filter(Boolean) : [];
	const t = tail ? tail.split(':').filter(Boolean) : [];
	const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
	const out = Buffer.alloc(16);
	groups.forEach((g, k) => out.writeUInt16BE(parseInt(g, 16), k * 2));
	return out;
}

export async function startMiniDns(
	table: Record<string, MiniDnsAnswer>
): Promise<{ server: string; close: () => Promise<void> }> {
	const sock: Socket = createSocket('udp4');
	sock.on('message', (msg, rinfo) => {
		const { name, next } = readName(msg, 12);
		const qtype = msg.readUInt16BE(next);
		const question = msg.subarray(12, next + 4);
		const entry = table[name];
		if (entry === 'silent') return;
		const header = Buffer.alloc(12);
		msg.copy(header, 0, 0, 2); // id
		let rcode = 0;
		const answers: Buffer[] = [];
		if (entry === undefined)
			rcode = 3; // NXDOMAIN
		else if (entry === 'servfail') rcode = 2;
		else
			for (const a of entry) {
				const fam = isIP(a);
				if ((qtype === 1 && fam !== 4) || (qtype === 28 && fam !== 6)) continue;
				const data = fam === 4 ? Buffer.from(a.split('.').map(Number)) : ipv6Bytes(a);
				const rr = Buffer.alloc(12);
				rr.writeUInt16BE(0xc00c, 0); // pointer to the question name
				rr.writeUInt16BE(qtype, 2);
				rr.writeUInt16BE(1, 4);
				rr.writeUInt32BE(60, 6);
				rr.writeUInt16BE(data.length, 10);
				answers.push(Buffer.concat([rr, data]));
			}
		header.writeUInt16BE(0x8180 | rcode, 2); // response, recursion desired+available
		header.writeUInt16BE(1, 4);
		header.writeUInt16BE(answers.length, 6);
		sock.send(Buffer.concat([header, question, ...answers]), rinfo.port, rinfo.address);
	});
	await new Promise<void>((res) => sock.bind(0, '127.0.0.1', () => res()));
	const { port } = sock.address();
	return {
		server: `127.0.0.1:${port}`,
		close: () => new Promise<void>((res) => sock.close(() => res()))
	};
}
