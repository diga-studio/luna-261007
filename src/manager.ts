import { FailoverGroup } from './group.js';
import type {
  GroupStatus,
  ProbeResult,
  SessionCallbacks,
} from './types.js';

/** 本库最多管理的互联组数。 */
export const MAX_GROUPS = 250;

/**
 * 主备隧道切换库入口，由上层控制面调用。
 * 配置与运行状态仅保存在进程内；各组独立选择转发路径。
 */
export class FailoverManager {
  private readonly callbacks: SessionCallbacks;
  private readonly groups = new Map<string, FailoverGroup>();

  constructor(callbacks: SessionCallbacks) {
    this.callbacks = callbacks;
  }

  /** 注册一个互联组；超过 250 组或组 ID 重复时抛错。 */
  addGroup(groupId: string): void {
    if (this.groups.has(groupId)) {
      throw new Error(`group already exists: ${groupId}`);
    }
    if (this.groups.size >= MAX_GROUPS) {
      throw new Error(`group limit reached: ${MAX_GROUPS}`);
    }
    this.groups.set(groupId, new FailoverGroup(groupId, this.callbacks));
  }

  /** 上报某组一轮探测结果（调用方已按隧道排序并去重）。 */
  reportProbeResults(groupId: string, results: readonly ProbeResult[]): void {
    this.requireGroup(groupId).applyProbeResults(results);
  }

  /** 查询单组状态（目标与活动会话同时展示）。 */
  getGroupStatus(groupId: string): GroupStatus {
    return this.requireGroup(groupId).status();
  }

  /** 一次查询全部组状态。 */
  getAllStatus(): GroupStatus[] {
    return [...this.groups.values()].map((group) => group.status());
  }

  private requireGroup(groupId: string): FailoverGroup {
    const group = this.groups.get(groupId);
    if (group === undefined) {
      throw new Error(`unknown group: ${groupId}`);
    }
    return group;
  }
}
