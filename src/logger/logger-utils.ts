import { releaseProxy } from 'comlink';

export interface LoggerConfig {
  loggerConsoleEnabled: boolean;
  loggerPrivacyActive: boolean;
  obfuscateKeys: string[];
}

export interface WorkerLoggerOptions {
  loggerConsoleEnabled?: boolean;
  maxDepth?: number;
}

function isComlinkProxy(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  const type = typeof value;
  if (type !== 'object' && type !== 'function') {
    return false;
  }
  try {
    return typeof (value as any)[releaseProxy] === 'function';
  } catch {
    return false;
  }
}

/**
 * Removes circular references and non clonable objects from complex objects before Electron IPC serialization.
 * Uses a memory tracking Set to catch recursive loops and replaces them safely.
 */
export function decycle(obj: any, currentDepth = 0, maxDepth = 10, seen = new Set<any>()): any {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (isComlinkProxy(obj)) {
    return '[Comlink Proxy]';
  }
  const type = typeof obj;
  if (type === 'function') {
    return `[Function: ${obj?.name || 'anonymous'}]`;
  }
  if (type === 'symbol') {
    return obj.toString();
  }
  if (type !== 'object') {
    return obj;
  }
  if (currentDepth > maxDepth) {
    return '[Max Depth Exceeded]';
  }
  if (seen.has(obj)) {
    return '[Circular Reference]';
  }
  if (obj instanceof Error) {
    return {
      name: obj.name,
      message: obj.message,
      stack: obj.stack,
    };
  }
  if (obj instanceof Date) {
    return obj.toISOString();
  }
  if (obj instanceof RegExp) {
    return obj.toString();
  }
  if (typeof Element !== 'undefined' && obj instanceof Element) {
    return `[HTMLElement: ${obj.tagName}]`;
  }
  // add to set
  seen.add(obj);
  const nextDepth = currentDepth + 1;
  // arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => decycle(item, nextDepth, maxDepth, seen));
  }
  // mobx handling
  const copy: Record<string, any> = {};
  const keys = Object.keys(obj);
  for (const key of keys) {
    try {
      const val = obj[key];
      copy[key] = decycle(val, nextDepth, maxDepth, seen);
    } catch (err) {
      copy[key] = '[Unreadable Property]';
    }
  }
  return copy;
}
