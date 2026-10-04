/**
 * private-term-encoding-deny-smoke.
 *
 * personal-name-deny-smoke keeps the terms of the maintainer's private term
 * list (private/deny-terms.json) out of the public tree in plain text. This
 * smoke keeps them out in disguise, because a disguised term is still
 * published: a hash of a short word is reversed by brute force in seconds,
 * and every encoding below is reversed by anyone who looks.
 *
 * For every term, in every case variant (as written, lower, UPPER, Title,
 * normalised), no public file — images, archives and the members of zip and
 * gzip files included — and no file name may hold:
 *   - its MD5, SHA-1, SHA-256 or SHA-512, as hex (any 12+ digit prefix) or
 *     base64 (the first 12 characters);
 *   - its bytes as hex, %-escapes (URL encoding), HTML entities (&#…; and
 *     &#x…;), \u / \x escapes, a list of character codes, UTF-16 (LE or BE),
 *     reversed or ROT13;
 *   - base64 of a text containing it: every base64 run (data: URIs too) is
 *     decoded at each of its four alignments, standard and URL-safe;
 *   - its letters split by separators ("t e r m", "t.e.r.m", "t-e-r-m"), or
 *     a host or address with its dots defanged ("[.]", "(.)", " dot ").
 * A term that the list allows in certain files is checked everywhere else.
 * Without the private list (a public clone) there is nothing to check, and
 * the run says so.
 *
 *   tsx scripts/private-term-encoding-deny-smoke.ts
 *   MORPHIT_ENCODING_SCAN_ROOT=<other tree> tsx scripts/private-term-encoding-deny-smoke.ts
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import {
	NO_DENY_TERMS,
	allDenyTerms,
	loadDenyTerms,
	normWord,
	publicTextFiles
} from './lib/public-tree-scan';

const REPO = join(__dirname, '..');
const ROOT = resolve(process.env.MORPHIT_ENCODING_SCAN_ROOT ?? REPO);
const TERMS = allDenyTerms(REPO);
const LISTS = loadDenyTerms(REPO);
const SELF = 'scripts/private-term-encoding-deny-smoke.ts';

/** Files a term may appear in (by its normalised form). */
const ALLOWED_FILES = new Map((LISTS?.allowedIn ?? []).map((a) => [a.word, a.files]));

const rot13 = (s: string): string =>
	s.replace(/[a-z]/gi, (c) => {
		const base = c <= 'Z' ? 65 : 97;
		return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
	});
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const variantsOf = (t: string): string[] =>
	[
		...new Set([
			t,
			t.toLowerCase(),
			t.toUpperCase(),
			t[0].toUpperCase() + t.slice(1).toLowerCase(),
			normWord(t)
		])
	].filter((v) => v.length > 0);

interface Term {
	readonly label: string;
	readonly norm: string;
	readonly variants: readonly string[];
}
const terms: Term[] = (TERMS ?? []).map(([label, t]) => ({
	label: `private term (${label})`,
	norm: normWord(t),
	variants: variantsOf(t)
}));

/** [needle, what, case-sensitive?]; latin1 strings (one char per byte). */
const needles: Array<[string, string, boolean, Term]> = [];
for (const term of terms) {
	for (const v of term.variants) {
		const bytes = Buffer.from(v, 'utf8');
		const codes = [...bytes];
		const add = (n: string, how: string, cs = false): void => {
			if (n.length >= 6 && n.toLowerCase() !== v.toLowerCase())
				needles.push([n, `${term.label} ${how}`, cs, term]);
		};
		for (const alg of ['md5', 'sha1', 'sha256', 'sha512']) {
			const d = createHash(alg).update(v).digest();
			add(d.toString('hex').slice(0, 12), `as a ${alg} hash`);
			add(d.toString('base64').slice(0, 12), `as a ${alg} hash (base64)`, true);
			add(d.toString('base64url').slice(0, 12), `as a ${alg} hash (base64url)`, true);
		}
		add(bytes.toString('hex'), 'as hex');
		add(codes.map((c) => `%${c.toString(16).padStart(2, '0')}`).join(''), 'URL-encoded');
		add(codes.map((c) => `&#${c};`).join(''), 'as HTML entities');
		add(codes.map((c) => `&#x${c.toString(16)};`).join(''), 'as HTML entities');
		add(codes.map((c) => `\\u${c.toString(16).padStart(4, '0')}`).join(''), 'as \\u escapes');
		add(codes.map((c) => `\\x${c.toString(16).padStart(2, '0')}`).join(''), 'as \\x escapes');
		add(codes.join(','), 'as character codes', true);
		add(codes.join(', '), 'as character codes', true);
		add(Buffer.from(v, 'utf16le').toString('latin1'), 'as UTF-16');
		add(Buffer.from(Buffer.from(v, 'utf16le').swap16()).toString('latin1'), 'as UTF-16 (BE)');
		add([...v].reverse().join(''), 'reversed');
		add(rot13(v), 'ROT13');
	}
}
const ci = needles.filter((n) => !n[2]);
const cs = needles.filter((n) => n[2]);
const byNeedle = new Map(
	needles.map(([n, what, c, term]) => [c ? n : n.toLowerCase(), { what, term }])
);
const alt = (list: typeof needles): RegExp | null =>
	list.length
		? new RegExp(
				[...new Set(list.map(([n]) => n))]
					.sort((a, b) => b.length - a.length)
					.map(esc)
					.join('|'),
				list === ci ? 'gi' : 'g'
			)
		: null;
const CI_RE = alt(ci);
const CS_RE = alt(cs);

/** Letters split by separators, and hosts/addresses with defanged dots. */
const SPLIT: Array<[RegExp, Term]> = [];
for (const term of terms) {
	const chars = [...term.norm].filter((c) => /[\p{L}\p{N}]/u.test(c));
	if (/^[\d.]+$/.test(term.norm) || term.norm.includes('.')) {
		const parts = term.variants[0].toLowerCase().split('.');
		const dot = String.raw`\s*(?:\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\)|\s+dot\s+)\s*`;
		SPLIT.push([
			new RegExp(`(?<![\\p{L}\\p{N}])${parts.map(esc).join(dot)}(?![\\p{L}\\p{N}])`, 'giu'),
			term
		]);
	} else if (chars.length >= 4) {
		SPLIT.push([
			new RegExp(
				`(?<![\\p{L}\\p{N}])${chars.map(esc).join(String.raw`[^\p{L}\p{N}\n]{1,3}`)}(?![\\p{L}\\p{N}])`,
				'giu'
			),
			term
		]);
	}
}

/** Mostly printable: a decoded run that holds real text, not noise. */
const printable = (b: Buffer, at: number, len: number): boolean => {
	const s = Math.max(0, at - 6);
	const e = Math.min(b.length, at + len + 6);
	let ok = 0;
	for (let i = s; i < e; i++)
		if ((b[i] >= 0x20 && b[i] < 0x7f) || b[i] === 9 || b[i] === 10 || b[i] === 13) ok++;
	return ok >= (e - s) * 0.9;
};
const B64_RUN = /[A-Za-z0-9+/_-]{8,}={0,2}/g;
function* base64Decodes(text: string): Generator<Buffer> {
	for (const m of text.matchAll(B64_RUN)) {
		const run = m[0].replace(/=+$/, '');
		for (let k = 0; k < 4; k++) {
			const part = run.slice(k);
			if (part.length < 8) continue;
			yield Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
		}
	}
}

/** Members of a zip (stored or deflated) or gzip file; [] for anything else. */
function members(b: Buffer): Array<[string, Buffer]> {
	try {
		if (b[0] === 0x1f && b[1] === 0x8b) return [['(gunzipped)', gunzipSync(b)]];
		if (b.readUInt32LE(0) !== 0x04034b50) return [];
		const out: Array<[string, Buffer]> = [];
		const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
		let off = b.readUInt32LE(eocd + 16);
		for (let i = 0, n = b.readUInt16LE(eocd + 10); i < n; i++) {
			const method = b.readUInt16LE(off + 10);
			const size = b.readUInt32LE(off + 20);
			const nameLen = b.readUInt16LE(off + 28);
			const name = b.toString('utf8', off + 46, off + 46 + nameLen);
			const local = b.readUInt32LE(off + 42);
			const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
			const data = b.subarray(start, start + size);
			if (method === 0) out.push([name, data]);
			else if (method === 8) out.push([name, inflateRawSync(data)]);
			off += 46 + nameLen + b.readUInt16LE(off + 30) + b.readUInt16LE(off + 32);
		}
		return out;
	} catch {
		return [];
	}
}

const hits: string[] = [];
function scan(where: string, rel: string, b: Buffer, depth = 0): void {
	const seen = new Set<string>();
	const allowed = (t: Term): boolean => ALLOWED_FILES.get(t.norm)?.has(rel) ?? false;
	const note = (what: string, t: Term): void => {
		if (allowed(t) || seen.has(what)) return;
		seen.add(what);
		hits.push(`${where}: ${what}`);
	};
	const binary = b.subarray(0, 8192).includes(0) && !/\.txt$/.test(rel);
	const text = b.toString('latin1');
	for (const [re, map] of [
		[CI_RE, (s: string) => s.toLowerCase()],
		[CS_RE, (s: string) => s]
	] as const) {
		if (!re) continue;
		for (const m of text.matchAll(re)) {
			const n = byNeedle.get(map(m[0]));
			// In a binary file only long needles count: short ones occur by chance.
			if (n && (!binary || m[0].length >= 10)) note(n.what, n.term);
		}
	}
	if (!binary) {
		const utf8 = b.toString('utf8');
		for (const [re, t] of SPLIT)
			for (const _ of utf8.matchAll(re)) note(`${t.label} with its letters or dots disguised`, t);
		for (const dec of base64Decodes(text)) {
			const low = dec.toString('latin1').toLowerCase();
			for (const t of terms)
				for (const v of t.variants) {
					const i = low.indexOf(v.toLowerCase());
					if (v.length >= 3 && i >= 0 && printable(dec, i, v.length))
						note(`${t.label} inside base64`, t);
				}
		}
	}
	if (depth < 3)
		for (const [name, body] of members(b)) scan(`${where} › ${name}`, rel, body, depth + 1);
}

const files = publicTextFiles(ROOT, new Set([SELF]), true);
if (TERMS && terms.length) {
	for (const rel of files) {
		scan(`${rel} (file name)`, rel, Buffer.from(rel, 'utf8'));
		let b: Buffer;
		try {
			b = readFileSync(join(ROOT, rel));
		} catch {
			continue;
		}
		scan(rel, rel, b);
	}
}

if (files.length < 1000) {
	console.log(`✗ scanned only ${files.length} files under ${ROOT} — wrong root?`);
	process.exit(1);
}
if (!TERMS) {
	console.log(NO_DENY_TERMS);
	console.log(
		`✓ all ${files.length} files checked (private term list absent: encoded-term checks skipped)`
	);
	process.exit(0);
}
if (hits.length > 0) {
	for (const h of hits.slice(0, 200)) console.log(`  ✗ ${h}`);
	if (hits.length > 200) console.log(`  … and ${hits.length - 200} more`);
	console.log(`✗ ${hits.length} disguised private term(s) in ${files.length} files`);
	process.exit(1);
}
console.log(
	`✓ all ${files.length} files free of ${needles.length + SPLIT.length} disguised forms of the private terms (base64 runs decoded, archives unpacked)`
);
