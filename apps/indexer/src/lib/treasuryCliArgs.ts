/**
 * Arguments of the one-time treasury pin scripts (set-treasury-btc-xpub.ts,
 * set-treasury-xmr-primary.ts): `<value> [--file <path>]`, in any order.
 *
 * v1.20.2 — both scripts dropped args[0] when `--file` was NOT given
 * (`indexOf` = -1, so "skip index fileIdx + 1" skipped index 0, the value
 * itself), and answered every real run with "Paste the whole key". The tests
 * always passed `--file`, so they never took that path. PURE.
 */
export function splitTreasuryArgs(args: readonly string[]): {
	readonly value: string;
	readonly file: string | null;
} {
	const i = args.indexOf('--file');
	if (i < 0) return { value: args[0] ?? '', file: null };
	const rest = args.filter((_, j) => j !== i && j !== i + 1);
	return { value: rest[0] ?? '', file: args[i + 1] ?? null };
}

/**
 * `<value>` plus named options, in any order (v1.20.2, set-treasury-btc-xpub.ts):
 * `valued` options take the next argument and may repeat (`--explorer a
 * --explorer b`); `flags` take none. Anything else starting with `--` is
 * returned in `unknown`, so a typo is refused instead of being read as the key.
 * PURE.
 */
export function parseTreasuryArgs(
	args: readonly string[],
	valued: readonly string[],
	flags: readonly string[]
): {
	readonly value: string;
	readonly options: Readonly<Record<string, readonly string[]>>;
	readonly flags: ReadonlySet<string>;
	readonly unknown: readonly string[];
} {
	const options: Record<string, string[]> = {};
	const set = new Set<string>();
	const unknown: string[] = [];
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		const name = a.startsWith('--') ? a.slice(2) : null;
		if (name !== null && valued.includes(name)) {
			const v = args[i + 1];
			if (v === undefined) unknown.push(a);
			else (options[name] ??= []).push(v);
			i++;
		} else if (name !== null && flags.includes(name)) set.add(name);
		else if (name !== null) unknown.push(a);
		else positional.push(a);
	}
	return { value: positional[0] ?? '', options, flags: set, unknown };
}
