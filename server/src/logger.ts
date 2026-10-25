export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const levelOrder: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(options: { production: boolean; level?: LogLevel }): Logger {
  const minimum = levelOrder[options.level ?? (options.production ? "info" : "debug")];

  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (levelOrder[level] < minimum) return;
    if (options.production) {
      const line = JSON.stringify({ level, time: new Date().toISOString(), message, ...fields });
      process.stdout.write(`${line}\n`);
      return;
    }
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : "";
    process.stdout.write(`[${level}] ${message}${suffix}\n`);
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
