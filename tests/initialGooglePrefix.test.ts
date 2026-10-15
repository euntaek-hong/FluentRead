import {describe, expect, it, vi} from 'vitest';
import {parseHTML} from 'linkedom';
import {createInitialGooglePrefix} from '@/src/features/full-page-translation/content/initialGooglePrefix';
import type {FullPageSession, PreparedCandidate} from '@/src/features/full-page-translation/content/sessionTypes';
import type {TranslationCandidate} from '@/src/core/translation/public';

function fixture() {
    const {document} = parseHTML('<html><body></body></html>');
    let resolve!: (value: string[]) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<string[]>((yes, no) => {resolve = yes; reject = no;});
    const session = {viewportCommitDiscoveryReady: false, scrollController: {isScrolling: false}, modal: null,
        preparedCandidates: new Map(), scheduled: new Map(), requestControllers: new Set()} as unknown as FullPageSession;
    const entries: PreparedCandidate[] = [];
    const eligible = vi.fn(() => true);
    const release = vi.fn((current: FullPageSession, key: Node, entry: PreparedCandidate) => {
        if (current.preparedCandidates.get(key) === entry) current.preparedCandidates.delete(key);
    });
    const prepare = vi.fn((current: FullPageSession, candidate: TranslationCandidate) => {
        const source = candidate.element.textContent!;
        const entry: PreparedCandidate = {candidate, source, controller: new AbortController(), origins: [source],
            nativeGooglePrimeProof: {origins: [source], invocationIdentity: 'test'},
            slots: 1, escapedCharacters: 100, settled: false, consumed: false};
        entries.push(entry);
        current.preparedCandidates.set(candidate.element, entry);
    });
    const cancel = vi.fn((current: FullPageSession, candidate: TranslationCandidate) => {
        const entry = current.preparedCandidates.get(candidate.element)!;
        current.preparedCandidates.delete(candidate.element);
        entry.controller.abort();
    });
    const prime = vi.fn((_session: FullPageSession, _origins: string[], _signal: AbortSignal) => response);
    const visible = vi.fn(() => true);
    const prefix = createInitialGooglePrefix({eligible, visible, prepare, release, cancel, prime});
    const candidate = (text: string): TranslationCandidate => {
        const element = document.createElement('p'); element.textContent = text;
        const result = {element, kind: 'content', reason: 'test', scope: 'all'} as TranslationCandidate;
        session.scheduled.set(element, result);
        return result;
    };
    return {session, prefix, candidate, prepare, cancel, prime, release, entries, resolve, reject, eligible, visible};
}

describe('initial bounded Google prefix', () => {
    it.each(['ineligible', 'sealed', 'scrolling', 'modal', 'invisible'] as const)('does not prepare a prefix when %s', reason => {
        const test = fixture();
        if (reason === 'ineligible') test.eligible.mockReturnValue(false);
        if (reason === 'sealed') test.session.viewportCommitDiscoveryReady = true;
        if (reason === 'scrolling') Object.assign(test.session.scrollController, {isScrolling: true});
        if (reason === 'modal') test.session.modal = {} as NonNullable<FullPageSession['modal']>;
        if (reason === 'invisible') test.visible.mockReturnValue(false);
        test.prefix.prepare(test.session, test.candidate('Ignored'));
        test.prefix.start(test.session);
        expect(test.prepare).not.toHaveBeenCalled();
        expect(test.prime).not.toHaveBeenCalled();
    });

    it('deduplicates preparation and ignores candidates rejected by the existing preparation gate', () => {
        const test = fixture();
        test.prepare.mockImplementationOnce(() => undefined);
        test.prefix.prepare(test.session, test.candidate('Rejected'));
        const accepted = test.candidate('Accepted');
        test.prefix.prepare(test.session, accepted);
        test.prefix.prepare(test.session, accepted);
        expect(test.prepare).toHaveBeenCalledTimes(2);
    });

    it.each([10_000, 10_001])('keeps the escaped character boundary at %s', async characters => {
        const test = fixture();
        const original = test.prepare.getMockImplementation()!;
        test.prepare.mockImplementation((session, candidate) => {
            original(session, candidate);
            test.entries.at(-1)!.escapedCharacters = characters;
        });
        test.prefix.prepare(test.session, test.candidate('Large paragraph'));
        test.prefix.prepare(test.session, test.candidate('Next paragraph'));
        test.prefix.start(test.session);
        await Promise.resolve();
        if (characters > 10_000) {
            expect(test.cancel).toHaveBeenCalledTimes(2);
            expect(test.prime).not.toHaveBeenCalled();
        } else {
            expect(test.prepare).toHaveBeenCalledOnce();
            expect(test.prime).toHaveBeenCalledOnce();
        }
        test.resolve([]);
    });

    it('rejects a candidate that would overflow text slots after preparation', () => {
        const test = fixture();
        const original = test.prepare.getMockImplementation()!;
        test.prepare.mockImplementation((session, candidate) => {original(session, candidate); test.entries.at(-1)!.slots = 33;});
        test.prefix.prepare(test.session, test.candidate('Many slots'));
        expect(test.cancel).toHaveBeenCalledOnce();
    });

    it.each(['ineligible', 'sealed', 'scrolling', 'modal', 'cancelled', 'replaced'] as const)('does not launch stale prefix work when %s', reason => {
        const test = fixture(); const candidate = test.candidate('Prepared');
        test.prefix.prepare(test.session, candidate);
        if (reason === 'ineligible') test.eligible.mockReturnValue(false);
        if (reason === 'sealed') test.session.viewportCommitDiscoveryReady = true;
        if (reason === 'scrolling') Object.assign(test.session.scrollController, {isScrolling: true});
        if (reason === 'modal') test.session.modal = {} as NonNullable<FullPageSession['modal']>;
        if (reason === 'cancelled') test.entries[0].controller.abort();
        if (reason === 'replaced') test.session.preparedCandidates.delete(candidate.element);
        test.prefix.start(test.session);
        expect(test.prime).not.toHaveBeenCalled();
        expect(test.prefix.isPrimed(test.entries[0])).toBe(false);
    });

    it.each(['consumed', 'replaced'] as const)('releases a completed prefix when its member is %s', async reason => {
        const test = fixture(); const candidate = test.candidate('Prepared');
        test.prefix.prepare(test.session, candidate); test.prefix.start(test.session);
        if (reason === 'consumed') test.entries[0].consumed = true;
        else test.session.scheduled.delete(candidate.element);
        test.resolve(['译文']);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(test.release).toHaveBeenCalledOnce();
    });

    it('registers independent early slots before discovery seals and keeps unconsumed results for later admission', async () => {
        const test = fixture();
        test.prefix.prepare(test.session, test.candidate('First paragraph'));
        test.prefix.prepare(test.session, test.candidate('Second paragraph'));
        test.prefix.start(test.session);
        await Promise.resolve();
        expect(test.prime).toHaveBeenCalledWith(test.session, ['First paragraph', 'Second paragraph'], expect.any(AbortSignal));
        expect(test.session.viewportCommitDiscoveryReady).toBe(false);
        expect(test.prefix.isPrimed(test.entries[0])).toBe(true);
        test.resolve(['甲', '乙']);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(test.entries.every(entry => entry.settled)).toBe(true);
        expect(test.release).not.toHaveBeenCalled();
        expect(test.session.requestControllers.size).toBe(0);
    });

    it('retains a shared request until every member cancels', async () => {
        const test = fixture();
        test.prefix.prepare(test.session, test.candidate('One'));
        test.prefix.prepare(test.session, test.candidate('Two'));
        test.prefix.start(test.session);
        await Promise.resolve();
        const signal = test.prime.mock.calls[0][2] as AbortSignal;
        test.entries[0].controller.abort();
        expect(signal.aborted).toBe(false);
        test.entries[1].controller.abort();
        expect(signal.aborted).toBe(true);
        test.reject(new Error('cancelled'));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(test.release).toHaveBeenCalledTimes(2);
        expect(test.session.requestControllers.size).toBe(0);
    });

    it('limits the prefix to one native packet and does not prepare again after it starts', async () => {
        const test = fixture();
        for (let index = 0; index < 40; index++) test.prefix.prepare(test.session, test.candidate(String(index)));
        expect(test.prepare).toHaveBeenCalledTimes(32);
        test.prefix.start(test.session);
        test.prefix.prepare(test.session, test.candidate('Late'));
        test.prefix.start(test.session);
        await Promise.resolve();
        expect(test.prime).toHaveBeenCalledOnce();
        expect(test.prime.mock.calls[0][1]).toHaveLength(32);
        test.resolve([]);
    });
});
