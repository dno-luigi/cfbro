import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  tool,
  type GenerateTextOnFinishCallback,
  type ToolSet
} from "ai";
import { z } from "zod";
import { createBrowserRuntime } from "agents/browser/ai";

import { SYSTEM_PROMPT } from "./prompt";
import type { BrowserEvent } from "./types";

type CdpResponse = {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type HandoffCompleteResponse = {
  targetId: string;
  handoffId?: string;
  success: boolean;
  reason?: string;
};

async function beginBrowserHandoff(options: {
  browser: BrowserRun;
  browserSessionId: string;
  targetId: string;
  instructions: string;
  timeoutMs: number;
}) {
  const response = await options.browser.fetch(
    `https://localhost/v1/devtools/browser/${options.browserSessionId}`,
    { headers: { Upgrade: "websocket" } }
  );
  const socket = response.webSocket;
  if (!socket) {
    throw new Error("Browser Run did not provide a CDP connection");
  }
  socket.accept();

  let nextId = 1;
  let targetSessionId: string | undefined;
  let resolveCompletion: (result: HandoffCompleteResponse) => void;
  let rejectCompletion: (error: Error) => void;
  const pending = new Map<
    number,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const completion = new Promise<HandoffCompleteResponse>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const completionTimeout = setTimeout(() => {
    rejectCompletion(new Error("Browser handoff completion event timed out"));
  }, options.timeoutMs + 5_000);

  const rejectPending = (error: Error) => {
    for (const [id, request] of pending) {
      clearTimeout(request.timeout);
      request.reject(error);
      pending.delete(id);
    }
  };

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: CdpResponse;
    try {
      message = JSON.parse(event.data) as CdpResponse;
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timeout);
      pending.delete(message.id);
      if (message.error) {
        request.reject(
          new Error(
            `CDP error ${message.error.code ?? "unknown"}: ${message.error.message ?? "Unknown error"}`
          )
        );
      } else {
        request.resolve(message.result);
      }
      return;
    }

    if (
      message.method === "Cloudflare.handoffComplete" &&
      (!message.sessionId || message.sessionId === targetSessionId)
    ) {
      const result = message.params as HandoffCompleteResponse;
      if (!result.targetId || result.targetId === options.targetId) {
        clearTimeout(completionTimeout);
        resolveCompletion(result);
      }
    }
  });
  socket.addEventListener("error", () => {
    const error = new Error("Browser Run CDP connection failed");
    rejectPending(error);
    rejectCompletion(error);
  });
  socket.addEventListener("close", () => {
    const error = new Error("Browser Run CDP connection closed");
    rejectPending(error);
    rejectCompletion(error);
  });

  const send = <T>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ) => {
    const id = nextId++;
    const result = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 10_000);
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });
    });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
    return result;
  };

  try {
    const attached = await send<{ sessionId: string }>(
      "Target.attachToTarget",
      {
        targetId: options.targetId,
        flatten: true
      }
    );
    targetSessionId = attached.sessionId;

    const liveView = await send<{ devtoolsFrontendUrl: string }>(
      "Cloudflare.getLiveView",
      {
        targetId: options.targetId,
        mode: "tab",
        expiresInMs: Math.min(options.timeoutMs, 3_600_000)
      },
      targetSessionId
    );
    const handoff = await send<{ handoffId: string }>(
      "Cloudflare.handoff",
      {
        targetId: options.targetId,
        instructions: options.instructions,
        timeout: options.timeoutMs
      },
      targetSessionId
    );

    return {
      handoffId: handoff.handoffId,
      url: liveView.devtoolsFrontendUrl,
      completion,
      close: () => {
        clearTimeout(completionTimeout);
        socket.close(1000, "Done");
      }
    };
  } catch (error) {
    clearTimeout(completionTimeout);
    socket.close(1000, "Failed");
    throw error;
  }
}

export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const broadcastEvent = (event: BrowserEvent) => {
      this.broadcast(JSON.stringify(event));
    };

    broadcastEvent({
      type: "browser-status",
      status: "starting",
      message: "Working on your request..."
    });

    const { connector, tools: browserTools } = createBrowserRuntime({
      ctx: this.ctx,
      browser: this.env.BROWSER,
      loader: this.env.LOADER,
      session: {
        mode: "reuse",
        key: "main",
        keepAliveMs: 600_000
      }
    });

    const handoffTools = {
      browser_handoff: tool({
        description:
          "Hand control of the current Browser Run tab to the user for login, MFA, CAPTCHA, sensitive input, approval, or another action that requires a human. The tool waits until the user selects Done or Failed in Live View, then returns the result.",
        inputSchema: z.object({
          instructions: z
            .string()
            .max(4096)
            .describe(
              "Clear, actionable instructions for the user, including what they should do before selecting Done or Failed"
            ),
          targetId: z
            .string()
            .optional()
            .describe(
              "The CDP target ID to hand off. Omit it to use the most recent non-blank page"
            ),
          timeoutMs: z
            .number()
            .int()
            .min(10_000)
            .max(1_800_000)
            .default(600_000)
            .describe("Handoff timeout in milliseconds")
        }),
        execute: async ({ instructions, targetId, timeoutMs }) => {
          const liveView = await connector.liveView({ mode: "tab" });
          if (!liveView) {
            throw new Error(
              "No active browser session is available for handoff"
            );
          }

          const pageTargets = liveView.targets.filter(
            (target) => target.type === "page"
          );
          const realPages = pageTargets.filter(
            (target) => target.pageUrl && !target.pageUrl.startsWith("about:")
          );
          const target = targetId
            ? liveView.targets.find(
                (candidate) => candidate.targetId === targetId
              )
            : (realPages[realPages.length - 1] ??
              pageTargets[pageTargets.length - 1] ??
              liveView.targets[0]);

          if (!target) {
            throw new Error(
              targetId
                ? `Browser target ${targetId} was not found`
                : "No browser tab is available for handoff"
            );
          }

          let handoff: Awaited<ReturnType<typeof beginBrowserHandoff>> | null =
            null;
          let handoffId: string | null = null;

          try {
            handoff = await beginBrowserHandoff({
              browser: this.env.BROWSER,
              browserSessionId: liveView.sessionId,
              targetId: target.targetId,
              instructions,
              timeoutMs
            });
            handoffId = handoff.handoffId;

            broadcastEvent({
              type: "browser-handoff-started",
              handoffId,
              instructions,
              timeoutMs,
              url: handoff.url
            });
            broadcastEvent({
              type: "browser-status",
              status: "waiting",
              message: "Waiting for you to complete the browser handoff..."
            });

            const result = await handoff.completion;
            broadcastEvent({
              type: "browser-handoff-complete",
              handoffId: result.handoffId ?? handoffId,
              success: result.success,
              reason: result.reason
            });
            broadcastEvent({
              type: "browser-status",
              status: "acting",
              message: result.success
                ? "Handoff complete. Resuming automation..."
                : "Handoff did not complete successfully."
            });

            return {
              handoffId: result.handoffId ?? handoffId,
              success: result.success,
              reason: result.reason
            };
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Browser handoff failed";
            if (handoffId) {
              broadcastEvent({
                type: "browser-handoff-complete",
                handoffId,
                success: false,
                reason: message
              });
            }
            broadcastEvent({ type: "browser-error", error: message });
            broadcastEvent({ type: "browser-status", status: "error" });
            throw error;
          } finally {
            handoff?.close();
          }
        }
      })
    };

    let stepCounter = 1;

    const result = streamText({
      model: workersai("@cf/zai-org/glm-5.2", {
        sessionAffinity: this.name,
        gateway: {
          id: "agent-browser"
        }
      }),
      system: SYSTEM_PROMPT,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: { ...browserTools, ...handoffTools },
      stopWhen: stepCountIs(100),
      abortSignal: options?.abortSignal,
      onStepFinish: (stepResult) => {
        const hasBrowserTool = stepResult.toolCalls?.some((tc) =>
          tc.toolName.startsWith("browser_")
        );
        if (hasBrowserTool) {
          broadcastEvent({
            type: "browser-action",
            action: `Step ${stepCounter}: ${stepResult.toolCalls.map((tc) => tc.toolName).join(", ")}`,
            step: stepCounter++
          });
          connector
            .liveView({ mode: "tab" })
            .then((liveView) => {
              const targets = liveView?.targets ?? [];
              const pageTargets = targets.filter((t) => t.type === "page");
              const realPages = pageTargets.filter(
                (t) => t.pageUrl && !t.pageUrl.startsWith("about:")
              );
              const target =
                realPages[realPages.length - 1] ??
                pageTargets[pageTargets.length - 1] ??
                targets[0];
              if (target?.url) {
                broadcastEvent({
                  type: "browser-liveview-url",
                  url: target.url
                });
              }
            })
            .catch(() => {});
        }
      },
      onFinish: () => {
        broadcastEvent({ type: "browser-status", status: "done" });
      }
    });

    return result.toUIMessageStreamResponse();
  }

  @callable()
  async closeBrowserSession() {
    try {
      const { connector } = createBrowserRuntime({
        ctx: this.ctx,
        browser: this.env.BROWSER,
        loader: this.env.LOADER,
        session: {
          mode: "reuse",
          key: "main",
          keepAliveMs: 600_000
        }
      });
      await connector.closeSession();
    } catch {
      // best-effort — session may not exist
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
