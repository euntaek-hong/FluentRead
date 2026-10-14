/**
 * @file src/features/full-page-translation/content/mutationRuntime.ts
 * 文件职责：组织动态正文的观察、来源变化重试和分片回收。
 * 主要内容：过滤自身 DOM 变更，复验宿主属性和文本槽，分片回收失联候选并协调重扫与重试。
 * 模块边界：不持有全局会话，不实现 provider 请求或用户配置。
 */
import {getComposedParent, getCurrentTranslationCore, getTranslationCandidateKey} from "@/src/core/translation/public";
import type {TranslationCandidate} from "@/src/core/translation/public";
import {ensureTranslationTruncationLayout} from "@/src/features/full-page-translation/content/layout";
import {stabilizeBilingualArtifact, type RemovedTranslationOwnerResolver} from '@/src/features/full-page-translation/content/bilingualRemount';
import {refreshBilingualTranslationSkeleton} from '@/src/features/full-page-translation/content/bilingualReplay';
import {detachFailedTranslationUi, discardTranslation, getTranslationState, getTranslationOwnersForRemovedNode, restoreTranslation, isTranslationLayoutOverrideMutation, type TranslationState} from "@/src/features/full-page-translation/content/state";
import {withFullPageViewportAnchor} from '@/src/features/full-page-translation/content/viewportStability';
import {canKeepTranslationAttempt, isTranslationStateCandidateCurrent, createTranslationMutationStabilityChecks, isTranslationStateSourceCurrent as attemptSourceIsCurrent, TRANSLATION_ARTIFACT_SELECTOR, getCurrentTranslationStateTextNodes, hasCurrentTranslationSource, isOwnCurrentArtifactAddition, isOwnStateArtifactMutation, isOwnSingleTextSlotMove, isTranslationArtifactCurrent, isTranslationArtifact, mutationTouchesCurrentTranslationArtifact, statefulSourceAndTextSlotsAreCurrent} from '@/src/features/full-page-translation/content/translationStability';
import {consumeOrphanedOwnerClassMutation, isTextEquivalentHostReplacement} from '@/src/features/full-page-translation/content/orphanArtifacts';
import {invalidateContextSensitiveRequestCache} from '@/src/features/full-page-translation/content/requestSession';
import {getSiteAdapterAttributeFilter} from '@/src/core/site-adaptation/compiler';
import {isElementNode, asHTMLElement, mutationTargetElement, allMutationNodesMatch, createTranslationAttributeMutationFilter, isOwnSyntheticSegmentMarkerMutation} from './mutationObservation';
import {mayChangeTranslationModal} from './modalPriority';
import {createAttributeMutationBatch} from './attributeMutationBatch';
import type {FullPageSession} from './sessionTypes';
export interface FullPageMutationPorts {
    forgetCandidate: (session: FullPageSession | undefined, candidate: TranslationCandidate) => void;
    refreshCandidateVisibilityBinding: (session: FullPageSession, key: Node, candidate: TranslationCandidate) => void;
    unregisterSessionStatefulTarget: (session: FullPageSession | undefined, target: HTMLElement, preserveOutcome?: boolean) => void;
    registerSessionStatefulTarget: (session: FullPageSession | undefined, candidateOwner: HTMLElement, target: HTMLElement) => void;
    enqueueFullPageRescan: (session: FullPageSession, changedNode: Node) => void;
    transferEquivalentBilingualOwners: (session: FullPageSession | undefined, mutations: readonly MutationRecord[]) => RemovedTranslationOwnerResolver;
    refreshFullPageModal: (session: FullPageSession) => void;
    getCurrentSession(): FullPageSession | null;
}
export function createFullPageMutationRuntime(ports: FullPageMutationPorts) {
    const {forgetCandidate, refreshCandidateVisibilityBinding, unregisterSessionStatefulTarget, registerSessionStatefulTarget, enqueueFullPageRescan, transferEquivalentBilingualOwners, refreshFullPageModal, getCurrentSession} = ports;
    const CANDIDATE_PRUNE_BUDGET_MS = 4;
    const STATEFUL_ATTRIBUTE_DEBOUNCE_MS = 500;
function resolveStatefulMutationTarget(element: Element): HTMLElement | false {
    let current: Element | null = element;
    while (current) {
        const htmlCurrent = asHTMLElement(current);
        if (htmlCurrent && getTranslationState(htmlCurrent)) return htmlCurrent;
        current = current.parentElement;
    }
    return false;
}

/**
 * materialize 的 childList 可在延迟 spinner 创建前送达；尚未创建允许零产物，已登记则必须保持唯一归属。
 * 这些真实 childList 记录会在 beginTranslation 之后、异步 provider 仍待完成时送达。
 * 只有本 generation 捕获的精确来源所有权、HTML 和 Text 槽身份都保持完整时才接受；
 * 任何宿主插入（包括伪装成 FluentRead 产物的节点）都必然无法通过至少一项检查，
 * 并继续进入 stale/重启路径。
 */
function isIntactLoadingSyntheticChildList(
    target: HTMLElement,
    state: TranslationState,
): boolean {
    if (!state.syntheticSegment || !target.matches('[data-fr-translation-segment="true"]')) return false;
    const spinner = state.spinner;
    if (spinner !== undefined && (spinner.parentNode !== target || !spinner.matches('[data-fr-translation-owned="true"]'))) return false;

    const expectedSourceNodes = state.syntheticSourceNodes;
    if (!expectedSourceNodes) return false;
    const currentSourceNodes = Array.from(target.childNodes).filter((node) => node !== spinner);
    if (currentSourceNodes.length !== expectedSourceNodes.length ||
        currentSourceNodes.some((node, index) => node !== expectedSourceNodes[index])) return false;

    const artifacts = Array.from(target.querySelectorAll(TRANSLATION_ARTIFACT_SELECTOR));
    if (artifacts.length !== (spinner === undefined ? 0 : 1) || (spinner !== undefined && artifacts[0] !== spinner)) return false;

    const sourceClone = target.cloneNode(false) as HTMLElement;
    currentSourceNodes.forEach((node) => sourceClone.appendChild(node.cloneNode(true)));
    if (sourceClone.innerHTML !== state.sourceHTML) return false;

    const expectedTextNodes = state.sourceTextNodes ?? [];
    const currentTextNodes = getCurrentTranslationStateTextNodes(target, state);
    return currentTextNodes.length === expectedTextNodes.length &&
        currentTextNodes.every((node, index) => node === expectedTextNodes[index]);
}

function isOwnMutation(
    mutation: MutationRecord,
    loadingSyntheticChecks: WeakMap<TranslationState, boolean>,
): boolean {
    const mutationElement = mutationTargetElement(mutation.target);
    // 框架在 hover/render 时会重复写入相同属性。相同值没有来源或展示变化，
    // 不能让一次 setAttribute 事务把控件/仅译文恢复后再从缓存重新渲染。
    // oldValue 为 null 时仍走完整复验，兼容不提供旧值的观察器实现。
    if (mutation.type === "attributes" && mutationElement && mutation.attributeName &&
        mutation.oldValue !== null &&
        mutation.oldValue === mutationElement.getAttribute(mutation.attributeName)) return true;
    if (mutation.type === "attributes" && mutationElement && (
        (mutation.attributeName === "style" && isTranslationLayoutOverrideMutation(mutationElement as HTMLElement)) ||
        (mutation.attributeName === "class" && consumeOrphanedOwnerClassMutation(mutationElement as HTMLElement)))) return true;
    // 不能用“位于任意插件节点内”作为判断：站点可能直接改写双语 wrapper
    // 的文本，必须让这类 mutation 进入 stale/retranslate 分支。加载/错误节点
    // 没有宿主正文，才可以直接视为插件自身变化。
    if (mutation.type !== "childList" &&
        isElementNode(mutation.target) &&
        mutation.target.matches('[data-fr-translation-owned="true"]') &&
        !mutation.target.matches('.fluent-read-bilingual-content')) return true;
    const target = mutationElement ? resolveStatefulMutationTarget(mutationElement) : false;
    const state = target ? getTranslationState(target as HTMLElement) : undefined;
    if (!target || !state) return false;
    if (isOwnSyntheticSegmentMarkerMutation(mutation, target, state,
        () => statefulSourceAndTextSlotsAreCurrent(target, state))) return true;
    if (isOwnStateArtifactMutation(mutation, target, state)) return true;
    if (state.phase === "error") {
        // 失败 UI 是扩展拥有的状态，不是宿主编辑；若缺少此分支，其 class mutation
        // 会恢复并重扫目标，使永久 provider 错误变成自动无限重试。
        if (mutation.type === "attributes" && mutationElement === target && mutation.attributeName === "class") {
            return target.getAttribute("class") === state.renderedClassAttribute;
        }
        if (mutation.type === "attributes" && mutationElement === target && mutation.attributeName === "style") {
            return target.getAttribute("style") === state.renderedStyleAttribute;
        }
        if (mutation.type === "childList") {
            return allMutationNodesMatch(mutation, isTranslationArtifact) &&
                mutationElement === target &&
                state.retryWrapper?.parentNode === target;
        }
        return false;
    }
    if (state.phase === "loading") {
        // 手动重试会在 beginTranslation 创建下一 generation 前立即移除旧失败 class。
        // mutation 异步送达，因此需依据新快照识别这次清理。
        if (mutation.type === "attributes" && mutationElement === target && mutation.attributeName === "class") {
            return target.getAttribute("class") === state.originalClassAttribute;
        }
        if (mutation.type === "attributes" && mutationElement === target && mutation.attributeName === "style") {
            return target.getAttribute("style") === state.originalStyleAttribute;
        }
        if (mutation.type === "childList" && mutationElement === target) {
            const cached = loadingSyntheticChecks.get(state);
            if (cached !== undefined) return cached;
            const intact = isIntactLoadingSyntheticChildList(target, state);
            loadingSyntheticChecks.set(state, intact);
            return intact;
        }
        return false;
    }
    if (state.phase !== "translated") return false;
    if (isOwnSingleTextSlotMove(mutation, target, state)) return true;
    if (state.mode === "single" && mutation.type === "characterData") {
        const textNode = mutation.target as Text;
        return state.textSlotsApplied === true &&
            state.translatedTextValues?.get(textNode) === (textNode.nodeValue ?? "");
    }
    if (state.bilingualContent?.isConnected) {
        const wrapper = state.bilingualContent;
        const mutationParent = isElementNode(mutation.target)
            ? mutation.target
            : mutation.target.parentElement;

        // wrapper 内部的变化只有在内容仍等于插件最后写入的快照时才算插件自身；
        // 如果站点脚本改写了译文，必须让后续分支恢复并重新排队。
        if (mutationParent && (mutationParent === wrapper || wrapper.contains(mutationParent))) {
            return wrapper.outerHTML === state.bilingualOuterHTML;
        }

        // 插件会先插入 loading，完成后再移除 loading 并插入译文 wrapper。
        // 这两类 childList mutation 都可能落在宿主节点上；只要所有增删节点
        // 都是扩展 artifact，且插件自己的最终快照仍然存在，就不能触发重译。
        // 若 wrapper 已被宿主移除，则保留 false，让后续逻辑恢复并重新排队。
        if (mutation.type === "childList" && allMutationNodesMatch(mutation, isTranslationArtifact)) {
            return state.bilingualContent?.parentNode === target &&
                state.bilingualContent.outerHTML === state.bilingualOuterHTML;
        }

        // 双语渲染会临时修改宿主节点的 style；只有值仍是插件记录的值时才忽略。
        if (mutation.type === "attributes" && mutationElement === target && mutation.attributeName === "style") {
            return target.getAttribute("style") === state.renderedStyleAttribute;
        }
        if (mutation.type === "attributes" && mutationElement === target && mutation.attributeName === "class") {
            return target.getAttribute("class") === state.renderedClassAttribute;
        }
    }
    return isOwnCurrentArtifactAddition(mutation, state);
}

function removeScheduledForStateTarget(session: FullPageSession, target: HTMLElement): void {
    const state = getTranslationState(target);
    const host = state?.syntheticSegment ? target.parentElement : target;
    const candidateElements = new Set<HTMLElement>([target]);
    if (host) candidateElements.add(host);
    for (const element of candidateElements) {
        const keys = session.candidateOwnerKeys.get(element);
        if (!keys) continue;
        for (const key of Array.from(keys)) {
            const candidate = session.scheduled.get(key);
            if (!candidate) continue;
            const matches = candidate.element === target || candidate.element === host ||
                Boolean(candidate.nodes?.some((node) => target.contains(node)));
            if (matches) forgetCandidate(session, candidate);
        }
    }
}

function runDisconnectedCandidatePrune(session: FullPageSession): void {
    session.pruneTimer = null;
    if (!session.active) return;
    if (!session.pruneIterator) {
        session.pruneIterator = session.scheduled.values();
        session.pruneRequested = false;
    }
    const startedAt = performance.now();

    while (session.pruneIterator) {
        const next = session.pruneIterator.next();
        if (next.done) {
            session.pruneIterator = null;
            if (session.pruneRequested && session.pruneTimer === null) {
                session.pruneTimer = window.setTimeout(() => runDisconnectedCandidatePrune(session), 0);
            }
            return;
        }
        const candidate = next.value;
        if (!candidate.element.isConnected || candidate.nodes?.some((node) => !node.isConnected)) {
            forgetCandidate(session, candidate);
        } else {
            const key = getTranslationCandidateKey(candidate);
            const anchor = session.candidateAnchors.get(key);
            if (anchor && !anchor.isConnected) {
                refreshCandidateVisibilityBinding(session, key, candidate);
            }
        }
        if (performance.now() - startedAt >= CANDIDATE_PRUNE_BUDGET_MS) break;
    }

    if (session.pruneIterator && session.pruneTimer === null) {
        session.pruneTimer = window.setTimeout(() => runDisconnectedCandidatePrune(session), 16);
    }
}

function scheduleDisconnectedCandidatePrune(session: FullPageSession): void {
    if (!session.active) return;
    session.pruneRequested = true;
    if (session.pruneTimer !== null || session.pruneIterator) return;
    session.pruneTimer = window.setTimeout(() => runDisconnectedCandidatePrune(session), 0);
}

function discardOwnersRemovedByHost(
    session: FullPageSession,
    removedNodes: readonly Node[],
    resolveRemovedOwners: RemovedTranslationOwnerResolver = getTranslationOwnersForRemovedNode,
    beforeHostWrite?: () => void,
): {removedAny: boolean; shouldRescan: boolean} {
    const owners = new Set<HTMLElement>();
    let shouldRescan = false;
    removedNodes.forEach((removed) => {
        const syntheticParent = removed.parentElement;
        const syntheticState = syntheticParent?.matches('[data-fr-translation-segment="true"]')
            ? getTranslationState(syntheticParent as HTMLElement)
            : undefined;
        // materializeCandidate 会在 MutationObserver 送达前把直属行内段移入自有片段；
        // 后代翻译 owner 仍存活于该精确片段中，不能当作宿主删除。
        if (removed.isConnected && syntheticState?.syntheticSegment === true) return;
        resolveRemovedOwners(removed).forEach((owner) => owners.add(owner));
    });
    if (owners.size > 0) beforeHostWrite?.();
    owners.forEach((owner) => {
        const state = getTranslationState(owner);
        if (!state) {
            unregisterSessionStatefulTarget(session, owner);
            return;
        }
        const removedOnlyFailureUi = state.phase === "error" &&
            owner.isConnected &&
            Boolean(state.retryWrapper) &&
            removedNodes.length === 1 &&
            removedNodes[0] === state.retryWrapper;
        const attributeTimer = session.statefulAttributeTimers.get(owner);
        if (attributeTimer !== undefined) {
            window.clearTimeout(attributeTimer.timer);
            if (attributeTimer.boundaryTimer !== undefined) window.clearTimeout(attributeTimer.boundaryTimer);
            session.statefulAttributeTimers.delete(owner);
        }
        session.statefulAttributeRescanTargets.delete(owner);
        if (removedOnlyFailureUi) {
            // 保留错误墓碑；否则框架移除重试子节点后，下一次无关 mutation 会永远
            // 自动请求同一个持续失败的 provider。
            removeScheduledForStateTarget(session, owner);
            detachFailedTranslationUi(owner, state);
            return;
        }
        const disposition = state.phase === 'translated' && state.mode === 'bilingual' && state.kind === 'content'
            ? stabilizeBilingualArtifact(owner, state, session.bilingualRemountCapitulations, ensureTranslationTruncationLayout) : 'retry';
        if (disposition === 'current') return;
        if (disposition === 'capitulated') {
            unregisterSessionStatefulTarget(session, owner);
            removeScheduledForStateTarget(session, owner);
            withFullPageViewportAnchor(() => discardTranslation(owner, state), [owner]);
            shouldRescan = true;
            return;
        }
        if (canKeepTranslationAttempt(owner, state, attemptSourceIsCurrent,
            statefulSourceAndTextSlotsAreCurrent)) {
            // 虚拟列表可能在请求仍进行时替换 spinner 或来源 Text，但当前
            // tweet/段落的语义原文没有变化。保留当前 generation，让结果提交到
            // 新的实时 DOM；否则每次滚动都会先 abort 再重新翻译。
            return;
        }
        if (session.scrollController.defer(owner)) {
            // 滚动期间虚拟列表可能暂时拆掉当前 wrapper/来源节点。把重启推迟到
            // scroll idle，避免用户看到原文、译文来回闪烁并避免取消正在进行的请求。
            return;
        }
        unregisterSessionStatefulTarget(session, owner);
        shouldRescan = true;
        removeScheduledForStateTarget(session, owner);
        // 宿主删除具有权威性：清除扩展状态/产物，但不重新挂回框架有意移除的旧来源节点。
        withFullPageViewportAnchor(() => discardTranslation(owner, state), [owner]);
    });
    return {removedAny: owners.size > 0, shouldRescan};
}

function restartStatefulTarget(session: FullPageSession, target: HTMLElement): boolean {
    const attributeTimer = session.statefulAttributeTimers.get(target);
    if (attributeTimer !== undefined) {
        window.clearTimeout(attributeTimer.timer);
        if (attributeTimer.boundaryTimer !== undefined) window.clearTimeout(attributeTimer.boundaryTimer);
        session.statefulAttributeTimers.delete(target);
    }
    session.statefulAttributeRescanTargets.delete(target);
    unregisterSessionStatefulTarget(session, target);
    const state = getTranslationState(target);
    if (!state) return false;
    if (session.scrollController.defer(target)) {
        return false;
    }
    const disposition = state.phase === 'translated' && state.mode === 'bilingual' && state.kind === 'content'
        ? stabilizeBilingualArtifact(target, state, session.bilingualRemountCapitulations, ensureTranslationTruncationLayout) : 'retry';
    if (disposition === 'current') {
        registerSessionStatefulTarget(session, target, target);
        return false;
    }
    if (disposition === 'capitulated') {
        removeScheduledForStateTarget(session, target);
        withFullPageViewportAnchor(() => restoreTranslation(target), [target]);
        return true;
    }
    // 显式来源/结构 mutation 属于新的 DOM generation；缓存仍按完整文本身份
    // 复用，只有依赖周边页面内容的 AI 上下文结果需全量失效。
    invalidateContextSensitiveRequestCache(session);
    const rescanRoot = state.syntheticSegment ? target.parentElement : target;
    removeScheduledForStateTarget(session, target);

    if (state.phase === "loading") {
        withFullPageViewportAnchor(() => discardTranslation(target, state), [target]);
    } else {
        withFullPageViewportAnchor(() => restoreTranslation(target), [target]);
    }
    if (rescanRoot?.isConnected) enqueueFullPageRescan(session, rescanRoot);
    return true;
}

function scheduleStatefulAttributeReevaluation(
    session: FullPageSession,
    target: HTMLElement,
    checkBoundary = false,
): void {
    const currentTimer = session.statefulAttributeTimers.get(target);
    if (currentTimer !== undefined) window.clearTimeout(currentTimer.timer);
    const scheduledState = getTranslationState(target);
    const scheduledPhase = scheduledState?.phase;
    const rescanRoot = scheduledState?.syntheticSegment ? target.parentElement : target;

    const timer = window.setTimeout(() => {
        const pending = session.statefulAttributeTimers.get(target);
        if (pending?.timer !== timer) return;
        session.statefulAttributeTimers.delete(target);
        if (pending.boundaryTimer !== undefined) window.clearTimeout(pending.boundaryTimer);
        if (!session.active) return;
        const state = getTranslationState(target);
        if (!state) {
            if (session.statefulAttributeRescanTargets.has(target) && rescanRoot?.isConnected) {
                session.statefulAttributeRescanTargets.delete(target);
                enqueueFullPageRescan(session, rescanRoot);
            }
            return;
        }
        session.statefulAttributeRescanTargets.delete(target);
        if (!target.isConnected) return;
        if (pending.boundaryTimer !== undefined && restoreStatefulTargetOutsideScope(session, target)) return;

        // A class/style reevaluation can be armed while the provider is still
        // loading. If the host replaces equivalent source Text nodes before
        // the request settles, do not let that old timer reinterpret the now
        // successfully committed translation as stale.
        if (scheduledState === state && scheduledPhase === "loading" &&
            hasCurrentTranslationSource(target, state, attemptSourceIsCurrent)) return;

        // 同时比较逻辑来源与精确文本槽身份，使纯 class/style 抖动保持低成本，
        // 又能发现同文本标签或行内链接替换。实时 single/control 文本槽比较本
        // generation 写入的值，而不是其旧原文。
        const shouldReconcileBilingualLayout =
            state.phase === "translated" &&
            state.mode === "bilingual" &&
            state.kind === "content" &&
            state.bilingualContent?.isConnected;
        if (shouldReconcileBilingualLayout && !ensureTranslationTruncationLayout(target)) {
            restartStatefulTarget(session, target);
            return;
        }
        let sourceCurrent = statefulSourceAndTextSlotsAreCurrent(target, state);
        if (!sourceCurrent && withFullPageViewportAnchor(() =>
            refreshBilingualTranslationSkeleton(target, state), [target])) sourceCurrent = true;
        if ((sourceCurrent &&
            (state.phase !== 'translated' || isTranslationArtifactCurrent(target, state))) ||
            canKeepTranslationAttempt(target, state, attemptSourceIsCurrent,
                statefulSourceAndTextSlotsAreCurrent)) return;
        restartStatefulTarget(session, target);
    }, STATEFUL_ATTRIBUTE_DEBOUNCE_MS);
    const pending = {timer, boundaryTimer: currentTimer?.boundaryTimer};
    // 来源/布局仍按最后一次变化防抖；边界检查按首次变化到期，避免动画一直延后清理。
    if (checkBoundary && pending.boundaryTimer === undefined) {
        const boundaryTimer = window.setTimeout(() => {
            const current = session.statefulAttributeTimers.get(target);
            if (current?.boundaryTimer !== boundaryTimer) return;
            delete current.boundaryTimer;
            if (!session.active) return;
            if (restoreStatefulTargetOutsideScope(session, target)) {
                window.clearTimeout(current.timer);
                session.statefulAttributeTimers.delete(target);
                session.statefulAttributeRescanTargets.delete(target);
            }
        }, STATEFUL_ATTRIBUTE_DEBOUNCE_MS);
        pending.boundaryTimer = boundaryTimer;
    }
    session.statefulAttributeTimers.set(target, pending);
}

function resolveStatefulMutationTargets(
    session: FullPageSession,
    element: Element,
): HTMLElement[] {
    const targets = new Set<HTMLElement>();
    const direct = resolveStatefulMutationTarget(element);
    if (direct) targets.add(direct);
    const descendants = session.statefulTargetsByAncestor.get(element);
    if (descendants) {
        for (const target of Array.from(descendants)) {
            if (getTranslationState(target)) targets.add(target);
            else unregisterSessionStatefulTarget(session, target);
        }
    }
    return [...targets];
}

/** 结构或属性关系变化后，先取消已不在正文范围内的旧候选，再扫描新候选。 */
function restoreStatefulTargetOutsideScope(session: FullPageSession, target: HTMLElement,
    checks?: ReturnType<typeof createTranslationMutationStabilityChecks>): boolean {
    const state = getTranslationState(target);
    if (!state || state.syntheticSegment || (checks?.scopeIsCurrent(target, state) ??
        isTranslationStateCandidateCurrent(target, state))) return false;
    checks?.invalidate();
    unregisterSessionStatefulTarget(session, target);
    removeScheduledForStateTarget(session, target);
    withFullPageViewportAnchor(() => restoreTranslation(target), [target]);
    return true;
}

function createFullPageMutationObserver(
    getSession: () => FullPageSession,
): MutationObserver {
    return new MutationObserver((mutations) => {
        const session = getSession();
        if (!session.active || getCurrentSession() !== session) return;
        const core = getCurrentTranslationCore(session.scope);
        const siteAttributes = getSiteAdapterAttributeFilter(core.adapters);
        // materialize 较宽行内段时，每个被移动来源节点都可能排入一条 childList 记录。
        // 精确快照在本次回调内稳定，因此每个 loading generation 只校验一次，
        // 避免进行 O(records) 次克隆。
        const loadingSyntheticChecks = new WeakMap<TranslationState, boolean>();
        // MathJax v2 单次回调可能产生数百条直属父级记录。实时 DOM 此时已处于回调
        // 最终状态，因此每个有状态来源/文本槽快照只比较一次，不为每条
        // Preview <-> staging-span 记录反复遍历很长的 P。
        const shouldCheckAttribute = createTranslationAttributeMutationFilter();
        const resolveRemovedOwners = transferEquivalentBilingualOwners(session, mutations);
        const stabilityReads = createTranslationMutationStabilityChecks();
        const attributeBatch = createAttributeMutationBatch({
            resolveTargets: root => resolveStatefulMutationTargets(session, root),
            readState: getTranslationState,
            restoreOutsideScope: target => restoreStatefulTargetOutsideScope(session, target, reads),
            sourceIsCurrent: (target, state) => reads.sourceIsCurrent(target, state),
            isArtifact: isTranslationArtifact,
            refreshSkeleton: (target, state) => withFullPageViewportAnchor(() =>
                (reads.invalidate(), refreshBilingualTranslationSkeleton(target, state)), [target]),
            restart: target => {
                reads.invalidate();
                restartStatefulTarget(session, target);
            },
            rescan: root => enqueueFullPageRescan(session, root),
            schedule: (target, boundary) => scheduleStatefulAttributeReevaluation(session, target, boundary),
            isActive: () => session.active && getCurrentSession() === session,
            hasTargetsOnlyAdapter: core.adapters.some(adapter => adapter.genericCandidatePolicy === 'targets-only'),
        });
        const reads = {
            ...stabilityReads,
            invalidate: () => {
                stabilityReads.invalidate();
                attributeBatch.invalidate();
            },
        };
        for (const mutation of mutations) {
            if (isOwnMutation(mutation, loadingSyntheticChecks)) continue;
            const mutationElement = mutationTargetElement(mutation.target);
            if (mutation.type === 'attributes' && mutationElement && mutation.attributeName &&
                !shouldCheckAttribute(mutationElement, mutation.attributeName)) continue;
            // spinner、译文写入和普通属性/文本变化不会让候选脱离文档。
            // 只有真实宿主删除才启动全队列的分片清理，避免每次渲染遍历离屏候选。
            if (mutation.type === 'childList' && mutation.removedNodes.length > 0) {
                scheduleDisconnectedCandidatePrune(session);
            }
            if (mayChangeTranslationModal(mutation, session.modal)) session.modalDirty = true;
            const siteAttributeMutation = mutation.type === 'attributes' && mutation.attributeName !== null &&
                (siteAttributes === null || siteAttributes.includes(mutation.attributeName));
            if (!siteAttributeMutation && mutation.type === 'attributes' && (mutation.attributeName === 'aria-modal' ||
                (mutation.attributeName === 'open' && mutationElement?.localName === 'dialog'))) {
                enqueueFullPageRescan(session, mutation.target); continue;
            }
            const preservesContext = isTextEquivalentHostReplacement(mutation);
            const removedOwners = mutation.type === "childList"
                ? discardOwnersRemovedByHost(session, Array.from(mutation.removedNodes), resolveRemovedOwners, reads.invalidate)
                : {removedAny: false, shouldRescan: false};
            if (removedOwners.shouldRescan && mutationElement) enqueueFullPageRescan(session, mutationElement);
            if (mutationElement && core.shouldIgnoreMutation(mutationElement) &&
                !siteAttributeMutation && !resolveStatefulMutationTarget(mutationElement)) continue;
            if (!preservesContext) invalidateContextSensitiveRequestCache(session);
            if (mutation.type === "childList") {
                if (core.adapters.length && mutationElement) {
                    const affectedRoot = siteAttributes === null ? document.documentElement : getComposedParent(mutationElement) ?? mutationElement;
                    for (const target of resolveStatefulMutationTargets(session, affectedRoot)) restoreStatefulTargetOutsideScope(session, target, reads);
                }
                const changedTarget = mutationElement ? resolveStatefulMutationTarget(mutationElement) : false;
                const changedState = changedTarget ? getTranslationState(changedTarget) : undefined;

                // 宿主直属 childList 可能只是受保护 renderer 事务。可翻译来源与精确
                // Text 槽不变时保留 loading/error/translated 所有权；旧行为会在
                // MathJax v2 于父 P 替换脱离文档且无 class 的 staging span 后移除
                // 已提交 wrapper。扩展当前产物内部或移除它的 mutation 仍属于
                // 权威宿主篡改，必须立即重启。
                if (changedTarget && changedState) {
                    const touchesArtifact = isTranslationArtifact(mutation.target) ||
                        mutationTouchesCurrentTranslationArtifact(mutation, changedState);
                    let sourceAndSlotsCurrent = reads.sourceIsCurrent(changedTarget, changedState);
                    if (!touchesArtifact && !sourceAndSlotsCurrent && withFullPageViewportAnchor(() =>
                        (reads.invalidate(), refreshBilingualTranslationSkeleton(changedTarget, changedState)), [changedTarget])) {
                        sourceAndSlotsCurrent = true;
                    }
                    const canKeepAttempt = canKeepTranslationAttempt(
                        changedTarget,
                        changedState,
                        attemptSourceIsCurrent,
                        statefulSourceAndTextSlotsAreCurrent,
                        !touchesArtifact || isTranslationArtifactCurrent(changedTarget, changedState),
                    );
                    if ((touchesArtifact || !sourceAndSlotsCurrent) && !canKeepAttempt) {
                        reads.invalidate();
                        restartStatefulTarget(session, changedTarget);
                    }
                }

                // 纯删除可能把原结构容器变成有效段落，因此所有情况都要重新分类 mutation 目标。
                enqueueFullPageRescan(session, mutation.target);

                // 扫描 mutation 目标已经覆盖全部新增后代；逐个排入子节点会把一次 React
                // commit 扩大为数十个冗余脏根。
            } else if (mutation.type === "characterData") {
                const target = mutation.target.parentElement
                    ? resolveStatefulMutationTarget(mutation.target.parentElement)
                    : false;
                if (target) {
                    const state = getTranslationState(target);
                    const touchesArtifact = isTranslationArtifact(mutation.target);
                    let sourceCurrent = state && reads.sourceIsCurrent(target, state);
                    if (state && !touchesArtifact && !sourceCurrent && withFullPageViewportAnchor(() =>
                        (reads.invalidate(), refreshBilingualTranslationSkeleton(target, state)), [target])) sourceCurrent = true;
                    if (!state || touchesArtifact || !sourceCurrent || !canKeepTranslationAttempt(
                        target,
                        state,
                        attemptSourceIsCurrent,
                        statefulSourceAndTextSlotsAreCurrent,
                    )) {
                        reads.invalidate();
                        restartStatefulTarget(session, target);
                    }
                } else {
                    // hydration 框架常在不新增 Element 的情况下追加/替换 Text 节点，
                    // 此时需重新分类其最近语义块。
                    enqueueFullPageRescan(session, mutation.target);
                }
            } else if (mutation.type === "attributes") {
                if (!mutationElement) continue;

                // 相邻选择器可能影响兄弟正文；不能穷举的关系选择器保守重扫文档，
                // 后续发现仍受既有帧预算、去重与广域重扫冷却约束。
                const affectedRoot = siteAttributeMutation
                    ? siteAttributes === null ? document.documentElement : getComposedParent(mutationElement) ?? mutationElement
                    : mutationElement;
                attributeBatch.process(affectedRoot, mutationElement, mutation.target, mutation.attributeName, siteAttributeMutation);
            }
        }
        refreshFullPageModal(session);
        attributeBatch.flush();
    });
}


    return {removeScheduledForStateTarget, restartStatefulTarget, scheduleStatefulAttributeReevaluation, createFullPageMutationObserver};
}
