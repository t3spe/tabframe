/**
 * The page's content security policy, one function for CloudFront and the local server, so the
 * browser suites run under the policy the deployed page gets. A worker takes its policy from its
 * own script's response, so the local server sends it for scripts too; the distribution attaches
 * it to every page response. Scripts come from the page's origin and blob: workers; WebAssembly
 * needs 'wasm-unsafe-eval'; styles are the page's plus inline attributes; connections go to the
 * page's own origin (the store behind CloudFront), the session function URL, the MicroVM
 * endpoints, and the blob bucket for uploads; nothing frames the page and no form posts anywhere.
 * `local` adds the loopback origins the local server's sockets and store live on.
 */
export function pageCsp(region: string, opts: { local?: boolean } = {}): string {
  const connect = [
    "'self'",
    ...(opts.local
      ? ["http://127.0.0.1:*", "ws://127.0.0.1:*", "http://localhost:*", "ws://localhost:*"]
      : []),
    // data: and blob: are the compiler worker's own: binaryen's wasm ships as a data URL inside the
    // worker bundle and is fetched at start.
    "data:",
    "blob:",
    `https://*.lambda-url.${region}.on.aws`,
    `wss://*.lambda-microvm.${region}.on.aws`,
    `https://*.s3.${region}.amazonaws.com`,
  ];
  return [
    "default-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The deployed policy for the machine's region. Hosting configuration, kept here for its callers
 * (the local server and the stacks) until they take the region from their own config.
 */
export const PAGE_CSP = pageCsp("us-west-2");

/** The local server's policy: the deployed one plus the loopback origins. */
export const LOCAL_PAGE_CSP = pageCsp("us-west-2", { local: true });
