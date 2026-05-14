/**
 * Daily INFO-tier digest scheduler.
 *
 * INFO-tier alerts (RECOVERED events, normal backup successes,
 * federation discovery, signup-count summaries) pile into the
 * state DB throughout the day.  Once per UTC day at the
 * configured time we drain the queue, format a single Matrix
 * message, and DM it to the operator.
 *
 * Why a fixed UTC time: operators have varying timezones, but
 * UTC 09:00 is "Asia evening / Europe morning / America night"
 * — touches at least one waking timezone for most ops teams.
 * Operator can tune via MORPHIT_MATRIX_BOT_DIGEST_SEND_TIME_UTC.
 */

import type { State } from './state.ts';
import type { RateLimiter } from './rateLimit.ts';
import type { StructuredAlert } from './classifier.ts';

export interface DigestSchedulerOptions {
	readonly sendTimeUtc: string; // "HH:MM"
	readonly state: State;
	readonly rateLimiter: RateLimiter;
	readonly onDigest: (body: { plain: string; html: string }) => Promise<void>;
}

/** Start the scheduler.  Returns a stop function. */
export function startDigestScheduler(opts: DigestSchedulerOptions): () => void {
	const [hourStr, minuteStr] = opts.sendTimeUtc.split(':');
	const hour = Number(hourStr);
	const minute = Number(minuteStr);

	let timer: NodeJS.Timeout | null = null;
	let stopped = false;

	function msUntilNextFire(): number {
		const now = new Date();
		const next = new Date(
			Date.UTC(
				now.getUTCFullYear(),
				now.getUTCMonth(),
				now.getUTCDate(),
				hour,
				minute,
				0,
				0
			)
		);
		if (next.getTime() <= now.getTime()) {
			next.setUTCDate(next.getUTCDate() + 1);
		}
		return next.getTime() - now.getTime();
	}

	function schedule(): void {
		if (stopped) return;
		const ms = msUntilNextFire();
		timer = setTimeout(async () => {
			try {
				await fire();
			} catch (err) {
				console.error('digest send failed:', err);
			}
			schedule();
		}, ms);
		// Allow process exit even with pending digest timer
		// (graceful shutdown).
		timer.unref();
	}

	async function fire(): Promise<void> {
		const events = opts.state.drainInfoEvents();
		// Prune state DB rows older than 30 days at each fire.
		opts.state.pruneOlderThan(Date.now() - 30 * 24 * 60 * 60 * 1000);
		if (events.length === 0) {
			// Skip the digest entirely on quiet days.  No news =
			// no message.  Avoids "you got 1 digest with no events"
			// pseudo-spam.
			return;
		}
		const body = buildDigestBody(events, opts);
		await opts.onDigest(body);
	}

	schedule();

	return () => {
		stopped = true;
		if (timer !== null) clearTimeout(timer);
	};
}

/** Format the accumulated INFO events plus WARN-suppression
 *  summary into a single Matrix message. */
export function buildDigestBody(
	events: ReadonlyArray<StructuredAlert>,
	_opts: DigestSchedulerOptions
): { plain: string; html: string } {
	// Group by category for readability.
	const byCategory = new Map<string, StructuredAlert[]>();
	for (const e of events) {
		const cat = `${e.module}:${e.event}`;
		const arr = byCategory.get(cat) ?? [];
		arr.push(e);
		byCategory.set(cat, arr);
	}
	const sortedCategories = [...byCategory.entries()].sort(([a], [b]) =>
		a.localeCompare(b)
	);

	const dateStr = new Date().toISOString().slice(0, 10);
	const plainLines = [
		`📊 morphit daily digest — ${dateStr} (UTC)`,
		`Total INFO events: ${events.length}`,
		''
	];
	const htmlLines = [
		`<strong>📊 morphit daily digest — ${dateStr} (UTC)</strong>`,
		`<br/>Total INFO events: ${events.length}`,
		'<br/><br/>'
	];

	for (const [cat, list] of sortedCategories) {
		plainLines.push(`  ${cat}: ${list.length}`);
		htmlLines.push(`<br/><code>${cat}</code>: ${list.length}`);
	}

	return {
		plain: plainLines.join('\n'),
		html: htmlLines.join('')
	};
}
