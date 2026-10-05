/** 协议条件 */
export type Protocol = 'TCP' | 'UDP' | 'ICMP';

/** 规则动作 */
export type Action = 'allow' | 'rate-limit' | 'challenge' | 'drop';

/** 端口条件：任意，或闭区间 [from, to]（0-65535，含端点） */
export type PortCondition =
  | { kind: 'any' }
  | { kind: 'range'; from: number; to: number };

/** 防护规则 */
export interface Rule {
  /** 唯一整数编号 */
  id: number;
  /** 优先级 1-1000，数字小者优先 */
  priority: number;
  /** 源 IPv4 网段，CIDR 记法，如 "10.0.0.0/8"；主机位不影响网络范围 */
  cidr: string;
  /** 协议条件：具体协议或 'ANY' */
  protocol: Protocol | 'ANY';
  /** 目的端口条件 */
  port: PortCondition;
  action: Action;
}

/** 流量记录。ICMP 记录无端口（dstPort 缺省）。 */
export interface TrafficRecord {
  /** 源 IPv4，点分十进制 */
  srcIp: string;
  protocol: Protocol;
  /** 目的端口；ICMP 记录缺省 */
  dstPort?: number;
}

/** 裁决决定 */
export interface Decision {
  action: Action;
  /** 获胜规则编号；无匹配（默认放行）时为 null */
  ruleId: number | null;
}
