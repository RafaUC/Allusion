import { IS_DEV } from 'common/process';
import { ipcRenderer } from 'electron';
import { LoggerConfig } from './types';

/**
 * Removes circular references from complex objects before Electron IPC serialization.
 * Uses a memory tracking Set to catch recursive loops and replaces them safely.
 */
function decycle(obj: any, currentDepth = 0, maxDepth = 10, seen = new Set<any>()): any {
  // Return primitive values as they are immediately
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (currentDepth > maxDepth) {
    return '[Max Depth Exceeded]';
  }
  // Catch circular references dynamically
  if (seen.has(obj)) {
    return '[Circular Reference]';
  }
  // Track reference in memory
  seen.add(obj);
  const nextDepth = currentDepth + 1;
  // Handle Arrays safely
  if (Array.isArray(obj)) {
    return obj.map((item) => decycle(item, nextDepth, maxDepth, seen));
  }
  // Handle standard key-value maps/objects safely
  const copy: Record<string, any> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      copy[key] = decycle(obj[key], nextDepth, maxDepth, seen);
    }
  }
  return copy;
}

// Local runtime flag determining whether logs are visible in the Chromium DevTools panel
let rendererConsoleEnabled = IS_DEV;

// Store absolute references to original Chromium logging features
const originalRendererConsole: Record<string, (...args: any[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

const levelsMapping = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
} as const;

type AllowedRendererLevels = keyof typeof levelsMapping;

/**
 * Initializes the global console interceptor for the Renderer process.
 * Call this once at the very top of your frontend entry point.
 */
export async function initializeRendererLogger(options = { maxDepth: 8 }) {
  // get persisted configuration if exists.
  const currentConfig = await ipcRenderer.invoke('update-logger-config', {});
  if (currentConfig && currentConfig.success && currentConfig.currentConfig) {
    rendererConsoleEnabled = currentConfig.currentConfig.consoleEnabled;
  }

  (Object.keys(levelsMapping) as AllowedRendererLevels[]).forEach((level) => {
    console[level] = (...args: any[]) => {
      // Print locally to Chromium DevTools if enabled
      if (rendererConsoleEnabled && typeof originalRendererConsole[level] === 'function') {
        originalRendererConsole[level](...args);
      }
      // Clear out deep circular object trees safely
      const safeArgs = args.map((arg) => decycle(arg, 0, options.maxDepth));
      // Send securely to the Main process using 'renderer-log-message'
      ipcRenderer.send('renderer-log-message', {
        level: levelsMapping[level],
        args: safeArgs,
      });
    };
  });

  // Intercept window alerts and route them through our logger
  const originalAlert = window.alert;
  window.alert = (message: string) => {
    console.warn(`[Window Alert Intercepted]: ${message}`);
    originalAlert(message);
  };

  // Intercepts standard application syntax, runtime errors, or DOM failures.
  window.addEventListener('error', (event: ErrorEvent) => {
    const diagnosticError = {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error?.stack || '[No Stack Trace Available]',
    };

    // Forward the diagnostic breakdown as an absolute critical error straight to the log file
    ipcRenderer.send('renderer-log-message', {
      level: 'error',
      args: ['[Uncaught Exception in Renderer Window]:', diagnosticError],
    });
  });

  /**
   * Intercepts unresolved async Promise drops (e.g., failed fetch requests without a .catch blocker).
   */
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    // Evaluate if the rejected reason is a native Error instance or a raw string/object
    const reason = event.reason;
    const stableReason =
      reason instanceof Error
        ? { message: reason.message, stack: reason.stack }
        : decycle(reason, 0, options.maxDepth);
    // Forward the rejected promise reason payload down to the file repository
    ipcRenderer.send('renderer-log-message', {
      level: 'error',
      args: ['[Unhandled Promise Rejection in Renderer Window]:', stableReason],
    });
  });

  // Global message event listener to capture 'postMessage' streams coming from worker scopes
  window.addEventListener('message', (event: MessageEvent) => {
    // Validate that the message belongs to our specific logger payload contract
    if (event.data && event.data.type === 'WORKER_LOG_INTERCEPT') {
      const { level, args } = event.data;
      // Clear out deep circular object trees safely before forwarding to Electron Main
      const safeArgs = args.map((arg: any) => decycle(arg, 0, options.maxDepth));
      // Append a clear visual marker so you know this log originated from the SQLite backend worker
      ipcRenderer.send('renderer-log-message', {
        level: level,
        args: ['[Worker]', ...safeArgs],
      });
    }
  });
}

/**
 * Expose a simple controller class to change settings at runtime from anywhere in the UI.
 */
export class RendererLoggerController {
  static sendLogDirectly(level: string, args: any[]): void {
    ipcRenderer.send('renderer-log-message', {
      level: level,
      args: args,
    });
  }
  static async getCurrentConfig(): Promise<Partial<LoggerConfig>> {
    const currentConfig = await ipcRenderer.invoke('update-logger-config', {});
    if (currentConfig && currentConfig.success && currentConfig.currentConfig) {
      return currentConfig.currentConfig as LoggerConfig;
    } else {
      return {};
    }
  }
  static setConsoleEnabled = async (
    isEnabled: boolean,
  ): Promise<{ success: boolean; currentConfig: LoggerConfig }> => {
    rendererConsoleEnabled = isEnabled;
    return await ipcRenderer.invoke('update-logger-config', { consoleEnabled: isEnabled });
  };

  static setPrivacyActive = async (
    isActive: boolean,
  ): Promise<{ success: boolean; currentConfig: LoggerConfig }> => {
    return await ipcRenderer.invoke('update-logger-config', { privacyActive: isActive });
  };
}
