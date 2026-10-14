import {beforeEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({manifest:{},apply:vi.fn(async(_port:unknown)=>{}),
    config:{maxConcurrentTranslations:10,translationRequestsPerSecond:10},patch:vi.fn(async()=>{})}));
vi.mock('@/src/app/background/personalPerformancePreset',()=>({applyPersonalPerformancePreset:state.apply}));
vi.mock('@/src/services/config/store',()=>({config:state.config,configReady:Promise.resolve(),requestConfigPatch:state.patch}));
import {installPersonalPerformancePreset} from '@/src/app/background/personalPerformanceRuntime';

describe('personal Firefox performance preset wiring',()=>{
    beforeEach(()=>{vi.clearAllMocks();state.apply.mockResolvedValue(undefined);state.manifest={};
        vi.stubGlobal('browser',{runtime:{getManifest:()=>state.manifest},storage:{local:{get:vi.fn(async()=>({personalPerformancePresetV1:true})),set:vi.fn(async()=>{})}}});});
    it('does not start for the original ID',()=>{installPersonalPerformancePreset();expect(state.apply).not.toHaveBeenCalled();});
    it('does not start when manifest APIs are absent',()=>{vi.stubGlobal('browser',{});installPersonalPerformancePreset();expect(state.apply).not.toHaveBeenCalled();});
    it('uses existing config hydration, narrow patch and private marker ports',async()=>{
        state.manifest={browser_specific_settings:{gecko:{id:'fluent-read@euntaek-hong'}}};installPersonalPerformancePreset();
        const port=state.apply.mock.calls[0]![0] as import('@/src/app/background/personalPerformancePreset').PersonalPerformancePresetPort;
        expect(port.personal).toBe(true);expect(await port.completed()).toBe(true);await port.ready();expect(port.current()).toBe(state.config);
        await port.patch({maxConcurrentTranslations:20});expect(state.patch).toHaveBeenCalledWith({maxConcurrentTranslations:20});
        await port.markComplete();expect(browser.storage.local.set).toHaveBeenCalledWith({personalPerformancePresetV1:true});
    });
    it('does not interpret any truthy marker as completion',async()=>{
        state.manifest={browser_specific_settings:{gecko:{id:'fluent-read@euntaek-hong'}}};vi.mocked(browser.storage.local.get).mockResolvedValue({personalPerformancePresetV1:'yes'});installPersonalPerformancePreset();
        const port=state.apply.mock.calls[0]![0] as import('@/src/app/background/personalPerformancePreset').PersonalPerformancePresetPort;expect(await port.completed()).toBe(false);
    });
    it('reports failed upgrade without marking success itself',async()=>{
        state.manifest={browser_specific_settings:{gecko:{id:'fluent-read@euntaek-hong'}}};const error=Error('conflict');state.apply.mockRejectedValueOnce(error);
        const log=vi.spyOn(console,'error').mockImplementation(()=>{});installPersonalPerformancePreset();await Promise.resolve();
        expect(log).toHaveBeenCalledWith('[FluentRead Personal] 请求预算升级失败',error);expect(browser.storage.local.set).not.toHaveBeenCalled();log.mockRestore();
    });
});
