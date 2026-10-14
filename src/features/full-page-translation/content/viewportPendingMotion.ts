/**
 * @file src/features/full-page-translation/content/viewportPendingMotion.ts
 * 文件职责：为同一视口提交组提供同步、可取消的轻量等待反馈。
 * 主要内容：仅使用浏览器原生 opacity 动画；尊重动画关闭和 reduced-motion，取消单个候选或结束整组时立即恢复原文视觉，不等待动画完成，不创建 spinner 或修改宿主 DOM/class/style。
 * 模块边界：不发现候选、不发请求、不提交译文；runtime 持有动画所有权并在取消、失败和提交时释放。
 */
export interface ViewportPendingMotion {
    stop(node: HTMLElement): void;
    dispose(): void;
}

export function createViewportPendingMotion(nodes: readonly HTMLElement[], enabled: boolean): ViewportPendingMotion {
    const animations = new Map<HTMLElement, Animation>();
    const stop = (node: HTMLElement): void => {
        const animation = animations.get(node);
        if (!animation) return;
        animations.delete(node);
        animation.cancel();
    };
    const motion = {stop, dispose: () => {for (const node of animations.keys()) stop(node);}};
    if (!enabled || typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return motion;
    const startTime = document.timeline?.currentTime;
    for (const node of new Set(nodes)) {
        if (typeof node.animate !== 'function') continue;
        try {
            const animation = node.animate([{opacity: 0.5}, {opacity: 0.9}, {opacity: 0.5}], {
                duration: 900, iterations: Infinity, easing: 'ease-in-out',
            });
            animations.set(node, animation);
            if (typeof startTime === 'number') animation.startTime = startTime;
        } catch { /* 动画不可用不影响请求、原文恢复或提交。 */ }
    }
    return motion;
}
