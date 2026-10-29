export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Structured JSON logs (CloudWatch friendly). Never pass payload bodies or tokens in fields. */
export const jsonLogger: Logger = {
  info: (msg, f) => console.log(JSON.stringify({ level: "info", msg, ...f })),
  warn: (msg, f) => console.warn(JSON.stringify({ level: "warn", msg, ...f })),
  error: (msg, f) => console.error(JSON.stringify({ level: "error", msg, ...f })),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
