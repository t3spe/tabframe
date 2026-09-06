# WP9.9 — The documents, read as a person wrote them

**Status:** done 2026-09-06.

## What

Every document a reader meets (the README, the documents under `docs/` except the historical
implementation notes, the program READMEs, the SDK README) went through one editing pass with the
structure untouched: the same headings, tables, lists, and code blocks, the same facts, and the same
quoted page sentences the browser tests assert.

## Why

The documents had no inflated vocabulary and almost no filler; a scan for the usual tells found
none. What they had was em dashes: 198 of them, up to eight per five hundred words in the README,
which is the punctuation most associated with generated text. A reader who trips on the punctuation
stops trusting the content.

## How

Each em dash became what it was standing in for: a colon before a list or an explanation, a comma or
a pair of parentheses around an aside, a semicolon or a full stop between two claims. Definition
lists and the glossary use the record's own "**Term.** Text" form. Two intensifiers went ("just",
"exactly" where they added nothing), one "not a nicety; it is" turned into the plain claim, and one
"additionally" became "also". Quoted user-interface strings such as tooltips ("— not connected yet")
and the placeholder cells of tables stayed, because the page says them and the tests check them.
The design record's title is in sentence case.

## Verified

- A structural diff of every file before and after: the same counts of code fences, table rows,
  headings, and list items.
- `bun test ./tests/links.test.ts ./tests/comments.test.ts`: every link and anchor resolves.
- Em dashes left in prose: none, apart from the quoted tooltips.
