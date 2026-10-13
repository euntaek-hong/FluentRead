/**
 * @file src/app/translation/check.ts
 * 文件职责：在内容侧翻译调用前执行最小配置可用性检查，并对模型输出做统一后处理，向页面用户反馈可操作错误。
 * 主要内容：根据服务类型验证自定义模型和必需模型选择，使用 page-notice 发送中文提示；Google 文本数组接口同时允许仅译文和双语渲染，不再沿用网页挂件的显示限制。
 * 模块边界：本文件不验证受保护凭据、不发起请求，也不决定 provider endpoint；可信凭据检查在后台或 extension page，网络与重试由 translation/client 负责。
 */
import {customModelString, servicesType} from '@/src/core/config/catalog';
import {config} from '@/src/services/config/store';
import {sendErrorMessage} from '@/src/features/page-notice/public';

export interface TranslationConfigCheckOptions {
    service?: string;
    model?: string;
    displayMode?: 'bilingual' | 'single';
}

// 翻译前检查配置。快捷方案可在不改写全局默认值的情况下传入本次请求身份。
export function checkConfig(options: TranslationConfigCheckOptions = {}): boolean {
    // 步骤 1：检查插件是否启用。
    if (!config.on) return false;

    // 凭据保存在扩展 session 存储中，按设计不向 content script 暴露。
    // 后台会在调用 provider 前，于请求边界完成校验。

    // 检查要求模型的服务是否已完成选择。
    const service = options.service?.trim() || config.service;
    const explicitModel = options.model?.trim();
    if (servicesType.isUseModel(service)) {
        const configuredModel = config.model[service];
        const customModel = config.customModel[service];
        const model = explicitModel || (configuredModel === customModelString ? customModel : configuredModel);
        if (!model || (!explicitModel && configuredModel === customModelString && !customModel)) {
            sendErrorMessage("模型尚未配置，请前往设置页配置");
            return false;
        }
    }

    return true;
}
