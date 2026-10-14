/**
 * @file src/app/background/personalPerformanceRuntime.ts
 * 文件职责：将个人 Firefox 请求预算升级连接到已有配置 patch 和浏览器存储端口。
 * 主要内容：只在 fluent-read@euntaek-hong 个人包中执行一次，等待配置水合后通过现有字段 CAS 保存，沿用用户其他设置。
 * 模块边界：后台组合层；预算算法由 personalPerformancePreset 提供，配置权限和持久化由现有 store 管理。
 */
import {applyPersonalPerformancePreset} from './personalPerformancePreset';
import {config, configReady, requestConfigPatch} from '@/src/services/config/store';

const marker = 'personalPerformancePresetV1';
export function installPersonalPerformancePreset(): void {
    const manifest = browser.runtime?.getManifest?.();
    const personal = manifest?.browser_specific_settings?.gecko?.id === 'fluent-read@euntaek-hong';
    if (!personal) return;
    void applyPersonalPerformancePreset({
        personal,
        completed: async () => (await browser.storage.local.get(marker))[marker] === true,
        ready: async () => {await configReady;},
        current: () => config,
        patch: requestConfigPatch,
        markComplete: async () => {await browser.storage.local.set({[marker]: true});},
    }).catch(error => console.error('[FluentRead Personal] 请求预算升级失败', error));
}
