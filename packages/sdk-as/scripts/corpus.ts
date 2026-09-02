// `node packages/sdk-as/scripts/corpus.ts`: fetch the word-count corpus — Herman Melville's
// Moby-Dick (1851), public domain, Project Gutenberg ebook #2701 — strip the Project Gutenberg
// header, footer, and license, normalize the typographic characters the word rule cares about,
// and write programs/wordcount/in/corpus.txt. The result is committed; this script exists so the
// build is reproducible. A plain request with no custom headers: no contact details leave this
// machine.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const CORPUS_FILE = path.join(root, "programs/wordcount/in/corpus.txt");

/** The cache URL first, then the pglaf mirror; both were reachable in preflight (design §5.6). */
export const SOURCES = [
  "https://www.gutenberg.org/cache/epub/2701/pg2701.txt",
  "https://gutenberg.pglaf.org/2/7/0/2701/2701-0.txt",
];

const START = /^\*\*\* START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*[ \t]*\r?$/m;
const END = /^\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*[ \t]*\r?$/m;

/** Editorial paragraphs inside the markers that are about the etext, not the book. */
const TRANSCRIBER_NOTES =
  /^Original Transcriber['’]s Notes:[ \t]*\r?\n(?:[ \t]*\r?\n)*(?:.+\r?\n)+/m;

/**
 * The text between the START and END markers, without either marker line, and without the
 * transcriber's notes paragraph Project Gutenberg's edition carries inside them.
 */
export function stripGutenberg(text: string): string {
  const s = START.exec(text);
  const e = END.exec(text);
  if (!s || !e || e.index <= s.index) throw new Error("Project Gutenberg markers not found");
  return text.slice(s.index + s[0].length, e.index).replace(TRANSCRIBER_NOTES, "");
}

/**
 * Normalization the word rule depends on: curly apostrophes and quotation marks become their
 * ASCII forms (so "Ahab’s" is one word, "ahab's"), the em dash becomes "--", the handful of
 * accented Latin letters and ligatures Melville uses become plain letters (so "Cæsar" stays one
 * word), CRLF becomes LF, a byte-order mark and outer whitespace go. Everything else stays;
 * non-ASCII bytes are separators to the program, which is the documented rule.
 */
export function normalizeText(text: string): string {
  return `${text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, "--")
    .replace(/æ/g, "ae")
    .replace(/Æ/g, "Ae")
    .replace(/œ/g, "oe")
    .replace(/Œ/g, "Oe")
    .replace(/[éèêë]/g, "e")
    .replace(/[àâä]/g, "a")
    .replace(/[îï]/g, "i")
    .replace(/[ôö]/g, "o")
    .replace(/[ùûü]/g, "u")
    .replace(/ç/g, "c")
    .trim()}\n`;
}

export async function fetchCorpus(
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; source: string }> {
  let lastError: unknown = null;
  for (const source of SOURCES) {
    try {
      const res = await fetchImpl(source);
      if (!res.ok) throw new Error(`${source}: ${res.status}`);
      return { text: await res.text(), source };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`no source answered: ${String(lastError)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { text, source } = await fetchCorpus();
  const corpus = normalizeText(stripGutenberg(text));
  mkdirSync(path.dirname(CORPUS_FILE), { recursive: true });
  writeFileSync(CORPUS_FILE, corpus);
  const bytes = Buffer.byteLength(corpus);
  const sha = createHash("sha256").update(corpus).digest("hex");
  console.log(
    `[corpus] ${path.relative(root, CORPUS_FILE)}: ${bytes} bytes, ${corpus.split("\n").length} lines, sha256 ${sha} (from ${new URL(source).host})`,
  );
}
