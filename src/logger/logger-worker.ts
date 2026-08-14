import { decycle, resolveLazyArgs, WorkerLoggerOptions } from './logger-utils';

// Local configuration state inside the Web Worker scope
let workerConfig: WorkerLoggerOptions = {
  loggerConsoleEnabled: true,
  maxDepth: 8,
};

// Store absolute references to original Chromium logging features inside the Worker
const originalWorkerConsole: Record<string, (...args: any[]) => void> = {
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

type AllowedLevels = keyof typeof levelsMapping;

// Listen for runtime configuration updates sent from the Main Renderer Window
if (typeof self !== 'undefined') {
  self.addEventListener('message', (event: MessageEvent) => {
    if (event.data && event.data.type === 'UPDATE_WORKER_LOGGER_CONFIG') {
      workerConfig = { ...workerConfig, ...event.data.config };
    }
  });
}

/**
 * Initializes the console interceptor inside a standard Web Worker.
 * Redirects all logs to the main Renderer window via postMessage.
 */
export function initializeWorkerLogger(initialOptions?: WorkerLoggerOptions) {
  if (initialOptions) {
    workerConfig = { ...workerConfig, ...initialOptions };
  }

  (Object.keys(levelsMapping) as AllowedLevels[]).forEach((level) => {
    console[level] = (...rawArgs: any[]) => {
      if (!workerConfig.loggerConsoleEnabled) {
        return;
      }
      const args = resolveLazyArgs(rawArgs);
      // Print locally to DevTools if enabled for this Worker
      if (typeof originalWorkerConsole[level] === 'function') {
        originalWorkerConsole[level].apply(console, args);
      }

      try {
        // Clean objects safely before sending them across the MessagePort boundary
        const safeArgs = args.map((arg) => decycle(arg, 0, workerConfig.maxDepth ?? 8));

        // Send the log payload upstream to the Main Renderer Window
        postMessage({
          type: 'WORKER_LOG_INTERCEPT',
          level: levelsMapping[level],
          args: safeArgs,
        });
      } catch (e) {
        originalWorkerConsole['error'](e);
        // Fallback in case serialization fails for complex objects inside the worker
        postMessage({
          type: 'WORKER_LOG_INTERCEPT',
          level: 'error',
          args: [`[Worker Logger Error]: Failed to serialize log from level ${level}`],
        });
      }
    };
  });
}

/**
 * Overrides the console context inside a Comlink-managed Worker.
 */
export function initializeWorkerLoggerCallback(
  onLogReceived: (level: string, args: any[]) => void,
  initialOptions?: WorkerLoggerOptions,
) {
  if (initialOptions) {
    workerConfig = { ...workerConfig, ...initialOptions };
  }

  (Object.keys(levelsMapping) as AllowedLevels[]).forEach((level) => {
    console[level] = (...args: any[]) => {
      // Keep printing to local Chromium DevTools terminal if enabled
      if (workerConfig.loggerConsoleEnabled && typeof originalWorkerConsole[level] === 'function') {
        originalWorkerConsole[level].apply(console, args);
      }

      try {
        // Clean deep structures safely before executing the Comlink callback
        const safeArgs = args.map((arg) => decycle(arg, 0, workerConfig.maxDepth ?? 8));

        // Trigger the proxied callback securely via Comlink
        onLogReceived(levelsMapping[level], safeArgs);
      } catch (e) {
        originalWorkerConsole['error'](e);
        onLogReceived('error', [`[Worker Logger Error]: Failed to format log from level ${level}`]);
      }
    };
  });
}

export function updateWorkerLoggerConfig(newConfig: Partial<WorkerLoggerOptions>) {
  workerConfig = { ...workerConfig, ...newConfig };
}
