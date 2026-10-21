import type { ServerResponse } from "node:http";
import { ByteBudget, type Reservation } from "./chunk.js";
import { CONNECTION_BUFFER_BUDGET_BYTES, IDLE_TIMEOUT_MS, LOGICAL_MESSAGE_MAX_BYTES, PACE_WRITE_BYTES } from "../protocol/limits.js";

interface QueuedEvent {
  buffer?: Buffer;
  tickets: Reservation[];
}

export interface SseWriterOptions {
  /** Socket output cap, not a maximum logical event size. */
  maxBufferedBytes: number;
  /** Shared with the other writers/transports in this process. */
  budget: ByteBudget;
  onClose?: () => void;
}

export interface PacedSseWriter {
  write(event: string): "accepted" | "too-large" | "closed";
  end(): void;
  close(): void;
  overCap(): boolean;
  readonly closed: boolean;
}

/** Node-only, byte-paced SSE output with bounded active AND queued events. */
export function createPacedSseWriter(res: ServerResponse, opts: SseWriterOptions): PacedSseWriter {
  const viewer = new ByteBudget("sse-viewer", CONNECTION_BUFFER_BUDGET_BYTES);
  const queue: QueuedEvent[] = [];
  let active: QueuedEvent | undefined;
  let closed = false;
  let ending = false;
  let pumping = false;
  let overflowed = false;
  let cancelWait: (() => void) | undefined;
  const release = (event: QueuedEvent) => {
    event.buffer = undefined;
    for (const ticket of event.tickets) ticket.release();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    cancelWait?.();
    if (active) release(active);
    for (const event of queue.splice(0)) release(event);
    opts.onClose?.();
  };
  const abort = () => {
    close();
    // end() alone can retain a blocked socket and its backing event buffer.
    if (res.destroy) res.destroy();
    else res.end();
  };
  const cut = () => {
    overflowed = true;
    abort();
  };
  res.on("close", close);
  res.on("error", abort);

  const writeSegment = (bytes: Buffer): Promise<void> | undefined => {
    let complete = false;
    let needsDrain = true;
    let onWritten: (() => void) | undefined;
    const ok = res.write(bytes, (error?: Error | null) => {
      if (error) return abort();
      complete = true;
      if (!needsDrain) onWritten?.();
    });
    needsDrain = !ok;
    if (res.writableLength > opts.maxBufferedBytes) cut();
    if (closed || (ok && (complete || res.writableLength === 0))) return;
    return new Promise<void>((resolve) => {
      const finish = () => {
        res.off("drain", finish);
        clearTimeout(timer);
        if (cancelWait === finish) cancelWait = undefined;
        resolve();
      };
      const timer = setTimeout(cut, IDLE_TIMEOUT_MS);
      timer.unref();
      onWritten = finish;
      cancelWait = finish;
      res.once("drain", finish);
    });
  };

  const finishEnd = () => {
    close();
    res.end();
  };
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (!closed && queue.length) {
        const event = queue.shift()!;
        active = event;
        for (let offset = 0; !closed && event.buffer && offset < event.buffer.length; offset += PACE_WRITE_BYTES) {
          const wait = writeSegment(event.buffer.subarray(offset, offset + PACE_WRITE_BYTES));
          if (wait) await wait;
        }
        release(event);
        active = undefined;
      }
      if (ending && !closed) finishEnd();
    } catch {
      abort();
    } finally {
      pumping = false;
    }
  };

  return {
    get closed() {
      return closed;
    },
    overCap: () => overflowed || res.writableLength > opts.maxBufferedBytes,
    close,
    end() {
      if (closed || ending) return;
      ending = true;
      if (!pumping) finishEnd();
    },
    write(event) {
      if (closed || ending) return "closed";
      if (res.destroyed || res.writableEnded) {
        close();
        return "closed";
      }
      const bytes = Buffer.byteLength(event, "utf8");
      if (bytes > LOGICAL_MESSAGE_MAX_BYTES) return "too-large";
      if (res.writableLength > opts.maxBufferedBytes) {
        cut();
        return "closed";
      }
      const local = viewer.reserve(bytes);
      const shared = local && opts.budget.reserve(bytes);
      if (!local || !shared) {
        local?.release();
        cut();
        return "closed";
      }
      // Admission precedes Buffer allocation. Closing clears queued references,
      // including the active buffer when a drain wait is cancelled.
      queue.push({ buffer: Buffer.from(event, "utf8"), tickets: [local, shared] });
      void pump();
      return "accepted";
    },
  };
}
