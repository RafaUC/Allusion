import { ipcMain } from 'electron';
import log from 'electron-log/main';
import crypto from 'crypto';
import { IS_DEV } from '../../common/process';
import { LoggerConfig } from './types';

const pathRegex =
  /([a-zA-Z]:\\[^:<>"|?*]+)|(\/(?:Users|home|app|var|tmp|desktop|documents)[^:<>"|?*]+)|(\/[^:<>"|?*\s]+\/[^:<>"|?*\s]+)/g;

const logLevels = ['log', 'info', 'warn', 'error', 'debug'] as const;
type LogLevel = (typeof logLevels)[number];

// Initialize loger to be availible in renderer
log.initialize();
log.info('Main process: Logger initialized');

// Default production configuration fallback state
let loggerConfig: LoggerConfig = {
  consoleEnabled: IS_DEV,
  privacyActive: true,
  obfuscateKeys: ['name', 'directory', 'path', 'user'],
};

// Internal placeholder for the external persistence subscriber callback
let configChangeCallback: ((config: LoggerConfig) => void) | null = null;

// Generates a stable, short, deterministic hash for a single word.
function hashWord(word: string) {
  if (!word || word.length <= 2) {
    return word;
  }
  return crypto.createHash('sha256').update(word).digest('hex').substring(0, 6);
}

/**
 * Obfuscator that secures strings while preserving special characters.
 * Keeps spaces, backslashes, dots, and punctuation exactly as they are.
 */
function secureHash(value: unknown, label = 'DATA'): unknown | string {
  if (typeof value !== 'string') {
    return value;
  }

  let textToProcess = value;
  let detectedExtension = '';

  // Scan for a standard file extension at the very end of the string (e.g., ".sqlite")
  // This matches a dot followed by 2 to 6 alphanumeric characters at the end of the line
  const extensionMatch = value.match(/\.([a-zA-Z0-9]{2,6})$/);
  if (extensionMatch) {
    detectedExtension = extensionMatch[0];
    // Remove the extension temporarily so it doesn't get obfuscated inside the loop
    textToProcess = value.substring(0, value.length - detectedExtension.length);
  }
  // Split the remaining text keeping delimiters
  const tokens = textToProcess.match(/(\w+|[^\w]+)/g);
  if (!tokens) {
    return value;
  }
  const processedTokens = tokens.map((token) => {
    if (/^\w+$/.test(token)) {
      return hashWord(token); // Returns the clean 6-character hex string
    }
    return token; // Keeps slashes, dots, and spaces intact
  });
  const unifiedContent = processedTokens.join('');
  return `HIDDEN_${label}_'${unifiedContent}${detectedExtension}'`;
}

/**
 * Recursively traverses objects to apply privacy filters on predefined target keys.
 * Operates on deep objects safely after circular references have been stripped out.
 */
function applyPrivacyFilter(obj: any): any {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => applyPrivacyFilter(item));
  }

  const sanitized: Record<string, any> = {};

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      // if explicit ofuscated key
      if (loggerConfig.obfuscateKeys.includes(key) && typeof obj[key] === 'string') {
        sanitized[key] = secureHash(obj[key], key.toUpperCase());
      } else if (typeof obj[key] === 'string' && loggerConfig.privacyActive) {
        // ofuscate paths
        if (pathRegex.test(obj[key])) {
          sanitized[key] = obj[key].replace(pathRegex, (match: string) =>
            String(secureHash(match, 'PATH')),
          );
        } else {
          sanitized[key] = obj[key];
        }
      } else {
        sanitized[key] = applyPrivacyFilter(obj[key]);
      }
    }
  }
  return sanitized;
}

// Sync electron-log initial transports configuration
log.transports.file.level = 'debug'; // Always write everything to the physical log file
log.transports.file.maxSize = 1024 * 1024 * 2;
log.transports.console.level = loggerConfig.consoleEnabled ? 'debug' : false;

// IPC handler to dynamically alter logging configurations at runtime
ipcMain.handle('update-logger-config', (event, newConfig: Partial<LoggerConfig>) => {
  loggerConfig = { ...loggerConfig, ...newConfig };
  log.transports.console.level = loggerConfig.consoleEnabled ? 'debug' : false;
  if (configChangeCallback) {
    configChangeCallback(loggerConfig);
  }
  return { success: true, currentConfig: loggerConfig };
});

// IPC channel receiving sanitized logs from the Renderer process
ipcMain.on('renderer-log-message', (event, { level, args }: { level: LogLevel; args: any[] }) => {
  const safeArgs = args.map((arg) => {
    // Check if the arg is string and contains a path-like pattern, then obfuscate it if privacy is active
    if (typeof arg === 'string') {
      if (loggerConfig.privacyActive && pathRegex.test(arg)) {
        return arg.replace(pathRegex, (match: string) => String(secureHash(match, 'PATH')));
      }
      return arg; // return the original string if no path-like pattern is found
    }
    // If it's a configuration or response object, recursively inspect its private keys
    return loggerConfig.privacyActive ? applyPrivacyFilter(arg) : arg;
  });
  const targetMethod = level === 'log' ? 'info' : level;
  if (typeof log[targetMethod] === 'function') {
    (log[targetMethod] as (...args: any[]) => void)(...safeArgs);
  }
});

// Monkey-patch and intercept the Main process native console functions
// Store native console references safely with clear indexable signatures
const originalMainConsole: Record<string, (...args: any[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

// Monkey-patch and intercept the Main process native console functions
logLevels.forEach((level) => {
  // FIX: Cast console key explicitly to avoid TS indexation errors
  const targetMethod = level === 'log' ? 'info' : level;

  console[level] = (...args: any[]) => {
    // Execute standard terminal print if console output is explicitly enabled
    if (loggerConfig.consoleEnabled && typeof originalMainConsole[level] === 'function') {
      originalMainConsole[level](...args);
    }
    // Process privacy filters and persist to the secure log file
    const safeArgs = args.map((arg) =>
      loggerConfig.privacyActive ? applyPrivacyFilter(arg) : arg,
    );
    // FIX: Safely trigger electron-log by asserting it as a function type
    if (typeof log[targetMethod] === 'function') {
      (log[targetMethod] as (...args: any[]) => void)(...safeArgs);
    }
  };
});

export class MainLoggerController {
  /**
   * Sets the initial logger configuration retrieved from your external JSON files during startup.
   * Call this on your main initialization sequence.
   */
  static setInitialLoggerConfig(config: Partial<LoggerConfig>) {
    loggerConfig = { ...loggerConfig, ...config };
    // Keep live electron-log transport streams synchronized immediately
    log.transports.console.level = loggerConfig.consoleEnabled ? 'debug' : false;
  }

  /**
   * Subscribes a external listener callback to act when the configuration changes.
   * Use this to hook your application's writeJSON / updatePreferences systems.
   */
  static onLoggerConfigChange(callback: (config: LoggerConfig) => void) {
    configChangeCallback = callback;
  }
}
