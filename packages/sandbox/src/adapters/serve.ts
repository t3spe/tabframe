import type { ResultMessage, TaskMessage } from "../host.ts";
import { runTask } from "../run.ts";
import type { BlobReader } from "../types.ts";

/**
 * The worker side of both adapters: a message handler that runs each task message with the reader
 * `readerFor` picks for it and posts the result. Anything that is not a task message is ignored.
 */
export function serveTasks(
  readerFor: (msg: TaskMessage) => BlobReader,
  post: (reply: ResultMessage) => void,
): (msg: unknown) => void {
  return (msg) => {
    const task = msg as TaskMessage | null | undefined;
    if (task?.type !== "task") return;
    const result = runTask(task.module, { ...task.request, reader: readerFor(task) });
    post({ type: "result", id: task.id, result });
  };
}
