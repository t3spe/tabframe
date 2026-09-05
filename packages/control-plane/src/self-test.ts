import { apply, createLedger } from "@tabframe/core";
import { PROTOCOL_VERSION } from "@tabframe/protocol";

/** The /validate self-test: a hello, a heartbeat, and a tick against a scratch ledger. */
export function selfTest(): boolean {
  const scratch = createLedger(0, { storeBase: "http://self-test/blob" });
  const now = 1_000;
  apply(scratch, { kind: "connected", connId: "t", role: "node" }, now);
  const hello = JSON.stringify({
    t: "hello",
    v: PROTOCOL_VERSION,
    gen: 0,
    hostId: "self",
    kind: "core",
    cores: 1,
    sandboxVersion: "1",
  });
  const effects = apply(scratch, { kind: "message", connId: "t", raw: hello }, now);
  const welcomed = effects.some((e) => e.kind === "send" && e.msg.t === "welcome");
  const heartbeat = JSON.stringify({
    t: "heartbeat",
    v: PROTOCOL_VERSION,
    gen: 0,
    visible: true,
    queue: 0,
    lastTaskMs: null,
    tasksDone: 0,
  });
  apply(scratch, { kind: "message", connId: "t", raw: heartbeat }, now + 1_000);
  apply(scratch, { kind: "tick" }, now + 2_000);
  return welcomed && scratch.nodes.size === 1;
}
