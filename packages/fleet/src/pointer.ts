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
}

export const EMPTY_POINTER: Pointer = {
  state: "off",
  microvmId: null,
  endpoint: null,
  generation: 0,
  imageVersion: null,
  updatedAt: "",
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
