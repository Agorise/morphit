/**
 * Morphit relay — passphrase prompt (ADR-0010 §4).
 *
 * Reads a passphrase from stdin without echoing. Refuses to run
 * if stdin isn't a TTY, because systemd (or any non-interactive
 * startup) would otherwise hang forever waiting for input. The
 * relay's systemd unit will need to use `StandardInput=tty-force`
 * to get a pty attached, or the operator will run the relay in
 * the foreground for the first boot after reboot.
 *
 * Design:
 *   - Prompt text goes to stderr so piping stdout doesn't capture
 *     the prompt.
 *   - Raw mode on stdin so typed characters aren't echoed.
 *   - Backspace, Ctrl-C, and EOF are handled explicitly.
 *   - Timeout after 5 minutes to prevent a forgotten prompt from
 *     holding the relay hostage.
 */

export class PassphrasePromptError extends Error {
	constructor(
		message: string,
		public readonly code: 'no_tty' | 'cancelled' | 'timeout' | 'empty'
	) {
		super(message);
		this.name = 'PassphrasePromptError';
	}
}

export interface PromptOptions {
	/** Prompt text shown to the user. Default: "Passphrase: ". */
	readonly prompt?: string;
	/** Abort the prompt after this many ms. Default 5 minutes. */
	readonly timeoutMs?: number;
	/** Minimum acceptable length. Default 1 (any non-empty). The
	 *  key envelope enforces a stronger floor at encrypt time. */
	readonly minLength?: number;
}

/** Read a passphrase from stdin with echo disabled. Resolves to
 *  the passphrase string on Enter; rejects with
 *  PassphrasePromptError otherwise. */
export function promptPassphrase(options: PromptOptions = {}): Promise<string> {
	const prompt = options.prompt ?? 'Passphrase: ';
	const timeoutMs = options.timeoutMs ?? 5 * 60_000;
	const minLength = options.minLength ?? 1;

	if (!process.stdin.isTTY) {
		return Promise.reject(
			new PassphrasePromptError(
				'stdin is not a TTY — cannot prompt for passphrase. ' +
					'Configure the systemd unit with StandardInput=tty-force, ' +
					'or start the relay in the foreground for the first boot.',
				'no_tty'
			)
		);
	}

	return new Promise<string>((resolve, reject) => {
		process.stderr.write(prompt);
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding('utf8');

		let passphrase = '';
		let finished = false;

		const timer = setTimeout(() => {
			finish(() => reject(new PassphrasePromptError('timeout waiting for passphrase', 'timeout')));
		}, timeoutMs);

		const onData = (chunk: string): void => {
			// Process chunk char-by-char to handle multi-byte edge
			// cases. In practice keyboard input arrives one char at
			// a time but paste could deliver a whole string.
			for (const ch of chunk) {
				if (finished) return;
				const code = ch.charCodeAt(0);
				if (ch === '\r' || ch === '\n') {
					// Enter pressed.
					process.stderr.write('\n');
					if (passphrase.length < minLength) {
						finish(() =>
							reject(
								new PassphrasePromptError(
									`passphrase shorter than minimum ${minLength} characters`,
									'empty'
								)
							)
						);
						return;
					}
					finish(() => resolve(passphrase));
					return;
				}
				if (code === 0x03) {
					// Ctrl-C.
					process.stderr.write('\n');
					finish(() => reject(new PassphrasePromptError('cancelled by operator', 'cancelled')));
					return;
				}
				if (code === 0x04) {
					// Ctrl-D / EOT on empty input.
					if (passphrase.length === 0) {
						process.stderr.write('\n');
						finish(() => reject(new PassphrasePromptError('EOF on empty passphrase', 'empty')));
						return;
					}
					// On non-empty, treat as Enter.
					process.stderr.write('\n');
					finish(() => resolve(passphrase));
					return;
				}
				if (code === 0x7f || code === 0x08) {
					// Backspace / DEL.
					if (passphrase.length > 0) {
						passphrase = passphrase.slice(0, -1);
					}
					continue;
				}
				if (code < 0x20) {
					// Ignore other control chars silently.
					continue;
				}
				passphrase += ch;
			}
		};

		const finish = (action: () => void): void => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			process.stdin.setRawMode(false);
			process.stdin.pause();
			process.stdin.removeListener('data', onData);
			action();
		};

		process.stdin.on('data', onData);
	});
}
