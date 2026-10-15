/**
 * @file src/app/background/personalPerformancePreset.ts
 * 文件职责：在个人 Firefox 包升级时一次性提高仍沿用旧默认值的全局请求预算。
 * 主要内容：仅识别个人扩展 ID，将旧默认并发 10 改为 20、每秒启动 10 改为 40，并一次性选用 viewport 模式；独立迁移启用现有 all 节点识别，覆盖导航与侧栏。迁移后保留用户再次修改的范围，保存成功后记录各自版本标记。
 * 模块边界：纯依赖注入的升级步骤，不读凭据、不改变 provider 协议、不控制网页 DOM。
 */
export interface PersonalPerformancePresetPort {
    personal: boolean;
    completed(): Promise<boolean>;
    ready(): Promise<void>;
    current(): {maxConcurrentTranslations: number; translationRequestsPerSecond: number; fullPageTranslationMode?: 'viewport' | 'all'};
    patch(value: Partial<{maxConcurrentTranslations: number; translationRequestsPerSecond: number; fullPageTranslationMode: 'viewport' | 'all'}>): Promise<void>;
    markComplete(): Promise<void>;
}

export async function applyPersonalPerformancePreset(port: PersonalPerformancePresetPort): Promise<void> {
    if (!port.personal || await port.completed()) return;
    await port.ready();
    const current = port.current();
    const patch: Partial<typeof current> = {};
    if (current.maxConcurrentTranslations === 10) patch.maxConcurrentTranslations = 20;
    if (current.translationRequestsPerSecond === 10) patch.translationRequestsPerSecond = 40;
    if (current.fullPageTranslationMode === 'all') patch.fullPageTranslationMode = 'viewport';
    if (Object.keys(patch).length > 0) await port.patch(patch);
    await port.markComplete();
}

export interface PersonalCoveragePresetPort {
    personal: boolean;
    completed(): Promise<boolean>;
    ready(): Promise<void>;
    current(): {translationScope: 'content' | 'all'};
    patch(value: {translationScope: 'all'}): Promise<void>;
    markComplete(): Promise<void>;
}

export async function applyPersonalCoveragePreset(port: PersonalCoveragePresetPort): Promise<void> {
    if (!port.personal || await port.completed()) return;
    await port.ready();
    if (port.current().translationScope !== 'all') await port.patch({translationScope: 'all'});
    await port.markComplete();
}
