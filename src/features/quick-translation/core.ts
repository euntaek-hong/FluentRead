/**
 * @file src/features/quick-translation/core.ts
 * 文件职责：把已归一化的快捷翻译方案解析为一次不可变的页面翻译调用配置。
 * 主要内容：合并方案与全局默认服务、模型、目标语言、显示方式、页面识别范围和全文加载范围，供内容脚本手势路由复用。
 * 模块边界：本文件只做纯数据解析，不监听事件、不读取存储、不执行翻译，也不持有 DOM 状态。
 */
import {resolveConfiguredModel} from '@/src/core/config/catalog';
import type {Config} from '@/src/core/config/model';
import type {QuickTranslationProfile} from '@/src/core/config/quickTranslation';
import type {PageTranslationInvocation} from '@/src/features/full-page-translation/public';

type QuickTranslationConfigSource = Pick<
    Config,
    'service' | 'model' | 'customModel' | 'to' | 'display' | 'fullPageTranslationMode' | 'translationScope'
>;

/** 在用户按下快捷键时冻结“跟随默认”后的真实请求身份。 */
export function resolveQuickTranslationInvocation(
    profile: QuickTranslationProfile,
    config: QuickTranslationConfigSource,
): PageTranslationInvocation {
    const service = profile.service || config.service;
    const model = profile.model || resolveConfiguredModel(
        config.model[service],
        config.customModel[service],
    );
    return {
        ...(profile.glossaryIds !== undefined ? {glossaryIds: profile.glossaryIds ? [...profile.glossaryIds] : null} : {}),
        profileId: profile.id,
        scope: config.translationScope,
        service,
        ...(model ? {model} : {}),
        targetLanguage: profile.targetLanguage || config.to,
        displayMode: profile.displayMode === 'bilingual'
            ? 'bilingual'
            : profile.displayMode === 'translation-only'
              ? 'single'
              : config.display === 1 ? 'bilingual' : 'single',
        ...(profile.action === 'full-page'
            ? {fullPageMode: profile.fullPageMode === 'inherit'
                ? config.fullPageTranslationMode
                : profile.fullPageMode}
            : {}),
    };
}
