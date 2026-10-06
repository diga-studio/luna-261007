/** 测试所需的少量 Node 全局声明（避免引入完整 @types/node）。 */
declare const process: {
  memoryUsage(): { rss: number } & Record<string, number>;
};

declare const performance: {
  now(): number;
};

declare const console: {
  log(...args: unknown[]): void;
};
