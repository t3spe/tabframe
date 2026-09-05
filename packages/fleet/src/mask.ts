// Masking for what the operator scripts print: account ids, IAM unique ids and proxy tokens never
// reach a terminal or a transcript.

/** Masks 12-digit account ids (to ********last4), IAM unique ids and `"token":"…"` values; "" for undefined. */
export function maskSecrets(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/\b(\d{8})(\d{4})\b/g, (_m, _head: string, tail: string) => `********${tail}`)
    .replace(/\bAIDA[A-Z0-9]+/g, "AIDA****")
    .replace(/"token":"[^"]+"/g, '"token":"<redacted>"');
}

/** Replaces MicroVM ids with `<microvm-id>`, for output that is kept beyond the terminal. */
export function maskMicrovmIds(text: string): string {
  return text.replace(/microvm-[0-9a-f-]{36}/g, "<microvm-id>");
}
