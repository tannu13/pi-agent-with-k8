import { AsyncLocalStorage } from "node:async_hooks";
import {
  AgentSession,
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getModel, type AssistantMessage } from "@earendil-works/pi-ai";

import env from "../env";
import {
  SANDBOX_CAPACITY_TIMEOUT,
  type K8Service,
} from "./k8Service";
import { createSandboxTools, type ToolRequestContext } from "./sandboxTools";

export type ChatInput = {
  requestId: string;
  sessionId: string;
  message: string;
};

export type ToolCallMetadata = {
  toolCallId: string;
  tool: string;
  pod?: string;
  status: "running" | "completed" | "failed";
  error?: {
    code: string;
    message: string;
  };
};

export type ChatResult = {
  sessionId: string;
  message: string;
  toolCalls: ToolCallMetadata[];
  error?: {
    code: string;
    message: string;
  };
};

export interface PiClient {
  runChat(input: ChatInput): Promise<ChatResult>;
}

type SessionEntry = {
  session: AgentSession;
  tail: Promise<unknown>;
};

const requestContext = new AsyncLocalStorage<ToolRequestContext>();

const getCurrentToolRequestContext = () => {
  const current = requestContext.getStore();
  if (!current) {
    throw new Error("Tool execution is missing chat request context.");
  }

  return current;
};

const getAssistantMessageText = (message: AssistantMessage | undefined) =>
  message?.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("") ?? "";

const providerCredentialEnv = (provider: string) => {
  const normalized = provider.toLowerCase();
  if (normalized === "google") return "GEMINI_API_KEY";
  if (normalized === "openai") return "OPENAI_API_KEY";
  if (normalized === "anthropic") return "ANTHROPIC_API_KEY";
  if (normalized === "mistral") return "MISTRAL_API_KEY";
  if (normalized === "groq") return "GROQ_API_KEY";
  if (normalized === "openrouter") return "OPENROUTER_API_KEY";
  return undefined;
};

export const assertPiCredentials = () => {
  if (env.NODE_ENV === "test") return;

  const credentialEnv = providerCredentialEnv(env.PI_PROVIDER);
  if (credentialEnv && !process.env[credentialEnv]) {
    throw new Error(
      `Missing Pi provider credentials: set ${credentialEnv} for PI_PROVIDER=${env.PI_PROVIDER}.`,
    );
  }
};

export class RealPiClient implements PiClient {
  private authStorage = AuthStorage.create();
  private modelRegistry = ModelRegistry.create(this.authStorage);
  private sessionManager = SessionManager.inMemory();
  private chatModel = getModel(env.PI_PROVIDER as any, env.PI_MODEL as any);
  private sessions = new Map<string, SessionEntry>();
  private tools;

  constructor(private k8Service: K8Service) {
    this.tools = createSandboxTools(
      this.k8Service,
      getCurrentToolRequestContext,
    );
  }

  async runChat(input: ChatInput): Promise<ChatResult> {
    const entry = await this.getSession(input.sessionId);
    const run = () =>
      requestContext.run(
        { requestId: input.requestId, sessionId: input.sessionId },
        async () => this.promptSession(entry.session, input),
      );

    const result = entry.tail.then(run, run);
    entry.tail = result.catch(() => undefined);
    return await result;
  }

  private async getSession(sessionId: string) {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const result = await createAgentSession({
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model: this.chatModel,
      sessionManager: this.sessionManager,
      noTools: "builtin",
      customTools: this.tools,
    });

    const entry = {
      session: result.session,
      tail: Promise.resolve(),
    };
    this.sessions.set(sessionId, entry);
    return entry;
  }

  private async promptSession(
    session: AgentSession,
    input: ChatInput,
  ): Promise<ChatResult> {
    const toolCallsById = new Map<string, ToolCallMetadata>();
    let lastAssistantMessage: AssistantMessage | undefined;

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        toolCallsById.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          tool: event.toolName,
          status: "running",
        });
      }

      if (event.type === "tool_execution_end") {
        const details = event.result?.details as
          | {
              pod?: string;
              success?: boolean;
              error?: { code: string; message: string };
            }
          | undefined;
        const current = toolCallsById.get(event.toolCallId);

        toolCallsById.set(event.toolCallId, {
          toolCallId: event.toolCallId,
          tool: event.toolName,
          pod: details?.pod ?? current?.pod,
          status:
            event.isError || details?.success === false
              ? "failed"
              : "completed",
          ...(details?.error && { error: details.error }),
        });
      }

      if (event.type === "message_end" && event.message.role === "assistant") {
        lastAssistantMessage = event.message;
      }
    });

    try {
      await session.prompt(input.message);
    } finally {
      unsubscribe();
    }

    const toolCalls = Array.from(toolCallsById.values());
    const capacityError = toolCalls.find(
      (toolCall) => toolCall.error?.code === SANDBOX_CAPACITY_TIMEOUT,
    )?.error;

    return {
      sessionId: input.sessionId,
      message: getAssistantMessageText(lastAssistantMessage),
      toolCalls,
      ...(capacityError && { error: capacityError }),
    };
  }
}
