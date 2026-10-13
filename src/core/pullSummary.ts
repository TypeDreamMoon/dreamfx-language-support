import { PullResult } from './bridgeProtocol';

/**
 * One line saying what a pull found, for the notification that closes it.
 *
 * The leading clause is the outcome; what follows is everything the pull *saw but did not write*,
 * because that is what an author who expected a value to move needs to hear. A pull that quietly
 * skipped a value because the text was newer than the asset looks, from the outside, exactly like a
 * pull that found nothing -- so the skips are always named, never folded into a green "up to date".
 *
 * @param structureEnabled whether the request asked for structural edits; it decides whether a
 *        refused structural difference is advice ("turn the setting on") or a plain count.
 */
export function describePull(pull: PullResult, structureEnabled: boolean): string {
	const parts: string[] = [];

	if (pull.changed) {
		const edits = `${pull.edits} edit${pull.edits === 1 ? '' : 's'}`;
		const detail: string[] = [];
		if (pull.changedValues > 0) {
			detail.push(`${pull.changedValues} value${pull.changedValues === 1 ? '' : 's'} changed`);
		}
		if (pull.added > 0) {
			detail.push(`${pull.added} added`);
		}
		if (pull.removed > 0) {
			detail.push(`${pull.removed} removed`);
		}
		parts.push(detail.length > 0 ? `${edits} (${detail.join(', ')})` : edits);
	} else {
		parts.push(pull.compared > 0
			? `The text already matches the asset (${pull.compared} compared)`
			: 'The text already matches the asset');
	}

	if (pull.withheld > 0) {
		parts.push(`${pull.withheld} left alone because the text is newer than the asset`);
	}
	if (pull.undeclared > 0) {
		parts.push(`${pull.undeclared} asset value${pull.undeclared === 1 ? '' : 's'} the text does not declare`);
	}
	if (pull.unwritable > 0) {
		parts.push(`${pull.unwritable} not writable as a literal`);
	}
	if (pull.unaddressable > 0) {
		parts.push(`${pull.unaddressable} stack${pull.unaddressable === 1 ? '' : 's'} could not be addressed`);
	}
	if (pull.structureRefused > 0) {
		parts.push(structureEnabled
			? `${pull.structureRefused} structural difference${pull.structureRefused === 1 ? '' : 's'} not applied`
			: `${pull.structureRefused} structural difference${pull.structureRefused === 1 ? '' : 's'} found; `
				+ 'turn on dreamfx.pull.structuralEdits to pull them');
	}

	return parts.join('; ') + '.';
}
