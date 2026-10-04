/**
 * Morphit indexer — text Postgres can store (v1.20.0, V3-11).
 *
 * WHAT WAS WRONG. Two things a JavaScript string can hold that Postgres cannot:
 *
 *   - U+0000 (NUL). A TEXT value with one is refused ("invalid byte sequence
 *     for encoding UTF8: 0x00"), and a JSONB value refuses the `\u0000` escape
 *     ("unsupported Unicode escape sequence").
 *   - An unpaired UTF-16 surrogate (U+D800–U+DFFF). JSONB refuses the escape
 *     ("Unicode low surrogate must follow a high surrogate"); as TEXT, Node's
 *     UTF-8 encoder silently turns it into U+FFFD on the way out.
 *
 * Both reach the indexer from the chain. Blurt accepts any valid UTF-8 in a
 * transfer memo and any JSON in a custom_json, `\u0000` and `\ud800` escapes
 * included. So ONE Morphit op carrying `"m":"hi\u0000"`, or one 0.001 BLURT
 * transfer to the fee account with a NUL in its memo, failed the block's
 * event-log or fee_transfers INSERT, rolled the whole block back, and the
 * poller retried it forever: every indexer on the network halted at that
 * block, for the price of one transaction.
 *
 * THE RULE, the same on every node so every node stores the same thing: each
 * NUL and each unpaired surrogate becomes U+FFFD (the replacement character,
 * which is also what Node's encoder already did to a surrogate in TEXT). The
 * mapping is a pure function of the input, so two indexers — or a replay, or
 * a snapshot restore — always agree. Well-formed text passes through untouched
 * and by reference, so the cost on the normal path is one regex test.
 *
 * Where it is applied:
 *   - the dispatcher canonicalises every block before any write
 *     (`pgSafeBlock`), and REJECTS a Morphit op whose parsed payload needed it
 *     (`invalid_text`, recorded in the event log with the canonical payload):
 *     no legitimate client writes a NUL or half a surrogate pair, and an op is
 *     never materialised from text other than what its signer wrote;
 *   - the production connection pool canonicalises every query parameter
 *     (`pgSafeParams`), the backstop for everything that is not a block:
 *     peer responses, RPC answers, anything a future change forgets.
 */

/** A NUL, an unpaired high surrogate, or an unpaired low surrogate. */
const PG_INVALID = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const PG_INVALID_ALL =
	/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Would Postgres store this string as it is? */
export function isPgSafeText(s: string): boolean {
	return !PG_INVALID.test(s);
}

/** The string with every NUL and every unpaired surrogate replaced by U+FFFD.
 *  Returns the SAME string when there is nothing to replace. */
export function pgSafeText(s: string): string {
	return PG_INVALID.test(s) ? s.replace(PG_INVALID_ALL, '\uFFFD') : s;
}

function isPlainObject(v: object): v is Record<string, unknown> {
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

/**
 * Deep copy of a JSON-shaped value with every string — object KEYS included —
 * made storable. Returns the SAME reference when nothing needed changing, so
 * `pgSafeDeep(v) !== v` is the test for "v held text Postgres cannot store".
 * Anything that is not a string, array or plain object (numbers, Dates,
 * Buffers, class instances) is returned as it is.
 *
 * Two keys that become equal (`"a\u0000"` and `"a\uFFFD"`) keep the later
 * one's value, in the object's own key order — deterministic, like JSON.parse
 * itself on a duplicate key. A `__proto__` key stays an own property.
 *
 * Iterative, with an explicit stack: it never throws on nesting depth. A
 * recursive walk ran out of call stack on a few thousand levels of `[`, which a
 * ~6 KB custom_json carries, and threw out of the dispatcher's block pre-pass —
 * every indexer halted at that block. How deep an op may nest is a separate
 * rule (`jsonNestingExceeds`), judged per op.
 */
export function pgSafeDeep<T>(v: T): T {
	if (typeof v === 'string') return pgSafeText(v) as T;
	if (!isContainer(v)) return v;

	const root = openFrame(v);
	const stack: Frame[] = [root];
	let done: unknown = v;
	while (stack.length > 0) {
		const top = stack[stack.length - 1]!;
		if (top.i < top.len) {
			const child =
				top.keys === null
					? (top.src as unknown[])[top.i]
					: (top.src as Record<string, unknown>)[top.keys[top.i]!];
			if (isContainer(child)) {
				stack.push(openFrame(child));
				continue;
			}
			deliver(top, typeof child === 'string' ? pgSafeText(child) : child, child);
			continue;
		}
		stack.pop();
		const out = closeFrame(top);
		if (stack.length === 0) {
			done = out;
			break;
		}
		const parent = stack[stack.length - 1]!;
		const orig =
			parent.keys === null
				? (parent.src as unknown[])[parent.i]
				: (parent.src as Record<string, unknown>)[parent.keys[parent.i]!];
		deliver(parent, out, orig);
	}
	return done as T;
}

/** An array or a plain object — the two shapes pgSafeDeep descends into. */
function isContainer(v: unknown): v is unknown[] | Record<string, unknown> {
	if (v === null || typeof v !== 'object') return false;
	return Array.isArray(v) || isPlainObject(v);
}

interface Frame {
	readonly src: unknown[] | Record<string, unknown>;
	/** Own keys for an object; null for an array. */
	readonly keys: string[] | null;
	readonly len: number;
	i: number;
	readonly vals: unknown[];
	readonly outKeys: string[];
	changed: boolean;
}

function openFrame(src: unknown[] | Record<string, unknown>): Frame {
	const keys = Array.isArray(src) ? null : Object.keys(src);
	return {
		src,
		keys,
		len: keys === null ? (src as unknown[]).length : keys.length,
		i: 0,
		vals: [],
		outKeys: [],
		changed: false
	};
}

/** Record the canonical value of the current child and move to the next. */
function deliver(f: Frame, value: unknown, orig: unknown): void {
	if (value !== orig) f.changed = true;
	f.vals.push(value);
	if (f.keys !== null) {
		const k = f.keys[f.i]!;
		const ck = pgSafeText(k);
		if (ck !== k) f.changed = true;
		f.outKeys.push(ck);
	}
	f.i++;
}

function closeFrame(f: Frame): unknown {
	if (!f.changed) return f.src;
	if (f.keys === null) return f.vals;
	const out: Record<string, unknown> =
		Object.getPrototypeOf(f.src) === null ? Object.create(null) : {};
	for (let j = 0; j < f.vals.length; j++) {
		Object.defineProperty(out, f.outKeys[j]!, {
			value: f.vals[j],
			enumerable: true,
			writable: true,
			configurable: true
		});
	}
	return out;
}

/**
 * Does `v` nest arrays / objects more than `maxDepth` levels deep? A bare
 * scalar is depth 0, `[]` and `{}` are depth 1, `[[1]]` is depth 2.
 * Iterative, so it answers for any depth without throwing, and it stops at the
 * first container past the limit.
 */
export function jsonNestingExceeds(v: unknown, maxDepth: number): boolean {
	if (v === null || typeof v !== 'object') return false;
	const stack: [unknown, number][] = [[v, 1]];
	while (stack.length > 0) {
		const [cur, depth] = stack.pop()!;
		if (depth > maxDepth) return true;
		const children = Array.isArray(cur) ? cur : Object.values(cur as Record<string, unknown>);
		for (const c of children) {
			if (c !== null && typeof c === 'object') stack.push([c, depth + 1]);
		}
	}
	return false;
}

/** U+FFFE and U+FFFF: Unicode noncharacters, and not XML characters — one in
 *  an order's text made every RSS/Atom feed that carried it unparseable. */
const XML_NONCHARACTER = /[\uFFFE\uFFFF]/;

/** Does any string (value or key) in `v` hold U+FFFE or U+FFFF? Iterative. */
export function hasXmlNoncharacter(v: unknown): boolean {
	const stack: unknown[] = [v];
	while (stack.length > 0) {
		const cur = stack.pop();
		if (typeof cur === 'string') {
			if (XML_NONCHARACTER.test(cur)) return true;
		} else if (cur !== null && typeof cur === 'object') {
			if (Array.isArray(cur)) stack.push(...cur);
			else
				for (const [k, c] of Object.entries(cur as Record<string, unknown>)) {
					if (XML_NONCHARACTER.test(k)) return true;
					stack.push(c);
				}
		}
	}
	return false;
}

/** Minimal block shape — what the dispatcher reads. */
interface BlockLike {
	readonly transactions: readonly unknown[];
	readonly transaction_ids?: readonly unknown[];
}

/**
 * The block with every string in its transactions and transaction ids made
 * storable (see the file header). The SAME object when nothing changed —
 * every real block so far. Never mutates its input: the raw block is what the
 * fee-block confirmation compares against other RPC operators, before this.
 */
export function pgSafeBlock<B extends BlockLike>(block: B): B {
	const transactions = pgSafeDeep(block.transactions);
	const ids = block.transaction_ids === undefined ? undefined : pgSafeDeep(block.transaction_ids);
	if (transactions === block.transactions && ids === block.transaction_ids) return block;
	return { ...block, transactions, ...(ids === undefined ? {} : { transaction_ids: ids }) };
}

/** A JSON text that holds a `\u0000` escape or an escaped surrogate — the
 *  escapes JSONB refuses (a paired surrogate escape is fine, but re-serialising
 *  it is harmless, so the test is deliberately simple). */
const JSON_BAD_ESCAPE = /\\u(?:0000|[dD][89a-fA-F][0-9a-fA-F]{2})/;

/**
 * Query parameters made storable — the connection-pool backstop.
 *
 *   - a string: NUL / unpaired surrogates → U+FFFD. Such a string could never
 *     have been stored (NUL) or was already stored as U+FFFD (surrogate), so
 *     nothing that used to succeed changes;
 *   - a string bound to a `$n::jsonb` placeholder that holds a `\u0000` or
 *     surrogate escape: parsed, canonicalised and re-serialised — JSONB would
 *     have refused it. Not valid JSON → left for Postgres to refuse as before;
 *   - arrays and plain objects (which pg serialises itself): canonicalised
 *     deeply;
 *   - everything else (numbers, Dates, Buffers, null): unchanged.
 *
 * Returns the SAME array when no parameter changed.
 */
export function pgSafeParams(text: string, params: readonly unknown[]): unknown[] {
	let jsonbIdx: Set<number> | null = null;
	let out: unknown[] | null = null;
	for (let i = 0; i < params.length; i++) {
		const p = params[i];
		let c: unknown = p;
		if (typeof p === 'string') {
			c = pgSafeText(p);
			if (JSON_BAD_ESCAPE.test(c as string)) {
				jsonbIdx ??= jsonbPlaceholders(text);
				if (jsonbIdx.has(i + 1)) {
					try {
						c = JSON.stringify(pgSafeDeep(JSON.parse(c as string) as unknown));
					} catch {
						// Not JSON: Postgres refuses it exactly as it did before.
					}
				}
			}
		} else if (p !== null && typeof p === 'object') {
			c = pgSafeDeep(p);
		}
		if (out === null && c !== p) out = params.slice(0, i);
		if (out !== null) out.push(c);
	}
	return out ?? (params as unknown[]);
}

function jsonbPlaceholders(text: string): Set<number> {
	const s = new Set<number>();
	for (const m of text.matchAll(/\$(\d+)\s*::\s*jsonb\b/gi)) s.add(Number(m[1]));
	return s;
}
