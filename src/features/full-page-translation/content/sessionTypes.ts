/**
 * @file src/features/full-page-translation/content/sessionTypes.ts
 * 文件职责：声明页面翻译会话、独立预准备候选与视口提交票据的共享类型。
 * 主要内容：声明请求会话与可见性队列的组合字段，区分准备候选、提交计划、组成员和取消票据。
 * 模块边界：只导出 TypeScript 类型，不产生运行时状态或浏览器副作用。
 */
import type {TranslationCandidate, TranslationScope, TranslationDiscoveryStep} from "@/src/core/translation/public";
import type {FullPageTranslationMode} from "@/src/core/config/model";
import {createFullPageOutcomeRegistry} from '../core/outcomes';
import {createBilingualRemountCapitulationRegistry} from '@/src/features/full-page-translation/content/bilingualRemount';
import {type FullPageTranslationCacheEntry, type FullPageTranslationConfigSnapshot, type NativeGooglePrimeProof} from '@/src/features/full-page-translation/content/translationRequest';
import {type FullPageScrollController} from '@/src/features/full-page-translation/content/viewportStability';
import {type FullPageQueueState, type FullPageDispatchPlan} from '@/src/features/full-page-translation/content/fullPageQueue';
import {type FullPageLifecycleRetry, type AcceptedUnchangedCompletion} from '@/src/features/full-page-translation/content/translationStability';
import {type FullPageRequestSessionState} from '@/src/features/full-page-translation/content/requestSession';
import {type ModalPrioritySession} from './modalSession';
import {type ViewportCommitGroup} from './viewportCommitGroup';
export type TranslationTargetOutcome =
    | {status: "committed" | "failed" | "owned" | "deferred"}
    | {status: "unchanged"; source: string; attemptNode?: HTMLElement; completion?: AcceptedUnchangedCompletion}
    | {
        status: "stale" | "not-current" | "empty";
        retryRoot?: Node;
        /** 尝试 owner，用于在较新的 generation 接管后拒绝旧重试。 */
        attemptNode?: HTMLElement;
    };
export interface FullPageSession extends FullPageRequestSessionState, ModalPrioritySession, FullPageQueueState {
    translationMode: FullPageTranslationMode;
    scope: TranslationScope;
    /** 会话启动时冻结所有会改变译文或 DOM 表达的配置，防止设置热更新混入当前页面。 */
    translationConfig: FullPageTranslationConfigSnapshot;
    progressSessionId: number;
    progressPublishScheduled: boolean;
    outcomes: ReturnType<typeof createFullPageOutcomeRegistry<HTMLElement>>;
    unsubscribeOutcomeChanges: () => void;
    observer: IntersectionObserver;
    mutationObserver: MutationObserver;
    shadowEventController: AbortController;
    /** 可见性锚点 -> 等待该锚点进入视口的候选。 */
    observedCandidates: Map<HTMLElement, Map<Node, TranslationCandidate>>;
    /** 最近一次 IO 通知为可见的锚点；同锚点迟到的候选需立即入队。 */
    visibleCandidateAnchors: WeakSet<HTMLElement>;
    /** 候选元素 -> 候选 key；与可见性锚点分开保存，便于精确清理。 */
    candidateOwnerKeys: Map<HTMLElement, Set<Node>>;
    /** 宿主 owner/祖先 -> 其下活跃翻译目标，避免 mutation 时全局扫描状态。 */
    statefulTargetsByAncestor: Map<Element, Set<HTMLElement>>;
    /** 活跃目标 -> 上述索引中为它登记的精确祖先 key。 */
    statefulAncestorsByTarget: WeakMap<HTMLElement, readonly Element[]>;
    /** provider 请求在途时失效候选的有界即时重试记录。 */
    lifecycleRetries: WeakMap<Node, FullPageLifecycleRetry>;
    /** 限定在本次全文会话内的 provider/语言“无需变更”判定。 */
    unchangedCandidates: WeakMap<Node, FullPageLifecycleRetry>;
    /**
     * 用户在本次全文会话中显式恢复的候选标识。来源快照允许真实宿主编辑
     * 清除取消墓碑，同时让扩展自身产生的恢复 mutation 继续排除该片段。
     * 按节点弱关联，不因保留取消记录而延长已被宿主删除节点的生命周期。
     */
    userCancelledCandidates: WeakMap<Node, string>;
    /** 用户滚动期间暂停新增翻译/重排，等待虚拟列表稳定后再继续。 */
    scrollController: FullPageScrollController;
    /** 宿主连续拒绝 wrapper 后，对稳定边界内的同源候选停止写 DOM。 */
    bilingualRemountCapitulations: ReturnType<typeof createBilingualRemountCapitulationRegistry>;
    /**
     * 本次全文会话已经请求过的翻译结果。宿主框架可能在样式/布局 mutation 后
     * 重新挂载同一段正文；此缓存避免生命周期抖动再次发出相同 provider 请求。
     */
    translationSlotCache: Map<string, FullPageTranslationCacheEntry>;
    /** 尚未交给 DOM 生命周期消费的 Google viewport 请求预准备。 */
    preparedCandidates: Map<Node, PreparedCandidate>;
    preparedSlots: number;
    preparedEscapedCharacters: number;
    dispatchPlan: FullPageDispatchPlan | null;
    prepareCursor: number;
    prepareTimer: number | null;
    primedGoogleWave: Promise<string[]> | null;
    primedGoogleWaveController: AbortController | null;
    primedGoogleWaveMembers: readonly PreparedCandidate[] | null;
    /** 初始发现越过近视口边界前，不能用零星 IO 回调提交 Google wave。 */
    googleInitialWaveDiscoveryReady: boolean;
    googleInitialWaveSawVisible: boolean;
    /** The first whole-viewport discovery pass must finish before it becomes one visual group. */
    viewportCommitDiscoveryReady: boolean;
    viewportCommitGroups: Set<ViewportCommitGroup<ViewportCommitEntry>>;
    viewportCommitTickets: Map<Node, ViewportCommitTicket>;
    titleTranslationStarted: boolean;
    draining: boolean;
    flushTimer: number | null;
    dirtyRoots: Set<Node>;
    mutationFlushTimer: number | null;
    activeDiscovery: {root: Node; steps: Generator<TranslationDiscoveryStep>} | null;
    broadRescanRoots: WeakSet<Node>;
    dirtyRootsBroadMode: boolean;
    pruneTimer: number | null;
    pruneIterator: Iterator<TranslationCandidate> | null;
    pruneRequested: boolean;
    statefulAttributeTimers: Map<HTMLElement, {timer: number; boundaryTimer?: number}>;
    statefulAttributeRescanTargets: WeakSet<HTMLElement>;
}
export interface ViewportCommitPlan {
    /** Commit 직전 읽기 전용으로 현재성 검사를 한다. */
    isCurrent(): boolean;
    /** 모든 group member 검증 뒤 anchor transaction 안에서 실행한다. */
    commit(): TranslationTargetOutcome;
    /** 취소 시 현재 attempt만 해제한다. */
    cancel(): void;
}
export interface ViewportCommitEntry extends ViewportCommitPlan {
    key: Node;
    node: HTMLElement;
    isActive(): boolean;
    resolve: (outcome: TranslationTargetOutcome) => void;
}
export interface ViewportCommitTicket {
    bindAttempt(cancel: () => void): void;
    settleFailure(): void;
    isStaged(): boolean;
    stage(node: HTMLElement, plan: ViewportCommitPlan): Promise<TranslationTargetOutcome>;
    cancel(): void;
}
export interface PreparedCandidate {
    candidate: TranslationCandidate;
    controller: AbortController;
    source: string;
    slots: number;
    escapedCharacters: number;
    origins: readonly string[];
    nativeGooglePrimeProof: NativeGooglePrimeProof;
    settled: boolean;
    consumed: boolean;
}
