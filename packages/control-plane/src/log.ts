/**
 * One JSON line per event. Stdout for a terminal and for the local runner; in the image the same
 * line also goes to stderr, because the MicroVM platform was observed to deliver only the first
 * stdout line of a run to CloudWatch (WP4.2) — whichever stream it forwards, the line is there.
 */
const mirror = process.env.TABFRAME_MODE === "image";
export function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`;
  process.stdout.write(line);
  if (mirror) process.stderr.write(line);
}
