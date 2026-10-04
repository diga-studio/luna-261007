// Minimal ambient declarations so the library compiles without @types/node.
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
