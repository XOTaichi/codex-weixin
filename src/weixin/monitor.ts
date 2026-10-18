import { WeixinApiClient } from "./api.js";
import { normalizeWeixinMessage, type NormalizedWeixinMessage, type WeixinRawMessage } from "./messages.js";

export type MonitorOptions = {
  client: WeixinApiClient;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxPollRetryMs?: number;
  initialSyncKey?: string;
  onSyncKey?: (syncKey: string) => Promise<void> | void;
  claimMessage?: (message: NormalizedWeixinMessage) => boolean;
  onMessage: (message: NormalizedWeixinMessage) => Promise<void>;
  isPriorityMessage?: (message: NormalizedWeixinMessage) => boolean;
  onMessageError?: (error: unknown, message: NormalizedWeixinMessage) => Promise<void> | void;
};

export class PollRetryBackoff {
  private readonly initialMs: number;
  private readonly maxMs: number;
  private currentMs: number;

  constructor(initialMs: number, maxMs: number) {
    this.initialMs = Math.max(0, initialMs);
    this.maxMs = Math.max(this.initialMs, maxMs);
    this.currentMs = this.initialMs;
  }

  next(): number {
    const delayMs = this.currentMs;
    this.currentMs = Math.min(this.maxMs, this.currentMs === 0 ? 0 : this.currentMs * 2);
    return delayMs;
  }

  reset(): void {
    this.currentMs = this.initialMs;
  }
}

export async function monitorWeixin(options: MonitorOptions): Promise<void> {
  let syncKey = options.initialSyncKey;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const retryBackoff = new PollRetryBackoff(pollIntervalMs, options.maxPollRetryMs ?? 30_000);
  const senderTasks = new Map<string, Promise<void>>();
  const activeTasks = new Set<Promise<void>>();
  const handle = async (message: NormalizedWeixinMessage) => {
    try {
      console.log(`[codex-weixin] handling message ${message.id} from ${message.senderId}`);
      await options.onMessage(message);
      console.log(`[codex-weixin] handled message ${message.id} from ${message.senderId}`);
    } catch (error) {
      console.error(`[codex-weixin] message handling failed for ${message.senderId}: ${errorDetail(error)}`);
      try { await options.onMessageError?.(error, message); }
      catch (reportError) {
        console.error(`[codex-weixin] failed to report message error for ${message.senderId}: ${errorDetail(reportError)}`);
      }
    }
  };
  while (!options.signal?.aborted) {
    let batch: { syncKey?: string; messages: WeixinRawMessage[] };
    try {
      batch = parseUpdateBatch(await options.client.getUpdates(syncKey, options.signal));
      if (batch.syncKey && batch.syncKey !== syncKey) {
        syncKey = batch.syncKey;
        await options.onSyncKey?.(syncKey);
      }
    } catch (error) {
      const retryMs = retryBackoff.next();
      console.error(`[codex-weixin] monitor poll failed; retrying in ${retryMs}ms: ${errorDetail(error)}`);
      await delay(retryMs, options.signal);
      continue;
    }
    retryBackoff.reset();
    const { messages } = batch;
    if (messages.length) {
      console.log(`[codex-weixin] received ${messages.length} update(s)`);
    }
    for (const raw of messages) {
      let normalized: NormalizedWeixinMessage | undefined;
      try {
        normalized = normalizeWeixinMessage(raw);
      } catch (error) {
        console.error(`[codex-weixin] failed to normalize message: ${errorDetail(error)}`);
        continue;
      }
      if (!normalized) {
        continue;
      }
      const message = normalized;
      if (options.claimMessage && !options.claimMessage(message)) {
        console.log(`[codex-weixin] skipped duplicate message ${message.id} from ${message.senderId}`);
        continue;
      }
      const priority = options.isPriorityMessage?.(message) ?? false;
      const previous = priority ? undefined : senderTasks.get(message.senderId);
      const task = previous ? previous.then(() => handle(message)) : handle(message);
      if (!priority) {
        senderTasks.set(message.senderId, task);
        void task.finally(() => {
          if (senderTasks.get(message.senderId) === task) senderTasks.delete(message.senderId);
        });
      }
      activeTasks.add(task);
      void task.finally(() => activeTasks.delete(task));
    }
    if (!messages.length) {
      await delay(pollIntervalMs, options.signal);
    }
  }
  await Promise.allSettled(activeTasks);
}

function parseUpdateBatch(value: unknown): { syncKey?: string; messages: WeixinRawMessage[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("getUpdates response must be an object");
  }
  const response = value as Record<string, unknown>;
  const messages = response.msgs ?? response.message_list ?? response.messages ?? [];
  if (!Array.isArray(messages)) {
    throw new Error("getUpdates response messages must be an array");
  }
  const syncKey = [response.get_updates_buf, response.next_sync_key, response.sync_key]
    .find((candidate): candidate is string => typeof candidate === "string");
  return { syncKey, messages: messages as WeixinRawMessage[] };
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
