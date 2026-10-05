// 本工程不依赖 @types/node，这里只声明用到的最小 Node.js 全局接口。
declare const process: {
  stdout: { write(s: string): void };
  stderr: { write(s: string): void };
  exit(code: number): never;
  memoryUsage(): {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
};
