/**
 * @file src/features/full-page-translation/content/preparedTextSource.ts
 * 文件职责：为已经预准备的独立正文或控件叶子保留精确请求输入证明。
 * 主要内容：只接受单个直接 Text 且没有换行的普通轻 DOM 叶子；admission 重新核对候选、kind、范围、节点身份和完整值，复用规范化输入与语言文本。该证明不代表当前候选仍有翻译资格，最终提交必须继续复验原文、站点边界和会话。
 * 模块边界：纯 DOM 读取，不缓存资格、不写 DOM、不发请求，不跨节点或合并独立段落。
 */
import type {TranslationCandidate} from '@/src/core/translation/public';
import {getTranslatableControlValueAttribute} from '@/src/core/translation/dom';

export function plainDirectText(candidate: TranslationCandidate): Text | undefined {
    const text = candidate.element.firstChild;
    return !candidate.visualRange && !candidate.manualChunk && !candidate.nodes?.length && !candidate.sourceLine &&
        !candidate.allowTopLevelApplicationShell && !candidate.element.shadowRoot &&
        candidate.element.getAttribute('role') !== 'tooltip' && !candidate.element.classList.contains('tooltip') &&
        !getTranslatableControlValueAttribute(candidate.element) && text?.nodeType === 3 && !text.nextSibling &&
        !/[\r\n\u2028\u2029]/u.test((text as Text).data) ? text as Text : undefined;
}

export interface PreparedTextSource {
    candidate: TranslationCandidate;
    scope: TranslationCandidate['scope'];
    kind: TranslationCandidate['kind'];
    text: Text;
    value: string;
    source: string;
}

export function capturePreparedTextSource(candidate: TranslationCandidate, source: string): PreparedTextSource | undefined {
    const text = plainDirectText(candidate);
    const value = text?.nodeValue ?? '';
    return text && source && value.replace(/[\s\u3000]+/gu,' ').trim() === source
        ? {candidate,scope:candidate.scope,kind:candidate.kind,text,value,source} : undefined;
}

export function readPreparedTextSource(candidate: TranslationCandidate, proof: PreparedTextSource | undefined):
    {source: string; language: string} | undefined {
    return proof && proof.candidate === candidate && candidate.scope === proof.scope &&
        candidate.kind === proof.kind && candidate.element.isConnected &&
        plainDirectText(candidate) === proof.text && proof.text.nodeValue === proof.value
        ? {source:proof.source,language:proof.source} : undefined;
}
