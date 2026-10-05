import { compileTemplates, type CompiledTemplate } from "./template.js";
import { judgeAnswer } from "./matcher.js";
import type { AnswerTemplate, JudgeResult } from "./types.js";

export type { AnswerTemplate, JudgeResult } from "./types.js";

/**
 * 对话练习可接受回答匹配器。
 * 装入一组回答模板后，可反复判定不同的学习者回答；全部数据仅存内存。
 */
export class AnswerMatcher {
  private readonly compiled: readonly CompiledTemplate[];

  constructor(templates: readonly AnswerTemplate[]) {
    this.compiled = compileTemplates(templates);
  }

  /** 判定一句学习者回答，返回最高相似度、是否达标及一条最优合法回答。 */
  judge(submission: string): JudgeResult {
    return judgeAnswer(this.compiled, submission);
  }
}
