import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { ConnRole, Event } from "@tabframe/core";
import { CLOSE, LIMITS } from "@tabframe/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { Log } from "./log.ts";

/**
 * Client sockets the control plane accepts: the endpoint holds sixteen (design §9.7), and two stay
 * free for the fleet's own calls, so a full house of tabs cannot block a handover or a drain.
 */
export const CLIENT_CONNECTION_CAP = 14;

export interface SocketGateway {
  /** The public server's upgrade handler. */
  onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void;
  get(connId: string): WebSocket | undefined;
  readonly size: number;
  /** Close every client with a code and a reason, and forget them. */
  closeAll(code: number, reason: string): void;
  /** Tear every socket down without a handshake; the server is going away. */
  terminateAll(): void;
}

export interface SocketGatewayDeps {
  dispatch: (event: Event) => void;
  /** Only an active control plane takes clients; a handed-over one's belong to its successor. */
  accepting: () => boolean;
  log: Log;
}

export function createSocketGateway(deps: SocketGatewayDeps): SocketGateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes });
  const conns = new Map<string, WebSocket>();
  let counter = 0;
  let loggedForwarding = false;
  return {
    onUpgrade(req, socket, head) {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const connRole: ConnRole | null =
        path === "/node" ? "node" : path === "/observer" ? "observer" : null;
      if (!connRole || !deps.accepting()) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (conns.size >= CLIENT_CONNECTION_CAP) {
        // The handshake completes and the socket closes with a code the page can read: a browser
        // learns nothing from a refused upgrade but "it failed".
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.close(
            CLOSE.machineFull,
            `machine full: ${CLIENT_CONNECTION_CAP} clients; retry in 10 s`,
          );
        });
        return;
      }
      // Once per process: whether the proxy forwards the client's address decides whether a
      // per-address quota is possible.
      if (!loggedForwarding) {
        loggedForwarding = true;
        deps.log("upgrade-headers", {
          forwardedFor: req.headers["x-forwarded-for"] ?? null,
          realIp: req.headers["x-real-ip"] ?? null,
        });
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const connId = `c${++counter}`;
        conns.set(connId, ws);
        deps.dispatch({ kind: "connected", connId, role: connRole });
        ws.on("message", (data, isBinary) => {
          deps.dispatch({ kind: "message", connId, raw: isBinary ? data : data.toString() });
        });
        ws.on("close", () => {
          conns.delete(connId);
          deps.dispatch({ kind: "disconnected", connId });
        });
        ws.on("error", (err) => deps.log("socket-error", { connId, error: String(err) }));
      });
    },
    get: (connId) => conns.get(connId),
    get size() {
      return conns.size;
    },
    closeAll(code, reason) {
      for (const ws of conns.values()) ws.close(code, reason);
      conns.clear();
    },
    terminateAll() {
      for (const ws of conns.values()) ws.terminate();
      conns.clear();
      wss.close();
    },
  };
}
