/** One JSON line per event on stdout; CloudWatch and a terminal both read it fine. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}
