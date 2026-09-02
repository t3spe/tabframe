import { describe, expect, test } from "bun:test";
import { fetchCorpus, normalizeText, SOURCES, stripGutenberg } from "../scripts/corpus.ts";

const wrapped = [
  "﻿The Project Gutenberg eBook of Something\r\n",
  "Title: Something\r\n",
  "*** START OF THE PROJECT GUTENBERG EBOOK SOMETHING ***\r\n",
  "\r\n",
  "Original Transcriber's Notes:\r\n",
  "\r\n",
  "This text is a combination of etexts, one from Project Gutenberg's archives.\r\n",
  "The proofreaders are indebted to a library.\r\n",
  "\r\n",
  "Call me Ishmael. Ahab’s “whale” — Cæsar’s œuvre, café.\r\n",
  "Last line without newline",
  "\r\n*** END OF THE PROJECT GUTENBERG EBOOK SOMETHING ***\r\n",
  "License text here.\r\n",
].join("");

describe("corpus preparation", () => {
  test("stripGutenberg keeps only the text between the markers", () => {
    const body = stripGutenberg(wrapped);
    expect(body).not.toContain("Project Gutenberg");
    expect(body).not.toContain("Transcriber");
    expect(body).not.toContain("proofreaders");
    expect(body).toContain("Call me Ishmael");
    expect(body).toContain("Last line without newline");
    expect(body).not.toContain("License text");
    expect(() => stripGutenberg("no markers")).toThrow("markers not found");
    expect(() =>
      stripGutenberg(
        "*** END OF THE PROJECT GUTENBERG EBOOK X ***\n*** START OF THE PROJECT GUTENBERG EBOOK X ***\n",
      ),
    ).toThrow();
  });

  test("normalizeText: ASCII apostrophes and quotes, LF endings, plain letters, one trailing newline", () => {
    const text = normalizeText(stripGutenberg(wrapped));
    expect(text).toBe(
      "Call me Ishmael. Ahab's \"whale\" -- Caesar's oeuvre, cafe.\nLast line without newline\n",
    );
    expect(text.startsWith("﻿")).toBe(false);
    expect(normalizeText("  a\r\nb  ")).toBe("a\nb\n");
  });

  test("fetchCorpus tries the cache URL first and falls back to the mirror", async () => {
    const asked: string[] = [];
    const fake = (async (url: string | URL | Request) => {
      asked.push(String(url));
      if (asked.length === 1) return new Response("nope", { status: 503 });
      return new Response(
        "*** START OF THE PROJECT GUTENBERG EBOOK X ***\nhi\n*** END OF THE PROJECT GUTENBERG EBOOK X ***\n",
      );
    }) as typeof fetch;
    const { text, source } = await fetchCorpus(fake);
    expect(asked).toEqual(SOURCES);
    expect(source).toBe(SOURCES[1] as string);
    expect(normalizeText(stripGutenberg(text))).toBe("hi\n");
    const dead = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(fetchCorpus(dead)).rejects.toThrow("no source answered");
  });
});
