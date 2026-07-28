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

/**
 * Initializes the console interceptor inside a Web Worker.
 * Redirects all logs to the main Renderer window via postMessage.
 */
export function initializeWorkerLogger() {
  (Object.keys(levelsMapping) as AllowedLevels[]).forEach((level) => {
    console[level] = (...args: any[]) => {
      // Optional: Still print to the browser terminal if needed
      if (typeof originalWorkerConsole[level] === 'function') {
        originalWorkerConsole[level](...args);
      }

      try {
        // Send the log payload upstream to the Main Renderer Window
        // Workers cannot use ipcRenderer, so we use the standard postMessage channel
        postMessage({
          type: 'WORKER_LOG_INTERCEPT',
          level: levelsMapping[level],
          // Simple string conversion or light serialization to avoid circular issues inside the worker
          args: args.map((arg) =>
            typeof arg === 'object' ? JSON.parse(JSON.stringify(arg)) : arg,
          ),
        });
      } catch (e) {
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
 * Overrides the console context inside the Comlink Worker.
 */
export function initializeWorkerLoggerCallback(
  onLogReceived: (level: string, args: any[]) => void,
) {
  (Object.keys(levelsMapping) as AllowedLevels[]).forEach((level) => {
    console[level] = (...args: any[]) => {
      // Keep printing to local Chromium DevTools terminal if open
      if (typeof originalWorkerConsole[level] === 'function') {
        originalWorkerConsole[level](...args);
      }
      try {
        // Clean objects briefly to avoid structure issues inside the Comlink payload
        const serializedArgs = args.map((arg) =>
          typeof arg === 'object' && arg !== null ? JSON.parse(JSON.stringify(arg)) : arg,
        );
        // Trigger the proxied callback securely via Comlink
        onLogReceived(levelsMapping[level], serializedArgs);
      } catch (e) {
        onLogReceived('error', [`[Worker Logger Error]: Failed to format log from level ${level}`]);
      }
    };
  });
}
