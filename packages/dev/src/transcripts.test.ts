import { describe, expect, test } from "bun:test";
import {
  describeToolUse,
  exportTranscript,
  extraPatterns,
  PATTERNS,
  parseEvents,
  scrub,
  truncateLines,
} from "./transcripts.ts";

// Everything below is synthetic: the real transcripts are never read by a test.

const ACCOUNT = "123456789012";
const ENDPOINT = "a1b2c3d4-e5f6-7a8b-9c0d-e1f2a3b4c5d6.lambda-microvm.us-west-2.on.aws";
const LAMBDA_URL = "ufz7io3kcgjo46xf2snwsbwncq0heilt.lambda-url.us-west-2.on.aws";
const MICROVM = "microvm-7690bcea-4999-37e7-992b-facbb9d8c8f6";
const JWE = "eyJraWQiOiI3YzEyZTI2YSIsImFsZyI6ImRpciJ9..qEJhAkrX9zK0.abcDEF123-_ghi.tagTAGtag";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const PRESIGNED = `https://bucket.s3.us-west-2.amazonaws.com/blob/abc?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F${ACCOUNT}%2Fus-west-2&X-Amz-Signature=deadbeef`;
const EMAIL = "someone@example.com";

describe("scrub", () => {
  test("every pattern replaces its own kind and nothing else", () => {
    const cases: Array<[string, string, string]> = [
      ["account-id", `account ${ACCOUNT} here`, "account ************ here"],
      ["microvm-endpoint", `wss://${ENDPOINT}/node`, "wss://<microvm-endpoint>/node"],
      ["lambda-url", `https://${LAMBDA_URL}/`, "https://<lambda-url>/"],
      ["microvm-id", `terminated ${MICROVM}.`, "terminated <microvm-id>."],
      ["token", `auth ${JWE} end`, "auth <token> end"],
      ["token", `bearer ${JWT}`, "bearer <token>"],
      ["email", `mail ${EMAIL} and git@github.com`, "mail <email> and <email>"],
      ["presigned-url", `PUT ${PRESIGNED} ok`, "PUT <presigned-url> ok"],
      // WP8.3: credentials in the shapes tool output shows them.
      ["aws-key-id", "key AKIAIOSFODNN7EXAMPLE x", "key <aws-key-id> x"],
      [
        "amz-credential",
        "q=1&X-Amz-Security-Token=IQoJb3JpZ2luX2VjEBcaCXVzLXdlc3QtMg&X-Amz-Date=20260904",
        "q=1&X-Amz-Credential=<redacted>&X-Amz-Date=20260904",
      ],
      ["masked-account-tail", "account ********6595 ok", "account ************ ok"],
    ];
    for (const [name, input, expected] of cases) {
      const { text, counts } = scrub(input);
      expect(text).toBe(expected);
      expect(counts[name]).toBeGreaterThanOrEqual(1);
    }
    expect(PATTERNS.map((p) => p.name)).toEqual([
      "presigned-url",
      "token",
      "microvm-endpoint",
      "lambda-url",
      "microvm-id",
      "aws-key-id",
      "amz-credential",
      "account-id",
      "masked-account-tail",
      "email",
    ]);
  });

  test("leaves what it should alone", () => {
    const keep = [
      "microvm-local-1 and tabframe-cp-g12",
      "https://d2w9z8juw4oo76.cloudfront.net/blob/abc",
      "1725285600000 is thirteen digits, 1725285600 is ten",
      "eyJ is too short to be a token",
      "af391bcd4011c82ad1cb090ff4db1c3531041a7e3b3176af30133ca3f5f826eb",
    ];
    for (const s of keep) {
      const { text, counts } = scrub(s);
      expect(text).toBe(s);
      expect(counts).toEqual({});
    }
  });

  test("a presigned URL disappears whole, including the account id and token inside it", () => {
    const { text, counts } = scrub(`see ${PRESIGNED}&X-Amz-Security-Token=${JWT} now`);
    expect(text).toBe("see <presigned-url> now");
    expect(counts).toEqual({ "presigned-url": 1 });
  });

  test("is idempotent", () => {
    const once = scrub(`${ACCOUNT} ${ENDPOINT} ${EMAIL} ${JWE}`).text;
    expect(scrub(once).text).toBe(once);
  });
});

describe("truncateLines", () => {
  test("keeps short text as is and cuts long text with a count", () => {
    expect(truncateLines("a\nb\nc", 3)).toBe("a\nb\nc");
    expect(truncateLines("a\nb\nc\nd\ne", 3)).toBe("a\nb\nc\n… (2 more lines)");
    const fifty = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    expect(truncateLines(fifty).endsWith("… (10 more lines)")).toBe(true);
  });
});

describe("describeToolUse", () => {
  test("shows the command, the path, the description — not the whole input", () => {
    expect(describeToolUse("Bash", { command: "ls -la", description: "list" })).toBe("ls -la");
    expect(describeToolUse("Read", { file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(describeToolUse("Write", { file_path: "/a/b.ts", content: "x\ny\nz" })).toBe(
      "/a/b.ts  (3 lines)",
    );
    expect(describeToolUse("Agent", { description: "do it", prompt: "one\ntwo" })).toBe(
      "do it\none\ntwo",
    );
    const other = describeToolUse("WebFetch", { url: "https://x", big: "y".repeat(1000) });
    expect(other.length).toBeLessThanOrEqual(501);
    expect(other.endsWith("…")).toBe(true);
  });
});

/** A tiny transcript in the shapes the real ones use (keys only borrowed; every value made up). */
function synthetic(): string {
  const long = Array.from({ length: 50 }, (_, i) => `out ${i} ${ACCOUNT}`).join("\n");
  const lines = [
    { type: "fork-context-ref", agentId: "agent-xyz", parentSessionId: "parent-1" },
    { type: "mode", sessionId: "s1", mode: "default" },
    {
      type: "user",
      sessionId: "s1",
      timestamp: "2026-09-02T10:00:00.000Z",
      message: { role: "user", content: `please deploy to ${ACCOUNT} and mail ${EMAIL}` },
    },
    {
      type: "assistant",
      sessionId: "s1",
      timestamp: "2026-09-02T10:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `the endpoint is ${ENDPOINT}\nsecond line` },
          { type: "text", text: "Deploying now." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: `curl https://${LAMBDA_URL}/ -H 'X-aws-proxy-auth: ${JWE}'` },
          },
        ],
      },
    },
    {
      type: "user",
      sessionId: "s1",
      timestamp: "2026-09-02T10:00:02.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: long }],
      },
    },
    {
      type: "assistant",
      sessionId: "s1",
      timestamp: "2026-09-02T10:00:03.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/x.ts" } }],
      },
    },
    {
      type: "user",
      sessionId: "s1",
      timestamp: "2026-09-02T10:00:04.000Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: [{ type: "text", text: `file says ${MICROVM}\n\`\`\`\nfenced\n\`\`\`` }],
          },
          { type: "text", text: "and a follow-up question" },
        ],
      },
    },
    {
      type: "attachment",
      sessionId: "s1",
      attachment: { filename: "notes.md", displayPath: "docs/notes.md", type: "file" },
    },
    {
      type: "system",
      sessionId: "s1",
      subtype: "compact_boundary",
      timestamp: "2026-09-02T10:00:05.000Z",
    },
    { type: "queue-operation", sessionId: "s1", operation: "enqueue" },
  ];
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\nnot json at all\n`;
}

describe("exportTranscript", () => {
  test("parses leniently and keeps the turns in order", () => {
    const events = parseEvents(synthetic());
    expect(events.length).toBe(10);
    expect(events.map((e) => e.type)).toEqual([
      "fork-context-ref",
      "mode",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "attachment",
      "system",
      "queue-operation",
    ]);
  });

  test("renders user and assistant text in full, tool calls by name, results truncated", () => {
    const { markdown, summary } = exportTranscript(synthetic(), { maxResultLines: 5 });
    expect(markdown.startsWith("# Session agent-xyz")).toBe(true);
    expect(markdown).toContain("## User · 2026-09-02T10:00:00.000Z");
    expect(markdown).toContain("please deploy to ************ and mail <email>");
    expect(markdown).toContain("## Assistant · 2026-09-02T10:00:01.000Z");
    expect(markdown).toContain("Deploying now.");
    expect(markdown).toContain("> **Thinking.** the endpoint is <microvm-endpoint>\n> second line");
    expect(markdown).toContain("**Tool `Bash`:**");
    expect(markdown).toContain("curl https://<lambda-url>/ -H 'X-aws-proxy-auth: <token>'");
    expect(markdown).toContain("**Result of `Bash`:**");
    expect(markdown).toContain("… (45 more lines)");
    expect(markdown).toContain("**Result of `Read`:**");
    expect(markdown).toContain("file says <microvm-id>");
    // A result carrying its own fence is wrapped in a longer one.
    expect(markdown).toContain("````\nfile says");
    expect(markdown).toContain("and a follow-up question");
    expect(markdown).toContain("*Attachment: docs/notes.md*");
    expect(markdown).toContain("*System: compact_boundary");
    expect(markdown).not.toContain("queue-operation");

    expect(summary.sessionId).toBe("agent-xyz");
    expect(summary.events).toBe(10);
    expect(summary.userMessages).toBe(2);
    expect(summary.assistantMessages).toBe(1);
    expect(summary.toolUses).toBe(2);
    expect(summary.toolResults).toBe(2);
    expect(summary.firstAt).toBe("2026-09-02T10:00:00.000Z");
    expect(summary.lastAt).toBe("2026-09-02T10:00:05.000Z");
    expect(summary.bytesIn).toBeGreaterThan(summary.bytesOut);
  });

  test("nothing secret survives the export", () => {
    const { markdown, summary } = exportTranscript(synthetic());
    for (const secret of [ACCOUNT, ENDPOINT, LAMBDA_URL, MICROVM, JWE, EMAIL]) {
      expect(markdown).not.toContain(secret);
    }
    expect(summary.scrubbed["account-id"]).toBeGreaterThanOrEqual(1);
    expect(summary.scrubbed.email).toBe(1);
    expect(summary.scrubbed.token).toBe(1);
    expect(summary.scrubbed["microvm-endpoint"]).toBe(1);
    expect(summary.scrubbed["microvm-id"]).toBe(1);
    expect(markdown).toContain("scrubbed: ");
  });

  test("a label overrides the id read from the events, and an empty transcript still renders", () => {
    expect(exportTranscript(synthetic(), { label: "main" }).summary.sessionId).toBe("main");
    const empty = exportTranscript("");
    expect(empty.summary.events).toBe(0);
    expect(empty.markdown).toContain("# Session (unknown)");
  });
});

describe("operator scrub words", () => {
  test("words from TABFRAME_SCRUB_WORDS are redacted case-insensitively and escaped as literals", () => {
    const extra = extraPatterns("acme, Widget.Co");
    expect(extra).toHaveLength(2);
    const { text, counts } = scrub("Acme sold widget.co to ACME; widgetXco stays", extra);
    expect(text).toBe("<redacted> sold <redacted> to <redacted>; widgetXco stays");
    expect(counts.word).toBe(3);
    expect(extraPatterns(undefined)).toEqual([]);
    expect(extraPatterns(" , ")).toEqual([]);
  });
});
