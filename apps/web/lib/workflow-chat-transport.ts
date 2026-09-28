import "client-only";

import {
  DefaultChatTransport,
  type HttpChatTransportInitOptions,
  type UIMessageChunk,
} from "ai";
import type { UIMessage } from "ai";

/**
 * Entry-native replacement for @workflow/ai's WorkflowChatTransport.
 *
 * Plain HTTP chat transport (AI SDK DefaultChatTransport) plus stream-chunk
 * index tracking so reconnects resume from the last received chunk instead
 * of replaying from the beginning: the stream route exposes the server's
 * tail index via the `x-workflow-stream-tail-index` header and accepts a
 * `startIndex` query param.
 */
export type WorkflowChatTransportOptions<UI_MESSAGE extends UIMessage> =
  HttpChatTransportInitOptions<UI_MESSAGE>;

export class WorkflowChatTransport<
  UI_MESSAGE extends UIMessage = UIMessage,
> extends DefaultChatTransport<UI_MESSAGE> {
  /** chatId -> next startIndex to request on reconnect. */
  private static readonly lastSentIndex = new Map<string, number>();

  constructor(options?: WorkflowChatTransportOptions<UI_MESSAGE>) {
    super(options);
  }

  override async sendMessages(
    options: Parameters<
      DefaultChatTransport<UI_MESSAGE>["sendMessages"]
    >[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const stream = await super.sendMessages(options);
    // Count chunks as they pass through so a drop can resume after them.
    const chatId = (options as { chatId?: string }).chatId;
    if (chatId !== undefined) {
      let count = WorkflowChatTransport.lastSentIndex.get(chatId) ?? 0;
      const counted = stream.pipeThrough(
        new TransformStream<UIMessageChunk, UIMessageChunk>({
          transform(chunk, controller) {
            count += 1;
            WorkflowChatTransport.lastSentIndex.set(chatId, count);
            controller.enqueue(chunk);
          },
        }),
      );
      return counted;
    }
    return stream;
  }

  override async reconnectToStream(
    options: Parameters<
      DefaultChatTransport<UI_MESSAGE>["reconnectToStream"]
    >[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const chatId = (options as { chatId?: string }).chatId;
    const startIndex =
      chatId !== undefined
        ? WorkflowChatTransport.lastSentIndex.get(chatId)
        : undefined;
    if (chatId !== undefined && startIndex !== undefined) {
      // Resume strictly after the last chunk we already applied. The
      // server clamps startIndex beyond its tail to "nothing new" (204).
      const prepared = this.prepareReconnectToStreamRequest?.(
        options as never,
      );
      const api =
        prepared && "api" in prepared && typeof prepared.api === "string"
          ? prepared.api
          : "/api/chat";
      const url = new URL(api, globalThis.location.origin);
      url.searchParams.set("startIndex", String(startIndex));
      WorkflowChatTransport.lastSentIndex.delete(chatId);
      const response = await fetch(url.toString(), {
        headers: { "content-type": "application/json" },
      });
      if (response.status === 204 || response.body === null) return null;
      // processResponseStream is protected; reuse the default SSE parsing
      // through a fresh DefaultChatTransport pointed at the resolved URL.
      const resume = new DefaultChatTransport<UI_MESSAGE>({ api: url.pathname + url.search });
      return resume.reconnectToStream({ chatId } as never);
    }
    return super.reconnectToStream(options);
  }
}
