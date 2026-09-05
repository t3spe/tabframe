// Number and time formatting shared by every view, so the same quantity reads the same everywhere.

/** `HH:MM:SS` in the reader's locale, 24-hour. */
export const fmtTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export const fmtMs = (ms: number | null): string => (ms === null ? "—" : `${ms} ms`);

/** Binary units, one decimal: `16.0 KiB`. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/** A bar's value: thousands separated, at most three decimals. */
export function fmtValue(v: number): string {
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  return v.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

/** The head of a hash with an ellipsis. */
export const short = (hash: string, n = 12): string => `${hash.slice(0, n)}…`;

/** How long ago, in seconds under a minute and whole minutes after. */
export const ago = (from: number, now: number): string => {
  const s = Math.max(0, Math.round((now - from) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
};

/** A countdown in seconds with one decimal: `2.4 s`. */
export const fmtCountdown = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
