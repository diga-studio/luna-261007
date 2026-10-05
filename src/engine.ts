import { ProjectDefinition, SessionStateView, TapResult, AdvanceResult } from "./types";
import { validateProject } from "./validate";
import { Session } from "./session";

/** 回放引擎：管理项目与多个互不影响的会话。 */
export class PlaybackEngine {
  private readonly project: ProjectDefinition;
  private readonly sessions = new Map<string, Session>();
  private nextId = 0;

  constructor(project: ProjectDefinition) {
    this.project = validateProject(project);
  }

  /** 创建会话，从初始屏幕与初始变量开始，返回会话 id */
  createSession(now: number): string {
    const id = `session-${this.nextId++}`;
    this.sessions.set(id, new Session(this.project, now));
    return id;
  }

  private session(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`unknown session "${sessionId}"`);
    return s;
  }

  /** 投递带时间戳的点按 */
  tap(sessionId: string, name: string, time: number): TapResult {
    return { triggers: this.session(sessionId).tap(name, time) };
  }

  /** 推进时间到指定时刻 */
  advanceTo(sessionId: string, time: number): AdvanceResult {
    return { triggers: this.session(sessionId).advanceTo(time) };
  }

  /** 查看当前屏幕、变量、返回历史与过期状态 */
  getState(sessionId: string): SessionStateView {
    return this.session(sessionId).getState();
  }
}
