// Preloaded (node --import) into a script run by an integration test:
//   - TEST_SEARCH_PATH: every pg connection uses that schema (the test's
//     isolated fixture), since the script's pool sets its own session options;
//   - TEST_DNS_LOG: every system-resolver lookup is appended to that file.
import { appendFileSync } from 'node:fs';
import dns from 'node:dns';
import { createRequire } from 'node:module';

const logFile = process.env.TEST_DNS_LOG;
if (logFile) {
	const orig = dns.lookup;
	dns.lookup = function (host, ...rest) {
		appendFileSync(logFile, `${host}\n`);
		return orig.call(this, host, ...rest);
	};
	const origP = dns.promises.lookup;
	dns.promises.lookup = function (host, ...rest) {
		appendFileSync(logFile, `${host}\n`);
		return origP.call(this, host, ...rest);
	};
}

const sp = process.env.TEST_SEARCH_PATH;
if (sp) {
	const pg = createRequire(import.meta.url)('pg');
	const orig = pg.Client.prototype.connect;
	pg.Client.prototype.connect = function (cb) {
		const set = `SET search_path TO "${sp.replace(/"/g, '')}"`;
		if (typeof cb !== 'function')
			return orig
				.call(this)
				.then(() => this.query(set))
				.then(() => undefined);
		return orig.call(this, (err) => {
			if (err) return cb(err);
			this.query(set, (e) => cb(e ?? undefined));
		});
	};
}
