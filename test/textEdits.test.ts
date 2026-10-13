import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PullEdit, applyTextEdits, matchLineEndings, planTextEdits, rebaseEdits } from '../src/core/textEdits';

/** Plans, applies, and checks the one property everything else rests on. */
function plan(oldText: string, newText: string): PullEdit[] {
	const edits = planTextEdits(oldText, newText);
	assert.equal(applyTextEdits(oldText, edits), newText, 'applying the edits must give the new text exactly');
	for (let index = 0; index < edits.length; index += 1) {
		assert.ok(edits[index].start <= edits[index].end);
		if (index > 0) {
			assert.ok(edits[index - 1].end <= edits[index].start, 'edits must be ascending and disjoint');
		}
	}
	return edits;
}

/** What each edit replaces, to assert that only the intended bytes are in play. */
function replaced(oldText: string, edits: readonly PullEdit[]): string[] {
	return edits.map((edit) => oldText.slice(edit.start, edit.end));
}

const SOURCE = [
	'System NS_Spark {',
	'\t// how fast it spins',
	'\tSpeed = 1.0; // tuned by hand',
	'\tLifetime = 2.5;',
	'\tColor = (R=1.0, G=0.5, B=0.25);',
	'}',
	'',
].join('\n');

test('identical texts need no edits', () => {
	assert.deepEqual(plan(SOURCE, SOURCE), []);
	assert.deepEqual(plan('', ''), []);
});

test('a changed value is an edit of just the value, and its trailing comment is untouched', () => {
	const next = SOURCE.replace('Speed = 1.0;', 'Speed = 4.0;');
	const edits = plan(SOURCE, next);
	assert.equal(edits.length, 1);
	assert.deepEqual(replaced(SOURCE, edits), ['1']);
	assert.equal(edits[0].newText, '4');
	assert.ok(applyTextEdits(SOURCE, edits).includes('// tuned by hand'));
});

test('a longer value grows the edit by exactly the difference', () => {
	const next = SOURCE.replace('Lifetime = 2.5;', 'Lifetime = 2.5000001;');
	const edits = plan(SOURCE, next);
	assert.equal(edits.length, 1);
	assert.deepEqual(replaced(SOURCE, edits), ['']);
	assert.equal(edits[0].newText, '000001');
});

test('values on neighbouring lines are separate edits, with the unchanged text between them left alone', () => {
	const next = SOURCE.replace('Speed = 1.0;', 'Speed = 9.0;').replace('Lifetime = 2.5;', 'Lifetime = 7.5;');
	const edits = plan(SOURCE, next);
	assert.equal(edits.length, 2);
	assert.deepEqual(replaced(SOURCE, edits), ['1', '2']);
});

test('several distant changes are several edits', () => {
	const next = SOURCE
		.replace('System NS_Spark', 'System NS_Sparks')
		.replace('Color = (R=1.0,', 'Color = (R=0.0,')
		.replace('B=0.25', 'B=0.75');
	const edits = plan(SOURCE, next);
	// The colour's two components are on one line, so they are one edit between them.
	assert.equal(edits.length, 2);
	assert.equal(edits[0].newText, 's');
	assert.equal(edits[0].end, edits[0].start);
});

test('CRLF files keep their line endings: an unchanged line is never in an edit', () => {
	const crlf = SOURCE.replace(/\n/g, '\r\n');
	const next = crlf.replace('Speed = 1.0;', 'Speed = 4.0;');
	const edits = plan(crlf, next);
	assert.equal(edits.length, 1);
	assert.deepEqual(replaced(crlf, edits), ['1']);
	for (const edit of edits) {
		assert.ok(!edit.newText.includes('\n') && !edit.newText.includes('\r'));
	}
});

test('a changed value on a CRLF file does not swallow the line break after it', () => {
	const crlf = 'A = 1; // note\r\nB = 2;\r\n';
	const edits = plan(crlf, 'A = 5; // note\r\nB = 2;\r\n');
	assert.deepEqual(replaced(crlf, edits), ['1']);
});

test('a file whose last line has no terminator', () => {
	const edits = plan('A = 1;\nB = 2;', 'A = 1;\nB = 3;');
	assert.deepEqual(replaced('A = 1;\nB = 2;', edits), ['2']);
	plan('A = 1;', 'A = 1;\nB = 2;');
	plan('A = 1;\nB = 2;', 'A = 1;');
});

test('a whole new line is a pure insertion at the start of the line after it', () => {
	const next = SOURCE.replace('\tLifetime = 2.5;\n', '\tLifetime = 2.5;\n\tSize = 3.0;\n');
	const edits = plan(SOURCE, next);
	assert.equal(edits.length, 1);
	assert.equal(edits[0].start, edits[0].end);
	assert.equal(edits[0].newText, '\tSize = 3.0;\n');
	assert.equal(SOURCE.slice(edits[0].start - 1, edits[0].start), '\n', 'inserted on a line boundary');
});

test('a removed line is a pure deletion of exactly that line, terminator included', () => {
	const next = SOURCE.replace('\tLifetime = 2.5;\n', '');
	const edits = plan(SOURCE, next);
	assert.equal(edits.length, 1);
	assert.deepEqual(replaced(SOURCE, edits), ['\tLifetime = 2.5;\n']);
	assert.equal(edits[0].newText, '');
});

test('insertion and removal together, as a structural pull produces them', () => {
	const next = SOURCE
		.replace('\t// how fast it spins\n', '')
		.replace('\tLifetime = 2.5;\n', '\tLifetime = 2.5;\n\tSize = 3.0;\n\tSpin = 0.5;\n')
		.replace('Speed = 1.0;', 'Speed = 2.0;');
	const edits = plan(SOURCE, next);
	// The removed comment and the changed Speed line are neighbours, so they form one hunk.
	assert.equal(edits.length, 2);
	assert.ok(applyTextEdits(SOURCE, edits).includes('// tuned by hand'));
});

test('a line replaced by two lines is exact', () => {
	const edits = plan('A = 1;\nB = 2;\nC = 3;\n', 'A = 1;\nB = 2;\nB2 = 2;\nB3 = 2;\nC = 3;\n');
	assert.ok(edits.length >= 1);
});

test('repeated lines are matched in order', () => {
	const old = 'X = 1;\nX = 1;\nX = 1;\nX = 1;\n';
	const next = 'X = 1;\nX = 2;\nX = 1;\nX = 1;\n';
	const edits = plan(old, next);
	assert.equal(edits.length, 1);
	assert.deepEqual(replaced(old, edits), ['1']);
});

test('from nothing, and to nothing', () => {
	assert.equal(plan('', 'A = 1;\n').length, 1);
	assert.equal(plan('A = 1;\n', '').length, 1);
});

test('an edit never splits a surrogate pair', () => {
	const old = 'Name = "a\u{1F600}b";\n';
	const next = 'Name = "a\u{1F601}b";\n';
	const edits = plan(old, next);
	assert.equal(edits.length, 1);
	assert.equal(replaced(old, edits)[0], '\u{1F600}');
});

test('a very different text still produces exact edits', () => {
	const old = Array.from({ length: 300 }, (_, index) => `A${index} = ${index};`).join('\n') + '\n';
	const next = Array.from({ length: 300 }, (_, index) => `B${index} = ${index * 2};`).join('\n') + '\n';
	plan(old, next);
});

test('a long file with two small changes far apart is two small edits', () => {
	const lines = Array.from({ length: 5000 }, (_, index) => `Value${index} = ${index}.0; // keep`);
	const old = lines.join('\n') + '\n';
	const changed = [...lines];
	changed[10] = 'Value10 = 99.0; // keep';
	changed[4900] = 'Value4900 = 77.0; // keep';
	const edits = plan(old, changed.join('\n') + '\n');
	assert.equal(edits.length, 2);
	for (const edit of edits) {
		assert.ok(edit.end - edit.start < 8);
	}
});

test('random edits always round-trip', () => {
	// Fixed seed: a failure here has to be reproducible, not a flake someone reruns until green.
	let seed = 12345;
	const random = (): number => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 0x100000000;
	};
	const words = ['A', 'B', 'C', 'Speed = 1.0;', '// c', '', '\t}', 'x = (1, 2);', 'é\u{1F600}'];

	for (let round = 0; round < 400; round += 1) {
		const eol = random() < 0.5 ? '\n' : '\r\n';
		const make = (): string[] => Array.from({ length: Math.floor(random() * 12) }, () => words[Math.floor(random() * words.length)]);
		const base = make();
		const mutated = base.map((line) => (random() < 0.2 ? line + String(Math.floor(random() * 3)) : line));
		for (let insertion = Math.floor(random() * 3); insertion > 0; insertion -= 1) {
			mutated.splice(Math.floor(random() * (mutated.length + 1)), 0, words[Math.floor(random() * words.length)]);
		}
		for (let removal = Math.floor(random() * 3); removal > 0 && mutated.length > 0; removal -= 1) {
			mutated.splice(Math.floor(random() * mutated.length), 1);
		}
		const trailing = random() < 0.5 ? eol : '';
		plan(base.join(eol) + trailing, mutated.join(eol) + trailing);
	}
});

// ---------------------------------------------------------------- line endings

test('text is given the reference line endings when the reference is uniform', () => {
	assert.equal(matchLineEndings('a\r\nb\r\n', 'a\nb\nc\n'), 'a\r\nb\r\nc\r\n');
	assert.equal(matchLineEndings('a\nb\n', 'a\r\nb\r\n'), 'a\nb\n');
	assert.equal(matchLineEndings('a\r\nb\r\n', 'a\r\nb\r\n'), 'a\r\nb\r\n', 'already matching is left alone');
});

test('mixed or absent line endings in the reference leave the text as received', () => {
	assert.equal(matchLineEndings('a\r\nb\n', 'a\r\nb\nc\n'), 'a\r\nb\nc\n');
	assert.equal(matchLineEndings('single line', 'x\r\ny'), 'x\r\ny');
});

test('normalising the line endings first makes an ending-only difference vanish', () => {
	const old = 'A = 1;\r\nB = 2;\r\n';
	assert.deepEqual(planTextEdits(old, matchLineEndings(old, 'A = 1;\nB = 2;\n')), []);
});

// ---------------------------------------------------------------- rebasing

test('edits move past changes that happened before them', () => {
	const old = 'AAAA\nBBBB\nCCCC\n';
	const edits = plan(old, 'AAAA\nBBBB\nCxCC\n');
	// The author typed two characters at the top while the request was in flight.
	const rebased = rebaseEdits(edits, [[{ start: 0, end: 0, text: '//' }]]);
	assert.ok(rebased);
	assert.equal(applyTextEdits('//' + old, rebased), '//AAAA\nBBBB\nCxCC\n');
});

test('edits stay put when the change is after them', () => {
	const old = 'AAAA\nBBBB\n';
	const edits = plan(old, 'AxAA\nBBBB\n');
	const rebased = rebaseEdits(edits, [[{ start: old.length, end: old.length, text: 'tail' }]]);
	assert.deepEqual(rebased, edits);
});

test('a change that overlaps an edit refuses the rebase', () => {
	const old = 'AAAA\nBBBB\n';
	const edits = plan(old, 'AAAA\nBxBB\n');
	assert.equal(rebaseEdits(edits, [[{ start: 6, end: 8, text: 'zz' }]]), undefined);
});

test('two insertions at the same point refuse the rebase rather than pick an order', () => {
	const old = 'A\nB\n';
	const edits = plan(old, 'A\nNew\nB\n');
	assert.equal(rebaseEdits(edits, [[{ start: 2, end: 2, text: 'mine\n' }]]), undefined);
});

test('batches apply in order, each expressed in the text before it', () => {
	const old = 'AAAA\nBBBB\n';
	const edits = plan(old, 'AAAA\nBxBB\n');
	const first = [{ start: 0, end: 0, text: '12345' }];
	const second = [{ start: 0, end: 5, text: '' }, { start: old.length + 5, end: old.length + 5, text: '!' }];
	const rebased = rebaseEdits(edits, [first, second]);
	assert.ok(rebased);
	assert.equal(applyTextEdits(old + '!', rebased), 'AAAA\nBxBB\n!');
});

test('no changes rebases to the same edits', () => {
	const edits = plan('A = 1;\n', 'A = 2;\n');
	assert.deepEqual(rebaseEdits(edits, []), edits);
});
