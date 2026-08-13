import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WorkQueue } from '../src/core/workQueue';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('the same item queued repeatedly runs once', () => {
	// Saving a file five times in a row is one thing to check, not five engine boots.
	const ran: string[] = [];
	const queue = new WorkQueue<string>((item) => item, async (item) => { ran.push(item); });

	queue.add('a');
	queue.add('a');
	queue.add('a');
	assert.equal(queue.size, 1);

	queue.pump();
	return queue.whenIdle().then(() => assert.deepEqual(ran, ['a']));
});

test('two jobs never overlap', async () => {
	// This is the rule the whole class exists for: each job boots the Unreal Editor, and two at once
	// is not slowness, it is a machine grinding to a halt.
	let concurrent = 0;
	let peak = 0;
	const queue = new WorkQueue<string>((item) => item, async () => {
		concurrent += 1;
		peak = Math.max(peak, concurrent);
		await tick(5);
		concurrent -= 1;
	});

	for (const item of ['a', 'b', 'c', 'd']) {
		queue.add(item);
	}
	queue.pump();
	await queue.whenIdle();

	assert.equal(peak, 1);
});

test('pumping while a job runs does not start a second drain', async () => {
	let concurrent = 0;
	let peak = 0;
	const queue = new WorkQueue<string>((item) => item, async () => {
		concurrent += 1;
		peak = Math.max(peak, concurrent);
		await tick(5);
		concurrent -= 1;
	});

	queue.add('a');
	queue.pump();
	queue.pump();
	queue.pump();
	await queue.whenIdle();
	assert.equal(peak, 1);
});

test('an item added while a job is running is picked up by the same drain', async () => {
	const ran: string[] = [];
	const queue = new WorkQueue<string>((item) => item, async (item) => {
		ran.push(item);
		if (item === 'a') {
			// The save that lands mid-run: it must not need another pump to be noticed.
			queue.add('b');
		}
		await tick(1);
	});

	queue.add('a');
	queue.pump();
	await queue.whenIdle();

	assert.deepEqual(ran, ['a', 'b']);
});

test('the newer item wins when a key is queued twice', async () => {
	const ran: Array<{ id: string; revision: number }> = [];
	const queue = new WorkQueue<{ id: string; revision: number }>(
		(item) => item.id,
		async (item) => { ran.push(item); });

	queue.add({ id: 'a', revision: 1 });
	queue.add({ id: 'a', revision: 2 });
	queue.pump();
	await queue.whenIdle();

	assert.deepEqual(ran, [{ id: 'a', revision: 2 }]);
});

test('a job that throws does not stop the queue', async () => {
	// The next file still deserves checking, and the runner reports its own failures.
	const ran: string[] = [];
	const queue = new WorkQueue<string>((item) => item, async (item) => {
		ran.push(item);
		if (item === 'a') {
			throw new Error('boom');
		}
	});

	queue.add('a');
	queue.add('b');
	queue.pump();
	await queue.whenIdle();

	assert.deepEqual(ran, ['a', 'b']);
	assert.equal(queue.busy, false);
});

test('whenIdle on an empty queue resolves immediately', async () => {
	const queue = new WorkQueue<string>((item) => item, async () => {});
	await queue.whenIdle();
	assert.equal(queue.size, 0);
	assert.equal(queue.busy, false);
});
