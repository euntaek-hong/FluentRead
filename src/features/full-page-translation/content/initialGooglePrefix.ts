/**
 * @file src/features/full-page-translation/content/initialGooglePrefix.ts
 * 文件职责：把初始发现中的一个有界 Google 请求与剩余发现重叠，不提前建立或提交译文 DOM。
 * 主要内容：最多登记 32 个独立文本槽与 10000 个 escaped 字符，只启动一次前缀请求；沿用准备条目与会话的身份，保留共享取消、结果消费和精确释放。
 * 模块边界：runtime 注入当前资格、几何及请求操作；本模块不选择候选、不写 DOM，也不改变整个初始视口组必须等待完整发现的契约。
 */
import {getTranslationCandidateKey, type TranslationCandidate} from '@/src/core/translation/public';
import type {FullPageSession, PreparedCandidate} from './sessionTypes';

interface PrefixPorts {
    eligible(session: FullPageSession): boolean;
    visible(element: HTMLElement): boolean;
    prepare(session: FullPageSession, candidate: TranslationCandidate): void;
    cancel(session: FullPageSession, candidate: TranslationCandidate): void;
    release(session: FullPageSession, key: Node, entry: PreparedCandidate): void;
    prime(session: FullPageSession, origins: string[], signal: AbortSignal): Promise<string[]>;
}

export function createInitialGooglePrefix(ports: PrefixPorts) {
    const states = new WeakMap<FullPageSession, {entries: PreparedCandidate[]; started: boolean; slots: number; characters: number}>();
    const primed = new WeakSet<PreparedCandidate>();
    return {
        isPrimed: (entry: PreparedCandidate): boolean => primed.has(entry),
        prepare(session: FullPageSession, candidate: TranslationCandidate): void {
            if (!ports.eligible(session) || session.viewportCommitDiscoveryReady || session.modal || session.scrollController.isScrolling) return;
            let state = states.get(session);
            if (!state) {state = {entries: [], started: false, slots: 0, characters: 0}; states.set(session, state);}
            if (state.started || state.slots >= 32 || state.characters >= 10_000) return;
            const key = getTranslationCandidateKey(candidate);
            if (state.entries.some(entry => entry.candidate === candidate)) return;
            if (!ports.visible(candidate.element)) return;
            ports.prepare(session, candidate);
            const entry = session.preparedCandidates.get(key);
            if (!entry) return;
            if (state.slots + entry.slots > 32 || state.characters + entry.escapedCharacters > 10_000) {
                ports.cancel(session, candidate);
                return;
            }
            state.entries.push(entry);
            state.slots += entry.slots;
            state.characters += entry.escapedCharacters;
        },
        start(session: FullPageSession): void {
            const state = states.get(session);
            if (!state || state.started || session.viewportCommitDiscoveryReady || !ports.eligible(session) || session.modal || session.scrollController.isScrolling) return;
            const entries = state.entries.filter(entry => !entry.controller.signal.aborted &&
                session.preparedCandidates.get(getTranslationCandidateKey(entry.candidate)) === entry);
            if (entries.length === 0) return;
            state.started = true;
            const controller = new AbortController();
            const abortIfEmpty = () => {if (entries.every(entry => entry.controller.signal.aborted)) controller.abort();};
            entries.forEach(entry => {primed.add(entry); entry.controller.signal.addEventListener('abort', abortIfEmpty);});
            session.requestControllers.add(controller);
            const release = () => {
                entries.forEach(entry => entry.controller.signal.removeEventListener('abort', abortIfEmpty));
                session.requestControllers.delete(controller);
            };
            void Promise.resolve().then(() => ports.prime(session, entries.flatMap(entry => [...entry.origins]), controller.signal)).then(
                () => entries.forEach(entry => {
                    entry.settled = true;
                    const key = getTranslationCandidateKey(entry.candidate);
                    if (entry.consumed || session.scheduled.get(key) !== entry.candidate) ports.release(session, key, entry);
                }),
                () => entries.forEach(entry => ports.release(session, getTranslationCandidateKey(entry.candidate), entry)),
            ).then(release, release);
        },
    };
}
