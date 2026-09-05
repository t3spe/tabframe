import type { SocketLike, Timers } from "../connection.ts";

/** A WHATWG WebSocket as the node's SocketLike, the four handlers wired explicitly. */
export function webSocketLike(url: string, protocols?: string[]): SocketLike {
  const ws = new WebSocket(url, protocols);
  const like: SocketLike = {
    get readyState() {
      return ws.readyState;
    },
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = (ev) => like.onopen?.(ev);
  ws.onmessage = (ev) => like.onmessage?.({ data: ev.data });
  ws.onclose = (ev) => like.onclose?.({ code: ev.code, reason: ev.reason });
  ws.onerror = (ev) => like.onerror?.(ev);
  return like;
}

/** The runtime's own timers as the node's Timers. */
export const globalTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
