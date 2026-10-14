/**
 * @file src/features/full-page-translation/content/viewportCommitExperiment.ts
 * 文件职责：集中声明视口整组提交的构建期策略。
 * 主要内容：默认启用整组视觉提交，受控对照构建可替换此纯函数，不保存会话状态。
 * 模块边界：不参与候选发现、请求调度或 DOM 渲染。
 */
export function isViewportCommitGroupEnabled(): boolean {
    return true;
}
