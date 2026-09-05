/**
 * One JSON line per event on stdout; a terminal, the local runner, and CloudWatch all read it. The
 * MicroVM platform forwards only the first line a process writes, on stdout and stderr alike, so
 * runtime observability is `/health`, `/diag`, the snapshots in S3, and the dashboard.
 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

export type Log = typeof log;
