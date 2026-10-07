/** Minimal per-client token bucket.  No deps.  Refills `perMin`
 *  tokens/minute up to a burst ceiling of `perMin`, keyed by a client
 *  identifier (the client's address — see clientKey.ts).
 *
 *  Privacy: the key lives only in this in-memory map, never on disk and never
 *  in a log line.  A bucket is full again 60 s after its client's last
 *  request, and a full bucket behaves exactly like no entry, so an entry idle
 *  that long is dropped: a sweep runs every minute on a timer (unref'd, so it
 *  never keeps the process alive), and on demand past 4096 entries.  An
 *  address is therefore held for at most about two minutes after its last
 *  request.  (The sweep used to run only past 4096 entries, so on a normal
 *  instance every address stayed in memory until a restart.) */
export class RateLimiter {
	private buckets = new Map<string, { tokens: number; last: number }>();
	private readonly timer: ReturnType<typeof setInterval>;
	constructor(private readonly perMin: number) {
		this.timer = setInterval(() => this.sweep(Date.now()), 60_000);
		this.timer.unref?.();
	}
	/** Take `n` tokens for `key` (one per JSON-RPC message): all of them, or
	 *  none and false. */
	take(key: string, n = 1): boolean {
		const now = Date.now();
		const refillPerMs = this.perMin / 60_000;
		let b = this.buckets.get(key);
		if (!b) {
			b = { tokens: this.perMin, last: now };
			this.buckets.set(key, b);
		}
		b.tokens = Math.min(this.perMin, b.tokens + (now - b.last) * refillPerMs);
		b.last = now;
		if (this.buckets.size > 4096) this.sweep(now);
		if (b.tokens < n) return false;
		b.tokens -= n;
		return true;
	}
	/** How many client keys are held (for tests). */
	size(): number {
		return this.buckets.size;
	}
	/** Stop the sweep timer (for tests and shutdown). */
	close(): void {
		clearInterval(this.timer);
	}
	private sweep(now: number): void {
		for (const [k, v] of this.buckets) if (now - v.last >= 60_000) this.buckets.delete(k);
	}
}
