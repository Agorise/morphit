/**
 * Questions nobody can answer any more (review v1.21.18), in real child
 * processes with a real pipe — or a real pseudo-terminal — on stdin:
 *  - once the input had ended, a question with no default got '' at once, so
 *    a caller that asks again until it gets an answer ("Fees account name", a
 *    payment method's key, the listing fee's "Enter ticker") asked about
 *    200,000 times a second, forever;
 *  - the masked passphrase reader read stdin itself, beside the shared reader
 *    of piped answers: the secret went to the NEXT question, and with every
 *    answer piped at once the run just ended (exit 0) mid-question; it also
 *    wrote terminal escapes to a stdout that was not a terminal;
 *  - Ctrl+D at the passphrase prompt returned '' (an "answer");
 *  - no answer within the wait on a pipe that is still open was reported as
 *    "the input ended".
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = new URL('../../../', import.meta.url).pathname;
const OPS = join(REPO, 'apps/ops-cli');
const TSX = join(REPO, 'node_modules/.bin/tsx');
const PROMPT = join(OPS, 'src/init/prompt.ts');
const FAILED = join(OPS, 'src/lib/commandFailed.ts');

/** A script with the prompt helpers in scope; a stop is printed as
 *  "THREW <inputEnded> <message>" and the line commandFailed says for it. */
function script(body: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-noanswer-'));
	const file = join(dir, 'run.ts');
	writeFileSync(
		file,
		`import { ask, askChoice, askYesNo, askPassword, isInputEnded } from ${JSON.stringify(PROMPT)};\n` +
			`import { commandFailed } from ${JSON.stringify(FAILED)};\n` +
			`(async () => {\ntry {\n${body}\n} catch (e) {\n` +
			`console.log('THREW ' + String(isInputEnded(e)) + ' ' + (e as Error).message);\n` +
			`console.log('CODE ' + String(commandFailed(e, (s) => console.log('SAID ' + s.trim()))));\n}\n` +
			`process.exit(0);\n})();\n`
	);
	return file;
}

/** Run `body` with `input` piped in (the pipe then closes). */
function piped(body: string, input: string, timeoutMs = 20_000) {
	const started = Date.now();
	const r = spawnSync(TSX, [script(body)], {
		input,
		encoding: 'utf8',
		timeout: timeoutMs,
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, MORPHIT_PROMPT_TIMEOUT_MS: '3000' }
	});
	return { out: `${r.stdout}${r.stderr}`, ms: Date.now() - started, status: r.status };
}

/** The fees-account loop as steps.ts has it: ask again until there is one. */
const FEES_LOOP =
	`while (true) { const v = await ask('Fees account name'); if (v.length) { console.log('GOT', v); break; } ` +
	`console.log('  ✗ Please enter the account where your fees should land.'); }`;

describe('a question asked again once the input has ended', () => {
	it('stops on the second time, instead of asking forever', () => {
		const r = piped(FEES_LOOP, '');
		expect(r.status).toBe(0);
		expect(r.out).toContain('THREW true No answer to "Fees account name" — the input ended');
		expect(r.out).toContain('SAID Stopped — the input ended');
		expect(r.out).toContain('CODE 130');
		// Asked twice, refused once — not hundreds of thousands of lines.
		expect(r.out.match(/Fees account name/g)?.length).toBe(3); // 2 prompts + the stop message
		expect(r.out.match(/Please enter the account/g)?.length).toBe(1);
		expect(r.ms).toBeLessThan(15_000);
	}, 30_000);

	it('with a default the caller refuses (an invalid current value): stops too', () => {
		const r = piped(
			`while (true) { const v = await ask('Fees account name', 'Not Valid!'); ` +
				`if (/^[a-z]+$/.test(v)) break; console.log('  ✗ invalid'); }`,
			''
		);
		expect(r.out).toContain('THREW true No answer to "Fees account name"');
		expect(r.out.match(/✗ invalid/g)?.length).toBe(1);
	}, 30_000);

	it('the first non-answer is still the default or "" — each "Enter to skip" question gets it', () => {
		const r = piped(
			`const n = await ask('Display name'); const d = await ask('Description (Enter to skip)'); ` +
				`const u = await ask('URL (Enter to skip)'); const y = await askYesNo('Save?', true); ` +
				`console.log('GOT', JSON.stringify([n, d, u, y]));`,
			'Alice Bank\n'
		);
		expect(r.out).toContain('GOT ["Alice Bank","","",true]');
		expect(r.out).not.toContain('THREW');
	}, 30_000);

	it('an answer in between starts afresh', () => {
		const r = piped(
			`const a = await ask('Name'); const b = await ask('Name'); console.log('GOT', JSON.stringify([a, b]));`,
			'alice\n'
		);
		// The first was answered; the second is the first non-answer: ''.
		expect(r.out).toContain('GOT ["alice",""]');
	}, 30_000);
});

describe('no answer on an input that is still open', () => {
	it('says no answer came within the wait — not that the input ended', async () => {
		const child = spawn(TSX, [script(FEES_LOOP)], {
			env: { ...process.env, MORPHIT_PROMPT_TIMEOUT_MS: '1000' },
			stdio: ['pipe', 'pipe', 'pipe']
		});
		let out = '';
		child.stdout.on('data', (d) => (out += String(d)));
		child.stderr.on('data', (d) => (out += String(d)));
		// stdin stays open (never written, never closed) until the child is done.
		const code = await new Promise<number | null>((resolve) => {
			const t = setTimeout(() => child.kill('SIGKILL'), 25_000);
			child.on('close', (c) => {
				clearTimeout(t);
				resolve(c);
			});
		});
		child.stdin.destroy();
		expect(code).toBe(0);
		expect(out).toContain('THREW true No answer to "Fees account name" within 1 second');
		expect(out).toContain(
			'SAID Stopped — no answer came within 1 second (this is not running at a terminal, so it does not wait longer).'
		);
		expect(out).not.toMatch(/SAID .*the input ended/);
		expect(out).toContain('CODE 130');
	}, 30_000);
});

describe('the passphrase question with piped answers', () => {
	const BODY =
		`const a = await ask('one'); console.log('\\nA', JSON.stringify(a)); ` +
		`const p = await askPassword('pw'); console.log('P', JSON.stringify(p)); ` +
		`const c = await ask('three'); console.log('\\nC', JSON.stringify(c));`;

	it('gets its own line, and the next question the next one (all piped at once)', () => {
		const r = piped(BODY, 'a\nsecret\nthree\n');
		expect(r.out).toContain('P "secret"');
		expect(r.out).toContain('C "three"');
		expect(r.out).not.toContain('THREW');
		// No terminal escapes (bracketed paste on/off) to a stdout that is a pipe.
		expect(r.out).not.toContain('\u001b');
	}, 30_000);

	it('the input ending at it is a stop, said as such — not exit 0 mid-question', () => {
		const r = piped(BODY, 'a\n');
		expect(r.out).toContain('THREW true No answer to "pw" — the input ended');
		expect(r.out).toContain('CODE 130');
		expect(r.out).not.toContain('P "');
	}, 30_000);
});

// ─── At a real terminal ──────────────────────────────────────────────

const DRIVER = `
import json, os, pty, re, select, sys, time, signal
spec = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(spec["cmd"][0], spec["cmd"], dict(os.environ, **spec["env"]))
buf, steps, deadline = b"", list(spec["steps"]), time.time() + 60
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        buf += data
    if steps and re.search(steps[0][0], buf.decode("utf-8", "replace"), re.S):
        time.sleep(0.2)
        os.write(fd, steps.pop(0)[1].encode())
else:
    os.kill(pid, signal.SIGKILL)
_, st = os.waitpid(pid, 0)
sys.stdout.write(buf.decode("utf-8", "replace"))
sys.stdout.write("\\n=== EXIT %d\\n" % os.waitstatus_to_exitcode(st))
`;

function atTerminal(body: string, steps: [string, string][]): string {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-noanswer-pty-'));
	const driver = join(dir, 'drive.py');
	writeFileSync(driver, DRIVER);
	const spec = { cmd: [TSX, script(body)], env: { TSX_DISABLE_CACHE: '1' }, steps };
	const r = spawnSync('python3', ['-I', driver, JSON.stringify(spec)], {
		encoding: 'utf8',
		timeout: 90_000
	});
	return r.stdout ?? '';
}

describe('the passphrase question at a terminal', () => {
	const BODY = `const p = await askPassword('pw'); console.log('PW', JSON.stringify(p));`;

	it('Ctrl+D is the input ending (a stop), not an empty answer', () => {
		const out = atTerminal(BODY, [['> ', 'ab\u0004']]);
		expect(out).toContain('THREW true Aborted with Ctrl+D');
		expect(out).toContain('SAID Stopped — the input ended');
		expect(out).not.toContain('PW ');
	}, 60_000);

	it('Ctrl+C is a stop, said as Ctrl+C', () => {
		const out = atTerminal(BODY, [['> ', 'ab\u0003']]);
		expect(out).toContain('THREW false Aborted with Ctrl+C');
		expect(out).toContain('SAID Stopped — you pressed Ctrl+C.');
	}, 60_000);

	it('a typed passphrase is read masked, and bracketed paste is turned off around it', () => {
		const out = atTerminal(BODY, [['> ', 'secret\r']]);
		expect(out).toContain('PW "secret"');
		expect(out).toContain('******');
		expect(out).not.toContain('secret\r\n');
		expect(out).toContain('\u001b[?2004l');
	}, 60_000);
});
