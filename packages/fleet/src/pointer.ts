// The pointer: one SSM parameter naming the active control plane and its generation (design §9.2).
// `state` is "on" or "off". Off means the machine is down until an explicit `mise run up` (D20).

export type PointerState = "on" | "off";

export interface Pointer {
  state: PointerState;
  microvmId: string | null;
  endpoint: string | null;
  generation: number;
  imageVersion: string | null;
  updatedAt: string;
  /**
   * A successor a rotation launched but has not yet promoted (design §9.4). A rotation that dies
   * between the launch and the pointer flip leaves this behind, and the next run finishes or
   * rolls it back rather than leaving an orphan MicroVM burning money.
   */
  pending: { microvmId: string; endpoint: string | null; generation: number; at?: number } | null;
  /**
   * The predecessor a rotation promoted over and has not yet drained and terminated. A
   * rotation that dies between the pointer flip and the retire leaves this behind; the next run
   * finishes the retire instead of leaving a second active generation running for hours.
   */
  retiring?: { microvmId: string; endpoint: string | null } | null;
  /**
   * An image version the operator pinned with `mise run rollback`: every launch until
   * `up` clears it boots this version, hourly rotations included. Null means the image's latest.
   */
  pinnedImageVersion?: string | null;
}

export const EMPTY_POINTER: Pointer = {
  state: "off",
  microvmId: null,
  endpoint: null,
  generation: 0,
  imageVersion: null,
  updatedAt: "",
  pending: null,
  retiring: null,
  pinnedImageVersion: null,
};

export interface PointerStore {
  read(): Promise<Pointer>;
  write(pointer: Pointer): Promise<void>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Tolerant parser: missing or malformed fields fall back to the empty pointer's values. */
export function parsePointer(raw: string | undefined | null): Pointer {
  if (!raw) return { ...EMPTY_POINTER };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...EMPTY_POINTER };
  }
  if (typeof data !== "object" || data === null) return { ...EMPTY_POINTER };
  const o = data as Record<string, unknown>;
  const generation =
    typeof o.generation === "number" && Number.isInteger(o.generation) && o.generation >= 0
      ? o.generation
      : 0;
  return {
    state: o.state === "on" ? "on" : "off",
    microvmId: asString(o.microvmId),
    endpoint: asString(o.endpoint),
    generation,
    imageVersion: asString(o.imageVersion),
    updatedAt: asString(o.updatedAt) ?? "",
    pending: parsePending(o.pending),
    // Both survive a round trip through SSM: a field the parser drops is a rotation step that never runs.
    retiring: parseRetiring(o.retiring),
    pinnedImageVersion: asString(o.pinnedImageVersion),
  };
}

function parseRetiring(value: unknown): { microvmId: string; endpoint: string | null } | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const microvmId = asString(r.microvmId);
  if (!microvmId) return null;
  return { microvmId, endpoint: asString(r.endpoint) };
}

function parsePending(value: unknown): Pointer["pending"] {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  const microvmId = asString(p.microvmId);
  const generation =
    typeof p.generation === "number" && Number.isInteger(p.generation) ? p.generation : null;
  if (!microvmId || generation === null) return null;
  const at = typeof p.at === "number" && Number.isFinite(p.at) ? p.at : undefined;
  return {
    microvmId,
    endpoint: asString(p.endpoint),
    generation,
    ...(at !== undefined ? { at } : {}),
  };
}

export function serializePointer(pointer: Pointer): string {
  return JSON.stringify(pointer);
}

export class InMemoryPointerStore implements PointerStore {
  private value: Pointer;
  readonly writes: Pointer[] = [];

  constructor(initial: Pointer = { ...EMPTY_POINTER }) {
    this.value = { ...initial };
  }

  async read(): Promise<Pointer> {
    return { ...this.value };
  }

  async write(pointer: Pointer): Promise<void> {
    this.value = { ...pointer };
    this.writes.push({ ...pointer });
  }
}
