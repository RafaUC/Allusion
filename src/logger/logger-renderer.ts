import { IS_DEV } from 'common/process';
import { ipcRenderer } from 'electron';
import { decycle, LoggerConfig, resolveLazyArgs, WorkerLoggerOptions } from './logger-utils';
import { action } from 'mobx';

// Local runtime flag determining whether logs are visible in the Chromium DevTools panel
let rendererConsoleEnabled = IS_DEV;

// Registry of active Workers to keep their logger configurations synchronized
const registeredWorkers = new Set<Worker>();

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
 * Helper function to end configuration payload updates to all registered Workers.
 */
function sendConfigToWorkers(config: WorkerLoggerOptions) {
  registeredWorkers.forEach((worker) => {
    try {
      worker.postMessage({
        type: 'UPDATE_WORKER_LOGGER_CONFIG',
        config,
      });
    } catch (e) {
      // Handles cases where a worker may have been terminated or is invalid
      originalRendererConsole.warn('[Renderer Logger]: Failed to notify a Web Worker:', e);
    }
  });
}

// listen to amin updates to the logger configuration and propagate them to all registered workers
ipcRenderer.on('update-logger-config', (_event, newConfig: Partial<LoggerConfig>) => {
  originalRendererConsole.log('[DEBUG] Received update-logger-config', newConfig);
  if (typeof newConfig.loggerConsoleEnabled === 'boolean') {
    rendererConsoleEnabled = newConfig.loggerConsoleEnabled;
    sendConfigToWorkers({
      loggerConsoleEnabled: rendererConsoleEnabled,
    });
  }
});

/**
 * Initializes the global console interceptor for the Renderer process.
 * Call this once at the very top of your frontend entry point.
 */
export async function initializeRendererLogger(options = { maxDepth: 8 }) {
  // Retrieve persisted configuration if available
  const currentConfig = await RendererLoggerController.getCurrentConfig();
  originalRendererConsole.log('[DEBUG] initializeRendererLogger', currentConfig);
  if (typeof currentConfig.loggerConsoleEnabled === 'boolean') {
    rendererConsoleEnabled = currentConfig.loggerConsoleEnabled;
    // send the restored initial configuration to any currently registered workers
    sendConfigToWorkers({
      loggerConsoleEnabled: rendererConsoleEnabled,
      maxDepth: options.maxDepth,
    });
  }

  (Object.keys(levelsMapping) as AllowedRendererLevels[]).forEach((level) => {
    console[level] = action((...rawArgs: any[]) => {
      if (!rendererConsoleEnabled) {
        return;
      }
      const args = resolveLazyArgs(rawArgs);
      // Print locally to Chromium DevTools preserving caller context if enabled
      if (typeof originalRendererConsole[level] === 'function') {
        originalRendererConsole[level].apply(console, args);
      }

      try {
        // Clear out deep circular object trees safely
        const safeArgs = args.map((arg) => decycle(arg, 0, options.maxDepth));
        ipcRenderer.send('renderer-log-message', {
          level: levelsMapping[level],
          args: safeArgs,
        });
      } catch (e) {
        originalRendererConsole['error'](e);
      }
    });
  });

  // Intercept window alerts and route them through our logger
  const originalAlert = window.alert;
  window.alert = (message: string) => {
    console.warn(`[Window Alert Intercepted]: ${message}`);
    originalAlert(message);
  };

  // Intercept standard application syntax, runtime errors, or DOM failures
  window.addEventListener('error', (event: ErrorEvent) => {
    const diagnosticError = {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error?.stack || '[No Stack Trace Available]',
    };

    ipcRenderer.send('renderer-log-message', {
      level: 'error',
      args: ['[Uncaught Exception in Renderer Window]:', diagnosticError],
    });
  });

  // Intercept unresolved async Promise drops (e.g., failed fetch requests without a .catch blocker)
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const stableReason =
      reason instanceof Error
        ? { message: reason.message, stack: reason.stack }
        : decycle(reason, 0, options.maxDepth);

    ipcRenderer.send('renderer-log-message', {
      level: 'error',
      args: ['[Unhandled Promise Rejection in Renderer Window]:', stableReason],
    });
  });

  // Global message event listener to capture 'postMessage' streams coming from worker scopes
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.data && event.data.type === 'WORKER_LOG_INTERCEPT') {
      const { level, args } = event.data;

      ipcRenderer.send('renderer-log-message', {
        level: level,
        args: ['[Worker]', ...args],
      });
    }
  });
}

// Helper function to handle log messages received from any Worker
function handleWorkerLogMessage(event: MessageEvent, name: string) {
  if (event.data && event.data.type === 'WORKER_LOG_INTERCEPT') {
    const { level, args } = event.data;

    ipcRenderer.send('renderer-log-message', {
      level: level,
      args: [`[Worker${name ? `: ${name}` : ''}]`, ...args],
    });
  }
}

/**
 * Controller class to manage logger settings and worker registrations dynamically at runtime.
 */
export class RendererLoggerController {
  /**
   * Registers one or multiple Workers to receive logger configuration broadcasts.
   */
  static registerWorker(workers: Worker | Worker[], name?: string): void {
    const workerList = Array.isArray(workers) ? workers : [workers];
    workerList.forEach((w, i) => {
      if (!registeredWorkers.has(w)) {
        registeredWorkers.add(w);
        // Attach listener specifically to the Worker instance
        w.addEventListener('message', (e) =>
          handleWorkerLogMessage(e, `${name}${i > 0 ? ` #${i}` : ''}`),
        );
      }
    });
    // Send the current configuration to newly registered worker(s)
    sendConfigToWorkers({
      loggerConsoleEnabled: rendererConsoleEnabled,
    });
  }

  /**
   * Unregisters one or multiple Workers from receiving future updates.
   */
  static unregisterWorker(workers: Worker | Worker[]): void {
    const workerList = Array.isArray(workers) ? workers : [workers];
    workerList.forEach((w) => registeredWorkers.delete(w));
  }

  /**
   * Clears all registered Workers from the registry.
   */
  static clearWorkers(): void {
    registeredWorkers.clear();
  }

  static sendLogDirectly(level: string, args: any[]): void {
    ipcRenderer.send('renderer-log-message', {
      level: level,
      args: args,
    });
  }

  /** Lets call sites skip building expensive debug payloads when console logging is off. */
  static isConsoleEnabled(): boolean {
    return rendererConsoleEnabled;
  }

  static async getCurrentConfig(): Promise<Partial<LoggerConfig>> {
    const currentConfig: { success: boolean; currentConfig: LoggerConfig } =
      await ipcRenderer.invoke('update-logger-config', {});
    if (currentConfig.success) {
      return currentConfig.currentConfig as LoggerConfig;
    } else {
      return {};
    }
  }

  /**
   * Enables or disables console logging globally across Renderer and all registered Workers.
   */
  static setConsoleEnabled = async (
    isEnabled: boolean,
  ): Promise<{ success: boolean; currentConfig: LoggerConfig }> => {
    rendererConsoleEnabled = isEnabled;

    // send the update to all registered workers
    sendConfigToWorkers({ loggerConsoleEnabled: isEnabled });
    const newConfig: Partial<LoggerConfig> = { loggerConsoleEnabled: isEnabled };
    return await ipcRenderer.invoke('update-logger-config', newConfig);
  };

  static setPrivacyActive = async (
    isActive: boolean,
  ): Promise<{ success: boolean; currentConfig: LoggerConfig }> => {
    const newConfig: Partial<LoggerConfig> = { loggerPrivacyActive: isActive };
    return await ipcRenderer.invoke('update-logger-config', newConfig);
  };
}
