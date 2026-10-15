/**
 * @file src/features/full-page-translation/content/discoveryReadStep.ts
 * 文件职责：在无站点适配器的纯读取发现阶段复用同步 DOM 守卫，不把候选消费或 DOM 写入纳入缓存。
 * 主要内容：只读取一个 enter/exit 步骤，保留消费与发现的交错顺序和调用方的逐步 8ms 预算；适配器回调不共享守卫。
 * 模块边界：只拉取 generator，不登记观察器、不改变会话，也不调度或渲染候选。
 */
import {withTranslationDOMReadBatch, type TranslationDiscoveryStep} from '@/src/core/translation/public';

export function readDiscoveryStep(
    iterator: Generator<TranslationDiscoveryStep>,
    hasAdapters: boolean,
): IteratorResult<TranslationDiscoveryStep> {
    return hasAdapters ? iterator.next() : withTranslationDOMReadBatch(() => iterator.next());
}
