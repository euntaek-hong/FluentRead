import {afterEach, describe, expect, it, vi} from 'vitest';
import {createViewportPendingMotion} from '@/src/features/full-page-translation/content/viewportPendingMotion';

afterEach(() => vi.unstubAllGlobals());
function setup(reduced = false, timeline: unknown = 123) {
    vi.stubGlobal('window', {matchMedia: vi.fn(() => ({matches: reduced}))});
    vi.stubGlobal('document', timeline === undefined ? {} : {timeline: {currentTime: timeline}});
    const animation = {cancel: vi.fn(), startTime: null} as unknown as Animation;
    const node = {animate: vi.fn(() => animation)} as unknown as HTMLElement;
    return {animation, node};
}
describe('viewport pending motion ownership', () => {
    it('shares a timeline, deduplicates owners and releases each animation exactly once', () => {
        const {node, animation} = setup();
        const second = {animate: vi.fn(() => ({cancel: vi.fn(), startTime: null}))} as unknown as HTMLElement;
        const motion = createViewportPendingMotion([node, node, second], true);
        expect(node.animate).toHaveBeenCalledOnce();
        expect(animation.startTime).toBe(123);
        expect(node.animate).toHaveBeenCalledWith([{opacity: 0.5}, {opacity: 0.9}, {opacity: 0.5}], {duration: 900, iterations: Infinity, easing: 'ease-in-out'});
        motion.stop(node);motion.stop(node);motion.dispose();motion.dispose();
        expect(animation.cancel).toHaveBeenCalledOnce();
        expect(second.animate).toHaveBeenCalledOnce();
        expect((second.animate as ReturnType<typeof vi.fn>).mock.results[0]!.value.cancel).toHaveBeenCalledOnce();
    });
    it.each([false, true])('does not animate when disabled or reduced motion is set (%s)', enabled => {
        const {node} = setup(true);
        createViewportPendingMotion([node], enabled).dispose();
        expect(node.animate).not.toHaveBeenCalled();
    });
    it('uses a static fallback when matchMedia is absent', () => {
        const {node} = setup();vi.stubGlobal('window', {});
        createViewportPendingMotion([node], true).dispose();
        expect(node.animate).not.toHaveBeenCalled();
    });
    it('leaves native animation timing alone when a numeric timeline is unavailable', () => {
        const {node, animation} = setup(false, null);
        createViewportPendingMotion([node], true).dispose();
        expect(animation.startTime).toBeNull();
        vi.stubGlobal('document', {});
        createViewportPendingMotion([node], true).dispose();
    });
    it('ignores unsupported or rejected animations without changing source ownership', () => {
        setup();
        const node = {animate: vi.fn(() => {throw Error('unsupported');})} as unknown as HTMLElement;
        createViewportPendingMotion([{} as HTMLElement, node], true).dispose();
        expect(node.animate).toHaveBeenCalledOnce();
    });
});
