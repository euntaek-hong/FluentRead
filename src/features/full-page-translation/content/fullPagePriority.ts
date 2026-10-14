/**
 * @file src/features/full-page-translation/content/fullPagePriority.ts
 * 文件职责：计算全文翻译待处理候选相对于当前视口的调度优先级。
 * 主要内容：按可见区、滚动方向、距离、等待时间和稳定序号比较候选；不读取 DOM、不访问配置，也不负责启动或取消请求。
 * 模块边界：这是全文 content 调度层的纯排序策略；全局翻译队列与后台 provider 速率调度仍保持各自的公平和并发约束。
 */

export type FullPageScrollDirection = 'forward' | 'backward' | 'unknown';
export type FullPagePriorityBand = 'visible' | 'near' | 'background';

/** 与 IntersectionObserver 的预取范围保持一致；它是候选进入队列的门槛，不是最终排序。 */
export const FULL_PAGE_PREFETCH_MARGIN_PX = 1200;
/** 长时间等待的离屏任务不能永久被当前视口淹没。 */
export const FULL_PAGE_BACKGROUND_MAX_WAIT_MS = 8_000;
/** 连续处理前景任务后允许一次后台任务，避免全文模式永远只翻译当前区域。 */
export const FULL_PAGE_FOREGROUND_DISPATCH_QUOTA = 8;

export interface FullPagePriorityRect {
    top: number;
    bottom: number;
}

export interface FullPageCandidatePriorityInput {
    rect?: FullPagePriorityRect;
    viewportTop: number;
    viewportBottom: number;
    prefetchMargin: number;
    direction: FullPageScrollDirection;
    queuedAt: number;
    now: number;
    sequence: number;
}

export interface FullPageCandidatePriority {
    band: FullPagePriorityBand;
    directional: boolean;
    distance: number;
    ageMs: number;
    sequence: number;
}

function finite(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
}

function bandRank(band: FullPagePriorityBand): number {
    if (band === 'visible') return 3;
    if (band === 'near') return 2;
    return 1;
}

export function scoreFullPageCandidatePriority(
    input: FullPageCandidatePriorityInput,
): FullPageCandidatePriority {
    const viewportTop = finite(input.viewportTop, 0);
    const viewportBottom = Math.max(viewportTop, finite(input.viewportBottom, viewportTop));
    const prefetchMargin = Math.max(0, finite(input.prefetchMargin, 0));
    const now = finite(input.now, 0);
    const queuedAt = finite(input.queuedAt, now);
    const ageMs = Math.max(0, now - queuedAt);
    const sequence = finite(input.sequence, Number.MAX_SAFE_INTEGER);

    const rect = input.rect;
    const top = rect ? finite(rect.top, Number.NaN) : Number.NaN;
    const bottom = rect ? finite(rect.bottom, Number.NaN) : Number.NaN;
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) {
        return {band: 'background', directional: false, distance: Number.POSITIVE_INFINITY, ageMs, sequence};
    }

    if (top < viewportBottom && bottom > viewportTop) {
        // 可见候选保持文档阅读顺序；滚动方向只用于比较视口外的预取内容。
        return {
            band: 'visible',
            directional: false,
            distance: Math.max(0, top - viewportTop),
            ageMs,
            sequence,
        };
    }

    const ahead = input.direction === 'forward'
        ? top >= viewportBottom
        : input.direction === 'backward'
            ? bottom <= viewportTop
            : false;
    const distance = ahead
        ? input.direction === 'forward'
            ? Math.max(0, top - viewportBottom)
            : Math.max(0, viewportTop - bottom)
        : Math.min(
            Math.abs(top - viewportBottom),
            Math.abs(viewportTop - bottom),
        );

    return {
        band: distance <= prefetchMargin ? 'near' : 'background',
        directional: ahead,
        distance,
        ageMs,
        sequence,
    };
}

/** 返回负数表示 left 应先执行，正数表示 right 应先执行。 */
export function compareFullPageCandidatePriority(
    left: FullPageCandidatePriority,
    right: FullPageCandidatePriority,
): number {
    const rankDelta = bandRank(right.band) - bandRank(left.band);
    if (rankDelta !== 0) return rankDelta;

    if (left.directional !== right.directional) return left.directional ? -1 : 1;

    // 后台任务优先按等待时间推进；前景任务先按空间位置保持阅读连续性。
    if (left.band === 'background' && left.ageMs !== right.ageMs) {
        return right.ageMs - left.ageMs;
    }
    if (left.distance !== right.distance) return left.distance - right.distance;
    if (left.ageMs !== right.ageMs) return right.ageMs - left.ageMs;
    return left.sequence - right.sequence;
}
