/**
 * One job at a time, deduplicated, with a queue behind it.
 *
 * Pulled out of the verify runner and put here so it can be tested without VSCode, because this is
 * the part that is silently wrong when it is wrong. Every job it runs boots the Unreal Editor --
 * tens of seconds, several gigabytes -- so "two ran at once" is not a slowdown, it is the failure
 * the design exists to prevent, and it would show up as a machine grinding rather than as an error.
 *
 * Deduplicating by key rather than queueing every request: saving the same file five times in a row
 * is one thing to check, not five.
 */
export class WorkQueue<T> {
	private readonly pending = new Map<string, T>();
	private running = false;
	private idleWaiters: Array<() => void> = [];

	constructor(
		private readonly key: (item: T) => string,
		private readonly run: (item: T) => Promise<void>,
	) {}

	get size(): number {
		return this.pending.size;
	}

	get busy(): boolean {
		return this.running;
	}

	/**
	 * Queues an item, replacing any queued item with the same key.
	 *
	 * The *newer* item wins, which matters when the payload carries state: a save that lands while
	 * an earlier one is still queued describes the file better than the one it replaces.
	 */
	add(item: T): void {
		this.pending.set(this.key(item), item);
	}

	/** Starts draining if nothing is already draining. Safe to call at any time. */
	pump(): void {
		if (this.running) {
			return;
		}
		void this.drainLoop();
	}

	/** Resolves when the queue is empty and nothing is running. */
	whenIdle(): Promise<void> {
		if (!this.running && this.pending.size === 0) {
			return Promise.resolve();
		}
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	private async drainLoop(): Promise<void> {
		this.running = true;
		try {
			for (;;) {
				const next = this.pending.keys().next();
				if (next.done) {
					break;
				}
				const item = this.pending.get(next.value)!;
				this.pending.delete(next.value);

				// A job that throws must not stop the queue: the next file still deserves checking,
				// and the runner reports its own failures.
				try {
					await this.run(item);
				} catch {
					// Deliberately swallowed here; see above.
				}
			}
		} finally {
			this.running = false;
			const waiters = this.idleWaiters;
			this.idleWaiters = [];
			for (const resolve of waiters) {
				resolve();
			}
		}
	}
}
