import { describe, expect, it, vi, afterEach } from 'vitest';
import { scrollToLazySection } from './scrollToLazySection';

/**
 * No jsdom in this workspace, so stub the two globals the helper touches.
 * That's actually the point of the test: it must not depend on a real DOM,
 * only on `document.getElementById` and `requestAnimationFrame`.
 */
function setup(opts: { elementAppearsAfterFrames?: number } = {}) {
	const queue: Array<() => void> = [];
	const scrollIntoView = vi.fn();
	let framesRun = 0;
	const appearAfter = opts.elementAppearsAfterFrames ?? 0;

	vi.stubGlobal('window', {});
	vi.stubGlobal('document', {
		getElementById: (_id: string) => (framesRun >= appearAfter ? { scrollIntoView } : null)
	});
	vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
		queue.push(cb);
		return queue.length;
	});

	return {
		scrollIntoView,
		flush(n: number) {
			for (let i = 0; i < n; i++) {
				const cb = queue.shift();
				if (!cb) return;
				framesRun++;
				cb();
			}
		}
	};
}

/** Let the helper's awaits (chunk + tick) settle. */
const settle = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

afterEach(() => vi.unstubAllGlobals());

describe('scrollToLazySection', () => {
	it('scrolls once the chunk has loaded and the element exists', async () => {
		const h = setup();
		const p = scrollToLazySection('feedback-form-abc', async () => undefined);
		await settle();
		h.flush(1);
		await expect(p).resolves.toBe(true);
		expect(h.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
	});

	// THE BUG: a cold chunk takes longer than the old 40-frame budget, so the
	// element never existed while anyone was still looking for it.
	it('waits for a slow chunk instead of giving up after a few frames', async () => {
		const h = setup();
		let resolveChunk!: () => void;
		const chunk = new Promise<void>((r) => (resolveChunk = r));

		const p = scrollToLazySection('late-form', () => chunk);
		h.flush(100); // 100 frames pass while the chunk downloads: nothing scheduled yet
		expect(h.scrollIntoView).not.toHaveBeenCalled();

		resolveChunk();
		await settle();
		h.flush(1);
		await expect(p).resolves.toBe(true);
		expect(h.scrollIntoView).toHaveBeenCalledOnce();
	});

	it('retries across frames until the element mounts', async () => {
		const h = setup({ elementAppearsAfterFrames: 3 });
		const p = scrollToLazySection('slow-mount', async () => undefined);
		await settle();
		h.flush(4);
		await expect(p).resolves.toBe(true);
		expect(h.scrollIntoView).toHaveBeenCalledOnce();
	});

	it('gives up on a WALL-CLOCK deadline, not a frame count', async () => {
		const h = setup({ elementAppearsAfterFrames: 999 });
		let t = 0;
		const p = scrollToLazySection('never-appears', async () => undefined, {
			now: () => t,
			budgetMs: 100
		});
		await settle();
		h.flush(1); // t=0 < 100 → schedules another frame
		t = 101; // deadline passes (rAF is throttled in background tabs; frames are not time)
		h.flush(1);
		await expect(p).resolves.toBe(false);
	});

	it('a failed chunk import resolves false rather than spinning forever', async () => {
		setup();
		await expect(
			scrollToLazySection('x', async () => {
				throw new Error('network');
			})
		).resolves.toBe(false);
	});

	it('is a no-op without a DOM (SSR)', async () => {
		vi.stubGlobal('window', undefined);
		await expect(scrollToLazySection('x', async () => undefined)).resolves.toBe(false);
	});
});
