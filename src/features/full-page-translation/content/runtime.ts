/**
 * @file src/features/full-page-translation/content/runtime.ts
 * 文件职责：实现全文翻译的页面级会话引擎，负责候选发现、可见性调度、Google viewport 无 DOM 预准备、当前与周边的独立 prime、同步等待动画和原子提交、动态 DOM 重扫、失败重试、缓存复用和恢复原文。
 * 主要内容：精确相同译文和有同目标语言证据的排版回显保留原文且不重复展示；以增量计数发布完成与失败摘要，仅对本会话失败目标重试和定位；维护 FullPageSession、AbortController、Intersection/Mutation 观察器、弹窗优先调度、精确属性写入过滤、候选所有权和生命周期重试；对变化来源等待安静窗口、跳过持续变化的计数，并清理延迟重扫，只有真实宿主删除启动候选回收，同批重复属性变化只处理一次；按时间片派发并在全文结果提交前让出主线程，合并同段 DOM 写入并在重挂时复用同批布局读数与单文本来源快照；Google viewport 仅从既有 IO pending 计划预准备有界请求，不创建 wrapper、spinner 或翻译状态；合成行内段在延迟 loading 前后都按精确来源节点、HTML 和 Text 槽识别自身迁移；已拥有状态的发现候选直接登记复验，取消记录命中后才提取原文，避免整批重扫重复计算熔断签名；连续滚动时限频派发当前可见候选，空闲后恢复预取，按阅读进度撤回离开预取区的待派发候选，冻结请求/展示配置与识别范围，在弹窗关闭后继续正文，按实际节点阶段发布进度及工具栏结果；悬浮按候选停留而非每次移动计时，同段复用冻结的独立服务与快捷方案配置，到期复验最新命中并在路由切换取消；同目标预检单独读取受保护规则约束的行内代码语言上下文，发送与渲染仍只使用可翻译文本槽；恢复单个所有者或全文时重置篇章证据，统一恢复原文并清理重挂预算及孤儿产物；向局部翻译开放单候选 translateTarget 与单个译文所有者的恢复入口。
 * 模块边界：这是 content 侧编排层，不实现 provider 协议、纯候选算法或底层状态存储；翻译调用经 app client，发现规则来自 core/translation，渲染与状态分别交给 renderer、liveTextRender 和 state。
 */
import {createFullPageMutationRuntime} from './mutationRuntime';
import type {FullPageSession, TranslationTargetOutcome, ViewportCommitPlan, ViewportCommitEntry, ViewportCommitTicket, PreparedCandidate} from './sessionTypes';
import {resetPageDiscourseContext} from '@/src/services/translation/context/pageDiscourse';
import {resolveTranslationToolbarStatus, countFullPageTranslationWork} from '../toolbarStatus';
import {hasDistinctTargetTranslation as hasDistinctTranslation} from '@/src/core/translation/targetResult';
import {getFullPageTranslationStateRevision, notifyFullPageTranslationState, notifyTranslationToolbarStatus} from './stateNotification';
import type {FrameTranslationState} from './frameSession';
import {checkConfig} from "@/src/app/translation/check";
import {insertFailedTip} from '@/src/features/full-page-translation/ui/translationIndicators';
import {scheduleTranslationLoadingIndicator} from './loadingIndicator';
import {syncModalTranslationHint} from '../ui/modalProgressHint';
import {styles} from "@/src/core/config/constants";
import {extractTranslationText, extractTranslationTextFromNodes, applyTranslationsToSnapshot, collectLiveTranslationTextSlots, createTranslationSourceSnapshot, getComposedParent, getCurrentTranslationCore, getOpenShadowRoots, getTranslationCandidateKey, resolveTranslationCandidateAtPoint, selectPreferredTranslationCandidate} from "@/src/core/translation/public";
import type {TranslationCandidate, TranslationScope} from "@/src/core/translation/public";
import {shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import {services} from '@/src/core/config/catalog';
import {config} from "@/src/services/config/store";
import type {FullPageTranslationMode} from "@/src/core/config/model";
import {consumeEagerTranslationBudget} from "@/src/features/full-page-translation/content/eagerTranslation";
import {normalizeMaxConcurrentTranslations} from "@/src/core/config/scheduling";
import {cancelTranslationQueueSession, createTranslationQueueSession} from "@/src/services/translation/queue";
import {finishFullPageTranslationProgress, startFullPageTranslationProgress, updateFullPageTranslationProgress} from '@/src/features/full-page-translation/progress';
import {createFullPageOutcomeRegistry} from '../core/outcomes';
import {bindFullPageOutcomeRecovery, getFullPageOutcomeSummary, getFullPageModalOutcomePhases, registerFullPageOutcomeTarget} from './outcomeSession';
import {appendBilingualTranslation, materializeCandidate, materializeVisualTranslationCandidate} from "@/src/features/full-page-translation/content/renderer";
import {renderLiveTextResult} from "@/src/features/full-page-translation/content/liveTextRender";
import {ensureTranslationTruncationLayout} from "@/src/features/full-page-translation/content/layout";
import {blocksBilingualRemountCandidate, createBilingualRemountCapitulationRegistry, createRemovedTranslationOwnerResolver, createBilingualRemountPreparationBatch, forgetBilingualRemountCandidate, stabilizeBilingualArtifact, transferEquivalentBilingualOwners as adoptEquivalentBilingualOwners, type RemovedTranslationOwnerResolver} from '@/src/features/full-page-translation/content/bilingualRemount';
import {refreshBilingualTranslationSkeleton} from '@/src/features/full-page-translation/content/bilingualReplay';
import {isAnchorNearViewport, TranslationSourceStabilityGate} from './sourceStabilityGate';
import {transferEquivalentSyntheticBilingualSegments} from '@/src/features/full-page-translation/content/syntheticRemount';
import {beginBilingualArtifactHostWriteGesture, beginTranslation, discardTranslation, getOwnedTranslationCandidateAtPoint, getTranslationState, resolveTranslationStateNode, markTranslationComplete, markTranslationError, resetAllBilingualArtifactHostWriteBudgets, resetBilingualArtifactHostWriteBudget, restoreTranslation, createBilingualTranslationReplay, setBilingualContent, setBilingualArtifactCapitulationHandler, setBilingualLifecycleExternalManager, setBilingualOwnerRemountHandler, setBilingualSkeletonRefreshHandler, setRenderedStyleAttribute, setRetryWrapper, type TranslationState} from "@/src/features/full-page-translation/content/state";
import {canPrimeNativeGoogleSlots, captureFullPageTranslationConfig, primeNativeGooglePageSlots, getTranslationInvocationIdentity, type FullPageTranslationConfigSnapshot, type FullPageTranslationSessionCache, type PageTranslationConfigOverrides} from '@/src/features/full-page-translation/content/translationRequest';
import {startFullPageTitleTranslation, stopFullPageTitleTranslation} from '@/src/features/full-page-translation/content/titleTranslation';
import {createFullPageScrollController, withFullPageViewportAnchor} from '@/src/features/full-page-translation/content/viewportStability';
import {clearFullPageQueueState, createFullPageQueueState, noteFullPageScroll, queueFullPageCandidate, queueFullPageFailedCandidate, removeFullPagePending, createFullPageDispatchPlan, type FullPageDispatchPlan} from '@/src/features/full-page-translation/content/fullPageQueue';
import {FULL_PAGE_PREFETCH_MARGIN_PX} from '@/src/features/full-page-translation/content/fullPagePriority';
import {createLifecycleRetry, sameLifecycleRetry, createAcceptedUnchangedCompletion, readAcceptedUnchangedCompletion, getCandidateTranslationTextProtectionOptions, isTranslationCandidateCurrent as candidateIsCurrent, isTranslationStateSourceCurrent as attemptSourceIsCurrent, TRANSLATION_ARTIFACT_SELECTOR, getCurrentTranslationStateTextNodes, getTranslationStateProtectionBoundary, getTranslationTextProtectionOptions, normalizeComparableText} from '@/src/features/full-page-translation/content/translationStability';
import {createTranslationRequest, type TranslationResult} from '@/src/features/full-page-translation/content/liveTextTranslation';
import {restorePageTranslationContent, normalizeOrphanedSingleSlots, normalizeOrphanedTranslationArtifacts, normalizeOrphanedTranslationOwner} from '@/src/features/full-page-translation/content/orphanArtifacts';
import {bindFullPageRequestSessionAttempt, createFullPageRequestSessionState, disposeFullPageRequestSession, getHoverTranslationRequestSession, invalidateContextSensitiveRequestCache, invalidateFullPageRequestSessionCache, invalidateHoverTranslationRequestSession, resetHoverTranslationRequestSession} from '@/src/features/full-page-translation/content/requestSession';
import {resetFullPageRouteSession} from './routeLifecycle';
import {HoverTranslationScheduler, type HoverTranslationInvocation} from './hoverScheduler';
import {personalCorrectionIsCurrent, registerPersonalCorrectionResult} from './personalCorrections';

import {isElementNode, asHTMLElement, createTranslationMutationObserverOptions, mutationRootContains as nodeContains, collapseMutationRescanRoot as broadRescanRoot} from './mutationObservation';
import {isWithinTranslationModal} from './modalPriority';
import {refreshModalSession} from './modalSession';

import {createViewportCommitGroup, type ViewportCommitGroup} from './viewportCommitGroup';
import {isViewportCommitGroupEnabled} from './viewportCommitExperiment';
import {createViewportPendingMotion} from './viewportPendingMotion';

const translationSourceStability = new TranslationSourceStabilityGate<FullPageSession>({
    isCurrent: session => session.active && fullPageSession === session,
    resolve: resolveFullPageRetryCandidate, discover: scheduleDiscoveredCandidate, source: candidateLifecycleSource,
    queue: queueFullPageCandidate, drain: scheduleFullPageDrain,
});
export type {TranslationTargetOutcome} from './sessionTypes';
const BROAD_RESCAN_COOLDOWN_MS = 1_000;
const FULL_PAGE_LIFECYCLE_RETRY_LIMIT = 2;
// 同时准备至多四个独立 native 批次，provider 仍按 32 槽/10k 分包。
const FULL_PAGE_PREPARE_MAX_TEXT_SLOTS = 128;
const FULL_PAGE_PREPARE_MAX_ESCAPED_CHARACTERS = 40_000;
const GOOGLE_HTML_WRAPPER_CHARACTERS = 11;

const hoverTranslationScheduler = new HoverTranslationScheduler({
    isAvailable: () => document.visibilityState !== 'hidden' && config.on !== false,
    captureCommitGuard: () => { const session = getHoverTranslationRequestSession(), generation = session.renderCommitGeneration; return () => getHoverTranslationRequestSession() === session && session.renderCommitGeneration === generation; },
    currentScope: () => config.translationScope,
    resolveCandidate: (x, y, scope) => getOwnedTranslationCandidateAtPoint(document, x, y)
        ?? resolveTranslationCandidateAtPoint(x, y, scope),
    captureConfig: overrides => captureFullPageTranslationConfig({...overrides,
        service: overrides.service?.trim() || config.hoverTranslationService || config.service}),
    checkConfig,
    noteGesture: beginBilingualArtifactHostWriteGesture,
    translate: (candidate, snapshot, continuous) => { void translateTarget(candidate, snapshot.displayMode, continuous, undefined, snapshot); },
});
let fullPageSession: FullPageSession | null = null;
const {removeScheduledForStateTarget, restartStatefulTarget, scheduleStatefulAttributeReevaluation, createFullPageMutationObserver} = createFullPageMutationRuntime({
    forgetCandidate, refreshCandidateVisibilityBinding, unregisterSessionStatefulTarget, registerSessionStatefulTarget, enqueueFullPageRescan, transferEquivalentBilingualOwners, refreshFullPageModal, getCurrentSession: () => fullPageSession,
});
let hoverBilingualRemountCapitulations = createBilingualRemountCapitulationRegistry();
setBilingualLifecycleExternalManager(() => fullPageSession?.active === true);
setBilingualOwnerRemountHandler((mutations) => transferEquivalentBilingualOwners(undefined, mutations));
// 宿主改写 title/href 等骨架属性时优先重建骨架复用已提交译文，而不是撕下译文重译。
setBilingualSkeletonRefreshHandler((owner, state) => refreshBilingualTranslationSkeleton(owner, state));
setBilingualArtifactCapitulationHandler((owner, state) => {
    const session = fullPageSession?.active ? fullPageSession : undefined;
    const sessionIdentity = session ? getTranslationInvocationIdentity(session.translationConfig) : undefined;
    const registry = session && state.translationInvocationIdentity === sessionIdentity
        ? session.bilingualRemountCapitulations : hoverBilingualRemountCapitulations;
    const identityOwner = state.syntheticSegment ? state.syntheticHost : owner;
    const boundary = identityOwner?.parentNode;
    if (boundary) registry.remember(boundary, owner, state);
});
export type PageTranslationInvocation = PageTranslationConfigOverrides & {fullPageMode?: FullPageTranslationMode; scope?: TranslationScope};

function scheduleFullPageProgressPublish(session: FullPageSession): void {
    if (!session.active || session.progressPublishScheduled) return;
    session.progressPublishScheduled = true;
    queueMicrotask(() => {
        session.progressPublishScheduled = false;
        if (!session.active || fullPageSession !== session) return;

        const modal = session.modal;
        const eligible = (node: Node) => !modal || isWithinTranslationModal(modal, node);
        let scheduled = session.scheduled;
        let pending = session.pending.size;
        if (modal) {
            scheduled = new Map();
            for (const [key, candidate] of session.scheduled) if (eligible(candidate.element)) scheduled.set(key, candidate);
            pending = 0;
            for (const candidate of session.pending.values()) if (eligible(candidate.element)) pending += 1;
        }
        const work = countFullPageTranslationWork(session.inFlightCandidates, scheduled, pending);
        const deferred = session.scheduled.size - scheduled.size;
        const outcomes = getFullPageOutcomeSummary(session);
        const busy = work.running > 0 || work.queued > 0;
        // 普通页面直接用增量摘要；弹窗仅惰性检查其内部目标，不预先分配整页数组。
        const status = resolveTranslationToolbarStatus(busy, !modal ? outcomes.phases : getFullPageModalOutcomePhases(
            session, session.statefulTargetsByAncestor.get(document.documentElement) ?? [], getTranslationInvocationIdentity(session.translationConfig)));
        notifyTranslationToolbarStatus(session.modal && status === 'translated' ? 'idle' : status);
        const modalPhase = session.modal ? busy ? 'translating' : 'waiting' : 'none';
        syncModalTranslationHint(session.modal, modalPhase, config.translationProgressPanelEnabled === true);
        updateFullPageTranslationProgress(session.progressSessionId, {...work, deferred, modalPhase, completed: outcomes.completed, failed: outcomes.failed, retryable: outcomes.retryable});
    });
}

function candidateSourceText(
    candidate: TranslationCandidate,
    core: ReturnType<typeof getCurrentTranslationCore>,
    protectionOptions: ReturnType<typeof getCandidateTranslationTextProtectionOptions>,
): string {
    if (candidate.visualRange) {
        if (candidate.visualSourceText) return candidate.visualSourceText;
        try {
            const range = candidate.element.ownerDocument.createRange();
            range.setStart(candidate.visualRange.startContainer, candidate.visualRange.startOffset);
            range.setEnd(candidate.visualRange.endContainer, candidate.visualRange.endOffset);
            return range.toString();
        } catch {
            return '';
        }
    }
    if (candidate.nodes?.length) {
        return extractTranslationTextFromNodes(
            candidate.nodes,
            core.shouldStayOriginal,
            undefined,
            protectionOptions,
        );
    }
    return extractTranslationText(
        candidate.element,
        core.shouldStayOriginal,
        candidate.manualChunk ? candidate.element : undefined,
        protectionOptions,
    );
}
function translateNode(
    node: unknown,
    displayMode: "bilingual" | "single",
    slide: boolean,
    owner?: FullPageSession,
): void {
    const target = asHTMLElement(node);
    if (!target) return;
    const candidate = getCurrentTranslationCore(owner?.scope ?? config.translationScope).resolve(target);
    if (candidate) void translateTarget(candidate, displayMode, slide, owner);
}

function transferEquivalentBilingualOwners(session: FullPageSession | undefined, mutations: readonly MutationRecord[]): RemovedTranslationOwnerResolver {
    const resolveRemovedOwners = createRemovedTranslationOwnerResolver();
    const sessionIdentity = session ? getTranslationInvocationIdentity(session.translationConfig) : undefined;
    const synthetic = transferEquivalentSyntheticBilingualSegments(
        mutations, ensureTranslationTruncationLayout, resolveRemovedOwners);
    synthetic.transfers.forEach(({owner, previousHost, replacementHost}) => {
        if (!session) return;
        unregisterSessionStatefulTarget(session, owner);
        registerSessionStatefulTarget(session, replacementHost, owner);
        removeScheduledForStateTarget(session, previousHost);
    });
    synthetic.capitulations.forEach(({owner, state, boundary}) => {
        (session && state.translationInvocationIdentity === sessionIdentity
            ? session.bilingualRemountCapitulations : hoverBilingualRemountCapitulations)
            .remember(boundary, owner, state);
    });
    const result = adoptEquivalentBilingualOwners(mutations, createBilingualRemountPreparationBatch(), resolveRemovedOwners);
    result.transfers.forEach(({previousOwner, replacementOwner}) => {
        if (!session) return;
        unregisterSessionStatefulTarget(session, previousOwner); removeScheduledForStateTarget(session, previousOwner);
        if (getTranslationState(replacementOwner)?.translationInvocationIdentity === sessionIdentity) registerSessionStatefulTarget(session, replacementOwner, replacementOwner);
    });
    result.capitulations.forEach(({previousOwner, replacementOwner, boundary}) => {
        const state = getTranslationState(previousOwner);
        if (state) {
            (session && state.translationInvocationIdentity === sessionIdentity
                ? session.bilingualRemountCapitulations : hoverBilingualRemountCapitulations)
                .remember(boundary, replacementOwner, state);
        }
    });
    return resolveRemovedOwners;
}
function createAbortError(): Error {
    try {
        return new DOMException('翻译已取消', 'AbortError');
    } catch {
        const error = new Error('翻译已取消');
        error.name = 'AbortError';
        return error;
    }
}

function discardStaleAttempt(
    node: HTMLElement,
    state: TranslationState,
): Node | undefined {
    const rescanRoot = state.syntheticSegment ? node.parentElement : node;
    if (getTranslationState(node) === state) {
        withFullPageViewportAnchor(() => discardTranslation(node, state), [node]);
    }
    return rescanRoot?.isConnected ? rescanRoot : undefined;
}

function markFailedTranslation(
    node: HTMLElement,
    candidate: TranslationCandidate,
    attempt: NonNullable<ReturnType<typeof beginTranslation>>,
    spinner: HTMLElement | undefined,
    error: unknown,
    owner?: FullPageSession, snapshot?: FullPageTranslationConfigSnapshot,
): TranslationTargetOutcome {
    if (!node.isConnected ||
        !attemptSourceIsCurrent(node, attempt.state) ||
        !markTranslationError(node, attempt.state, attempt.generation, false)) {
        return {
            status: "stale",
            retryRoot: discardStaleAttempt(node, attempt.state),
            attemptNode: node,
        };
    }
    const retryIsCurrent = () => node.isConnected && getTranslationState(node) === attempt.state && attempt.state.phase === 'error'
        && (!owner || owner.active && fullPageSession === owner);
    const retry = (): boolean => {
        if (!retryIsCurrent()) return false;
        if (owner) return queueFullPageFailedCandidate(owner, candidate, attempt.state.sourceText,
            () => { scheduleFullPageProgressPublish(owner); scheduleFullPageDrain(owner); }, retryIsCurrent);
        const retrySnapshot = snapshot?.requestOverridesApplied ? snapshot : undefined;
        void translateTarget(candidate,
            retrySnapshot?.displayMode ?? (config.display === styles.bilingualTranslation ? "bilingual" : "single"),
            false, undefined, retrySnapshot, true);
        return true;
    };
    const retryWrapper = withFullPageViewportAnchor(() => {
        spinner?.remove();
        return insertFailedTip(node, error instanceof Error ? error.message : String(error || "翻译失败"), retry);
    }, [node]);
    if (owner?.active) {
        owner.outcomes.setRetry(node, retry);
        scheduleFullPageProgressPublish(owner);
    }
    setRetryWrapper(node, retryWrapper);
    setRenderedStyleAttribute(node);
    return {status: "failed"};
}

async function renderTranslation(
    node: HTMLElement,
    candidate: TranslationCandidate,
    attempt: NonNullable<ReturnType<typeof beginTranslation>>,
    request: Promise<TranslationResult>,
    snapshot: FullPageTranslationConfigSnapshot,
    requestSession: FullPageTranslationSessionCache, requestCommitGeneration: number,
    owner?: FullPageSession,
    viewportCommitTicket?: ViewportCommitTicket,
): Promise<TranslationTargetOutcome> {
    const { state, generation } = attempt;

    const staleOutcome = (): TranslationTargetOutcome => ({
        status: "stale",
        retryRoot: discardStaleAttempt(node, state),
        attemptNode: node,
    });

    try {
        const result = await request;
        if (viewportCommitTicket) {
            const staged = await prepareViewportCommit(
                node, candidate, attempt, result, snapshot, requestSession, requestCommitGeneration, owner,
            );
            return await viewportCommitTicket.stage(node, staged);
        }
        // 缓存命中/批量响应会在同一个微任务检查点完成很多段。给每个全文提交独立的
        // 浏览器任务，让输入与绘制能够穿插；让出后仍须复验取消、generation 和宿主节点。
        if (owner) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
        if (import.meta.env.BROWSER !== 'userscript' && !await personalCorrectionIsCurrent(result.personalCorrection, node)) return staleOutcome();
        if (state.controller.signal.aborted || getTranslationState(node) !== state || (owner && !owner.active)) return staleOutcome();
        if ((requestSession.renderCommitGeneration ?? 0) !== requestCommitGeneration) return staleOutcome();
        const spinner = state.spinner;

        // 目标文本即使不变，class/role/可见性变化也可能把所有权移到另一语义块。
        // 提交前必须复验原 owner；合成行内段因 materialize 已移动节点，
        // 所以下方改用其精确 Text 节点身份校验。
        if (!node.isConnected || !attemptSourceIsCurrent(node, state) ||
            (!candidate.nodes?.length && !candidateIsCurrent(candidate))) return staleOutcome();

        // 交互控件、仅译文正文和按钮属性共用替换式渲染；提交细节由渲染模块负责。
        if (result.kind === "control-value" || result.kind === "live-text") {
            const commit = renderLiveTextResult(node, state, generation, result,
                candidate.scope, snapshot.targetLanguage);
            if (commit === "committed") return {status: "committed"};
            if (commit === "stale") return staleOutcome();
            if (commit === "unchanged") return {status: "unchanged", source: state.sourceText, attemptNode: node};
            return {status: "empty", retryRoot: node.isConnected ? node : undefined, attemptNode: node};
        }

        if (result.sources.length === 0 || result.translations.length !== result.sources.length) {
            withFullPageViewportAnchor(() => discardTranslation(node, state), [node]);
            return {status: "empty", retryRoot: node.isConnected ? node : undefined, attemptNode: node};
        }
        if (!result.translations.some((translation, index) =>
            hasDistinctTranslation(result.sources[index] ?? '', translation, snapshot.targetLanguage))) {
            const completion = owner && fullPageSession === owner && owner.scheduled.get(getTranslationCandidateKey(candidate)) === candidate
                ? createAcceptedUnchangedCompletion(node, candidate, state, generation, result.sources, result.translations,
                    {...snapshot, sessionId: owner.progressSessionId, renderCommitGeneration: requestCommitGeneration,
                        configIdentity: getTranslationInvocationIdentity(snapshot)}) : undefined;
            const discarded = withFullPageViewportAnchor(() => discardTranslation(node, state), [node]);
            return {status: "unchanged", source: state.sourceText, attemptNode: node, completion: discarded ? completion : undefined};
        }

        // 在提交时才构建输出骨架，因此宿主属性和安全结构（例如链接 href 从 /a
        // 变为 /b）来自当前 DOM；provider 译文仍绑定请求创建时捕获的精确有序原文。
        const core = getCurrentTranslationCore(candidate.scope);
        const freshSnapshot = createTranslationSourceSnapshot(
            node, core.shouldStayOriginal,
            getTranslationStateProtectionBoundary(node, state),
            getTranslationTextProtectionOptions(state.allowTopLevelApplicationShell, node),
            core.shouldOmitFromTranslation,
        );
        const freshSources = freshSnapshot.slots.map((slot) => slot.source);
        if (freshSources.length !== result.sources.length ||
            freshSources.some((source, index) => source !== result.sources[index])) {
            return staleOutcome();
        }
        const translatedText = applyTranslationsToSnapshot(freshSnapshot, result.translations);
        if (!markTranslationComplete(node, state, generation, false)) {
            return staleOutcome();
        }
        // The host may have rebuilt equivalent source nodes while the provider
        // was loading. Rebase the committed generation to the live snapshot so
        // a deferred layout reevaluation does not mistake that harmless remount
        // for a second source edit.
        state.sourceTextNodes = getCurrentTranslationStateTextNodes(node, state);
        // 原文和输出骨架的只读校验完成后才撤下 loading；避免“先删 spinner → 强制
        // 重排校验 → 插译文 → 再重排”。两项 DOM 写入共用一次锚点事务。
        const content = withFullPageViewportAnchor(() => {
            spinner?.remove();
            state.sourceHTML = node.innerHTML;
            return appendBilingualTranslation(node, translatedText, {
                sourceSkeleton: freshSnapshot.clone, targetLanguage: snapshot.targetLanguage,
                style: snapshot.style, sourceText: result.sources.join('\n'),
                longParagraphLineBreak: snapshot.longParagraphLineBreak, translationBeforeOriginal: snapshot.translationBeforeOriginal,
            });
        }, [node]);
        setBilingualContent(node, content, createBilingualTranslationReplay(result.sources, result.translations, snapshot));
        setRenderedStyleAttribute(node);
        if (import.meta.env.BROWSER !== 'userscript') registerPersonalCorrectionResult(node, state, result.personalCorrection);
        return {status: "committed"};
    } catch (error) {
        if (state.controller.signal.aborted || getTranslationState(node) !== state || (owner && !owner.active)) return staleOutcome();
        if ((requestSession.renderCommitGeneration ?? 0) !== requestCommitGeneration) return staleOutcome();
        if (!candidate.nodes?.length && !candidateIsCurrent(candidate)) return staleOutcome();
        return markFailedTranslation(node, candidate, attempt, state.spinner, error, owner, snapshot);
    }
}

async function prepareViewportCommit(
    node: HTMLElement,
    candidate: TranslationCandidate,
    attempt: NonNullable<ReturnType<typeof beginTranslation>>,
    result: TranslationResult,
    snapshot: FullPageTranslationConfigSnapshot,
    requestSession: FullPageTranslationSessionCache,
    requestCommitGeneration: number,
    owner?: FullPageSession,
): Promise<ViewportCommitPlan> {
    const {state, generation} = attempt;
    const stableOwner = owner;
    const stale = (): TranslationTargetOutcome => ({status: 'stale', retryRoot: discardStaleAttempt(node, state), attemptNode: node});
    const cancel = (): void => { if (getTranslationState(node) === state) discardStaleAttempt(node, state); };
    const isBaseCurrent = (): boolean => state.controller.signal.aborted === false &&
        getTranslationState(node) === state && stableOwner?.active === true && fullPageSession === stableOwner &&
        (requestSession.renderCommitGeneration ?? 0) === requestCommitGeneration && node.isConnected &&
        attemptSourceIsCurrent(node, state) && (Boolean(candidate.nodes?.length) || candidateIsCurrent(candidate));
    if (import.meta.env.BROWSER !== 'userscript' && !await personalCorrectionIsCurrent(result.personalCorrection, node)) {
        return {isCurrent: () => false, commit: stale, cancel};
    }
    if (!isBaseCurrent()) return {isCurrent: () => false, commit: stale, cancel};
    if (result.kind === 'control-value' || result.kind === 'live-text') {
        return {
            isCurrent: isBaseCurrent,
            commit: () => {
                if (!isBaseCurrent()) return stale();
                const committed = renderLiveTextResult(node, state, generation, result, candidate.scope, snapshot.targetLanguage);
                if (committed === 'committed') return {status: 'committed'};
                if (committed === 'unchanged') return {status: 'unchanged', source: state.sourceText, attemptNode: node};
                return committed === 'stale' ? stale() : {status: 'empty', retryRoot: node.isConnected ? node : undefined, attemptNode: node};
            },
            cancel,
        };
    }
    if (result.sources.length === 0 || result.translations.length !== result.sources.length) {
        return {
            isCurrent: isBaseCurrent,
            commit: () => {
                if (!isBaseCurrent()) return stale();
                discardTranslation(node, state);
                return {status: 'empty', retryRoot: node.isConnected ? node : undefined, attemptNode: node};
            },
            cancel,
        };
    }
    if (!result.translations.some((translation, index) => hasDistinctTranslation(result.sources[index] ?? '', translation, snapshot.targetLanguage))) {
        const completion = stableOwner?.scheduled.get(getTranslationCandidateKey(candidate)) === candidate
            ? createAcceptedUnchangedCompletion(node, candidate, state, generation, result.sources, result.translations,
                {...snapshot, sessionId: stableOwner!.progressSessionId, renderCommitGeneration: requestCommitGeneration,
                    configIdentity: getTranslationInvocationIdentity(snapshot)}) : undefined;
        return {
            isCurrent: isBaseCurrent,
            commit: () => {
                if (!isBaseCurrent()) return stale();
                const discarded = discardTranslation(node, state);
                return {status: 'unchanged', source: state.sourceText, attemptNode: node, completion: discarded ? completion : undefined};
            },
            cancel,
        };
    }
    const core = getCurrentTranslationCore(candidate.scope);
    const freshSnapshot = createTranslationSourceSnapshot(node, core.shouldStayOriginal,
        getTranslationStateProtectionBoundary(node, state),
        getTranslationTextProtectionOptions(state.allowTopLevelApplicationShell, node), core.shouldOmitFromTranslation);
    const freshSources = freshSnapshot.slots.map(slot => slot.source);
    const areSourcesCurrent = (): boolean => {
        if (!isBaseCurrent()) return false;
        const current = createTranslationSourceSnapshot(node, core.shouldStayOriginal,
            getTranslationStateProtectionBoundary(node, state),
            getTranslationTextProtectionOptions(state.allowTopLevelApplicationShell, node), core.shouldOmitFromTranslation);
        const currentSources = current.slots.map(slot => slot.source);
        return currentSources.length === result.sources.length &&
            currentSources.every((source, index) => source === result.sources[index]);
    };
    if (freshSources.length !== result.sources.length || freshSources.some((source, index) => source !== result.sources[index])) {
        return {isCurrent: () => false, commit: stale, cancel};
    }
    const translatedText = applyTranslationsToSnapshot(freshSnapshot, result.translations);
    return {
        isCurrent: areSourcesCurrent,
        commit: () => {
            if (!areSourcesCurrent() || !markTranslationComplete(node, state, generation, false)) return stale();
            state.sourceTextNodes = getCurrentTranslationStateTextNodes(node, state);
            state.spinner?.remove();
            state.sourceHTML = node.innerHTML;
            const content = appendBilingualTranslation(node, translatedText, {
                sourceSkeleton: freshSnapshot.clone, targetLanguage: snapshot.targetLanguage, style: snapshot.style,
                sourceText: result.sources.join('\n'), longParagraphLineBreak: snapshot.longParagraphLineBreak,
                translationBeforeOriginal: snapshot.translationBeforeOriginal,
            });
            setBilingualContent(node, content, createBilingualTranslationReplay(result.sources, result.translations, snapshot));
            setRenderedStyleAttribute(node);
            if (import.meta.env.BROWSER !== 'userscript') registerPersonalCorrectionResult(node, state, result.personalCorrection);
            return {status: 'committed'};
        },
        cancel,
    };
}
function hasIntersectionLayoutBox(element: HTMLElement): boolean {
    if (typeof element.getClientRects !== "function") return false;
    try {
        const rects = element.getClientRects();
        for (let index = 0; index < rects.length; index += 1) {
            const rect = rects[index];
            if (rect && rect.width > 0 && rect.height > 0) return true;
        }
    } catch {
        // 脱离文档或自定义元素在重建布局时可能抛出异常。
    }
    return false;
}

/**
 * IntersectionObserver 无法可靠唤醒不生成布局盒的目标，典型情况是
 * `display: contents`。候选自身有布局盒时优先使用自身，否则按文档顺序遍历
 * 非扩展后代；找不到锚点时由调用方直接排队，并继续受全文 drain 并发限制。
 */
function resolveFullPageVisibilityAnchor(candidate: HTMLElement): HTMLElement | null {
    if (hasIntersectionLayoutBox(candidate)) return candidate;

    const pending: Element[] = [];
    const pushChildrenInReverse = (container: ParentNode) => {
        for (let index = container.children.length - 1; index >= 0; index -= 1) {
            const child = container.children.item(index);
            if (child) pending.push(child);
        }
    };
    pushChildrenInReverse(candidate);

    while (pending.length > 0) {
        const element = pending.pop();
        if (!element || element.matches(TRANSLATION_ARTIFACT_SELECTOR)) continue;
        const htmlElement = asHTMLElement(element);
        if (htmlElement && hasIntersectionLayoutBox(htmlElement)) return htmlElement;

        // open Shadow DOM 既作为独立观察根参与全文翻译，也可能是宿主唯一的渲染盒。
        // 先压入 light DOM 子节点，使 LIFO 顺序优先访问 shadow 子节点。
        pushChildrenInReverse(element);
        if (element.shadowRoot) pushChildrenInReverse(element.shadowRoot);
    }
    return null;
}

function removeCandidateObservation(session: FullPageSession, key: Node): void {
    const anchor = session.candidateAnchors.get(key);
    if (!anchor) return;
    session.candidateAnchors.delete(key);
    const observed = session.observedCandidates.get(anchor);
    observed?.delete(key);
    if (observed?.size === 0) {
        session.observedCandidates.delete(anchor);
        session.observer.unobserve(anchor);
    }
}

function addCandidateOwnerKey(session: FullPageSession, owner: HTMLElement, key: Node): void {
    let keys = session.candidateOwnerKeys.get(owner);
    if (!keys) {
        keys = new Set();
        session.candidateOwnerKeys.set(owner, keys);
    }
    keys.add(key);
}

function removeCandidateOwnerKey(session: FullPageSession, owner: HTMLElement, key: Node): void {
    const keys = session.candidateOwnerKeys.get(owner);
    keys?.delete(key);
    if (keys?.size === 0) session.candidateOwnerKeys.delete(owner);
}

function unregisterSessionStatefulTarget(session: FullPageSession | undefined, target: HTMLElement, preserveOutcome = false): void {
    if (!session) return;
    if (!preserveOutcome) session.outcomes.update(target);
    const ancestors = session.statefulAncestorsByTarget.get(target);
    if (!ancestors) return;
    scheduleFullPageProgressPublish(session);
    session.statefulAncestorsByTarget.delete(target);
    for (const ancestor of ancestors) {
        const targets = session.statefulTargetsByAncestor.get(ancestor);
        targets?.delete(target);
        if (targets?.size === 0) session.statefulTargetsByAncestor.delete(ancestor);
    }
}

function rememberUserCancelledCandidate(
    session: FullPageSession,
    candidate: TranslationCandidate,
    target: HTMLElement,
    state: TranslationState,
): void {
    const source = normalizeComparableText(state.sourceText || candidateLifecycleSource(candidate));
    const remember = (node: Node | null | undefined) => {
        if (node) session.userCancelledCandidates.set(node, source);
    };

    // 精确候选以元素作为 key；合成行内段以首个来源节点作为 key，因此需保留
    // 所有已捕获来源节点，才能跨过 restoreTranslation() 对片段的解包过程。
    remember(getTranslationCandidateKey(candidate));
    if (!candidate.nodes?.length) remember(candidate.element);
    state.sourceTextNodes?.forEach((node) => remember(node));
    state.syntheticSourceNodes?.forEach((node) => remember(node));
    remember(target);
}

function isUserCancelledCandidate(
    session: FullPageSession,
    candidate: TranslationCandidate,
): boolean {
    let source: string | undefined;
    const identities = [
        getTranslationCandidateKey(candidate),
        ...(candidate.nodes ?? []),
    ];
    let cancelled = false;
    identities.forEach((identity) => {
        const cancelledSource = session.userCancelledCandidates.get(identity);
        if (cancelledSource === undefined) return;
        source ??= candidateLifecycleSource(candidate);
        if (cancelledSource === source) {
            cancelled = true;
        } else {
            // 宿主复用同一 DOM 节点承载了不同内容，之前的用户取消不能屏蔽新原文。
            session.userCancelledCandidates.delete(identity);
        }
    });
    return cancelled;
}

function registerSessionStatefulTarget(
    session: FullPageSession | undefined,
    candidateOwner: HTMLElement,
    target: HTMLElement,
): void {
    if (!session?.active) return;
    unregisterSessionStatefulTarget(session, target, true);
    const ancestors: Element[] = [];
    let current: Element | null = candidateOwner;
    let depth = 0;
    while (current && depth < 512) {
        depth += 1;
        ancestors.push(current);
        let targets = session.statefulTargetsByAncestor.get(current);
        if (!targets) {
            targets = new Set();
            session.statefulTargetsByAncestor.set(current, targets);
        }
        targets.add(target);
        current = getComposedParent(current);
    }
    session.statefulAncestorsByTarget.set(target, ancestors);
    registerFullPageOutcomeTarget(session, target, getTranslationInvocationIdentity(session.translationConfig));
    scheduleFullPageProgressPublish(session);
}

function refreshCandidateVisibilityBinding(
    session: FullPageSession,
    key: Node,
    candidate: TranslationCandidate,
): void {
    if (session.translationMode === "all" || (session.modal && isWithinTranslationModal(session.modal, candidate.element)) || consumeEagerTranslationBudget(session, key, candidate)) {
        // “翻译到网页底部”和免滚动预翻译都只绕过视口门禁，不操纵页面滚动位置；初次扫描和后续 mutation 发现的内容都进入同一受限队列。
        removeCandidateObservation(session, key);
        queueFullPageCandidate(session, key, candidate, candidateLifecycleSource(candidate));
        scheduleFullPageDrain(session);
        return;
    }

    const target = asHTMLElement(candidate.element);
    const nextAnchor = target?.isConnected ? resolveFullPageVisibilityAnchor(target) : null;
    const currentAnchor = session.candidateAnchors.get(key) ?? null;

    if (currentAnchor === nextAnchor && (nextAnchor !== null || session.pending.has(key))) return;
    removeCandidateObservation(session, key);

    if (!nextAnchor) {
        // 已可见候选的 display:contents 子树重建时仍应保持 pending；若它仍在等待
        // 旧锚点，直接调度是唯一不会丢失可见性的回退方式。
        if (!session.pending.has(key)) {
            queueFullPageCandidate(session, key, candidate, candidateLifecycleSource(candidate));
        }
        scheduleFullPageProgressPublish(session);
        scheduleFullPageDrain(session);
        return;
    }

    if (shouldPrepareGoogleViewport(session)) {
        if (isAnchorVisible(nextAnchor)) session.googleInitialWaveSawVisible = true;
        else if (session.googleInitialWaveSawVisible && isAnchorBelowViewport(nextAnchor)) {
            releaseInitialGoogleVisibleWave(session);
        }
    }

    let observed = session.observedCandidates.get(nextAnchor);
    const alreadyObserved = Boolean(observed);
    if (!observed) {
        observed = new Map();
        session.observedCandidates.set(nextAnchor, observed);
    }
    observed.set(key, candidate);
    session.candidateAnchors.set(key, nextAnchor);
    session.observer.observe(nextAnchor);
    // observe() 对已观察且仍可见的元素不会再次派发入视口事件。增量发现
    // 可能在首个同容器候选完成后才登记其余歌词行，此时直接唤醒新候选。
    if (session.visibleCandidateAnchors.has(nextAnchor) &&
        (!isViewportCommitGroupEnabled() || session.translationMode !== 'viewport' || session.viewportCommitDiscoveryReady) &&
        (alreadyObserved || isAnchorNearViewport(nextAnchor))) {
        queueFullPageCandidate(session, key, candidate, candidateLifecycleSource(candidate));
        scheduleFullPageDrain(session);
    } else if (!alreadyObserved) {
        session.visibleCandidateAnchors.delete(nextAnchor);
    }
    scheduleFullPageProgressPublish(session);
}

function googleEscapedTextLength(text: string): number {
    return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;').replace(/'/gu, '&#39;').length + GOOGLE_HTML_WRAPPER_CHARACTERS;
}

function releasePreparedCandidate(session: FullPageSession, key: Node, entry: PreparedCandidate): void {
    if (session.preparedCandidates.get(key) !== entry) return;
    session.preparedCandidates.delete(key);
    session.preparedSlots = Math.max(0, session.preparedSlots - entry.slots);
    session.preparedEscapedCharacters = Math.max(0, session.preparedEscapedCharacters - entry.escapedCharacters);
}

function cancelPreparedCandidate(session: FullPageSession, candidate: TranslationCandidate): void {
    const key = getTranslationCandidateKey(candidate);
    const entry = session.preparedCandidates.get(key);
    if (!entry) return;
    releasePreparedCandidate(session, key, entry);
    entry.controller.abort();
    abortGooglePrimeWithoutMembers(session);
}

/** 未交给 DOM 消费的预准备归属旧路线时必须同步释放；旧 completion 不能释放同 key 的新条目。 */
function clearPreparedCandidates(session: FullPageSession): void {
    for (const [key, entry] of [...session.preparedCandidates]) {
        releasePreparedCandidate(session, key, entry);
        entry.controller.abort();
    }
    abortGooglePrimeWithoutMembers(session);
    session.preparedSlots = 0;
    session.preparedEscapedCharacters = 0;
}

/**
 * Google prime은 아직 DOM lifecycle에 넘기지 않은 후보 controller를 lease로 쓴다.
 * 한 후보가 viewport를 벗어나도 같은 wave의 다른 후보는 계속 기다린다. 모두 사라질
 * 때만 wave controller를 중단해 queue lease와 provider 작업을 즉시 돌려준다.
 */
function abortGooglePrimeWithoutMembers(session: FullPageSession): void {
    const controller = session.primedGoogleWaveController;
    const members = session.primedGoogleWaveMembers;
    if (!controller || !members || members.some(entry => !entry.controller.signal.aborted)) return;
    controller.abort();
}

function canPrepareGoogleCandidate(session: FullPageSession, candidate: TranslationCandidate): boolean {
    return session.active
        && session.translationMode === 'viewport'
        && session.translationConfig.service === services.google
        && session.translationConfig.enableNativeBatch !== false
        && candidate.kind === 'content'
        && !candidate.nodes?.length
        && !candidate.visualRange
        && !candidate.manualChunk
        && candidate.element.isConnected
        && !getTranslationState(candidate.element)
        && candidateIsCurrent(candidate);
}

function prepareGoogleCandidate(session: FullPageSession, candidate: TranslationCandidate): void {
    if (!canPrepareGoogleCandidate(session, candidate)) return;
    const key = getTranslationCandidateKey(candidate);
    const metadata = session.pendingMetadata.get(key);
    // drain이 재시도 소유권과 실패 강제 재요청을 판정하기 전에는 네트워크를 시작하지 않는다.
    // 실패 retry는 이전 오류 cache를 의도적으로 우회하므로 일반 preprepare와 공유할 수 없다.
    if (metadata?.retryIsCurrent?.() === false || metadata?.forceFailedRequest === true) {
        cancelPreparedCandidate(session, candidate);
        return;
    }
    const core = getCurrentTranslationCore(candidate.scope);
    const protectionOptions = getCandidateTranslationTextProtectionOptions(candidate);
    const source = candidateSourceText(candidate, core, protectionOptions);
    const existing = session.preparedCandidates.get(key);
    if (!normalizeComparableText(source)) return;
    // translateTarget와 같은 자동 진입 문턱을 DOM 생성 전에 적용한다. 안정화 gate는
    // 대기 timer를 등록할 수 있지만 provider, spinner, wrapper 또는 상태를 만들지 않는다.
    if (translationSourceStability.blocks(candidate, source, session)) return;
    if (session.translationConfig.displayMode === 'bilingual' && blocksBilingualRemountCandidate(
        session.bilingualRemountCapitulations,
        candidate.element,
        source,
        candidate.allowTopLevelApplicationShell === true,
        getTranslationInvocationIdentity(session.translationConfig),
        candidate.nodes,
        candidate.scope,
    )) return;
    if (shouldSkipTranslationForTarget(
        candidateSourceText(candidate, core, {...protectionOptions, includeInlineCodeForLanguage: true}),
        session.translationConfig.targetLanguage,
        session.translationConfig.excludedLanguages,
    )) return;
    const slots = collectLiveTranslationTextSlots(candidate.element, core.shouldStayOriginal, undefined, protectionOptions);
    if (slots.length === 0) return;
    const origins = slots.map(slot => slot.source);
    if (!canPrimeNativeGoogleSlots(origins, session.translationConfig)) return;
    if (existing) {
        const exactSameSlots = existing.origins.length === origins.length
            && existing.origins.every((origin, index) => origin === origins[index]);
        if (existing.source === source && existing.candidate.scope === candidate.scope && exactSameSlots) {
            existing.candidate = candidate;
            return;
        }
        cancelPreparedCandidate(session, existing.candidate);
    }
    const slotCount = slots.length;
    const escapedCharacters = slots.reduce((total, slot) => total + googleEscapedTextLength(slot.source), 0);
    const oversizedSingle = slotCount === 1 && escapedCharacters > FULL_PAGE_PREPARE_MAX_ESCAPED_CHARACTERS;
    if (!oversizedSingle && (session.preparedSlots + slotCount > FULL_PAGE_PREPARE_MAX_TEXT_SLOTS
        || session.preparedEscapedCharacters + escapedCharacters > FULL_PAGE_PREPARE_MAX_ESCAPED_CHARACTERS)) return;
    if (oversizedSingle && session.preparedCandidates.size > 0) return;

    const controller = new AbortController();
    const entry: PreparedCandidate = {candidate, controller, source, slots: slotCount, escapedCharacters,
        origins,
        nativeGooglePrimeProof: {origins, invocationIdentity: getTranslationInvocationIdentity(session.translationConfig)},
        settled: false, consumed: false};
    session.preparedCandidates.set(key, entry);
    session.preparedSlots += slotCount;
    session.preparedEscapedCharacters += escapedCharacters;
}

function invalidateGoogleDispatchPlan(session: FullPageSession): void {
    session.dispatchPlan = null;
    session.prepareCursor = 0;
    if (session.prepareTimer !== null) {
        window.clearTimeout(session.prepareTimer);
        session.prepareTimer = null;
    }
}

function shouldPrepareGoogleViewport(session: FullPageSession): boolean {
    return session.translationMode === 'viewport'
        && session.translationConfig.service === services.google
        && session.translationConfig.enableNativeBatch !== false;
}

/** Initial IO delivery order is not an admission boundary. */
function releaseInitialGoogleVisibleWave(session: FullPageSession): void {
    if (session.googleInitialWaveDiscoveryReady) return;
    session.observedCandidates.forEach((candidates, anchor) => {
        if (!isAnchorVisible(anchor)) return;
        candidates.forEach((candidate, key) => {
            queueFullPageCandidate(session, key, candidate, candidateLifecycleSource(candidate));
        });
    });
    session.googleInitialWaveDiscoveryReady = true;
    invalidateGoogleDispatchPlan(session);
}

/** 多列页面按实际几何恢复初始预取队列；提交组仍只保留当前可见锚点。 */
function releaseInitialViewportCommitGroup(session: FullPageSession): void {
    if (session.viewportCommitDiscoveryReady) return;
    session.observedCandidates.forEach((candidates, anchor) => {
        if (!isAnchorNearViewport(anchor)) return;
        candidates.forEach((candidate, key) => {
            queueFullPageCandidate(session, key, candidate, candidateLifecycleSource(candidate));
        });
    });
    session.viewportCommitDiscoveryReady = true;
}

function isAnchorVisible(anchor: HTMLElement): boolean {
    try {
        const rect = anchor.getBoundingClientRect();
        const width = window.innerWidth || document.documentElement.clientWidth;
        const height = window.innerHeight || document.documentElement.clientHeight;
        return width > 0 && height > 0 && rect.width > 0 && rect.height > 0
            && rect.right > 0 && rect.left < width && rect.bottom > 0 && rect.top < height;
    } catch {
        return false;
    }
}

function isAnchorBelowViewport(anchor: HTMLElement): boolean {
    try {
        const rect = anchor.getBoundingClientRect();
        const width = window.innerWidth || document.documentElement.clientWidth;
        const height = window.innerHeight || document.documentElement.clientHeight;
        return width > 0 && height > 0 && rect.right > 0 && rect.left < width && rect.top >= height;
    } catch {
        return false;
    }
}

/** Google 첫 body wave가 collector 자리를 먼저 확정한 뒤 제목 요청을 시작한다. */
function startFullPageTitleTranslationIfNeeded(session: FullPageSession): void {
    if (session.titleTranslationStarted || config.pageTitleTranslationEnabled === false) return;
    session.titleTranslationStarted = true;
    startFullPageTitleTranslation(session.translationConfig);
}

function ensureGoogleDispatchPlan(session: FullPageSession, scrolling: boolean): FullPageDispatchPlan {
    if (session.dispatchPlan) return session.dispatchPlan;
    session.prepareCursor = 0;
    session.dispatchPlan = createFullPageDispatchPlan(session, {now: Date.now(), viewportHeight: window.innerHeight, visibleOnly: scrolling,
        isEligible: candidate => !session.modal || isWithinTranslationModal(session.modal, candidate.element),
        resolveSource: candidateLifecycleSource});
    return session.dispatchPlan;
}

function prepareGoogleDispatchPlan(session: FullPageSession, startedAt: number): boolean {
    const plan = session.dispatchPlan;
    if (!plan) return true;
    while (session.prepareCursor < plan.candidates.length && performance.now() - startedAt < 8) {
        const selection = plan.candidates[session.prepareCursor++]!;
        if (session.pending.get(selection.key) !== selection.candidate
            || session.inFlightCandidates.has(selection.key)) continue;
        // plan은 visible을 먼저 정렬한다. 남은 bounded 준비 예산으로 nearby 원문도
        // 독립 slot으로 준비하지만 첫 화면 commit barrier에는 넣지 않는다.
        if (selection.priority.band === 'background') continue;
        prepareGoogleCandidate(session, selection.candidate);
        if (session.preparedSlots >= FULL_PAGE_PREPARE_MAX_TEXT_SLOTS
            || session.preparedEscapedCharacters >= FULL_PAGE_PREPARE_MAX_ESCAPED_CHARACTERS) return true;
    }
    if (session.prepareCursor < plan.candidates.length) return false;
    // 첫 IO callback은 discovery가 막 등록한 일부 anchor만 담을 수 있다. near-viewport
    // 탐색이 끝나거나 네 요청의 준비 예산을 채울 때까지 기다립니다.
    return session.googleInitialWaveDiscoveryReady;
}

function primePreparedGoogleWave(session: FullPageSession): boolean {
    if (session.primedGoogleWave) return false;
    const entries = [...session.preparedCandidates.values()].filter(entry => !entry.consumed && !entry.controller.signal.aborted);
    if (entries.length === 0) return false;
    const controller = new AbortController();
    session.requestControllers.add(controller);
    // 远一屏的慢响应不能阻止当前画面；两个独立 prime 各自注册 slot promise。
    const visible = entries.filter(entry => isAnchorVisible(entry.candidate.element));
    const nearby = entries.filter(entry => !visible.includes(entry));
    const requests = [visible, nearby].filter(group => group.length > 0).map(group =>
        primeNativeGooglePageSlots(group.flatMap(entry => entry.origins), session.translationConfig, session, controller.signal));
    const request = Promise.all(requests).then(results => results.flat());
    startFullPageTitleTranslationIfNeeded(session);
    session.primedGoogleWave = request;
    session.primedGoogleWaveController = controller;
    session.primedGoogleWaveMembers = entries;
    const releaseWave = () => {
        session.requestControllers.delete(controller);
        if (session.primedGoogleWave === request) {
            session.primedGoogleWave = null;
            session.primedGoogleWaveController = null;
            session.primedGoogleWaveMembers = null;
        }
    };
    void request.then(
        () => entries.forEach(entry => {
            entry.settled = true;
            const key = getTranslationCandidateKey(entry.candidate);
            if (entry.consumed || session.scheduled.get(key) !== entry.candidate) releasePreparedCandidate(session, key, entry);
        }),
        () => entries.forEach(entry => releasePreparedCandidate(session, getTranslationCandidateKey(entry.candidate), entry)),
    ).then(releaseWave, releaseWave);
    return true;
}

function consumePreparedCandidate(session: FullPageSession | undefined, candidate: TranslationCandidate, source: string): PreparedCandidate | undefined {
    if (!session) return undefined;
    const key = getTranslationCandidateKey(candidate);
    const entry = session.preparedCandidates.get(key);
    if (!entry) return undefined;
    if (entry.source !== source || entry.candidate !== candidate) {
        cancelPreparedCandidate(session, entry.candidate);
        return undefined;
    }
    entry.consumed = true;
    if (entry.settled) releasePreparedCandidate(session, key, entry);
    return entry;
}

function forgetCandidate(session: FullPageSession | undefined, candidate: TranslationCandidate): void {
    if (!session) return;
    const key = getTranslationCandidateKey(candidate);
    session.viewportCommitTickets.get(key)?.cancel();
    cancelPreparedCandidate(session, candidate);
    const removedPending = removeFullPagePending(session, key, candidate);
    if (session.scheduled.get(key) !== candidate) {
        if (removedPending) scheduleFullPageProgressPublish(session);
        return;
    }
    session.scheduled.delete(key);
    removeCandidateObservation(session, key);
    removeCandidateOwnerKey(session, candidate.element, key);
    scheduleFullPageProgressPublish(session);
}

export async function translateTarget(candidate: TranslationCandidate, displayMode: "bilingual" | "single", slide: boolean,
    owner?: FullPageSession,
    translationConfigOverride?: FullPageTranslationConfigSnapshot,
    forceFailedRequest = false,
    viewportCommitTicket?: ViewportCommitTicket,
): Promise<TranslationTargetOutcome> {
    if (!candidate.element.isConnected) return {status: "not-current"};
    const statefulSession = owner?.active ? owner : fullPageSession?.active ? fullPageSession : undefined;
    statefulSession?.unchangedCandidates.delete(getTranslationCandidateKey(candidate));
    const remountCapitulations = statefulSession?.bilingualRemountCapitulations ?? hoverBilingualRemountCapitulations;
    const translationConfig = owner?.active ? owner.translationConfig
        : translationConfigOverride ?? captureFullPageTranslationConfig();
    const requestOwner = statefulSession?.active && getTranslationInvocationIdentity(statefulSession.translationConfig) === getTranslationInvocationIdentity(translationConfig) ? statefulSession : undefined;
    const requestSession = requestOwner ?? getHoverTranslationRequestSession(); const requestCommitGeneration = requestSession.renderCommitGeneration ?? 0;
    const existingNode = resolveTranslationStateNode(candidate);
    const current = existingNode ? getTranslationState(existingNode) : undefined;
    if (existingNode && (current?.phase === "loading" || current?.phase === "translated")) {
        const nextIdentity = getTranslationInvocationIdentity(translationConfig);
        const shouldSwitchProfile = Boolean(nextIdentity && current.translationInvocationIdentity !== nextIdentity);
        if (current.phase === "loading" && !shouldSwitchProfile) return {status: "owned"};
        const retryAnchor = candidate.nodes?.[0] ?? existingNode;

        // 连续滑动是 ensure-visible，不是单次 toggle。内存中的 translated
        // 只有在原文快照和真实译文工件都完整时才能短路；宿主仅删除
        // wrapper 时先原子重挂，不发起新请求。
        if (current.phase === "translated" && slide && !shouldSwitchProfile) {
            const disposition = stabilizeBilingualArtifact(
                existingNode, current, remountCapitulations, ensureTranslationTruncationLayout);
            if (disposition === 'current') return {status: "committed"};
            // 结构签名或工件属性被宿主改写、但可译文本未变时，按当前 DOM 重建骨架
            // 并复用已提交译文；不能因此撤下译文重新请求。
            if (refreshBilingualTranslationSkeleton(existingNode, current)) return {status: 'committed'};

            unregisterSessionStatefulTarget(statefulSession, existingNode);
            withFullPageViewportAnchor(() => restoreTranslation(existingNode), [existingNode]);
            if (disposition === 'capitulated') return {status: 'owned'};
            if (!retryAnchor.isConnected) {
                return {status: "not-current", retryRoot: candidate.element.isConnected ? candidate.element : undefined};
            }
            const refreshedCandidate = getCurrentTranslationCore(candidate.scope).resolve(retryAnchor);
            return refreshedCandidate
                ? translateTarget(
                    refreshedCandidate,
                    displayMode,
                    slide,
                    owner,
                    translationConfigOverride,
                    forceFailedRequest,
                )
                : {status: "not-current", retryRoot: candidate.element.isConnected ? candidate.element : undefined};
        }

        if (statefulSession?.active && fullPageSession === statefulSession) {
            rememberUserCancelledCandidate(statefulSession, candidate, existingNode, current);
        }
        unregisterSessionStatefulTarget(statefulSession, existingNode);
        resetPageDiscourseContext();
        withFullPageViewportAnchor(() => restoreTranslation(existingNode), [existingNode]);
        if (shouldSwitchProfile && retryAnchor.isConnected) {
            const refreshedCandidate = getCurrentTranslationCore(candidate.scope).resolve(retryAnchor);
            if (refreshedCandidate) return translateTarget(
                refreshedCandidate, displayMode, slide, owner, translationConfigOverride, forceFailedRequest);
        }
        return {status: current.phase === "loading" ? "owned" : "committed"};
    }
    if (current?.phase === "error" && existingNode) {
        if (slide && current.translationInvocationIdentity === getTranslationInvocationIdentity(translationConfig)) return {status: 'owned'};
        if (current.syntheticSegment) {
            const sourceNodes = Array.from(existingNode.childNodes).filter((node) =>
                !isElementNode(node) || !node.matches('[data-fr-translation-owned="true"]'),
            );
            const sourceAnchor = sourceNodes.find((node) =>
                normalizeComparableText(node.textContent ?? node.nodeValue ?? "").length > 0,
            ) ?? sourceNodes[0];
            const retryRoot = existingNode.parentElement ?? undefined;
            unregisterSessionStatefulTarget(statefulSession, existingNode);
            withFullPageViewportAnchor(() => restoreTranslation(existingNode), [existingNode]);
            if (!sourceAnchor?.isConnected) return {status: "not-current", retryRoot};
            const refreshedCandidate = getCurrentTranslationCore(candidate.scope).resolve(sourceAnchor);
            if (!refreshedCandidate) return {status: "not-current", retryRoot};
            return translateTarget(
                refreshedCandidate, displayMode, slide, owner, translationConfigOverride, forceFailedRequest);
        }
        unregisterSessionStatefulTarget(statefulSession, existingNode);
        withFullPageViewportAnchor(() => restoreTranslation(existingNode), [existingNode]);
    }

    if (!candidateIsCurrent(candidate)) {
        return {
            status: "not-current",
            retryRoot: candidate.element.isConnected ? candidate.element : undefined,
        };
    }

    const core = getCurrentTranslationCore(candidate.scope);
    const candidateProtectionOptions = getCandidateTranslationTextProtectionOptions(candidate);
    const sourceText = candidateSourceText(candidate, core, candidateProtectionOptions);
    if (!normalizeComparableText(sourceText)) {
        return {
            status: "empty",
            retryRoot: candidate.element.isConnected ? candidate.element : undefined,
        };
    }
    // 安静窗口由自动全文 owner 负责重新派发；手动悬浮没有该队列，不能静默吞掉已明确请求的新来源。
    if (owner?.active && translationSourceStability.blocks(candidate, sourceText, owner)) return {status: 'unchanged', source: sourceText};
    if (slide && displayMode === 'bilingual' && blocksBilingualRemountCandidate(remountCapitulations, candidate.element, sourceText,
        candidate.allowTopLevelApplicationShell === true,
        getTranslationInvocationIdentity(translationConfig), candidate.nodes, candidate.scope)) return {status: 'owned'};
    if (!slide) {
        resetBilingualArtifactHostWriteBudget(candidate.element);
        forgetBilingualRemountCandidate(remountCapitulations, candidate.element, sourceText,
            candidate.allowTopLevelApplicationShell === true, getTranslationInvocationIdentity(translationConfig),
            candidate.nodes, candidate.scope);
    }

    // 同语言检测只是节流优化；不确定、短 Latin 与纯 Han 必须 fail-open，
    // 否则日中混合标题或法德短文会在 provider 之前静默漏译。
    if (shouldSkipTranslationForTarget(
            candidateSourceText(candidate, core, {...candidateProtectionOptions, includeInlineCodeForLanguage: true}),
            translationConfig.targetLanguage, translationConfig.excludedLanguages)) {
        return {status: "unchanged", source: sourceText};
    }
    const preparedCandidate = consumePreparedCandidate(statefulSession, candidate, sourceText);

    if (candidate.visualRange) {
        const visualCandidate = withFullPageViewportAnchor(
            () => materializeVisualTranslationCandidate(candidate),
            [candidate.element],
        );
        if (!visualCandidate) {
            return {
                status: "not-current",
                retryRoot: candidate.element.isConnected ? candidate.element : undefined,
            };
        }
        candidate = visualCandidate;
    }

    const materialized = candidate.nodes?.length && !candidate.manualChunk
        ? withFullPageViewportAnchor(() => materializeCandidate(candidate), [candidate.element])
        : materializeCandidate(candidate);
    if (!materialized) {
        if (preparedCandidate && statefulSession) cancelPreparedCandidate(statefulSession, candidate);
        return {
            status: "not-current",
            retryRoot: candidate.element.isConnected ? candidate.element : undefined,
        };
    }
    const {node, synthetic} = materialized;
    normalizeOrphanedTranslationOwner(node);

    const kind = candidate.kind;
    // 捕获每个候选中可翻译 Text 节点的精确身份。renderer 可能在提交后只替换受保护的
    // MathJax/KaTeX 子节点；仅比较原文无法区分这种无害事务与同文本宿主/链接替换，
    // 后者会使已渲染快照失效。
    const sourceTextNodes = collectLiveTranslationTextSlots(
        node,
        core.shouldStayOriginal,
        synthetic ? node : undefined,
        getTranslationTextProtectionOptions(candidate.allowTopLevelApplicationShell, node),
    ).map((slot) => slot.node);
    const attempt = beginTranslation(
        node,
        displayMode,
        kind,
        synthetic,
        sourceText,
        sourceTextNodes,
        candidate.allowTopLevelApplicationShell === true,
        getTranslationInvocationIdentity(translationConfig),
        candidate.scope,
    );
    if (!attempt) {
        if (preparedCandidate && statefulSession) cancelPreparedCandidate(statefulSession, candidate);
        if (synthetic) {
            withFullPageViewportAnchor(() => node.replaceWith(...Array.from(node.childNodes)), [node]);
        }
        return {status: "owned"};
    }
    viewportCommitTicket?.bindAttempt(() => {discardStaleAttempt(node, attempt.state);});
    if (preparedCandidate) {
        // 준비 lease는 이제 실제 DOM attempt controller를 따른다. 한 후보의 취소는
        // 자신의 lease만 반납하고, 마지막 owner가 사라질 때만 공유 wave를 중단한다.
        attempt.state.controller.signal.addEventListener('abort', () => {
            preparedCandidate.controller.abort();
            if (statefulSession) abortGooglePrimeWithoutMembers(statefulSession);
        }, {once: true});
    }
    // 请求必须在 spinner 插入前创建；微软 HTML 克隆和文本节点快照不能把
    // 插件自己的 loading 元素送到服务端。
    const requestProtectionOptions = getTranslationTextProtectionOptions(candidate.allowTopLevelApplicationShell, node);
    const queueSession = createTranslationQueueSession();
    const signal = attempt.state.controller.signal;
    const releaseRequestSession = bindFullPageRequestSessionAttempt(requestSession, attempt.state.controller);
    const cancelQueuedRequest = () => cancelTranslationQueueSession(queueSession, createAbortError());
    signal.addEventListener('abort', cancelQueuedRequest, {once: true});
    const request = createTranslationRequest(
        node,
        kind,
        displayMode,
        translationConfig,
        signal,
        queueSession,
        requestSession,
        requestProtectionOptions,
        forceFailedRequest,
        candidate.scope,
        preparedCandidate?.nativeGooglePrimeProof,
    )
        .finally(() => { signal.removeEventListener('abort', cancelQueuedRequest); releaseRequestSession(); });
    if (synthetic) node.setAttribute('data-fr-translation-segment', 'true');
    const cancelLoading = scheduleTranslationLoadingIndicator(node, attempt.state, Boolean(owner), isViewportCommitGroupEnabled());
    registerSessionStatefulTarget(statefulSession, candidate.element, node);
    const outcome = await renderTranslation(
        node,
        candidate,
        attempt,
        request.finally(cancelLoading),
        translationConfig,
        requestSession,
        requestCommitGeneration,
        requestOwner,
        viewportCommitTicket,
    ).finally(() => { if (statefulSession) scheduleFullPageProgressPublish(statefulSession); });
    if ((outcome.status === "stale" || outcome.status === "not-current" || outcome.status === "empty" || outcome.status === "deferred" ||
        outcome.status === "unchanged") && (!getTranslationState(node) || getTranslationState(node) === attempt.state)) {
        unregisterSessionStatefulTarget(statefulSession, node);
    }
    return outcome;
}

function candidateLifecycleSource(candidate: TranslationCandidate): string {
    try {
        const core = getCurrentTranslationCore(candidate.scope);
        const protectionOptions = getCandidateTranslationTextProtectionOptions(candidate);
        return normalizeComparableText(candidateSourceText(candidate, core, protectionOptions));
    } catch {
        return normalizeComparableText(candidate.element.textContent ?? "");
    }
}

function resolveFullPageRetryCandidate(
    candidate: TranslationCandidate,
    retryRoot?: Node,
): TranslationCandidate | null {
    const core = getCurrentTranslationCore(candidate.scope);
    const key = getTranslationCandidateKey(candidate);
    const starts = [retryRoot, key, candidate.element];
    const visited = new Set<Node>();

    for (const start of starts) {
        if (!start || visited.has(start) || !start.isConnected) continue;
        visited.add(start);
        const fresh = core.resolve(start);
        if (fresh?.element.isConnected) return fresh;
    }

    if (!candidate.element.isConnected) return null;
    return core.inspect(candidate.element).candidate ?? null;
}

function finalizeFullPageCandidate(
    session: FullPageSession,
    candidate: TranslationCandidate,
    outcome: TranslationTargetOutcome,
): void {
    const originalKey = getTranslationCandidateKey(candidate);

    // mutation 重启或更新的发现 generation 可能已替换 scheduled 条目；
    // 旧 provider 结果不能删除新 owner，也不能替它重新排队。
    if (!session.active || fullPageSession !== session || session.scheduled.get(originalKey) !== candidate) return;
    // 离开预取区只撤销此次 attempt；保留 IO 归属，重新进入后再派发。
    if (outcome.status === 'deferred') return;
    if (isViewportCommitGroupEnabled() && session.translationMode === 'viewport' && outcome.status === 'stale') {
        const anchor = session.candidateAnchors.get(originalKey);
        if (anchor && !isAnchorNearViewport(anchor)) return;
    }

    if (outcome.status !== "stale" && outcome.status !== "not-current" && outcome.status !== "empty") {
        session.lifecycleRetries.delete(originalKey);
        if (outcome.status === "unchanged") {
            if (outcome.attemptNode && session.statefulAttributeTimers.has(outcome.attemptNode)) {
                session.statefulAttributeRescanTargets.add(outcome.attemptNode);
            }
            session.unchangedCandidates.set(
                originalKey,
                createLifecycleRetry(candidate, outcome.source, 0, outcome.completion),
            );
        } else {
            session.unchangedCandidates.delete(originalKey);
        }
        forgetCandidate(session, candidate);
        return;
    }

    session.unchangedCandidates.delete(originalKey);

    // 新的悬浮/全文 generation 已拥有同一节点，其完成结果才是权威；
    // 旧 generation 不得重复发起请求。
    if (outcome.attemptNode && getTranslationState(outcome.attemptNode)) {
        session.lifecycleRetries.delete(originalKey);
        forgetCandidate(session, candidate);
        return;
    }

    // mutation 流水线会刻意防抖 class/style 变化，应保留这次唯一重扫，
    // 不要再用即时重试与其竞争。
    if (outcome.attemptNode && session.statefulAttributeTimers.has(outcome.attemptNode)) {
        session.statefulAttributeRescanTargets.add(outcome.attemptNode);
        forgetCandidate(session, candidate);
        return;
    }

    const fresh = resolveFullPageRetryCandidate(candidate, outcome.retryRoot);
    if (fresh && candidate.element.isConnected && (
        fresh.element !== candidate.element ||
        fresh.kind !== candidate.kind ||
        getTranslationCandidateKey(fresh) !== originalKey
    )) {
        // 同一实时 DOM 子树改变了语义所有权，这是新的 DOM generation；缓存身份
        // 已含完整原文。只有真正依赖周边内容的 AI 上下文结果需全量失效，普通
        // 服务继续按槽复用，避免一个局部 mutation 冲掉整页去重。
        invalidateContextSensitiveRequestCache(session);
    }
    const retryCandidate = fresh ?? candidate;
    const retryKey = fresh ? getTranslationCandidateKey(fresh) : originalKey;
    const source = candidateLifecycleSource(retryCandidate);
    const previous = session.lifecycleRetries.get(retryKey) ?? session.lifecycleRetries.get(originalKey);
    const attempts = sameLifecycleRetry(previous, retryCandidate, source)
        ? previous!.attempts + 1
        : 1;
    const retryState = createLifecycleRetry(retryCandidate, source, attempts);

    if (retryKey !== originalKey) session.lifecycleRetries.delete(originalKey);
    session.unchangedCandidates.delete(retryKey);
    session.lifecycleRetries.set(retryKey, retryState);
    forgetCandidate(session, candidate);

    if (attempts > FULL_PAGE_LIFECYCLE_RETRY_LIMIT) return;

    if (fresh) {
        scheduleDiscoveredCandidate(session, fresh);
        if (session.scheduled.get(retryKey) === fresh) {
            // 原候选已经通过可见性门禁，应直接重试新解析出的 owner；
            // 若 IntersectionObserver 不再派发，重新观察可能永远等待。
            queueFullPageCandidate(session, retryKey, fresh, candidateLifecycleSource(fresh));
            scheduleFullPageDrain(session);
        }
        return;
    }

    if (outcome.retryRoot?.isConnected) enqueueFullPageRescan(session, outcome.retryRoot);
}

function scheduleFullPageDrain(session: FullPageSession): void {
    if (!session.active || session.flushTimer !== null) return;
    session.flushTimer = window.setTimeout(() => {
        session.flushTimer = null;
        drainFullPage(session);
    }, session.scrollController.isScrolling ? 120 : 0);
}

function createViewportCommitTicket(session: FullPageSession, key: Node,
    group: ViewportCommitGroup<ViewportCommitEntry>, stopMotion: () => void): ViewportCommitTicket {
    let phase: 'pending' | 'staged' | 'complete' = 'pending';
    let resolve: ((outcome: TranslationTargetOutcome) => void) | undefined;
    let cancelPlan: (() => void) | undefined;
    const ticket: ViewportCommitTicket = {
        bindAttempt(cancel): void {cancelPlan = cancel;},
        isStaged: () => phase === 'staged',
        settleFailure(): void {
            if (phase === 'complete') return;
            stopMotion();
            phase = 'complete';
            session.viewportCommitTickets.delete(key);
            group.withdraw(key);
        },
        stage(node, plan): Promise<TranslationTargetOutcome> {
            if (phase !== 'pending') return Promise.resolve({status: session.active ? 'deferred' : 'stale'});
            phase = 'staged';
            cancelPlan = plan.cancel;
            session.inFlightCandidates.delete(key);
            scheduleFullPageProgressPublish(session);
            scheduleFullPageDrain(session);
            return new Promise<TranslationTargetOutcome>((done) => {
                resolve = done;
                group.settle(key, {
                    key,
                    node,
                    isCurrent: plan.isCurrent,
                    commit: plan.commit,
                    cancel: plan.cancel,
                    isActive: () => phase === 'staged' && session.active && fullPageSession === session,
                    resolve: done,
                });
            });
        },
        cancel(): void {
            stopMotion();
            if (phase === 'complete') return;
            phase = 'complete';
            session.inFlightCandidates.delete(key);
            session.viewportCommitTickets.delete(key);
            cancelPlan?.();
            resolve?.({status: session.active ? 'deferred' : 'stale'});
            group.withdraw(key);
        },
    };
    session.viewportCommitTickets.set(key, ticket);
    return ticket;
}

function createViewportCommitGroupForPlan(session: FullPageSession, plan: FullPageDispatchPlan): void {
    if (!isViewportCommitGroupEnabled() || session.translationMode !== 'viewport' ||
        !session.viewportCommitDiscoveryReady || session.viewportCommitTickets.size > 0) return;
    const visible = plan.candidates.filter(({priority}) => priority.band === 'visible');
    if (visible.length === 0) return;
    const motion = createViewportPendingMotion(visible.map(({candidate}) => candidate.element as HTMLElement), config.animations !== false);
    let group!: ViewportCommitGroup<ViewportCommitEntry>;
    group = createViewportCommitGroup((entries) => {
        motion.dispose();
        session.viewportCommitGroups.delete(group);
        const validEntries = entries.filter(entry =>
            entry.isActive() && session.active && fullPageSession === session && entry.isCurrent());
        entries.forEach(entry => {
            session.viewportCommitTickets.delete(entry.key);
            if (!validEntries.includes(entry)) {
                entry.cancel();
                entry.resolve({status: 'stale'});
            }
        });
        if (validEntries.length === 0) return;
        withFullPageViewportAnchor(() => {
            validEntries.forEach(entry => entry.resolve(entry.commit()));
        }, validEntries.map(({node}) => node));
    });
    session.viewportCommitGroups.add(group);
    visible.forEach(({key, candidate}) => {
        if (!session.viewportCommitTickets.has(key)) createViewportCommitTicket(session, key, group, () => motion.stop(candidate.element as HTMLElement));
        group.reserve(key);
    });
    group.seal();
}
function scheduleGooglePreparationSlice(session: FullPageSession): void {
    if (!session.active || session.prepareTimer !== null) return;
    session.prepareTimer = window.setTimeout(() => {
        session.prepareTimer = null;
        drainFullPage(session);
    }, 0);
}

function refreshFullPageModal(session: FullPageSession): void {
    refreshModalSession(session, {
        forget: candidate => forgetCandidate(session, candidate),
        unregister: target => unregisterSessionStatefulTarget(session, target),
        discover: candidate => scheduleDiscoveredCandidate(session, candidate),
        promote: (key, candidate) => refreshCandidateVisibilityBinding(session, key, candidate),
        rescan: root => enqueueFullPageRescan(session, root),
        publish: () => scheduleFullPageProgressPublish(session),
        drain: () => scheduleFullPageDrain(session),
    });
}

function drainFullPage(session: FullPageSession): void {
    if (!session.active || session.draining) return;
    if (isViewportCommitGroupEnabled() && session.translationMode === 'viewport' && !session.viewportCommitDiscoveryReady) {
        scheduleFullPageProgressPublish(session);
        return;
    }
    const scrolling = session.scrollController.isScrolling;
    refreshFullPageModal(session);
    session.draining = true;
    const maxConcurrent = normalizeMaxConcurrentTranslations(config.maxConcurrentTranslations);
    const startedAt = performance.now();
    let scrollingDispatches = 0;
    let needsAnotherSlice = false;
    const preparesGoogleViewport = shouldPrepareGoogleViewport(session);

    // Google viewport은 DOM lifecycle 전에 exact slot을 bounded batch로 prime한다.
    let plan: FullPageDispatchPlan | undefined;
    let prepared = !preparesGoogleViewport;
    let primingStarted = false;
    if (preparesGoogleViewport && session.pending.size > 0) {
        plan = ensureGoogleDispatchPlan(session, scrolling);
        prepared = prepareGoogleDispatchPlan(session, startedAt);
        if (prepared) primingStarted = primePreparedGoogleWave(session);
    }
    plan ??= session.pending.size > 0
        ? createFullPageDispatchPlan(session, {now: Date.now(), viewportHeight: window.innerHeight, visibleOnly: scrolling,
            isEligible: candidate => !session.modal || isWithinTranslationModal(session.modal, candidate.element),
            resolveSource: candidateLifecycleSource})
        : undefined;
    if (plan) createViewportCommitGroupForPlan(session, plan);
    // prime이 cache entry를 먼저 등록한 뒤에는 DOM lifecycle이 바로 그 promise를 소비한다.
    // 따라서 첫 frame에서도 사용자 maxConcurrent만큼 loading을 만들되 HTTP wave는 쪼개지 않는다.
    while (session.active && prepared
        && session.inFlightCandidates.size < maxConcurrent && session.pending.size > 0) {
        plan ??= preparesGoogleViewport
            ? ensureGoogleDispatchPlan(session, scrolling)
            : createFullPageDispatchPlan(session, {now: Date.now(), viewportHeight: window.innerHeight, visibleOnly: scrolling,
                isEligible: candidate => !session.modal || isWithinTranslationModal(session.modal, candidate.element),
                resolveSource: candidateLifecycleSource});
        const selection = plan.next();
        if (!selection) {
            if (preparesGoogleViewport) invalidateGoogleDispatchPlan(session);
            break;
        }
        const {key, candidate, priority} = selection;
        if (session.viewportCommitTickets.get(key)?.isStaged()) {
            removeFullPagePending(session, key, candidate);
            continue;
        }
        if (session.pendingMetadata.get(key)?.retryIsCurrent?.() === false) {
            forgetCandidate(session, candidate);
            continue;
        }
        const forceFailedRequest = session.pendingMetadata.get(key)?.forceFailedRequest === true;
        const viewportCommitTicket = session.viewportCommitTickets.get(key);
        removeFullPagePending(session, key, candidate);
        session.inFlightCandidates.set(key, candidate);
        if (priority.band === 'background') session.foregroundDispatchesSinceBackground = 0;
        else session.foregroundDispatchesSinceBackground += 1;
        void translateTarget(candidate, session.translationConfig.displayMode, !forceFailedRequest, session, undefined, forceFailedRequest,
            viewportCommitTicket)
            .then(
                (outcome) => {
                    if (outcome.status === 'failed') viewportCommitTicket?.settleFailure();
                    finalizeFullPageCandidate(session, candidate, outcome);
                },
                () => {
                    // 意外 runtime 异常保留原有终止行为；provider 失败会由
                    // translateTarget 显式表示，并在到达此处前渲染重试 UI。
                    forgetCandidate(session, candidate);
                },
            )
            .finally(() => {
                if (session.inFlightCandidates.get(key) === candidate) {
                    session.inFlightCandidates.delete(key);
                }
                if (session.active) {
                    scheduleFullPageProgressPublish(session);
                    scheduleFullPageDrain(session);
                }
            });
        // 每个 120ms 滚动批次最多三个可见候选，保留原生合批，仍受原并发上限与 8ms 切片约束。
        if ((scrolling && ++scrollingDispatches >= 3) || performance.now() - startedAt >= 8) {
            needsAnotherSlice = session.inFlightCandidates.size < maxConcurrent && session.pending.size > 0;
            break;
        }
    }
    session.draining = false;
    // 먼 영역 discovery가 다음 8ms slice를 예약해도 초기 Google 준비 cursor는 독립적으로
    // 이어져야 한다. 두 timer는 DOM을 쓰지 않는 bounded 작업이며 scroll/route invalidation이
    // 같은 session의 plan을 폐기한다.
    if (preparesGoogleViewport && !prepared && session.dispatchPlan
        && session.prepareCursor < session.dispatchPlan.candidates.length) {
        scheduleGooglePreparationSlice(session);
    }
    // body wave가 8ms preparation slice를 더 필요로 하면 title collector가 먼저 flush되어
    // Google HTTP gate를 점유할 수 있다. body가 전혀 없거나 이번 plan 준비가 끝난 뒤에만
    // fallback title을 시작한다. body wave를 만든 경로는 primePreparedGoogleWave()가 즉시 시작한다.
    const noPendingGoogleBody = session.pending.size === 0 && session.preparedCandidates.size === 0;
    if (preparesGoogleViewport && session.googleInitialWaveDiscoveryReady && !session.primedGoogleWave
        && (prepared || noPendingGoogleBody)) {
        startFullPageTitleTranslationIfNeeded(session);
    }
    if (primingStarted) scheduleFullPageDrain(session);
    if (needsAnotherSlice) scheduleFullPageDrain(session);
    scheduleFullPageProgressPublish(session);
}

function scheduleDiscoveredCandidate(session: FullPageSession, candidate: TranslationCandidate): void {
    const target = asHTMLElement(candidate.element);
    if (!session.active || !target || !target.isConnected) return;
    const key = getTranslationCandidateKey(candidate);
    if (isUserCancelledCandidate(session, candidate)) {
        // 用户显式取消后的恢复 mutation 仍会被全文会话观察到。丢弃重新发现的候选前
        // 必须移除旧队列条目，否则延迟的可见性回调会再次引入它。
        const queuedCandidate = session.scheduled.get(key);
        if (queuedCandidate) {
            forgetCandidate(session, queuedCandidate);
        } else if (session.pending.get(key) === candidate) {
            removeFullPagePending(session, key, candidate);
            removeCandidateObservation(session, key);
            scheduleFullPageProgressPublish(session);
        }
        return;
    }
    if (session.scope === 'all') {
        let ancestor = getComposedParent(target);
        while (ancestor) {
            const ancestorState = getTranslationState(ancestor as HTMLElement);
            if (ancestorState) {
                registerSessionStatefulTarget(session, ancestor as HTMLElement, ancestor as HTMLElement);
                return;
            }
            ancestor = getComposedParent(ancestor);
        }
    }
    const targetState = getTranslationState(target);
    if (targetState) {
        // 悬浮翻译可能在全文会话创建前提交此状态。只把它加入本会话的观察型祖先索引，
        // 不替换状态的 generation/controller 所有权，使祖先硬门禁仍能恢复它，
        // 正常会话清理也能删除该索引。
        registerSessionStatefulTarget(session, candidate.element, target);
        // 祖先 class/style mutation 可能改变翻译目标内实际可见的标签。发现流程仍会到达
        // 同一候选，因此安排防抖后的来源/文本槽检查，不静默跳过也不无条件重试。
        scheduleStatefulAttributeReevaluation(session, target);
        // loading/error/translated 对通用发现都属于终态；显式来源/结构 mutation
        // 会通过 observer 重新启动它们。
        return;
    }
    if (session.translationConfig.displayMode === 'bilingual' && blocksBilingualRemountCandidate(
        session.bilingualRemountCapitulations,
        target,
        candidateLifecycleSource(candidate),
        candidate.allowTopLevelApplicationShell === true,
        getTranslationInvocationIdentity(session.translationConfig),
        candidate.nodes,
        candidate.scope,
    )) return;
    const unchanged = session.unchangedCandidates.get(key);
    const cappedRetry = session.lifecycleRetries.get(key);
    if (unchanged || (cappedRetry && cappedRetry.attempts > FULL_PAGE_LIFECYCLE_RETRY_LIMIT)) {
        const source = candidateLifecycleSource(candidate);
        if (sameLifecycleRetry(unchanged ?? cappedRetry, candidate, source)) return;
        session.unchangedCandidates.delete(key);
        session.lifecycleRetries.delete(key);
    }

    // 很大的祖先仍在后续帧切片中发现时，精确后代可能已经完成。完成后 scheduled 条目会
    // 被有意遗忘，因此接受迟到的通用候选前还要检查共享 key 上的状态。
    const keyedTarget = asHTMLElement(key);
    if (keyedTarget && getTranslationState(keyedTarget)) {
        registerSessionStatefulTarget(session, candidate.element, keyedTarget);
        scheduleStatefulAttributeReevaluation(session, keyedTarget);
        return;
    }

    // 后序发现可能在祖先上产生通用行内段，而其首节点同时是精确 adapter 目标的 key。
    // 必须保留站点的显式决策，否则 GitHub 的 `.markdown-title` 候选会被合成父段替代，
    // 标题自身将永远无法拥有译文 wrapper。
    const existing = session.scheduled.get(key);
    if (existing) {
        if (selectPreferredTranslationCandidate(existing, candidate) === existing) {
            // 稳定候选可能比用作 IO 目标的已渲染后代存活更久；hydration 与显示变化
            // 必须刷新锚点，但不能替换 scheduled/pending 所有权。
            refreshCandidateVisibilityBinding(session, key, existing);
            return;
        }
        removeCandidateObservation(session, key);
        removeCandidateOwnerKey(session, existing.element, key);
        cancelPreparedCandidate(session, existing);
        if (session.pending.has(key)) {
            queueFullPageCandidate(session, key, candidate, candidateLifecycleSource(candidate));
        }
    }
    session.scheduled.set(key, candidate);
    addCandidateOwnerKey(session, target, key);
    refreshCandidateVisibilityBinding(session, key, candidate);
    scheduleFullPageProgressPublish(session);
}

/**
 * React/Vue 页面每个滚动帧可能产生数百个 style/class mutation。observer 回调
 * 保持 O(records)，合并重叠脏子树后以短任务发现，使宿主输入/滚动回调持续运行。
 */
function enqueueFullPageRescan(session: FullPageSession, changedNode: Node): void {
    if (!session.active) return;
    const root = changedNode.nodeType === 3 ? changedNode.parentElement : changedNode;
    if (!root) return;
    if (isElementNode(root) && !root.isConnected) return;

    const dirtyRoot: Node = root;

    // React/Reddit mutation 风暴期间限制单条记录的工作量；不相交根积累到一定数量后，
    // 一次增量根扫描比二次复杂度的两两合并更便宜，同时保持正确性。
    if (session.dirtyRootsBroadMode) {
        const collapsed = broadRescanRoot(dirtyRoot);
        session.dirtyRoots.add(collapsed);
        session.broadRescanRoots.add(collapsed);
    } else if (session.dirtyRoots.size >= 32) {
        const collapsedRoots = new Set<Node>(
            [...session.dirtyRoots, dirtyRoot].map(broadRescanRoot),
        );
        session.dirtyRoots.clear();
        collapsedRoots.forEach((collapsed) => {
            session.dirtyRoots.add(collapsed);
            session.broadRescanRoots.add(collapsed);
        });
        // 一轮突发越过合并阈值后，只加入其宽范围 Document/ShadowRoot，使新 mutation
        // 在本批完全排空前保持 O(1)；绝不丢弃另一棵 composed tree 的根。
        session.dirtyRootsBroadMode = true;
    } else {
        for (const existing of session.dirtyRoots) {
            if (nodeContains(existing, dirtyRoot)) return;
            if (nodeContains(dirtyRoot, existing)) session.dirtyRoots.delete(existing);
        }
        session.dirtyRoots.add(dirtyRoot);
    }
    if (session.mutationFlushTimer !== null) return;
    // 初始视口发现不是 mutation burst；立即进入 8ms 切片，不付 50ms debounce。
    const delay = isViewportCommitGroupEnabled() && session.translationMode === 'viewport'
        && !session.viewportCommitDiscoveryReady ? 0 : 50;
    session.mutationFlushTimer = window.setTimeout(() => flushMutationRescans(session), delay);
}

/** 扩大范围仅重建展示类型变化或新增可译 Text 槽的 owner，其余正文和在途请求保持不变。 */
function upgradeFullPageTargetScope(session: FullPageSession, target: HTMLElement, state: TranslationState): boolean {
    if (session.scope !== 'all' || state.scope === 'all') return false;
    const core = getCurrentTranslationCore('all');
    const changesKind = state.kind === 'content' && core.resolve(target)?.kind === 'control';
    const previousNodes = new Set(state.sourceTextNodes);
    const expandsText = collectLiveTranslationTextSlots(target, core.shouldStayOriginal,
        getTranslationStateProtectionBoundary(target, state),
        getTranslationTextProtectionOptions(state.allowTopLevelApplicationShell, target),
    ).some((slot) => !previousNodes.has(slot.node));
    if (!changesKind && !expandsText) return false;
    const root = state.syntheticSegment ? target.parentElement : target;
    unregisterSessionStatefulTarget(session, target);
    removeScheduledForStateTarget(session, target);
    withFullPageViewportAnchor(() => restoreTranslation(target), [target]);
    if (root?.isConnected) enqueueFullPageRescan(session, root);
    return true;
}

function flushMutationRescans(session: FullPageSession): void {
    session.mutationFlushTimer = null;
    if (!session.active) return;
    // 같은 generator의 다음 8ms slice는 이미 측정된 Google preparation cursor를 이어간다.
    // 새 discovery root는 activeDiscovery가 비어 있을 때만 새 plan을 요구한다.
    if (!session.activeDiscovery) invalidateGoogleDispatchPlan(session);
    const startedAt = performance.now();
    let nextDelay = 16;

    while (session.activeDiscovery || session.dirtyRoots.size > 0) {
        if (!session.activeDiscovery) {
            const iterator = session.dirtyRoots.values().next();
            const root = iterator.value as Node | undefined;
            if (!root) break;
            session.dirtyRoots.delete(root);
            if (isElementNode(root) && !root.isConnected) continue;
            const rescanNotBefore = session.broadRescanCooldowns.get(root) ?? 0;
            if (session.broadRescanRoots.has(root) && performance.now() < rescanNotBefore) {
                session.dirtyRoots.add(root);
                nextDelay = Math.max(16, rescanNotBefore - performance.now());
                break;
            }
            normalizeOrphanedTranslationArtifacts(root);
            normalizeOrphanedSingleSlots(root);
            if (isElementNode(root) && !root.isConnected) continue;
            session.activeDiscovery = {
                root,
                steps: getCurrentTranslationCore(session.scope).discoverSteps(root),
            };
        }

        const active = session.activeDiscovery;
        const step = active.steps.next();
        if (step.done) {
            if (session.broadRescanRoots.has(active.root)) {
                session.broadRescanCooldowns.set(active.root, performance.now() + BROAD_RESCAN_COOLDOWN_MS);
            }
            session.activeDiscovery = null;
            continue;
        }
        if (step.value.element.shadowRoot) observeFullPageRoot(session, step.value.element.shadowRoot);
        if (step.value.phase === "enter") {
            const statefulStepTarget = asHTMLElement(step.value.element);
            const statefulStepState = statefulStepTarget
                ? getTranslationState(statefulStepTarget)
                : undefined;
            if (statefulStepTarget && statefulStepState) {
                if (upgradeFullPageTargetScope(session, statefulStepTarget, statefulStepState)) continue;
                const candidateOwner = statefulStepState.syntheticSegment
                    ? asHTMLElement(statefulStepTarget.parentElement) ?? statefulStepTarget
                    : statefulStepTarget;
                registerSessionStatefulTarget(session, candidateOwner, statefulStepTarget);
                // 合成 owner 会被普通候选发现刻意硬剪枝；祖先 class/style 重扫时仍需
                // 复验其实时原文，避免标签可见性变化后长期漏译。
                scheduleStatefulAttributeReevaluation(session, statefulStepTarget);
            }
        }
        if (step.value.candidate) scheduleDiscoveredCandidate(session, step.value.candidate);

        // 첫 Google viewport wave는 전체 문서가 아니라 가까운 경계를 찾을 때까지만
        // 8ms slice를 이어간다. 이후에는 기존 16ms discovery cadence로 돌아간다.
        if (isViewportCommitGroupEnabled() && session.translationMode === 'viewport' && !session.viewportCommitDiscoveryReady) {
            nextDelay = 0;
        } else if (shouldPrepareGoogleViewport(session)) {
            nextDelay = session.googleInitialWaveDiscoveryReady ? 16 : 0;
        }

        // 每一步最多代表一个已访问元素；即使脏根覆盖整个 Reddit/Wikipedia DOM，
        // 也要在很小的帧预算后让出执行权。
        if (performance.now() - startedAt >= 8) break;
    }

    if (session.activeDiscovery || session.dirtyRoots.size > 0) {
        session.mutationFlushTimer = window.setTimeout(() => flushMutationRescans(session), nextDelay);
    } else {
        session.dirtyRootsBroadMode = false;
        if (shouldPrepareGoogleViewport(session)) releaseInitialGoogleVisibleWave(session);
        if (isViewportCommitGroupEnabled() && session.translationMode === 'viewport') {
            releaseInitialViewportCommitGroup(session);
        }
    }
    scheduleFullPageDrain(session);
}

function observeFullPageRoot(session: FullPageSession, root: Node): void {
    if (session.roots.has(root)) return;
    session.roots.add(root);
    session.modalDirty = true;
    session.mutationObserver.observe(root, createTranslationMutationObserverOptions(getCurrentTranslationCore(session.scope).adapters));
}

function createFullPageSession(
    root: HTMLElement,
    invocation: PageTranslationInvocation = {},
    inheritedConfig?: FullPageTranslationConfigSnapshot,
): FullPageSession {
    let session!: FullPageSession;
    const observer = new IntersectionObserver((entries) => {
        if (!session.active || fullPageSession !== session) return;
        for (const entry of entries) {
            const node = entry.target as HTMLElement;
            const candidates = session.observedCandidates.get(node);
            if (!candidates) continue;
            if (entry.isIntersecting) session.visibleCandidateAnchors.add(node);
            else session.visibleCandidateAnchors.delete(node);
            candidates.forEach((candidate, key) => {
                if (entry.isIntersecting && (!isViewportCommitGroupEnabled() || session.translationMode !== 'viewport' || session.viewportCommitDiscoveryReady)) {
                    queueFullPageCandidate(session, key, candidate, candidateLifecycleSource(candidate));
                } else {
                    // 快速划过的内容退出预取区后继续观察，等再次进入时才派发。
                    // 已交给 DOM 的请求继续；尚未消费的预准备则撤销，立即归还 32 槽/10k 预算。
                    removeFullPagePending(session, key, candidate);
                    session.viewportCommitTickets.get(key)?.cancel();
                    if (!session.preparedCandidates.get(key)?.consumed) cancelPreparedCandidate(session, candidate);
                }
            });
        }
        invalidateGoogleDispatchPlan(session);
        scheduleFullPageProgressPublish(session);
        scheduleFullPageDrain(session);
    }, {
        root: null,
        rootMargin: `${FULL_PAGE_PREFETCH_MARGIN_PX}px 0px`,
        threshold: 0.01,
    });
    const mutationObserver = createFullPageMutationObserver(() => session);
    const scrollController = createFullPageScrollController({
        isActive: () => session.active && fullPageSession === session,
        onIdle: (targets) => {
            targets.forEach((target) => {
                if (getTranslationState(target)) restartStatefulTarget(session, target);
            });
            if (session.dirtyRoots.size > 0 && session.mutationFlushTimer === null) {
                session.mutationFlushTimer = window.setTimeout(
                    () => flushMutationRescans(session),
                    0,
                );
            }
        },
        afterIdle: () => scheduleFullPageDrain(session),
    });

    session = {
        active: true,
        modal: null,
        modalDirty: true,
        translationMode: invocation.fullPageMode ?? config.fullPageTranslationMode,
        scope: invocation.scope ?? config.translationScope,
        translationConfig: inheritedConfig ? {...inheritedConfig} : captureFullPageTranslationConfig(invocation),
        progressSessionId: startFullPageTranslationProgress(),
        progressPublishScheduled: false,
        outcomes: createFullPageOutcomeRegistry<HTMLElement>(),
        unsubscribeOutcomeChanges: () => {},
        observer,
        mutationObserver,
        shadowEventController: new AbortController(),
        roots: new Set(),
        ...createFullPageQueueState(),
        scheduled: new Map(),
        observedCandidates: new Map(),
        visibleCandidateAnchors: new WeakSet(),
        candidateOwnerKeys: new Map(),
        statefulTargetsByAncestor: new Map(),
        statefulAncestorsByTarget: new WeakMap(),
        lifecycleRetries: new WeakMap(),
        unchangedCandidates: new WeakMap(),
        userCancelledCandidates: new WeakMap(),
        inFlightCandidates: new Map(),
        scrollController,
        bilingualRemountCapitulations: createBilingualRemountCapitulationRegistry(),
        translationSlotCache: new Map(),
        preparedCandidates: new Map(),
        preparedSlots: 0,
        preparedEscapedCharacters: 0,
        dispatchPlan: null,
        prepareCursor: 0,
        prepareTimer: null,
        primedGoogleWave: null,
        primedGoogleWaveController: null,
        primedGoogleWaveMembers: null,
        googleInitialWaveDiscoveryReady: false,
        googleInitialWaveSawVisible: false,
        viewportCommitDiscoveryReady: false,
        viewportCommitGroups: new Set(),
        viewportCommitTickets: new Map(),
        titleTranslationStarted: false,
        ...createFullPageRequestSessionState(),
        draining: false,
        flushTimer: null,
        dirtyRoots: new Set(),
        mutationFlushTimer: null,
        activeDiscovery: null,
        broadRescanRoots: new WeakSet([root]),
        broadRescanCooldowns: new WeakMap(),
        dirtyRootsBroadMode: false,
        pruneTimer: null,
        pruneIterator: null,
        pruneRequested: false,
        statefulAttributeTimers: new Map(),
        statefulAttributeRescanTargets: new WeakSet(),
    };
    session.unsubscribeOutcomeChanges = bindFullPageOutcomeRecovery(session,
        () => fullPageSession === session, () => scheduleFullPageProgressPublish(session));
    return session;
}

function disposeFullPageSession(session: FullPageSession): void {
    session.active = false;
    session.unsubscribeOutcomeChanges();
    session.outcomes.clear();
    syncModalTranslationHint(null, 'none', false);
    session.modal = null;
    session.modalDirty = false;
    disposeFullPageRequestSession(session, createAbortError());
    if (session.flushTimer !== null) window.clearTimeout(session.flushTimer);
    if (session.prepareTimer !== null) window.clearTimeout(session.prepareTimer);
    if (session.mutationFlushTimer !== null) window.clearTimeout(session.mutationFlushTimer);
    if (session.pruneTimer !== null) window.clearTimeout(session.pruneTimer);
    session.scrollController.dispose();
    translationSourceStability.dispose(session);
    session.statefulAttributeTimers.forEach(({timer, boundaryTimer}) => {
        window.clearTimeout(timer);
        if (boundaryTimer !== undefined) window.clearTimeout(boundaryTimer);
    });
    session.observer.disconnect();
    session.mutationObserver.disconnect();
    session.shadowEventController.abort();
    session.roots.clear();
    clearFullPageQueueState(session);
    session.scheduled.clear();
    session.observedCandidates.clear();
    session.visibleCandidateAnchors = new WeakSet();
    session.candidateOwnerKeys.clear();
    session.statefulTargetsByAncestor.clear();
    session.statefulAncestorsByTarget = new WeakMap();
    session.inFlightCandidates.clear();
    session.userCancelledCandidates = new WeakMap();
    session.translationSlotCache.clear();
    session.viewportCommitTickets.forEach(ticket => ticket.cancel());
    session.viewportCommitGroups.forEach(group => group.dispose());
    session.viewportCommitTickets.clear();
    session.viewportCommitGroups.clear();
    clearPreparedCandidates(session);
    session.primedGoogleWave = null;
    session.primedGoogleWaveController = null;
    session.primedGoogleWaveMembers = null;
    invalidateGoogleDispatchPlan(session);
    session.dirtyRoots.clear();
    session.dirtyRootsBroadMode = false;
    session.activeDiscovery = null;
    session.pruneIterator = null;
    session.pruneRequested = false;
    session.statefulAttributeTimers.clear();
    session.statefulAttributeRescanTargets = new WeakSet();
    finishFullPageTranslationProgress(session.progressSessionId);
}

function stopFullPageSession(): void {
    const session = fullPageSession;
    if (!session) return;
    fullPageSession = null;
    disposeFullPageSession(session);
}
export function invalidateFullPageTranslationSessionCache(): void { if (fullPageSession?.active) invalidateFullPageRequestSessionCache(fullPageSession); }
/** 新路由取消旧请求并重扫当前 DOM；旧页面的熔断和无需变更判定不能压住新页面。 */
export function resetFullPageTranslationRouteState(): void {
    cancelPendingHoverTranslation();
    translationSourceStability.reset();
    hoverBilingualRemountCapitulations = createBilingualRemountCapitulationRegistry();
    invalidateHoverTranslationRequestSession();
    if (fullPageSession?.active) {
        clearPreparedCandidates(fullPageSession);
        fullPageSession.primedGoogleWave = null;
        fullPageSession.primedGoogleWaveController = null;
        fullPageSession.primedGoogleWaveMembers = null;
        fullPageSession.googleInitialWaveDiscoveryReady = false;
        fullPageSession.googleInitialWaveSawVisible = false;
        fullPageSession.viewportCommitDiscoveryReady = false;
        fullPageSession.viewportCommitTickets.forEach(ticket => ticket.cancel());
        fullPageSession.viewportCommitGroups.forEach(group => group.dispose());
        fullPageSession.viewportCommitTickets.clear();
        fullPageSession.viewportCommitGroups.clear();
        invalidateGoogleDispatchPlan(fullPageSession);
    }
    resetFullPageRouteSession(fullPageSession, document.documentElement, {
        observe: observeFullPageRoot,
        rescan: enqueueFullPageRescan,
    });
    resetAllBilingualArtifactHostWriteBudgets();
}

/**
 * 恢复全文翻译。全文和悬浮翻译共享同一份节点状态，因此这里无需再用
 * data-fr-node-id + innerHTML 覆盖页面，也能处理 Shadow DOM 和动态节点。
 */
export function restoreOriginalContent(): void {
    cancelPendingHoverTranslation();
    stopFullPageTitleTranslation();
    stopFullPageSession(); resetHoverTranslationRequestSession(createAbortError());
    hoverBilingualRemountCapitulations = createBilingualRemountCapitulationRegistry();
    restorePageTranslationContent();
    notifyFullPageTranslationState(false);
}

/**
 * 启动全文翻译会话：根固定为 documentElement，使用较大的预取窗口和并发
 * 限制，并持续观察新增 DOM/open ShadowRoot。这样 body 被 SPA 替换后仍能
 * 继续工作，也不会一次性给整页发出数百个请求。
 */
export function autoTranslateEnglishPage(invocation: PageTranslationInvocation = {}, inheritedConfig?: FullPageTranslationConfigSnapshot): void {
    if (!checkConfig(invocation) || fullPageSession?.active) return;
    const root = document.documentElement;
    if (!root) return;

    const session = createFullPageSession(root, invocation, inheritedConfig);
    fullPageSession = session;
    // 标题不在正文候选范围内（<head> 属硬裁剪标签），单独随会话翻译并跟随 SPA 改写；
    // 高级设置可关闭，关闭后标签页保持原标题。
    if (!shouldPrepareGoogleViewport(session)) startFullPageTitleTranslationIfNeeded(session);
    document.addEventListener('fluentread-open-shadow-root', (event) => {
        if (!session.active || fullPageSession !== session) return;
        const host = isElementNode(event.target as Node) ? event.target as Element : null;
        const shadowRoot = host?.shadowRoot;
        if (!shadowRoot) return;
        observeFullPageRoot(session, shadowRoot);
        enqueueFullPageRescan(session, shadowRoot);
        refreshFullPageModal(session);
    }, {capture: true, signal: session.shadowEventController.signal});
    document.addEventListener('scroll', () => noteFullPageScroll(session, () => session.active && fullPageSession === session,
        () => {session.scrollController.note(); invalidateGoogleDispatchPlan(session); scheduleFullPageDrain(session);}), {
        capture: true,
        passive: true,
        signal: session.shadowEventController.signal,
    });
    const refreshModal = () => {
        if (!session.active || fullPageSession !== session) return;
        session.modalDirty = true;
        refreshFullPageModal(session);
    };
    // close 不冒泡，capture 覆盖原生 dialog；CSS 过渡结束补足尚无尺寸的入场帧。
    // 事件仅触发只读复验，不能凭合成 close 事件放行仍打开的公告。
    for (const event of ['close', 'toggle', 'transitionend', 'animationend']) {
        document.addEventListener(event, refreshModal, {capture: true, signal: session.shadowEventController.signal});
    }
    window.addEventListener('resize', () => {invalidateGoogleDispatchPlan(session); refreshModal(); scheduleFullPageDrain(session);},
        {passive: true, signal: session.shadowEventController.signal});
    observeFullPageRoot(session, root);
    for (const shadowRoot of getOpenShadowRoots(root)) observeFullPageRoot(session, shadowRoot);
    refreshFullPageModal(session);
    enqueueFullPageRescan(session, root);
    notifyFullPageTranslationState(true);
}
/** 仅共享无凭据的会话快照；旧 QQ 邮件 frame 使用同一目标语言、服务和展示设置。 */
export function getFullPageTranslationFrameState(): Omit<FrameTranslationState, 'enabled'> {
    const session = fullPageSession?.active ? fullPageSession : null;
    const revision = getFullPageTranslationStateRevision();
    return session ? {revision, sessionId: session.progressSessionId, translationConfig: {...session.translationConfig}, fullPageMode: session.translationMode, scope: session.scope} : {revision, sessionId: null};
}
/** Reads only the exact current owner; missing evidence is never a completion claim. */
export function readFullPageUnchangedCompletion(owner: HTMLElement, sessionId: number, source: string) {
    const session = fullPageSession?.active ? fullPageSession : undefined;
    return readAcceptedUnchangedCompletion(owner, session?.unchangedCandidates.get(owner), {
        sessionId, currentSessionId: session?.progressSessionId, renderCommitGeneration: session?.renderCommitGeneration,
        configIdentity: session && getTranslationInvocationIdentity(session.translationConfig), source,
        cancelled: session?.userCancelledCandidates.has(owner) === true,
    });
}
export function isFullPageTranslationActive(): boolean {
    return fullPageSession?.active === true;
}
/** 局部恢复单个译文所有者；全文会话仍在时记为用户取消，避免滚动或 DOM 变化后被自动重译。 */
export function restoreTranslationOwner(owner: HTMLElement): boolean { const state = getTranslationState(owner), session = fullPageSession?.active ? fullPageSession : undefined; if (!state) return false;
    resetPageDiscourseContext();
    if (session) rememberUserCancelledCandidate(session, {element: owner, kind: state.kind, reason: 'section-restore', ...(state.syntheticSegment && state.sourceTextNodes?.length ? {nodes: state.sourceTextNodes} : {})}, owner, state);
    unregisterSessionStatefulTarget(session, owner); return withFullPageViewportAnchor(() => restoreTranslation(owner), [owner]); }
export function cancelPendingHoverTranslation(): void {
    hoverTranslationScheduler.cancel();
}
/**
 * 处理鼠标悬浮/快捷键翻译。坐标只负责找到内容块，真正的翻译调用与全文
 * 会话共用 translateTarget，因此按钮、富文本和恢复行为不会出现两套规则。
 */
export function handleTranslation(
    mouseX: number,
    mouseY: number,
    invocation: HoverTranslationInvocation = {},
): void {
    hoverTranslationScheduler.handle(mouseX, mouseY, invocation);
}

export function handleBilingualTranslation(node: unknown, slide: boolean): void {
    translateNode(node, "bilingual", slide);
}
