// `mise run transcripts`: export the build's session transcripts as scrubbed Markdown under
// docs/transcripts/ (plan WP5.4). Reads every *.jsonl and *.output in TABFRAME_TRANSCRIPTS_DIR
// (the durable copy of the worker transcripts) plus the main session file, writes one Markdown
// file per session and an index, and prints a summary line each. The output directory is
// gitignored until the export has been reviewed by a person.
//   node scripts/transcripts/export.ts [--out docs/transcripts] [--max-result-lines 40]
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { exportTranscript, type Summary } from "../../packages/dev/src/transcripts.ts";

const root = path.resolve(import.meta.dirname, "../..");
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const outDir = path.resolve(root, arg("--out", "docs/transcripts"));
const maxResultLines = Number(arg("--max-result-lines", "40"));
const expand = (p: string): string => (p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p);
const workersDir = expand(
  process.env.TABFRAME_TRANSCRIPTS_DIR ?? "~/homework/tabframe-transcripts",
);
const mainFile = expand(
  process.env.TABFRAME_MAIN_TRANSCRIPT ??
    "~/.claude/projects/-home-mircea-homework/2f9f4ebc-d551-4417-ad7d-e749c7e0ea1a.jsonl",
);

const sources: Array<{ file: string; label: string }> = [];
if (existsSync(mainFile))
  sources.push({ file: mainFile, label: path.basename(mainFile, ".jsonl") });
else console.error(`main transcript not found: ${mainFile}`);
if (existsSync(workersDir) && statSync(workersDir).isDirectory()) {
  for (const name of readdirSync(workersDir).sort()) {
    if (!/\.(jsonl|output)$/.test(name)) continue;
    const file = path.join(workersDir, name);
    if (!statSync(file).isFile() || statSync(file).size < 1024) continue; // a bash task's output, not a session
    sources.push({ file, label: name.replace(/\.(jsonl|output)$/, "") });
  }
} else {
  console.error(`worker transcripts directory not found: ${workersDir}`);
}
if (sources.length === 0) {
  console.error("nothing to export");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const rows: Summary[] = [];
for (const { file, label } of sources) {
  const jsonl = readFileSync(file, "utf8");
  const { markdown, summary } = exportTranscript(jsonl, { label, maxResultLines });
  writeFileSync(path.join(outDir, `${summary.sessionId}.md`), markdown);
  rows.push(summary);
  const scrubbed = Object.values(summary.scrubbed).reduce((n, v) => n + v, 0);
  console.log(
    `${summary.sessionId}: ${summary.events} events, ${summary.userMessages} user / ${summary.assistantMessages} assistant messages, ${summary.toolUses} tool calls, ${(summary.bytesIn / 1024).toFixed(0)} KB in → ${(summary.bytesOut / 1024).toFixed(0)} KB out, ${scrubbed} scrubbed`,
  );
}

const index = [
  "# Transcripts",
  "",
  "The build's Claude Code sessions, exported as scrubbed Markdown by `mise run transcripts`. The",
  "main session is the conversation with Mircea; the others are worker sessions it forked for",
  "individual work packages. Account ids, MicroVM endpoints and ids, tokens, presigned URLs, and",
  "addresses were replaced with placeholders; tool results are cut to their first lines.",
  "",
  "| Session | From | To | Events | Messages (user / assistant) | Tool calls | Scrubbed |",
  "|---|---|---|---|---|---|---|",
  ...rows.map(
    (r) =>
      `| [${r.sessionId}](${r.sessionId}.md) | ${r.firstAt ?? "?"} | ${r.lastAt ?? "?"} | ${r.events} | ${r.userMessages} / ${r.assistantMessages} | ${r.toolUses} | ${Object.values(r.scrubbed).reduce((n, v) => n + v, 0)} |`,
  ),
  "",
].join("\n");
writeFileSync(path.join(outDir, "index.md"), index);
console.log(`${rows.length} transcripts → ${path.relative(root, outDir)}/`);
