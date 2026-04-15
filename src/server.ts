import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  type StreamTextOnFinishCallback,
  type ToolSet,
} from "ai";

import { SYSTEM_PROMPT } from "./prompt";
import {
  type BrowserState,
  createBrowserState,
  ensureBrowserSession,
  closeBrowserSession as closeBrowserSessionFn,
  getSnapshotCdp,
  invalidateSnapshotCdp,
  detectAndSwitchToNewPage,
} from "./browser/session";
import type { BrowserEvent } from "./types";
import { createTools } from "./tools";

export class ChatAgent extends AIChatAgent<Env> {
  private browserState: BrowserState = createBrowserState();

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const broadcastEvent = (event: BrowserEvent) => {
      this.broadcast(JSON.stringify(event));
    };

    const tools = createTools({
      getPage: () =>
        ensureBrowserSession(this.browserState, this.env, broadcastEvent),
      getCurrentPageUrl: () => this.browserState.page?.url(),
      broadcastEvent,
      getSnapshotCdp: () => getSnapshotCdp(this.browserState),
      invalidateSnapshotCdp: () => invalidateSnapshotCdp(this.browserState),
      detectAndSwitchToNewPage: (currentPage, knownPageCount) =>
        detectAndSwitchToNewPage(
          this.browserState,
          currentPage,
          knownPageCount,
          broadcastEvent,
        ),
    });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.5", {
        sessionAffinity: this.name,
        gateway: {
          id: "agent-browser",
        },
      }),
      system: SYSTEM_PROMPT,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
      }),
      tools,
      stopWhen: stepCountIs(100),
      abortSignal: options?.abortSignal,
    });

    return result.toUIMessageStreamResponse();
  }

  @callable()
  async closeBrowserSession() {
    await closeBrowserSessionFn(this.browserState);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
