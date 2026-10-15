import {describe,expect,it,vi} from 'vitest';
import {applyPersonalPerformancePreset,applyPersonalCoveragePreset,type PersonalPerformancePresetPort} from '@/src/app/background/personalPerformancePreset';

function port(concurrency=10,rate=10): PersonalPerformancePresetPort {
    return {personal:true,completed:vi.fn(async()=>false),ready:vi.fn(async()=>{}),
        current:()=>({maxConcurrentTranslations:concurrency,translationRequestsPerSecond:rate}),
        patch:vi.fn(async()=>{}),markComplete:vi.fn(async()=>{})};
}
describe('personal performance request budgets',()=>{
    it('upgrades old defaults through a narrow config patch before marking success',async()=>{
        const p=port();await applyPersonalPerformancePreset(p);
        expect(p.patch).toHaveBeenCalledWith({maxConcurrentTranslations:20,translationRequestsPerSecond:40});
        expect(vi.mocked(p.patch).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(p.markComplete).mock.invocationCallOrder[0]!);
    });
    it('never runs for public packages',async()=>{const p=port();p.personal=false;await applyPersonalPerformancePreset(p);expect(p.completed).not.toHaveBeenCalled();});
    it('never reapplies after a user later changes the budget',async()=>{const p=port();p.completed=vi.fn(async()=>true);await applyPersonalPerformancePreset(p);expect(p.ready).not.toHaveBeenCalled();});
    it('preserves a custom concurrency while upgrading only the old start rate',async()=>{const p=port(3);await applyPersonalPerformancePreset(p);expect(p.patch).toHaveBeenCalledWith({translationRequestsPerSecond:40});});
    it('preserves a custom start rate while upgrading only old concurrency',async()=>{const p=port(10,5);await applyPersonalPerformancePreset(p);expect(p.patch).toHaveBeenCalledWith({maxConcurrentTranslations:20});});
    it('marks a fully custom setup without writing configuration',async()=>{const p=port(3,5);await applyPersonalPerformancePreset(p);expect(p.patch).not.toHaveBeenCalled();expect(p.markComplete).toHaveBeenCalledOnce();});
    it('keeps a failed patch eligible for the next background start',async()=>{const p=port();p.patch=vi.fn(async()=>{throw Error('conflict');});await expect(applyPersonalPerformancePreset(p)).rejects.toThrow('conflict');expect(p.markComplete).not.toHaveBeenCalled();});
    it('selects the optimized viewport mode once for the old all-mode installation',async()=>{const p=port(3,5);p.current=()=>({maxConcurrentTranslations:3,translationRequestsPerSecond:5,fullPageTranslationMode:'all'});await applyPersonalPerformancePreset(p);expect(p.patch).toHaveBeenCalledWith({fullPageTranslationMode:'viewport'});});
});

describe('personal visible interface coverage',()=>{
    function coverage(scope: 'all'|'content'='content') {
        return {personal:true,completed:vi.fn(async()=>false),ready:vi.fn(async()=>{}),
            current:()=>({translationScope:scope}),patch:vi.fn(async()=>{}),markComplete:vi.fn(async()=>{})};
    }
    it('enables existing all-node discovery once without changing viewport scheduling or budgets',async()=>{
        const p=coverage();await applyPersonalCoveragePreset(p);
        expect(p.patch).toHaveBeenCalledWith({translationScope:'all'});
        expect(p.ready.mock.invocationCallOrder[0]).toBeLessThan(p.patch.mock.invocationCallOrder[0]!);
        expect(p.patch.mock.invocationCallOrder[0]).toBeLessThan(p.markComplete.mock.invocationCallOrder[0]!);
    });
    it('keeps an existing all scope without a redundant config write',async()=>{
        const p=coverage('all');await applyPersonalCoveragePreset(p);expect(p.patch).not.toHaveBeenCalled();expect(p.markComplete).toHaveBeenCalledOnce();
    });
    it('leaves public packages alone',async()=>{
        const p=coverage();p.personal=false;await applyPersonalCoveragePreset(p);expect(p.completed).not.toHaveBeenCalled();
    });
    it('preserves later user scope changes after the independent coverage migration',async()=>{
        const p=coverage();p.completed.mockResolvedValue(true);await applyPersonalCoveragePreset(p);expect(p.ready).not.toHaveBeenCalled();expect(p.patch).not.toHaveBeenCalled();
    });
    it('retries failed config writes on the next background start',async()=>{
        const p=coverage();p.patch.mockRejectedValueOnce(Error('conflict'));await expect(applyPersonalCoveragePreset(p)).rejects.toThrow('conflict');expect(p.markComplete).not.toHaveBeenCalled();
    });
});
