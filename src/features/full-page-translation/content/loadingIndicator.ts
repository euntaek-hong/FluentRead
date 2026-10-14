/**
 * @file src/features/full-page-translation/content/loadingIndicator.ts
 * 文件职责：控制单次翻译的 loading 展示时机，避免全文快速响应或缓存命中仍插入并删除临时 DOM。
 * 主要内容：传统全文路径等待 180ms 后仅为仍存活的 loading generation 显示指示器；视口整组提交可抑制全文逐项动画，悬浮保持即时反馈，取消、请求完成和宿主移除都不会留下迟到的指示器。
 * 模块边界：只编排指示器定时器和 DOM 所有权，不创建翻译请求、不改变状态机、不决定重试。
 */
import {insertLoadingSpinner} from '../ui/translationIndicators';
import {getTranslationState, setSpinner, type TranslationState} from './state';
import {withFullPageViewportAnchor} from './viewportStability';

/** 返回幂等清理函数；请求结算和取消都应释放计时器，而非等待渲染提交结束。 */
export function scheduleTranslationLoadingIndicator(
    node: HTMLElement,
    state: TranslationState,
    deferred: boolean,
    suppress = false,
): () => void {
    const signal = state.controller.signal;
    let timer: number | undefined;
    const cancel = () => {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
        signal.removeEventListener('abort', cancel);
    };
    const show = () => {
        cancel();
        if (signal.aborted || !node.isConnected || getTranslationState(node) !== state || state.phase !== 'loading') return;
        withFullPageViewportAnchor(() => setSpinner(node, insertLoadingSpinner(node)), [node]);
    };
    if (!signal.aborted && !suppress) {
        if (deferred) {
            timer = window.setTimeout(show, 180);
            signal.addEventListener('abort', cancel, {once: true});
        } else show();
    }
    return cancel;
}
