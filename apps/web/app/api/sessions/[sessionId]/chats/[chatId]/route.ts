import {
  requireAuthenticatedUser,
  requireOwnedSessionChat,
} from "@/app/api/sessions/_lib/session-context";
import type { WebAgentUIMessage } from "@/app/types";
import {
  deleteChat,
  getChatMessages,
  getChatsBySessionId,
  updateChat,
} from "@/lib/db/sessions";
import { sanitizeSelectedModelIdForSession } from "@/lib/model-access";
import {
  reasoningEffortSchema,
  sanitizeReasoningEffort,
} from "@/lib/model-reasoning";
import { getServerSession } from "@/lib/session/get-server-session";

type RouteContext = {
  params: Promise<{ sessionId: string; chatId: string }>;
};

interface UpdateChatRequest {
  title?: string;
  modelId?: string;
  reasoningEffort?: string | null;
}

export interface ChatRefreshResponse {
  chat: {
    id: string;
    modelId: string | null;
    reasoningEffort: string | null;
    activeStreamId: string | null;
  };
  isStreaming: boolean;
  messages: WebAgentUIMessage[];
}

export async function GET(req: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const session = await getServerSession();
  const { sessionId, chatId } = await context.params;

  const chatContext = await requireOwnedSessionChat({
    userId: authResult.userId,
    sessionId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  const messages = await getChatMessages(chatId);
  const modelId =
    sanitizeSelectedModelIdForSession(
      chatContext.chat.modelId,
      session,
      req.url,
    ) ??
    chatContext.chat.modelId ??
    null;

  return Response.json({
    chat: {
      id: chatContext.chat.id,
      modelId,
      reasoningEffort: modelId
        ? sanitizeReasoningEffort(modelId, chatContext.chat.reasoningEffort)
        : null,
      activeStreamId: chatContext.chat.activeStreamId,
    },
    isStreaming: chatContext.chat.activeStreamId !== null,
    messages: messages.map((message) => message.parts as WebAgentUIMessage),
  } satisfies ChatRefreshResponse);
}

export async function PATCH(req: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const session = await getServerSession();
  const { sessionId, chatId } = await context.params;

  const chatContext = await requireOwnedSessionChat({
    userId: authResult.userId,
    sessionId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  let body: UpdateChatRequest;
  try {
    body = (await req.json()) as UpdateChatRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const nextTitle = body.title?.trim();
  const nextModelId = body.modelId?.trim();
  const hasReasoningEffortField = Object.hasOwn(body, "reasoningEffort");

  if (!nextTitle && !nextModelId && !hasReasoningEffortField) {
    return Response.json(
      { error: "At least one field is required" },
      { status: 400 },
    );
  }

  const updatePayload: {
    title?: string;
    modelId?: string;
    reasoningEffort?: string | null;
  } = {};
  if (nextTitle) {
    updatePayload.title = nextTitle;
  }
  if (nextModelId) {
    const sanitizedModelId = sanitizeSelectedModelIdForSession(
      nextModelId,
      session,
      req.url,
    );
    updatePayload.modelId = sanitizedModelId ?? nextModelId;
  }
  if (hasReasoningEffortField) {
    if (body.reasoningEffort === null) {
      updatePayload.reasoningEffort = null;
    } else {
      const parsed = reasoningEffortSchema.safeParse(body.reasoningEffort);
      if (!parsed.success) {
        return Response.json(
          { error: "Invalid reasoningEffort value" },
          { status: 400 },
        );
      }
      updatePayload.reasoningEffort = parsed.data;
    }
  }

  const updatedChat = await updateChat(chatId, updatePayload);
  if (!updatedChat) {
    return Response.json({ error: "Chat not found" }, { status: 404 });
  }

  const resolvedModelId =
    sanitizeSelectedModelIdForSession(updatedChat.modelId, session, req.url) ??
    updatedChat.modelId;

  return Response.json({
    chat: {
      ...updatedChat,
      modelId: resolvedModelId,
      reasoningEffort: resolvedModelId
        ? sanitizeReasoningEffort(resolvedModelId, updatedChat.reasoningEffort)
        : null,
    },
  });
}

export async function DELETE(_req: Request, context: RouteContext) {
  const authResult = await requireAuthenticatedUser();
  if (!authResult.ok) {
    return authResult.response;
  }

  const { sessionId, chatId } = await context.params;

  const chatContext = await requireOwnedSessionChat({
    userId: authResult.userId,
    sessionId,
    chatId,
  });
  if (!chatContext.ok) {
    return chatContext.response;
  }

  const chats = await getChatsBySessionId(sessionId);
  if (chats.length <= 1) {
    return Response.json(
      { error: "Cannot delete the only chat in a session" },
      { status: 400 },
    );
  }

  await deleteChat(chatId);
  return Response.json({ success: true });
}
