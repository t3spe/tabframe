// Transcript export (plan WP5.4): a Claude Code session transcript — JSONL, one event per line —
// rendered as readable Markdown with the secrets scrubbed. The build's transcripts are submitted
// with the code; every one of them contains an account id, MicroVM endpoints, and proxy tokens in
// tool output, so nothing leaves this module unscrubbed. Tool results are truncated so the export
// reads as a conversation rather than a log dump; user and assistant text are kept in full.

/** A scrub pattern: what it matches, what replaces it, and the name the summary counts under. */
export interface ScrubPattern {
  name: string;
  re: RegExp;
  replacement: string;
}

/**
 * Applied in this order: a presigned URL carries a token and often an id, so it goes first and
 * whole; tokens before ids; account ids before emails (an email never contains twelve digits, but
 * a replacement must not create a new match). Every pattern is global.
 */
export const PATTERNS: readonly ScrubPattern[] = [
  {
    name: "presigned-url",
    re: /https?:\/\/[^\s"'<>)\]]*X-Amz-Signature[^\s"'<>)\]]*/g,
    replacement: "<presigned-url>",
  },
  // JWE/JWS compact serialization: base64url parts joined by dots, an empty part allowed (`..`).
  {
    name: "token",
    re: /\beyJ[A-Za-z0-9_-]{8,}(?:\.{1,2}[A-Za-z0-9_-]+)*/g,
    replacement: "<token>",
  },
  {
    name: "microvm-endpoint",
    re: /\b[a-z0-9-]+\.lambda-microvm\.[a-z0-9-]+\.on\.aws\b/g,
    replacement: "<microvm-endpoint>",
  },
  {
    name: "lambda-url",
    re: /\b[a-z0-9-]+\.lambda-url\.[a-z0-9-]+\.on\.aws\b/g,
    replacement: "<lambda-url>",
  },
  {
    name: "microvm-id",
    re: /\bmicrovm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
    replacement: "<microvm-id>",
  },
  { name: "account-id", re: /\b\d{12}\b/g, replacement: "************" },
  {
    name: "email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    replacement: "<email>",
  },
];

/** Scrub text; the counts say how many of each pattern were replaced. */
export function scrub(text: string): { text: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  let out = text;
  for (const p of PATTERNS) {
    let n = 0;
    out = out.replace(p.re, () => {
      n += 1;
      return p.replacement;
    });
    if (n > 0) counts[p.name] = n;
  }
  return { text: out, counts };
}

/** Keep the first `max` lines and say how many were cut. */
export function truncateLines(text: string, max = 40): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join("\n")}\n… (${lines.length - max} more lines)`;
}

// ---- the transcript's shapes, as much of them as the export needs -------------------------------

interface ContentPart {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentPart[];
}

interface TranscriptEvent {
  type: string;
  sessionId?: string;
  agentId?: string;
  timestamp?: string;
  subtype?: string;
  message?: { role?: string; content?: string | ContentPart[] };
  attachment?: { filename?: string; displayPath?: string; type?: string };
}

export interface Summary {
  sessionId: string;
  firstAt: string | null;
  lastAt: string | null;
  events: number;
  userMessages: number;
  assistantMessages: number;
  toolUses: number;
  toolResults: number;
  bytesIn: number;
  bytesOut: number;
  scrubbed: Record<string, number>;
}

export interface Exported {
  markdown: string;
  summary: Summary;
}

export interface ExportOptions {
  /** Lines of a tool result to keep. */
  maxResultLines?: number;
  /** Overrides the id read from the events (the file's own name, usually). */
  label?: string;
}

/** Parse JSONL leniently: a line that is not JSON is skipped, not fatal. */
export function parseEvents(jsonl: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { type?: unknown }).type === "string"
      ) {
        events.push(parsed as TranscriptEvent);
      }
    } catch {
      // not an event line
    }
  }
  return events;
}

const asText = (content: string | ContentPart[] | undefined): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .filter((t) => t.length > 0)
    .join("\n");
};

/** What to show for a tool call: the command, the path, the description — never the whole input. */
export function describeToolUse(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const str = (k: string): string | null => (typeof i[k] === "string" ? (i[k] as string) : null);
  switch (name) {
    case "Bash":
      return str("command") ?? "";
    case "Read":
    case "Write":
    case "Edit": {
      const path = str("file_path") ?? "";
      if (name === "Write" && typeof i.content === "string") {
        return `${path}  (${i.content.split("\n").length} lines)`;
      }
      return path;
    }
    case "Agent":
    case "SendMessage": {
      const head = str("description") ?? str("summary") ?? "";
      const body = str("prompt") ?? str("message") ?? "";
      return body ? `${head}\n${truncateLines(body, 12)}` : head;
    }
    default: {
      const json = JSON.stringify(i);
      return json.length > 500 ? `${json.slice(0, 500)}…` : json;
    }
  }
}

const quote = (text: string): string =>
  text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

const fence = (text: string): string => {
  // A result that contains a fence of its own gets a longer one, so the block cannot close early.
  let ticks = "```";
  while (text.includes(ticks)) ticks += "`";
  return `${ticks}\n${text}\n${ticks}`;
};

/**
 * Render one transcript. Events the export does not need — mode changes, snapshots of the
 * editor's file history, queue bookkeeping — are skipped; user and assistant turns, tool calls
 * and their (truncated) results, attachments, and system notices are kept in order.
 */
export function exportTranscript(jsonl: string, opts: ExportOptions = {}): Exported {
  const maxLines = opts.maxResultLines ?? 40;
  const events = parseEvents(jsonl);
  const toolNames = new Map<string, string>();
  const summary: Summary = {
    sessionId: opts.label ?? "",
    firstAt: null,
    lastAt: null,
    events: events.length,
    userMessages: 0,
    assistantMessages: 0,
    toolUses: 0,
    toolResults: 0,
    bytesIn: jsonl.length,
    bytesOut: 0,
    scrubbed: {},
  };
  const body: string[] = [];

  for (const e of events) {
    if (!summary.sessionId) summary.sessionId = e.agentId ?? e.sessionId ?? "";
    if (e.timestamp) {
      if (!summary.firstAt) summary.firstAt = e.timestamp;
      summary.lastAt = e.timestamp;
    }
    const stamp = e.timestamp ? ` · ${e.timestamp}` : "";
    switch (e.type) {
      case "user": {
        const content = e.message?.content;
        if (typeof content === "string") {
          summary.userMessages += 1;
          body.push(`## User${stamp}\n\n${content}\n`);
          break;
        }
        if (!Array.isArray(content)) break;
        for (const part of content) {
          if (part.type === "text" && typeof part.text === "string") {
            summary.userMessages += 1;
            body.push(`## User${stamp}\n\n${part.text}\n`);
          } else if (part.type === "tool_result") {
            summary.toolResults += 1;
            const name = (part.tool_use_id && toolNames.get(part.tool_use_id)) || "tool";
            const text = asText(part.content) || "(no text)";
            body.push(`**Result of \`${name}\`:**\n\n${fence(truncateLines(text, maxLines))}\n`);
          }
        }
        break;
      }
      case "assistant": {
        const content = e.message?.content;
        if (!Array.isArray(content)) break;
        let said = false;
        for (const part of content) {
          if (part.type === "thinking" && typeof part.thinking === "string") {
            body.push(`${quote(`**Thinking.** ${part.thinking}`)}\n`);
          } else if (part.type === "text" && typeof part.text === "string") {
            if (!said) {
              body.push(`## Assistant${stamp}\n`);
              said = true;
            }
            body.push(`${part.text}\n`);
          } else if (part.type === "tool_use" && typeof part.name === "string") {
            summary.toolUses += 1;
            if (part.id) toolNames.set(part.id, part.name);
            body.push(
              `**Tool \`${part.name}\`:**\n\n${fence(describeToolUse(part.name, part.input))}\n`,
            );
          }
        }
        if (said) summary.assistantMessages += 1;
        break;
      }
      case "attachment": {
        const name = e.attachment?.displayPath ?? e.attachment?.filename ?? "(file)";
        body.push(`*Attachment: ${name}*\n`);
        break;
      }
      case "system": {
        body.push(`*System: ${e.subtype ?? "notice"}${stamp}*\n`);
        break;
      }
      default:
        break;
    }
  }

  const { text, counts } = scrub(body.join("\n"));
  summary.scrubbed = counts;
  const head = [
    `# Session ${summary.sessionId || "(unknown)"}`,
    "",
    "Exported from a Claude Code transcript with account ids, endpoints, tokens, presigned URLs,",
    "and addresses scrubbed; tool results are cut to their first lines.",
    "",
    `- events: ${summary.events} · user messages: ${summary.userMessages} · assistant messages: ${summary.assistantMessages} · tool calls: ${summary.toolUses} · tool results: ${summary.toolResults}`,
    `- from ${summary.firstAt ?? "?"} to ${summary.lastAt ?? "?"}`,
    `- scrubbed: ${
      Object.entries(counts)
        .map(([k, v]) => `${k} ×${v}`)
        .join(", ") || "nothing"
    }`,
    "",
    "---",
    "",
  ].join("\n");
  const markdown = head + text;
  summary.bytesOut = markdown.length;
  return { markdown, summary };
}
