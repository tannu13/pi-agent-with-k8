import path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import Type from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

import env from "../env";
import { logger } from "../logger";
import {
  SANDBOX_CAPACITY_TIMEOUT,
  SandboxCapacityTimeoutError,
  type K8Service,
  type SandboxExecutionContext,
} from "./k8Service";

export type ToolRequestContext = Omit<
  SandboxExecutionContext,
  "toolCallId" | "toolName"
>;

export type ToolContextProvider = () => ToolRequestContext;

type ToolDetails = {
  pod?: string;
  success: boolean;
  exitCode?: number;
  error?: {
    code: string;
    message: string;
  };
};

const allowedShellCommands = new Set([
  "pwd",
  "ls",
  "cat",
  "node --version",
  "whoami",
]);

const capacityErrorBody = {
  code: SANDBOX_CAPACITY_TIMEOUT,
  message: "No sandbox pod became available within 15 seconds.",
};

const tokenizeCommand = (command: string) => {
  const tokens: string[] = [];
  const tokenPattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }

  return tokens;
};

const resolveSandboxPath = (inputPath: string) => {
  if (!inputPath || inputPath.includes("\0")) {
    throw new Error("A non-empty file path is required.");
  }

  const normalized = path.posix.normalize(inputPath);
  const relative = normalized.startsWith("/")
    ? path.posix.relative(env.SANDBOX_WORKDIR, normalized)
    : normalized;

  if (
    relative === ".." ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative)
  ) {
    throw new Error(`Path is outside the sandbox root: ${inputPath}`);
  }

  return path.posix.join(env.SANDBOX_WORKDIR, relative);
};

const quotedSandboxWorkdir = () => `'${env.SANDBOX_WORKDIR}'`;

const validateShellCommand = (command: string) => {
  const trimmed = command.trim();
  if (trimmed === "node --version") {
    return ["node", "--version"];
  }

  const tokens = tokenizeCommand(trimmed);
  const [commandName, ...args] = tokens;

  if (!commandName) {
    throw new Error(
      `Command is required. Allowed commands: ${[...allowedShellCommands].join(", ")}`,
    );
  }

  if (!allowedShellCommands.has(commandName)) {
    throw new Error(
      `Forbidden command "${commandName}". Allowed commands: ${[...allowedShellCommands].join(", ")}`,
    );
  }

  if (commandName === "pwd" || commandName === "whoami") {
    if (args.length > 0) {
      throw new Error(`${commandName} does not accept arguments.`);
    }

    if (commandName === "pwd") {
      return [
        "sh",
        "-c",
        `mkdir -p ${quotedSandboxWorkdir()} && cd ${quotedSandboxWorkdir()} && pwd`,
      ];
    }

    return [commandName];
  }

  if (commandName === "ls") {
    if (args.some((arg) => arg.startsWith("-"))) {
      throw new Error("ls options are not allowed in this sandbox.");
    }

    if (args.length === 0) {
      return [
        "sh",
        "-c",
        `mkdir -p ${quotedSandboxWorkdir()} && ls ${quotedSandboxWorkdir()}`,
      ];
    }

    return ["ls", ...args.map(resolveSandboxPath)];
  }

  if (commandName === "cat") {
    if (args.length === 0) {
      throw new Error("cat requires at least one sandbox file path.");
    }

    if (args.some((arg) => arg.startsWith("-"))) {
      throw new Error("cat options are not allowed in this sandbox.");
    }

    return ["cat", ...args.map(resolveSandboxPath)];
  }

  throw new Error(`Unsupported command: ${commandName}`);
};

const asToolFailure = (error: unknown): AgentToolResult<ToolDetails> => {
  if (error instanceof SandboxCapacityTimeoutError) {
    return {
      content: [{ type: "text" as const, text: capacityErrorBody.message }],
      details: {
        success: false,
        error: capacityErrorBody,
      },
    };
  }

  const message = error instanceof Error ? error.message : "Unknown tool error.";
  return {
    content: [{ type: "text" as const, text: `Tool execution failed: ${message}` }],
    details: {
      success: false,
      error: {
        code: "sandbox_tool_failed",
        message,
      },
    },
  };
};

const runLeasedCommand = async (
  k8Service: K8Service,
  baseContext: ToolRequestContext,
  toolCallId: string,
  toolName: string,
  command: string[],
): Promise<AgentToolResult<ToolDetails>> => {
  const context: SandboxExecutionContext = {
    ...baseContext,
    toolCallId,
    toolName,
  };

  return await k8Service.withSandboxLease(context, async (lease) => {
    logger.info("sandbox.tool.execution_started", {
      ...context,
      pod: lease.podName,
    });

    try {
      const result = await k8Service.execInPod(
        lease.podName,
        command,
        env.TOOL_TIMEOUT_MS,
      );

      if (result.exitCode !== 0) {
        logger.error("sandbox.tool.execution_failed", {
          ...context,
          pod: lease.podName,
          exitCode: result.exitCode,
          stderr: result.stderr,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: result.stderr || result.stdout || "Command failed.",
            },
          ],
          details: {
            pod: lease.podName,
            success: false,
            exitCode: result.exitCode,
            error: {
              code: "sandbox_tool_failed",
              message: result.stderr || "Command failed.",
            },
          },
        };
      }

      logger.info("sandbox.tool.execution_completed", {
        ...context,
        pod: lease.podName,
      });

      return {
        content: [{ type: "text" as const, text: result.stdout }],
        details: {
          pod: lease.podName,
          success: true,
          exitCode: result.exitCode,
        },
      };
    } catch (err) {
      const timedOut =
        err instanceof Error && err.message.toLowerCase().includes("timed out");
      logger.error(
        timedOut
          ? "sandbox.tool.execution_timed_out"
          : "sandbox.tool.execution_failed",
        {
        ...context,
        pod: lease.podName,
        error: err instanceof Error ? err.message : String(err),
        },
      );
      throw err;
    }
  });
};

export const createSandboxTools = (
  k8Service: K8Service,
  getContext: ToolContextProvider,
) => {
  const shellRunTool = defineTool({
    name: "shell.run",
    label: "shell.run",
    description: `Run an allowlisted shell command in a leased Kubernetes sandbox pod. Allowed commands: ${[...allowedShellCommands].join(", ")}.`,
    parameters: Type.Object({
      command: Type.String({
        description: `Command to run. Only ${[...allowedShellCommands].join(", ")} are allowed.`,
      }),
    }),
    execute: async (toolCallId, params) => {
      try {
        const command = validateShellCommand(params.command);
        logger.info("sandbox.tool.requested", {
          ...getContext(),
          toolCallId,
          toolName: "shell.run",
        });
        return await runLeasedCommand(
          k8Service,
          getContext(),
          toolCallId,
          "shell.run",
          command,
        );
      } catch (err) {
        return asToolFailure(err);
      }
    },
  });

  const fsReadTool = defineTool({
    name: "fs.read",
    label: "fs.read",
    description: `Read a file from ${env.SANDBOX_WORKDIR} inside a leased Kubernetes sandbox pod.`,
    parameters: Type.Object({
      path: Type.String({
        description: `Sandbox-relative path under ${env.SANDBOX_WORKDIR}.`,
      }),
    }),
    execute: async (toolCallId, params) => {
      try {
        const filePath = resolveSandboxPath(params.path);
        logger.info("sandbox.tool.requested", {
          ...getContext(),
          toolCallId,
          toolName: "fs.read",
        });
        return await runLeasedCommand(
          k8Service,
          getContext(),
          toolCallId,
          "fs.read",
          ["cat", filePath],
        );
      } catch (err) {
        return asToolFailure(err);
      }
    },
  });

  const envInspectTool = defineTool({
    name: "env.inspect",
    label: "env.inspect",
    description:
      "Inspect basic runtime information for a leased Kubernetes sandbox pod.",
    parameters: Type.Object({}),
    execute: async (toolCallId) => {
      try {
        logger.info("sandbox.tool.requested", {
          ...getContext(),
          toolCallId,
          toolName: "env.inspect",
        });

        const baseContext = getContext();
        const context: SandboxExecutionContext = {
          ...baseContext,
          toolCallId,
          toolName: "env.inspect",
        };

        return await k8Service.withSandboxLease(context, async (lease) => {
          logger.info("sandbox.tool.execution_started", {
            ...context,
            pod: lease.podName,
          });

          const result = await k8Service.execInPod(
            lease.podName,
            [
              "sh",
              "-c",
              `mkdir -p ${quotedSandboxWorkdir()} && cd ${quotedSandboxWorkdir()} && printf 'pod=%s\\nnamespace=%s\\nworkdir=' '${lease.podName}' '${env.K8_NAMESPACE}'; pwd; printf 'user='; whoami; printf 'node='; node --version`,
            ],
            env.TOOL_TIMEOUT_MS,
          );

          if (result.exitCode !== 0) {
            throw new Error(result.stderr || "env.inspect failed.");
          }

          logger.info("sandbox.tool.execution_completed", {
            ...context,
            pod: lease.podName,
          });

          return {
            content: [{ type: "text" as const, text: result.stdout }],
            details: {
              pod: lease.podName,
              success: true,
              exitCode: result.exitCode,
            },
          };
        });
      } catch (err) {
        return asToolFailure(err);
      }
    },
  });

  return [shellRunTool, fsReadTool, envInspectTool];
};
