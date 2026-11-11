export class MonitorError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
// Never expose raw SQLite errors, paths, source values or SQL in output/logs.
export function safeCode(error: unknown): string {
  return error instanceof MonitorError ? error.code : 'IO_OR_DATABASE_ERROR';
}
