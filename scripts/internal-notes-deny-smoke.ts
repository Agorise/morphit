/**
 * internal-notes-deny-smoke.
 *
 * The public tree (every text file but private/ and build output, see
 * lib/public-tree-scan.ts) must not carry:
 *   - ids and names from the private fix records ("M-123", "pre-vigilante",
 *     "deep-deep", "fix wave"), and in operator docs and config files also
 *     checkpoint markers ("cp123", "Part 121"): a reader cannot look them up;
 *   - pointers to private working notes (`t.txt`, `tt.txt`), AI-session memory
 *     pointers ("memory #23" in any case), chat requests pasted in as quotes
 *     (a "Requested:" line, or "the user said: '…'"), or test-environment
 *     leftovers ("the sandbox doesn't have node_modules", a chat sandbox
 *     output path);
 *   - a public IPv4 address that is not on the reviewed list below (test
 *     fixtures, well-known resolvers, published CDN ranges). A real box's
 *     address fails here without anyone having to name it.
 * The private term list is personal-name-deny-smoke's.
 *
 *   MORPHIT_NOTES_SCAN_ROOT=<other tree> tsx scripts/internal-notes-deny-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { looksBinary, publicTextFiles } from './lib/public-tree-scan';

const ROOT = resolve(process.env.MORPHIT_NOTES_SCAN_ROOT ?? join(__dirname, '..'));
/** This file names the patterns it forbids. */
const SELF = 'scripts/internal-notes-deny-smoke.ts';

/** AI-session chatter and test-environment leftovers. */
export const DENY: ReadonlyArray<[string, RegExp]> = [
	['a private working-notes file', /\bt{1,2}\.txt\b/],
	['an AI-session memory pointer', /\bmemory (?:fact )?#\d+/i],
	['a chat request pasted into the tree', /(?<![\w-])Requested:/],
	[
		'a chat request pasted into the tree',
		/\b(?:the user|the maintainer|the operator) (?:said|wrote|asked|typed)[:,]? ?["“'‘]/i
	],
	// Ids and names from the private fix records: they mean nothing to a
	// reader of the public tree. Say what and why instead.
	['a private finding id', /(?<![\w./-])M-\d{3}(?![\w-])/],
	[
		'private process vocabulary',
		/\bpre-vigilante\b|\bdeep-deep\b|\bfix (?:wave|round)\b|\bROUND ?2 item\b/i
	],
	[
		'a test-environment leftover',
		/\bsandbox (?:doesn't|does not|has no|can't|cannot)\b|Hono isn't installed|\/mnt\/user-data\b/i
	]
];
/** Docs and config files operators read or install. Code comments and test
 *  labels are not covered here (an old checkpoint id in a test name is not
 *  operator-facing). */
const OPERATOR_FACING = /\.(?:md|txt|example|env|j2|ya?ml|conf|service|timer|ini|toml)$/;
/** "cp123", "Part 121" — ids from the private fix journals. A registered check
 *  id that starts with one ("cp30-usdc-p2p") is a name, not a marker. */
const CHECKPOINT = /(?<![\w./@#`-])(?:[Cc]p\d+[a-z]?(?![\w-])|Part \d+\b)/;

/** Public IPv4 literals reviewed as fixtures, resolvers or published ranges.
 *  19.104.182.65, 7.3.9.5 and 1.1.13.32 are digit runs inside SVG path data. */
const ALLOWED_PUBLIC_IPV4 = new Set([
	'1.1.1.1',
	'1.2.3.4',
	'5.6.7.8',
	'6.6.6.6',
	'7.7.7.7',
	'8.8.8.8',
	'9.9.9.9',
	'93.184.216.34',
	'100.63.0.1',
	'100.63.255.254',
	'100.128.0.1',
	'103.21.244.0',
	'104.16.0.1',
	'142.250.1.1',
	'172.15.0.1',
	'172.15.255.1',
	'172.32.0.1',
	'172.32.0.5',
	'173.245.48.0',
	'192.0.3.0',
	'192.0.3.55',
	'19.104.182.65',
	'7.3.9.5',
	'1.1.13.32',
	// Kubo's stock bootstrap peer (mars.i.ipfs.io), in the clearnet bootstrap
	// set that morphit-ipfs-privacy.sh writes.
	'104.131.131.82',
	// A routable-looking address inside the kubo-egress smoke's network
	// namespace (Kubo ignores private ranges, so the test needs a public one).
	'45.33.0.2'
]);
/** Files whose addresses are a list someone else publishes, reviewed as a
 *  whole: the Tor Project's built-in bridges (2026-10-09), shipped so a server
 *  whose network blocks torproject.org can still reach Tor. Every other check
 *  still applies to them. */
const PUBLISHED_ADDRESS_FILES = new Set(['ops/tor/builtin-bridges.json']);
/** Dotted quads without leading zeros ("08.1.1.1" is a number run, not an address). */
const IPV4 =
	/(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g;

/** Not a globally routable unicast address (private, loopback, link-local,
 *  CGNAT, documentation, benchmarking, multicast, reserved). */
function isNonPublic(ip: string): boolean {
	const [a, b, c] = ip.split('.').map(Number) as [number, number, number];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113)
	);
}

const files = publicTextFiles(ROOT, new Set([SELF]));
const hits: string[] = [];
for (const rel of files) {
	const buf = readFileSync(join(ROOT, rel));
	if (looksBinary(buf)) continue;
	const lines = buf.toString('utf8').split('\n');
	lines.forEach((line, i) => {
		const at = `${rel}:${i + 1}`;
		for (const [what, re] of DENY) if (re.test(line)) hits.push(`${at}: ${what}`);
		if (OPERATOR_FACING.test(rel) && CHECKPOINT.test(line))
			hits.push(`${at}: a fix-session checkpoint marker in an operator doc or config file`);
		// SVG path data is digit runs, not addresses.
		if (rel.endsWith('.svg') || PUBLISHED_ADDRESS_FILES.has(rel)) return;
		for (const m of line.matchAll(IPV4))
			if (!isNonPublic(m[0]) && !ALLOWED_PUBLIC_IPV4.has(m[0]))
				hits.push(`${at}: a public IPv4 address not on the reviewed list (${m[0]})`);
	});
}

if (files.length < 1000) {
	console.log(`✗ scanned only ${files.length} files under ${ROOT} — wrong root?`);
	process.exit(1);
}
if (hits.length > 0) {
	for (const h of hits.slice(0, 200)) console.log(`  ✗ ${h}`);
	if (hits.length > 200) console.log(`  … and ${hits.length - 200} more`);
	console.log(`✗ ${hits.length} internal-note line(s) in ${files.length} files`);
	process.exit(1);
}
console.log(
	`✓ all ${files.length} files free of internal notes, test-environment leftovers and unreviewed public addresses`
);
