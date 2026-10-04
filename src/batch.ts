import { renderTemplate } from "./render";
import type { Batch, PageInput, PageResult, TemplateRevision } from "./types";

/**
 * 批次实现：
 * - 启动时绑定各模板最新修订快照，之后的提交不影响本批次。
 * - 结果按页面输入顺序逐条交付（同步渲染、入队即交付，不必等输入结束）。
 * - 取消后丢弃未消费的结果，迭代器立即结束，不再交付。
 * - 全部结果交付完毕或取消后，通过 onSettled 释放对旧修订的钉住资格。
 */
export class BatchImpl implements Batch {
  readonly id: string;

  private readonly bindings: ReadonlyMap<string, TemplateRevision>;
  private readonly onSettled: (batch: BatchImpl) => void;
  private readonly queue: PageResult[] = [];
  private waiter: (() => void) | null = null;
  private inputEnded = false;
  private cancelled = false;
  private settled = false;
  private sequence = 0;

  constructor(
    id: string,
    bindings: ReadonlyMap<string, TemplateRevision>,
    onSettled: (batch: BatchImpl) => void,
  ) {
    this.id = id;
    this.bindings = bindings;
    this.onSettled = onSettled;
  }

  /** 该批次钉住的 (templateId -> revision)，用于保留窗口外的旧修订 */
  pins(): ReadonlyMap<string, number> {
    if (this.settled) return new Map();
    const out = new Map<string, number>();
    for (const [templateId, record] of this.bindings) {
      out.set(templateId, record.revision);
    }
    return out;
  }

  get isSettled(): boolean {
    return this.settled;
  }

  submitPage(page: PageInput): void {
    if (this.cancelled) throw new Error(`batch ${this.id} is cancelled`);
    if (this.inputEnded) throw new Error(`batch ${this.id} input already ended`);
    const bound = this.bindings.get(page.templateId);
    if (bound === undefined) {
      throw new Error(`template "${page.templateId}" is not in this batch's template list`);
    }
    this.sequence += 1;
    const result: PageResult = {
      sequence: this.sequence,
      templateId: page.templateId,
      revision: bound.revision,
      output: renderTemplate(bound.template, page.params),
    };
    this.queue.push(result);
    this.notify();
  }

  endInput(): void {
    if (this.cancelled || this.inputEnded) return;
    this.inputEnded = true;
    this.notify();
  }

  cancel(): Promise<void> {
    if (!this.cancelled) {
      this.cancelled = true;
      this.queue.length = 0;
      this.notify();
      this.settle();
    }
    return Promise.resolve();
  }

  get results(): AsyncIterable<PageResult> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<PageResult> {
        return {
          async next(): Promise<IteratorResult<PageResult>> {
            for (;;) {
              const item = self.queue.shift();
              if (item !== undefined) return { value: item, done: false };
              if (self.cancelled || self.inputEnded) {
                self.settle();
                return { value: undefined, done: true };
              }
              await self.wait();
            }
          },
        };
      },
    };
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  private notify(): void {
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter !== null) waiter();
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.onSettled(this);
  }
}
