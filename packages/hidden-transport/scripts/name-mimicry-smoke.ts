/**
 * nameMimicsNonPublicAddress — no false positives, no lost refusals
 * (v1.20.0 fix wave 2, D13 follow-up).
 *
 * D13 moved the non-public address set into @morphit/net-defense and widened
 * it (192.0.0.0/24 among others). The mimicry check padded a name's leading
 * numeric labels with ZEROS, so `192.example.org` became 192.0.0.0 — now
 * non-public — and a real registrable name was refused as "IP-like". A name
 * only mimics a non-public address when its numeric labels ALONE put it in a
 * non-public range: both the 0-padded and the 255-padded forms must be
 * non-public.
 *
 * The oracle for "must stay refused" is the PRE-D13 rule re-derived here (its
 * range list, zero padding) over every 1- and 2-numeric-label prefix: nothing
 * it refused may now be accepted.
 */
import net from 'node:net';
import { nameMimicsNonPublicAddress } from '../src/index.ts';

const OLD = new net.BlockList();
for (const [a, p] of [
	['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16],
	['0.0.0.0', 8], ['100.64.0.0', 10], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) OLD.addSubnet(a, p, 'ipv4');
function oldRefused(name: string): boolean {
	const labels = name.split('.');
	if (labels.length <= 2) return false;
	const o: string[] = [];
	for (const l of labels) {
		if (o.length === 4 || !/^\d{1,3}$/.test(l) || Number(l) > 255) break;
		o.push(String(Number(l)));
	}
	if (o.length === 0) return false;
	while (o.length < 4) o.push('0');
	return OLD.check(o.join('.'), 'ipv4');
}

let failed = 0;
let n = 0;
function check(name: string, ok: boolean, detail = ''): void {
	n++;
	if (ok) console.log(`  ✓ ${name}`);
	else {
		failed++;
		console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
	}
}

console.log('name-mimicry smoke:\n');
const lost: string[] = [];
for (let a = 0; a <= 255; a++) {
	for (const name of [`${a}.example.org`, ...Array.from({ length: 256 }, (_, b) => `${a}.${b}.example.org`)]) {
		if (oldRefused(name) && !nameMimicsNonPublicAddress(name)) lost.push(name);
	}
}
check('every name the pre-D13 rule refused is still refused (all 1- and 2-label numeric prefixes)', lost.length === 0, `now accepted: ${lost.slice(0, 8).join(', ')}${lost.length > 8 ? ` … (+${lost.length - 8})` : ''}`);
for (const ok of ['192.example.org', '172.example.org', '100.example.org', '198.example.org', '10.tv', '1.1.1.1.example.org']) {
	check(`a real name is not "IP-like": ${ok}`, !nameMimicsNonPublicAddress(ok));
}
for (const bad of ['10.x.example', '192.168.1.example.org', '127.0.0.1.nip.io', '169.254.169.254.example', '192.0.0.8.example.org', '100.64.x.example']) {
	check(`a dressed-up name is refused: ${bad}`, nameMimicsNonPublicAddress(bad));
}
console.log('');
if (failed > 0) {
	console.log(`✗ ${failed} of ${n} name-mimicry scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${n} name-mimicry scenarios passed`);
