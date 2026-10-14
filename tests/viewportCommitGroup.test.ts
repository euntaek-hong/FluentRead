import {describe, expect, it} from 'vitest';
import {createViewportCommitGroup} from '@/src/features/full-page-translation/content/viewportCommitGroup';
import {isViewportCommitGroupEnabled} from '@/src/features/full-page-translation/content/viewportCommitExperiment';

describe('viewport commit group', () => {
    it('enables the verified viewport policy in the personal fork', () => {
        expect(isViewportCommitGroupEnabled()).toBe(true);
    });
    it('waits for every reserved member and preserves settlement order only in its value list', () => {
        const first = {} as Node;
        const second = {} as Node;
        const commits: string[][] = [];
        const group = createViewportCommitGroup<string>((values) => commits.push([...values]));
        group.reserve(first);
        group.reserve(second);
        group.seal();
        group.settle(second, 'second');
        expect(commits).toEqual([]);
        group.settle(first, 'first');
        expect(commits).toEqual([['second', 'first']]);
    });

    it('lets cancelled members settle the gate without creating a commit entry', () => {
        const first = {} as Node;
        const second = {} as Node;
        const commits: string[][] = [];
        const group = createViewportCommitGroup<string>((values) => commits.push([...values]));
        group.reserve(first);
        group.reserve(second);
        group.seal();
        group.settle(first, 'first');
        group.settle(second);
        expect(commits).toEqual([['first']]);
    });

    it('withdraws a staged member so it cannot reach the eventual commit', () => {
        const first = {} as Node;
        const second = {} as Node;
        const commits: string[][] = [];
        const group = createViewportCommitGroup<string>((values) => commits.push([...values]));
        group.reserve(first);
        group.reserve(second);
        group.seal();
        group.settle(first, 'staged-first');
        group.withdraw(first);
        group.settle(second, 'second');
        expect(commits).toEqual([['second']]);
    });
    it('drops pending work when disposed', () => {
        const node = {} as Node;
        const commits: string[][] = [];
        const group = createViewportCommitGroup<string>((values) => commits.push([...values]));
        group.reserve(node);
        group.dispose();
        group.seal();
        group.settle(node, 'late');
        expect(commits).toEqual([]);
    });

    it('ignores duplicate, unknown and late settlement without a second commit', () => {
        const first = {} as Node;
        const unknown = {} as Node;
        const commits: string[][] = [];
        const group = createViewportCommitGroup<string>((values) => commits.push([...values]));
        group.reserve(first);
        group.settle(unknown, 'unknown');
        group.settle(first, 'first');
        group.seal();
        group.settle(first, 'late');
        group.withdraw(first);
        expect(commits).toEqual([['first']]);
    });
});

