/**
 * A command's error as its exit code: Ctrl+C (an AbortError from a question or
 * a step that was stopped) is 130, with one plain line — never "Error: …" and a
 * failure code a caller would treat as a fault (the install wizard queues a
 * `register` that failed for an unattended retry). Anything else is printed
 * (sanitised) and is 3.
 */
import { isAbortError } from '../init/prompt.ts';
import { error as printError } from '../render/term.ts';

export function commandFailed(err: unknown, print: (s: string) => void = console.log): number {
	if (isAbortError(err)) {
		print('\n  Stopped — you pressed Ctrl+C.');
		return 130;
	}
	printError(err instanceof Error ? err.message : String(err));
	return 3;
}
