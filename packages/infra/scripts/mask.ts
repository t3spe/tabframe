/** Masks AWS account ids (12 digits → ********last4) and IAM unique ids in any text. */
export function maskAccount(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/\b(\d{8})(\d{4})\b/g, (_m, _head: string, tail: string) => `********${tail}`)
    .replace(/\bAIDA[A-Z0-9]+/g, "AIDA****");
}
