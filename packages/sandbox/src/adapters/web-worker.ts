/// <reference lib="webworker" />
// Web adapter, worker side: the dedicated worker a browser node spawns for its sandbox. Bytes come
// from the store with synchronous requests, which dedicated workers may make (design §4.2).
import { CachingBlobReader } from "../blob-reader.ts";
import type { TaskMessage } from "../host.ts";
import type { BlobReader } from "../types.ts";
import { serveTasks } from "./serve.ts";

class XhrBlobReader implements BlobReader {
  private readonly base: string;

  constructor(storeBase: string) {
    this.base = storeBase.replace(/\/$/, "");
  }

  read(hash: string, offset: number, len: number): Uint8Array | null {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", `${this.base}/${hash}`, false);
    if (offset !== 0 || Number.isFinite(len)) {
      const end = Number.isFinite(len) ? String(offset + len - 1) : "";
      xhr.setRequestHeader("Range", `bytes=${offset}-${end}`);
    }
    xhr.responseType = "arraybuffer";
    try {
      xhr.send();
    } catch {
      return null;
    }
    if (xhr.status === 200 || xhr.status === 206)
      return new Uint8Array(xhr.response as ArrayBuffer);
    return null;
  }
}

/** One caching reader per store base, so a node that changes stores keeps neither's blobs mixed. */
const readers = new Map<string, CachingBlobReader>();
function readerFor(msg: TaskMessage): BlobReader {
  const base = msg.storeBase ?? "/blob";
  let reader = readers.get(base);
  if (!reader) {
    reader = new CachingBlobReader(new XhrBlobReader(base));
    readers.set(base, reader);
  }
  return reader;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const serve = serveTasks(readerFor, (reply) => scope.postMessage(reply));
scope.onmessage = (ev: MessageEvent<unknown>) => serve(ev.data);
