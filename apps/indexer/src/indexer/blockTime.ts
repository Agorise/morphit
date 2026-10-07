/**
 * A Blurt block's timestamp as an instant.
 *
 * Blurt serves "2026-11-01T00:00:00" — no zone, meaning UTC. `new Date()` reads
 * a zone-less date-time as LOCAL time, so on a server whose clock zone is not
 * UTC every block time would be off by the zone offset, and with it every rule
 * gated on the consensus activation time (consensusActivation.ts): such a node
 * would switch to the new rules hours early or late and disagree with the rest.
 *
 * No imports, so a test can load it in a child process with another TZ.
 */
export function blockTimeOf(timestamp: string): Date {
	return new Date(timestamp + (timestamp.endsWith('Z') ? '' : 'Z'));
}
