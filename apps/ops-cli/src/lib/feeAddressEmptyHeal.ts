/**
 * Empty fee-address lines in an installed node's env files.
 *
 * The shipped indexer.env.example used to carry the UNCOMMENTED lines
 * `MORPHIT_INDEXER_BTC_FEE_ADDRESS=` and `MORPHIT_INDEXER_XMR_FEE_ADDRESS=`
 * and said empty meant "use the address the release pins on chain". It now
 * turns that method OFF on the node, even when an address is pinned. A node
 * set up by copying the example would stop taking BTC/XMR fees after this
 * upgrade, so, once per box (marker file), in the env files the indexer
 * sources:
 *   - an exactly-empty line is commented out, with a note saying why and that
 *     uncommenting it turns that method off; owner and mode are kept and the
 *     file is read back;
 *   - a file that cannot be written: the exact line to change is printed;
 *   - after the services restart (the after-restart phase), the running
 *     indexer's /v1/instance must show an address for each method whose line
 *     was commented (not checked on a hidden-only node, which shows none).
 * The marker means an operator who sets `=` on purpose later is never
 * rewritten. Ansible installs never write these keys.
 */
import {
	chownSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';

export const FEE_ADDRESS_HEAL_MARKER = '/etc/morphit/fee-address-heal-v1.done';
/** The files the indexer unit sources, in order (ops/systemd/morphit-indexer.service). */
export const INDEXER_ENV_FILES = [
	'/opt/morphit/morphit.env',
	'/opt/morphit/morphit.config.env',
	'/etc/morphit/indexer.env'
];

const EMPTY_LINE =
	/^[ \t]*(?:export[ \t]+)?(MORPHIT_INDEXER_(BTC|XMR)_FEE_ADDRESS)[ \t]*=[ \t]*(?:""|'')?[ \t]*$/;

/** Comment out exactly-empty fee-address lines. PURE. */
export function commentEmptyFeeAddressLines(text: string): { text: string; methods: string[] } {
	const methods: string[] = [];
	const out = text.split('\n').map((line) => {
		const m = EMPTY_LINE.exec(line);
		if (!m) return line;
		const coin = m[2]!;
		if (!methods.includes(coin)) methods.push(coin);
		return (
			`# ${line.trim()}  # commented by morphit-ops upgrade: an empty value now turns ${coin} fees ` +
			`OFF on this node (it used to mean "use the pinned address"). Uncomment it to turn ${coin} fees off.`
		);
	});
	return { text: out.join('\n'), methods };
}

export interface FeeAddressRuntime {
	readonly files: readonly string[];
	read(file: string): string | null;
	/** Write keeping owner and mode; false when it cannot. */
	write(file: string, text: string): boolean;
	markerText(): string | null;
	writeMarker(text: string): void;
}

export async function healEmptyFeeAddressLines(
	_ctx: HealCtx,
	rt: FeeAddressRuntime
): Promise<HealResult> {
	if (rt.markerText() !== null) return { strategy: 'already-marked', verified: true, detail: '' };
	const changed: string[] = [];
	const methods = new Set<string>();
	const stuck: string[] = [];
	for (const f of rt.files) {
		const before = rt.read(f);
		if (before === null) continue;
		const r = commentEmptyFeeAddressLines(before);
		if (r.methods.length === 0) continue;
		const ok =
			rt.write(f, r.text) && commentEmptyFeeAddressLines(rt.read(f) ?? '').methods.length === 0;
		if (ok) {
			changed.push(f);
			for (const m of r.methods) methods.add(m);
		} else {
			stuck.push(
				...r.methods.map(
					(m) => `in ${f}, put a # in front of the empty line MORPHIT_INDEXER_${m}_FEE_ADDRESS=`
				)
			);
		}
	}
	if (stuck.length > 0) {
		return {
			strategy: 'not-writable',
			verified: false,
			detail: `Fee addresses: an empty fee-address line now turns that fee method OFF (it used to mean "use the pinned address"), and it could not be changed here. On this server: ${stuck.join('; ')}, then: sudo systemctl restart morphit-indexer`
		};
	}
	rt.writeMarker(`fee-address-empty-v1\nmethods=${[...methods].join(',')}\n`);
	if (changed.length === 0) return { strategy: 'not-present', verified: true, detail: '' };
	return {
		strategy: 'commented',
		verified: true,
		detail: `Fee addresses: commented out the empty ${[...methods].map((m) => `MORPHIT_INDEXER_${m}_FEE_ADDRESS=`).join(' and ')} line(s) in ${changed.join(', ')} — empty now turns that fee method OFF; with the line commented this node takes ${[...methods].join(' and ')} fees again (checked once the indexer has restarted).`
	};
}

/** After the restart: each method whose line was commented has an address. */
export async function verifyFeeAddressHeal(
	_ctx: HealCtx,
	deps: {
		readonly markerText: () => string | null;
		readonly hiddenOnly: () => boolean;
		readonly instance: () => Promise<{
			treasury?: { btc?: string | null; xmr?: string | null };
		} | null>;
		/** Where the indexer listens, configured address first. */
		readonly bases?: () => readonly string[];
	}
): Promise<HealResult> {
	const marker = deps.markerText();
	const methods = (/^methods=(.*)$/m.exec(marker ?? '')?.[1] ?? '')
		.split(',')
		.filter((m) => m !== '');
	if (methods.length === 0 || deps.hiddenOnly())
		return { strategy: 'nothing-to-check', verified: true, detail: '' };
	const inst = await deps.instance().catch(() => null);
	if (inst === null) {
		const base = deps.bases?.()[0] ?? 'http://127.0.0.1:8081';
		return {
			strategy: 'unchecked',
			verified: false,
			detail: `Fee addresses: the indexer did not answer /v1/instance, so the fee addresses were not checked. Later: curl -s ${base}/v1/instance | grep -o '"treasury":{[^}]*}'`
		};
	}
	const missing = methods.filter((m) => {
		const v = m === 'BTC' ? inst.treasury?.btc : inst.treasury?.xmr;
		return typeof v !== 'string' || v === '';
	});
	return missing.length === 0
		? {
				strategy: 'verified',
				verified: true,
				detail: `Fee addresses: the running indexer takes ${methods.join(' and ')} fees again.`
			}
		: {
				strategy: 'still-off',
				verified: false,
				detail: `Fee addresses: the running indexer still shows no ${missing.join('/')} fee address — no release pins one yet, or the method is switched off elsewhere. See: sudo morphit-ops doctor`
			};
}

export function realFeeAddressRuntime(
	envRoot = process.env.MORPHIT_ENV_ROOT ?? '',
	marker = `${envRoot}${FEE_ADDRESS_HEAL_MARKER}`
): FeeAddressRuntime {
	return {
		files: INDEXER_ENV_FILES.map((f) => `${envRoot}${f}`),
		read: (f) => {
			try {
				return existsSync(f) ? readFileSync(f, 'utf8') : null;
			} catch {
				return null;
			}
		},
		write: (f, text) => {
			try {
				const st = statSync(f);
				const tmp = `${f}.fee-heal.new`;
				writeFileSync(tmp, text, { mode: st.mode & 0o777 });
				chownSync(tmp, st.uid, st.gid);
				renameSync(tmp, f);
				return true;
			} catch {
				return false;
			}
		},
		markerText: () => (existsSync(marker) ? readFileSync(marker, 'utf8') : null),
		writeMarker: (text) => {
			mkdirSync(dirname(marker), { recursive: true });
			writeFileSync(marker, text, { mode: 0o644 });
		}
	};
}
