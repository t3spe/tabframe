/**
 * The page's content security policy (WP8.2, tightened in WP8.3), one function for CloudFront and
 * the local server, so the browser suites run under the policy the deployed page gets. A worker
 * takes its policy from its own script's response, so the local server sends it for scripts too
 * (WP8.4) — the deployed distribution attaches it to every page response. Scripts
 * come from the page's origin and blob: workers; WebAssembly needs 'wasm-unsafe-eval'; styles are
 * the page's plus inline attributes; connections go to the page's own origin (the store behind
 * CloudFront), the session function URL, the MicroVM endpoints, and the blob bucket for uploads;
 * nothing frames the page and no form posts anywhere.
 */
export function pageCsp(region: string): string {
  return [
    "default-src 'self'",
    // data: and blob: are the compiler worker's own: binaryen's wasm ships as a data URL inside the
    // worker bundle and is fetched at start (the first M8 demo passes failed on exactly this —
    // locally the worker script carried no policy, at CloudFront it does).
    `connect-src 'self' data: blob: https://*.lambda-url.${region}.on.aws wss://*.lambda-microvm.${region}.on.aws https://*.s3.${region}.amazonaws.com`,
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

/** The deployed policy for the machine's region. */
export const PAGE_CSP = pageCsp("us-west-2");

/** Locally the sockets and the store are plain http and ws on the loopback. */
export const LOCAL_PAGE_CSP = PAGE_CSP.replace(
  "connect-src 'self'",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*",
);
