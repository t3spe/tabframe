/**
 * The page's content security policy (WP8.2), one string for CloudFront and the local server, so
 * the browser suites run under the policy the deployed page gets. Scripts come from the page's
 * origin and blob: workers; WebAssembly needs 'wasm-unsafe-eval'; styles are the page's plus inline
 * attributes; nothing frames the page.
 */
export const PAGE_CSP = [
  "default-src 'self' https: wss: data: blob:",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Locally the sockets and the store are plain http and ws on the loopback. */
export const LOCAL_PAGE_CSP = PAGE_CSP.replace(
  "default-src 'self' https: wss:",
  "default-src 'self' https: wss: http: ws:",
);
