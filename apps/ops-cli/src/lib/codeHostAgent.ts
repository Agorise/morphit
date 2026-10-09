/**
 * A connection pool for asking the code host (git.agorise.net, or a mirror)
 * whose connect limit matches the caller's own wait.
 *
 * WHY. Node's fetch gives up on any connection (TCP plus TLS) after 10 s,
 * whatever wait the caller set. 2026-10-08, morphit.io: three curls to
 * git.agorise.net connected in 0.9 s, 0.05 s and 8.7 s, and the menu's check
 * with a 30 s limit "got no answer after 20.6 s": two 10 s connect failures. The
 * upgrade's own release lookup (30 s) and its download hit the same 10 s
 * ceiling on such a path.
 *
 * The hidden-upgrade transport passes its own undici Agent to fetch the same
 * way (init/hiddenUpgradeTransport.ts). The caller closes the agent when done.
 */
import { Agent } from 'undici';

export function codeHostAgent(connectTimeoutMs: number): Agent {
	return new Agent({ connect: { timeout: connectTimeoutMs } });
}

/** Close it without waiting on anything that can no longer matter. */
export function closeQuietly(agent: Agent): void {
	agent.destroy().catch(() => undefined);
}
