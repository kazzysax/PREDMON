import { Buffer } from 'buffer';
// The Aurora widget was written for Node-style bundles and expects these two globals.
(globalThis as any).Buffer ??= Buffer;
(globalThis as any).process ??= { env: {}, browser: true, version: '', versions: {}, nextTick: (f: any, ...a: any[]) => queueMicrotask(() => f(...a)) };
