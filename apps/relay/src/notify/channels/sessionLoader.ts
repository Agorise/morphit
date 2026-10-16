/**
 * Loads Session.js under Node.
 *
 * Session.js is published for Bun: its packages import their own files
 * without extensions and take named imports from lodash (a CommonJS module),
 * neither of which Node's ESM loader accepts. So the first time a Session
 * notice is needed, the pinned packages are bundled in memory by esbuild —
 * already installed on every box, it is what runs the relay's TypeScript
 * (tsx) — into one ES module, which is imported from a data: URL. Nothing is
 * written to disk and nothing is downloaded: the bundle is built only from
 * the packages in node_modules, at the versions package-lock.json pins.
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { Session as SessionClass } from '@session.js/client';

export interface SessionLib {
	readonly Session: typeof SessionClass;
	readonly generateSeedHex: () => string;
	readonly getKeysFromSeed: (seedHex: string) => { x25519: { publicKey: Uint8Array } };
	readonly encodeMnemonic: (seedHex: string) => string;
	readonly RequestType: Record<'Store' | 'GetSnodes' | 'GetSwarms', string>;
	readonly SessionFetchError: new (o: { code: string; message: string }) => Error;
	readonly SessionFetchErrorCode: Record<string, string>;
}

const ENTRY = `
export { Session } from '@session.js/client';
export { generateSeedHex, getKeysFromSeed } from '@session.js/keypair';
export { encode as encodeMnemonic } from '@session.js/mnemonic';
export { RequestType } from '@session.js/types/network/request';
export { SessionFetchError, SessionFetchErrorCode } from '@session.js/errors';
`;

let loading: Promise<SessionLib> | null = null;

/** The part of esbuild's API used here (its own types are not imported: the
 *  esbuild that npm hoists to the top of node_modules is another workspace's,
 *  at another version). */
interface Esbuild {
	build(options: Record<string, unknown>): Promise<{ outputFiles: Array<{ text: string }> }>;
}

/** esbuild, from tsx's own dependency — tsx is the relay's declared
 *  dependency and declares esbuild, so this works whatever npm hoists, and
 *  it is always the esbuild that runs the relay. Never a bare
 *  require('esbuild'): that would take whichever copy was hoisted. */
function loadEsbuild(): Esbuild {
	const req = createRequire(import.meta.url);
	return req(
		req.resolve('esbuild', { paths: [dirname(req.resolve('tsx/package.json'))] })
	) as Esbuild;
}

export function loadSessionLib(): Promise<SessionLib> {
	loading ??= (async () => {
		const esbuild = loadEsbuild();
		const result = await esbuild.build({
			stdin: {
				contents: ENTRY,
				resolveDir: dirname(new URL(import.meta.url).pathname),
				loader: 'js'
			},
			bundle: true,
			platform: 'node',
			format: 'esm',
			target: 'node22',
			write: false,
			logLevel: 'silent',
			// Node's own modules stay imports; everything else is in the bundle.
			external: ['node:*'],
			// CommonJS parts that call require() get a real one.
			banner: {
				js: `import { createRequire as __mcr } from 'node:module'; const require = __mcr(${JSON.stringify(import.meta.url)});`
			}
		});
		const code = result.outputFiles[0]!.text;
		return (await import(
			`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`
		)) as SessionLib;
	})();
	loading.catch(() => {
		loading = null;
	});
	return loading;
}
