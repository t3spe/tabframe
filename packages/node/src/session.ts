/** What the session function (or the local control plane) answers (design §8.1). */
export type Session =
  | {
      kind: "on";
      endpoint: string;
      token: string;
      expiresAt: number;
      storeBase: string;
      generation: number;
    }
  | { kind: "off" }
  | { kind: "starting"; retryAfterMs: number };

export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function fetchSession(sessionUrl: string, fetchImpl: FetchLike): Promise<Session> {
  const res = await fetchImpl(sessionUrl);
  if (!res.ok) throw new Error(`session ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (body.off === true) return { kind: "off" };
  if (body.starting === true) {
    const retry = typeof body.retryAfterMs === "number" ? body.retryAfterMs : 3_000;
    return { kind: "starting", retryAfterMs: retry };
  }
  const endpoint = body.endpoint;
  const token = body.token;
  const storeBase = body.storeBase;
  const generation = body.generation;
  if (
    typeof endpoint !== "string" ||
    typeof token !== "string" ||
    typeof storeBase !== "string" ||
    typeof generation !== "number"
  ) {
    throw new Error("malformed session");
  }
  const expiresAt =
    typeof body.expiresAt === "number"
      ? body.expiresAt
      : typeof body.expiresAt === "string" && !Number.isNaN(Date.parse(body.expiresAt))
        ? Date.parse(body.expiresAt)
        : Date.now() + 25 * 60_000;
  return {
    kind: "on",
    endpoint: socketEndpoint(endpoint),
    token,
    expiresAt,
    storeBase,
    generation,
  };
}

/** The session may hand out a bare host (MicroVM endpoints have no scheme); sockets need wss. */
export function socketEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, "");
  if (/^wss?:\/\//.test(trimmed)) return trimmed;
  if (/^https?:\/\//.test(trimmed)) return trimmed.replace(/^http/, "ws");
  return `wss://${trimmed}`;
}

/** The subprotocols a browser passes the MicroVM proxy (design §9.1). A local token needs none. */
export function socketProtocols(token: string, port = 8080): string[] | undefined {
  if (token === "local") return undefined;
  return [
    "lambda-microvms",
    `lambda-microvms.authentication.${token}`,
    `lambda-microvms.port.${port}`,
  ];
}
