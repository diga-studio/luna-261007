import {
  ProbeOutcome,
  SessionCallbacks,
  SessionHandle,
  TunnelRole,
} from "../src/types";

export interface PrepareCall {
  groupId: string;
  tunnel: TunnelRole;
  resolve: (session: SessionHandle) => void;
}

export interface ReleaseRecord {
  groupId: string;
  tunnel: TunnelRole;
  session: SessionHandle;
}

/** 可控的会话回调：准备永不自动完成，由测试手动 resolve；释放逐条记录 */
export class ControllableCallbacks implements SessionCallbacks {
  readonly prepares: PrepareCall[] = [];
  readonly releases: ReleaseRecord[] = [];
  private nextSessionId = 1;

  prepare(groupId: string, tunnel: TunnelRole): Promise<SessionHandle> {
    return new Promise<SessionHandle>((resolve) => {
      this.prepares.push({ groupId, tunnel, resolve });
    });
  }

  release(groupId: string, tunnel: TunnelRole, session: SessionHandle): void {
    this.releases.push({ groupId, tunnel, session });
  }

  /** 发起一次新的不透明会话句柄 */
  newSession(): SessionHandle {
    return { sessionId: this.nextSessionId++ };
  }

  /** 完成第 index 次（0 起）准备调用，返回所用会话句柄 */
  completePrepare(index: number): SessionHandle {
    const call = this.prepares[index];
    if (!call) throw new Error(`no prepare call at index ${index}`);
    const session = this.newSession();
    call.resolve(session);
    return session;
  }

  releaseCount(): number {
    return this.releases.length;
  }
}

/** 等待微任务/宏任务排空，让已 resolve 的准备完成回调执行 */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

export const S = ProbeOutcome.Success;
export const T = ProbeOutcome.Timeout;
