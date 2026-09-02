/**
 * One JSON line per event on stdout; a terminal, the local runner, and CloudWatch all read it. In
 * the MicroVM image the platform was observed (WP4.2) to forward only the first line a process
 * writes — on stdout and on stderr alike — so runtime observability is `/health`, `/diag`, the
 * snapshots in S3, and the dashboard, not the log group.
 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}
