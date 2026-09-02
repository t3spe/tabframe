// Placeholder control plane for the image skeleton (WP0.8): answers the lifecycle hooks on the
// private port so the image build completes, and a health route on both ports. Replaced by the
// real bundle from packages/control-plane in WP0.4/WP0.10.
const http = require("node:http");

const PUBLIC_PORT = Number(process.env.TABFRAME_PUBLIC_PORT || 8080);
const PRIVATE_PORT = Number(process.env.TABFRAME_PRIVATE_PORT || 8081);
const HOOK_BASE = "/aws/lambda-microvms/runtime/v1/";

let role = "neutral";
let generation = 0;

function log(message, fields) {
  console.log(JSON.stringify({ level: "info", message, role, ...fields }));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
    });
    req.on("end", () => resolve(data));
  });
}

const privateServer = http.createServer(async (req, res) => {
  const url = req.url || "/";
  if (url.startsWith(HOOK_BASE)) {
    const hook = url.slice(HOOK_BASE.length);
    const body = await readBody(req);
    if (hook === "run" && body) {
      try {
        const parsed = JSON.parse(body);
        const payload = parsed.runHookPayload ? JSON.parse(parsed.runHookPayload) : {};
        role = payload.role || "unknown";
        generation = payload.generation || 0;
      } catch {
        role = "unknown";
      }
    }
    log(`hook ${hook}`, { generation });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, hook, role }));
    return;
  }
  if (url === "/health" || url === "/diag") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, role, generation, placeholder: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const publicServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, role, generation, placeholder: true, path: req.url }));
});

privateServer.listen(PRIVATE_PORT, () => log("listening", { port: PRIVATE_PORT, kind: "private" }));
publicServer.listen(PUBLIC_PORT, () => log("listening", { port: PUBLIC_PORT, kind: "public" }));
