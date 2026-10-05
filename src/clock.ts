/** 业务时钟：返回当前 UTC 毫秒时间戳。测试可替换为固定/步进时钟。 */
export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
