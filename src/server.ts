import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import env from "./env";
import { createK8Service } from "./services/k8Service";
import {
  AgentSession,
  AuthStorage,
  createAgentSession,
  defineTool,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { getModel, type AssistantMessage } from "@earendil-works/pi-ai";
import { execFile as execFileCb } from "child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const workspaceRoot = `${process.cwd()}/data`;
const allowedBashCommands = new Set([
  "pwd",
  "ls",
  "cat",
  "node --version",
  "whoami",
]);

const k8Service = createK8Service();
await k8Service.init();

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const sessionManager = SessionManager.inMemory();
const chatModel = getModel("google", "gemma-4-26b-a4b-it");

export interface ExecutionResult {
  success: boolean;
  output: string;
  pod?: string;
}

export interface SandboxExecutor {
  executeCommand(command: string): Promise<ExecutionResult>;
}

const tokenizeCommand = (command: string) => {
  const tokens: string[] = [];
  const tokenPattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }

  return tokens;
};

const resolveWorkspacePath = (inputPath: string) => {
  const resolvedPath = path.resolve(workspaceRoot, inputPath);
  const isInsideWorkspace =
    resolvedPath === workspaceRoot ||
    resolvedPath.startsWith(`${workspaceRoot}${path.sep}`);

  if (!isInsideWorkspace) {
    throw new Error(`Path is outside the workspace: ${inputPath}`);
  }

  return resolvedPath;
};

const validateBashCommand = (command: string) => {
  const tokens = tokenizeCommand(command.trim());
  const [commandName, ...args] = tokens;

  if (!commandName) {
    throw new Error(
      `Command is required. Allowed commands: ${[...allowedBashCommands].join(", ")}`,
    );
  }

  if (!allowedBashCommands.has(commandName)) {
    throw new Error(
      `Forbidden command "${commandName}". Allowed commands: ${[...allowedBashCommands].join(", ")}`,
    );
  }

  if (commandName === "pwd") {
    if (args.length > 0) {
      throw new Error("pwd does not accept arguments in this sandbox.");
    }

    return { commandName, args };
  }

  if (args.some((arg) => arg.startsWith("-"))) {
    throw new Error(`${commandName} options are not allowed in this sandbox.`);
  }

  if (commandName === "cat" && args.length === 0) {
    throw new Error("cat requires at least one workspace file path.");
  }

  return {
    commandName,
    args: args.map(resolveWorkspacePath),
  };
};

export class LocalFilesystemExecutor implements SandboxExecutor {
  async executeCommand(command: string): Promise<ExecutionResult> {
    try {
      const validatedCommand = validateBashCommand(command);
      const { stdout, stderr } = await execFile(
        validatedCommand.commandName,
        validatedCommand.args,
        { cwd: workspaceRoot, timeout: 30000 },
      );

      return {
        success: true,
        output: stdout.trim() || stderr.trim(),
      };
    } catch (error: any) {
      return {
        success: false,
        output:
          error.stderr?.trim() || error.message || "Unknown execution error",
      };
    }
  }
}

type ToolCallStatus = {
  toolCallId: string;
  tool: string;
  pod?: string;
  status: "running" | "completed" | "failed";
};

const sandboxExecutor = new LocalFilesystemExecutor();

const bashTool = defineTool({
  name: "bash",
  label: "Bash",
  description: `Execute a read-only command in the repo workspace. Allowed commands only: ${[...allowedBashCommands].join(", ")}. Use cat with a workspace-relative file path, for example \`cat data/rainbow.txt\`. Forbidden commands or paths outside the workspace are rejected and reported back.`,
  parameters: Type.Object({
    command: Type.String({
      description: `Command to run. Only ${[...allowedBashCommands].join(", ")} are allowed. Paths must stay inside the repo workspace.`,
    }),
  }),
  execute: async (_toolCallId, params) => {
    const result = await sandboxExecutor.executeCommand(params.command);
    const output = result.success
      ? result.output
      : `Tool execution failed: ${result.output}`;

    return {
      content: [{ type: "text", text: output }],
      details: { pod: result.pod, success: result.success },
    };
  },
});

const getAssistantMessageText = (message: AssistantMessage | undefined) =>
  message?.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("") ?? "";

const sessions = new Map<string, AgentSession>();

const app = express();
app.use(express.json());

app.post("/chat", async (req: Request, res: Response) => {
  if (!req.body?.message || typeof req.body?.message !== "string") {
    return res.status(400).json({
      error: "missing a string `message` in the payload",
    });
  }
  const { message } = req.body;

  const sessionId = req.body.sessionId || crypto.randomUUID();
  let session = sessions.get(sessionId);
  if (!session) {
    const result = await createAgentSession({
      authStorage,
      modelRegistry,
      model: chatModel,
      sessionManager,
      noTools: "builtin",
      customTools: [bashTool],
    });

    session = result.session;
    sessions.set(sessionId, session);
  }

  const toolCallsById = new Map<string, ToolCallStatus>();
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
        | Partial<ExecutionResult>
        | undefined;
      const current = toolCallsById.get(event.toolCallId);

      toolCallsById.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        tool: event.toolName,
        pod: details?.pod ?? current?.pod,
        status:
          event.isError || details?.success === false ? "failed" : "completed",
      });
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      lastAssistantMessage = event.message;
    }
  });

  try {
    await session.prompt(message);
  } finally {
    unsubscribe();
  }

  return res.status(200).json({
    sessionId,
    message: getAssistantMessageText(lastAssistantMessage),
    toolCalls: Array.from(toolCallsById.values()),
  });
});

app.get("/health", async (_req: Request, res: Response) => {
  try {
    const { totalHealthyCount } = await k8Service.getPods();

    return res.status(200).json({
      ok: true,
      kubernetes: "connected",
      sandboxPodsReady: totalHealthyCount,
    });
  } catch (err) {
    console.error("Health check failed:", err);
    return res.status(503).json({
      ok: false,
      kubernetes: "disconnected",
      sandboxPodsReady: 0,
    });
  }
});

app.get("/pods", async (_req: Request, res: Response) => {
  try {
    const [{ podsMap }, leases] = await Promise.all([
      k8Service.getPods(),
      k8Service.getLeases(),
    ]);

    const pods = Array.from({ length: 8 }, (_, i) => {
      const podName = `${env.K8_LABEL}-${i}`;

      const livePod = podsMap.get(podName);
      const lease = leases.find((l) => l.metadata?.name === podName);

      let leaseStatus: "free" | "leased" = "free";
      let holderIdentity: string | undefined = undefined;
      let expiresAt: string | undefined = undefined;

      if (lease?.spec) {
        const {
          holderIdentity: holder,
          renewTime,
          acquireTime,
          leaseDurationSeconds = env.LEASE_DURATION_SECONDS,
        } = lease.spec;

        const baseTime = renewTime || acquireTime;
        if (holder && baseTime) {
          const expirationMs =
            new Date(baseTime).getTime() + leaseDurationSeconds * 1000;

          if (Date.now() < expirationMs) {
            leaseStatus = "leased";
            holderIdentity = holder;
            expiresAt = new Date(expirationMs).toISOString();
          }
        }
      }

      return {
        name: podName,
        ready: livePod ? livePod.ready : false,
        lease: {
          status: leaseStatus,
          ...(leaseStatus === "leased" && { holderIdentity, expiresAt }),
        },
      };
    });

    return res.status(200).json({ pods });
  } catch (err) {
    console.error("Error generating pod statuses:", err);
    return res.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to fetch status.",
    });
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  return res.status(500).json({
    code: "INTERNAL_SERVER_ERROR",
    message:
      err instanceof Error ? err.message : "Something went wrong on our end.",
  });
});

export default app;
export { app };
