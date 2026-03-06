import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs,
  type StreamTextOnFinishCallback,
  type ToolSet
} from "ai";
import { z } from "zod";
import { Stagehand } from "@browserbasehq/stagehand";
import { endpointURLString } from "@cloudflare/playwright";
import { WorkersAIClient } from "./workersAIClient";
import { startScreencast } from "./screencast";
import { type BrowserEvent, isAllowedUrl } from "./types";

// ── Constants ───────────────────────────────────────────────────────────

/** Maximum number of observe+act steps before stopping the automation */
const MAX_ACTIONS = 10;

/** Delay after each action to let the page settle (ms) */
const ACTION_SETTLE_MS = 1000;

/** Delay after a direct act() fallback (ms) */
const DIRECT_ACT_SETTLE_MS = 1500;

/** Delay before extraction to let dynamic content load (ms) */
const EXTRACTION_SETTLE_MS = 1000;

export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash"),
      system: `You are a browser automation assistant. When the user asks you to do something on the web — search for products, look up information, check prices, read articles, etc. — use the browseWeb tool.

When using browseWeb:
- Provide a clear, specific task description
- Include the starting URL if you know the right website (e.g., https://www.amazon.com for product searches)
- If you don't know the website, start with https://www.google.com and search from there

After the browse completes, summarize the results for the user based on the tool output.`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        browseWeb: tool({
          description:
            "Browse the web to accomplish a task. Use this for any request that requires navigating websites, searching for information, clicking links, extracting data, etc.",
          inputSchema: z.object({
            task: z
              .string()
              .describe(
                "A clear description of the browsing task to perform, e.g. 'Search for iPhone 16 and get the price of the first result'"
              ),
            startUrl: z
              .string()
              .url()
              .refine(isAllowedUrl, {
                message:
                  "Only public HTTP/HTTPS URLs are allowed. Internal and reserved addresses are blocked."
              })
              .describe(
                "The URL to start browsing from, e.g. https://www.amazon.com"
              )
          }),
          execute: async ({ task, startUrl }) => {
            return await this.executeBrowseTask(
              task,
              startUrl,
              options?.abortSignal
            );
          }
        })
      },
      stopWhen: stepCountIs(5),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  /**
   * Execute a browser automation task using Stagehand.
   * Streams live screencast frames and action logs to connected clients.
   */
  private async executeBrowseTask(
    task: string,
    startUrl: string,
    signal?: AbortSignal
  ): Promise<string> {
    let stagehand: Stagehand | null = null;
    let stopScreencast: (() => Promise<void>) | null = null;
    let step = 0;

    const broadcastEvent = (event: BrowserEvent) => {
      this.broadcast(JSON.stringify(event));
    };

    try {
      // Bail early if already cancelled
      if (signal?.aborted) {
        return JSON.stringify({ success: false, task, error: "Cancelled" });
      }

      // ── 1. Launch browser ─────────────────────────────────────────────
      broadcastEvent({
        type: "browser-status",
        status: "starting",
        message: "Launching browser..."
      });

      stagehand = new Stagehand({
        env: "LOCAL",
        localBrowserLaunchOptions: {
          cdpUrl: endpointURLString(this.env.BROWSER)
        },
        llmClient: new WorkersAIClient(this.env.AI),
        logger: (line) => console.log(`[stagehand] ${line.message}`),
        verbose: 1,
        disablePino: true
      });

      await stagehand.init();
      const page = stagehand.page;

      // ── 2. Start CDP screencast for live browser view ─────────────────
      stopScreencast = await startScreencast(page, (base64) => {
        broadcastEvent({ type: "browser-screenshot", data: base64 });
      });

      // ── 3. Navigate to start URL ──────────────────────────────────────
      broadcastEvent({
        type: "browser-status",
        status: "navigating",
        message: `Navigating to ${startUrl}`
      });

      await page.goto(startUrl, { waitUntil: "domcontentloaded" });

      step++;
      broadcastEvent({
        type: "browser-action",
        action: `Navigated to ${startUrl}`,
        step
      });

      // ── 4. Execute the task using observe + act loop ──────────────────
      broadcastEvent({
        type: "browser-status",
        status: "acting",
        message: `Working on: ${task}`
      });

      // Use observe to determine the actions needed
      const actions = await page.observe(task);

      // Cap the number of actions to prevent runaway automation
      const cappedActions = actions.slice(0, MAX_ACTIONS);
      if (actions.length > MAX_ACTIONS) {
        console.warn(
          `Task produced ${actions.length} actions, capping at ${MAX_ACTIONS}`
        );
      }

      // Execute each observed action
      for (const action of cappedActions) {
        // Check for cancellation between actions
        if (signal?.aborted) {
          broadcastEvent({
            type: "browser-status",
            status: "done",
            message: "Task cancelled"
          });
          break;
        }

        step++;
        const actionDesc = action.description || `Action step ${step}`;

        broadcastEvent({
          type: "browser-status",
          status: "acting",
          message: actionDesc
        });

        await page.act(action);

        // Brief pause for page to settle (screencast continues streaming)
        await new Promise((resolve) => setTimeout(resolve, ACTION_SETTLE_MS));

        broadcastEvent({
          type: "browser-action",
          action: actionDesc,
          step
        });
      }

      // If observe returned no actions, try acting directly on the task
      if (actions.length === 0) {
        step++;
        broadcastEvent({
          type: "browser-status",
          status: "acting",
          message: `Performing: ${task}`
        });

        await page.act(task);
        await new Promise((resolve) =>
          setTimeout(resolve, DIRECT_ACT_SETTLE_MS)
        );

        broadcastEvent({
          type: "browser-action",
          action: task,
          step
        });
      }

      // Skip extraction if cancelled
      if (signal?.aborted) {
        await cleanup(stagehand, stopScreencast);
        return JSON.stringify({ success: false, task, error: "Cancelled" });
      }

      // ── 5. Extract page content ───────────────────────────────────────
      broadcastEvent({
        type: "browser-status",
        status: "extracting",
        message: "Extracting information from page..."
      });

      // Wait a moment for any remaining dynamic content
      await new Promise((resolve) => setTimeout(resolve, EXTRACTION_SETTLE_MS));

      const extraction = await page.extract({
        instruction: `Extract the most relevant information from this page related to the task: "${task}". Include titles, prices, descriptions, links, or any other key data visible on the page.`,
        schema: z.object({
          pageTitle: z.string().describe("The page title"),
          pageUrl: z.string().describe("The current page URL"),
          mainContent: z
            .string()
            .describe(
              "The main relevant content/information found on the page"
            ),
          items: z
            .array(
              z.object({
                title: z.string().describe("Item title or heading"),
                detail: z
                  .string()
                  .describe("Key detail (price, description, etc.)")
                  .optional()
              })
            )
            .describe("List of relevant items found")
            .optional()
        })
      });

      step++;
      broadcastEvent({
        type: "browser-action",
        action: "Extraction complete",
        step
      });

      broadcastEvent({
        type: "browser-status",
        status: "done",
        message: "Browser task completed"
      });

      // ���─ 6. Clean up and return results ────────────────────────────────
      await cleanup(stagehand, stopScreencast);

      return JSON.stringify({
        success: true,
        task,
        url: extraction.pageUrl,
        pageTitle: extraction.pageTitle,
        content: extraction.mainContent,
        items: extraction.items || [],
        totalSteps: step
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      broadcastEvent({
        type: "browser-error",
        error: errorMessage
      });
      broadcastEvent({
        type: "browser-status",
        status: "error",
        message: errorMessage
      });

      // Ensure browser is closed on error
      await cleanup(stagehand, stopScreencast);

      return JSON.stringify({
        success: false,
        task,
        error: errorMessage
      });
    }
  }
}

/** Gracefully close Stagehand and stop the screencast session. */
async function cleanup(
  stagehand: Stagehand | null,
  stopScreencast: (() => Promise<void>) | null
) {
  if (stopScreencast) {
    try {
      await stopScreencast();
    } catch {
      // best-effort
    }
  }
  if (stagehand) {
    try {
      await stagehand.close();
    } catch {
      // ignore close errors
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
