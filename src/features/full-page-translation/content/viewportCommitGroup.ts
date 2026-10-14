/**
 * @file src/features/full-page-translation/content/viewportCommitGroup.ts
 * 文件职责：暂存同一视口内已独立完成的翻译请求，等固定成员全部结算后再执行一次视觉提交。
 * 主要内容：登记成员、接收成功结果或取消结算、封组后只调用一次提交，并在会话销毁时丢弃未提交结果。
 * 模块边界：不访问 DOM、不发起请求、不决定成员集合；runtime 负责可见性、生命周期验证和实际 DOM 写入。
 */
export interface ViewportCommitGroup<T> {
    reserve(key: Node): void;
    settle(key: Node, value?: T): void;
    /** 取消尚在等待或已暂存的成员，保证它不会进入最终 commit。 */
    withdraw(key: Node): void;
    seal(): void;
    dispose(): void;
}

/** 固定成员全部结算后才提交，取消成员同时解除等待和删除暂存 DOM 工作。 */
export function createViewportCommitGroup<T>(commit: (values: readonly T[]) => void): ViewportCommitGroup<T> {
    const pending = new Set<Node>();
    const values = new Map<Node, T>();
    let sealed = false;
    let disposed = false;
    const flush = () => {
        if (disposed || !sealed || pending.size > 0) return;
        disposed = true;
        commit([...values.values()]);
        values.clear();
    };
    return {
        reserve(key): void { if (!disposed) pending.add(key); },
        settle(key, value): void {
            if (disposed || !pending.delete(key)) return;
            if (value !== undefined) values.set(key, value);
            flush();
        },
        withdraw(key): void {
            if (disposed) return;
            pending.delete(key);
            values.delete(key);
            flush();
        },
        seal(): void { sealed = true; flush(); },
        dispose(): void { disposed = true; pending.clear(); values.clear(); },
    };
}
