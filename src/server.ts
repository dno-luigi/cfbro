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
import {
  launch,
  sessions,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
  type WorkersLaunchOptions
} from "@cloudflare/playwright";

import { startScreencast } from "./screencast";
import { type BrowserEvent, isAllowedUrl } from "./types";

// ── Constants ───────────────────────────────────────────────────────────

/** Browser session keep-alive duration (ms) — session expires after this if unused */
const KEEP_ALIVE_MS = 600_000;

// ── Shared helpers ──────────────────────────────────────────────────────

async function createBrowser(
  env: Env,
  options?: { keepAlive?: number }
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const launchOptions: WorkersLaunchOptions = {};
  if (options?.keepAlive) launchOptions.keep_alive = options.keepAlive;
  const browser = await launch(env.BROWSER, launchOptions);
  const context =
    browser.contexts()[0] ??
    (await browser.newContext({ viewport: { width: 1280, height: 720 } }));
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, context, page };
}

async function resolveSessionId(
  browserBinding: Env["BROWSER"]
): Promise<string | null> {
  try {
    const activeSessions = await sessions(browserBinding);
    const sid = activeSessions[0]?.sessionId ?? null;
    console.log(`[Browser] sessionId from sessions(): ${sid}`);
    return sid;
  } catch (e) {
    console.warn("[Browser] sessions() failed:", e);
    return null;
  }
}

async function getPageSnapshot(page: Page): Promise<string> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    await cdp.detach();

    const skipRoles = new Set([
      "generic",
      "text",
      "StaticText",
      "InlineTextBox",
      "linebreak",
      "presentation",
      "none"
    ]);

    const lines: string[] = [];
    let ref = 0;

    for (const node of nodes) {
      const roleValue = node.role?.value;
      if (!roleValue || skipRoles.has(String(roleValue))) continue;
      if (node.ignored) continue;

      ref++;
      const nameValue = node.name?.value;
      const name = nameValue ? ` "${nameValue}"` : "";
      const descValue = node.description?.value;
      const description = descValue ? ` [${descValue}]` : "";
      const valValue = node.value?.value;
      const value = valValue ? ` value="${valValue}"` : "";

      lines.push(`[ref=${ref}] ${roleValue}${name}${description}${value}`);
    }

    return lines.length > 0
      ? lines.join("\n")
      : "No interactive elements found on page.";
  } catch {
    const text = await page.evaluate(() => {
      const body = document.body;
      if (!body) return "Empty page";
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
      const elements: string[] = [];
      let i = 1;
      const interactiveTags = new Set([
        "a",
        "button",
        "input",
        "select",
        "textarea"
      ]);
      const interactiveRoles = new Set([
        "button",
        "link",
        "textbox",
        "searchbox",
        "combobox",
        "menuitem",
        "tab",
        "checkbox",
        "radio",
        "switch"
      ]);
      while (walker.nextNode()) {
        const el = walker.currentNode as HTMLElement;
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role");
        if (interactiveTags.has(tag) || (role && interactiveRoles.has(role))) {
          const ariaLabel = el.getAttribute("aria-label");
          const label = el.getAttribute("label");
          const txt = el.textContent?.trim().slice(0, 100);
          elements.push(
            `[ref=${i++}] <${tag}>${ariaLabel ? ` aria-label="${ariaLabel}"` : ""}${label ? ` label="${label}"` : ""}${txt ? ` "${txt}"` : ""}`
          );
        }
      }
      return elements.length > 0
        ? elements.join("\n")
        : "No interactive elements found.";
    });
    return text;
  }
}

async function resolveLocator(page: Page, ref: number): Promise<Locator> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    await cdp.detach();

    const skipRoles = new Set([
      "generic",
      "text",
      "StaticText",
      "InlineTextBox",
      "linebreak",
      "presentation",
      "none"
    ]);

    const filtered = nodes.filter(
      (n) => n.role?.value && !skipRoles.has(String(n.role.value)) && !n.ignored
    );
    const node = filtered[ref - 1];

    if (!node) {
      throw new Error(
        `Element ref=${ref} not found. Take a new page_snapshot first.`
      );
    }

    const name = String(node.name?.value ?? "");
    const role = String(node.role?.value ?? "");

    if (role === "link" && name) {
      return page.getByRole("link", { name, exact: false });
    }
    if (role === "button" && name) {
      return page.getByRole("button", { name, exact: false });
    }
    if (
      (role === "textbox" || role === "searchbox" || role === "combobox") &&
      name
    ) {
      return page.getByRole("textbox", { name, exact: false });
    }
    if (role === "heading" && name) {
      return page.getByRole("heading", { name, exact: false });
    }
    if (name) {
      return page.getByText(name, { exact: false });
    }

    throw new Error(
      `Could not resolve element ref=${ref} (${role}). Take a new page_snapshot and try a different approach.`
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      throw err;
    }
    throw new Error(
      `Failed to resolve element ref=${ref}. Take a new page_snapshot first.`
    );
  }
}

export class ChatAgent extends AIChatAgent<Env> {
  private _browser: Browser | null = null;
  private _page: Page | null = null;
  private _stopScreencast: (() => Promise<void>) | null = null;

  // ── Chat message handler ────────────────────────────────────────────

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });

    let stepCounter = 1;
    const broadcastEvent = (event: BrowserEvent) => {
      this.broadcast(JSON.stringify(event));
    };

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.5"),
      system: `You are a browser automation assistant that controls a real web browser using Playwright tools.

You have these tools:
- navigate: Go to a URL. Always start here.
- page_snapshot: Get a list of all interactive elements on the page with their ref IDs. Use this to "see" the page.
- click: Click an element by its ref number (from page_snapshot).
- fill: Type text into an input element by its ref number.
- press: Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.).
- scroll: Scroll the page up or down.
- extract_text: Read visible text content from the page.
- ask_user: Ask the user for help when you are stuck or need information.

Workflow:
1. Use navigate to go to the target URL.
2. Use page_snapshot to see what's on the page — this returns a list of elements with ref IDs.
3. Use click, fill, or press to interact with elements by their ref numbers.
4. Use extract_text to read information from the page.
5. After acting, use page_snapshot again to see the updated page state.

Important:
- Always use page_snapshot before interacting to get the latest ref IDs.
- Ref IDs change after navigation or page updates — never reuse old refs.
- If an action fails, take a new page_snapshot and try again.
- Use fill for typing into inputs, then press Enter to submit forms.
- For scrolling long pages, use scroll then page_snapshot to see new content.

When to ask the user for help:
- If you encounter an issue you cannot resolve after 2-3 attempts (e.g., CAPTCHA, login required, unexpected popup, element not found after multiple snapshots), use the ask_user tool to request help.
- Use ask_type "action_needed" when the user needs to do something in the browser (solve CAPTCHA, log in, dismiss a popup).
- Use ask_type "question" when you need a text answer (which account to use, what credentials, which option to pick).
- After calling ask_user, do NOT call any other tools — wait for the user to respond before continuing.`,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        navigate: tool({
          description: "Navigate the browser to a URL",
          inputSchema: z.object({
            url: z
              .string()
              .url()
              .refine(isAllowedUrl, {
                message:
                  "Only public HTTP/HTTPS URLs are allowed. Internal and reserved addresses are blocked."
              })
              .describe("The URL to navigate to, e.g. https://www.google.com")
          }),
          execute: async ({ url }) => {
            try {
              const page = await this.ensureBrowserSession(broadcastEvent);
              broadcastEvent({
                type: "browser-status",
                status: "navigating",
                message: `Navigating to ${url}`
              });
              await page.goto(url, { waitUntil: "domcontentloaded" });
              const title = await page.title();
              broadcastEvent({
                type: "browser-action",
                action: `Navigated to ${url}`,
                step: stepCounter++
              });
              return JSON.stringify({ success: true, title, url: page.url() });
            } catch (err) {
              return JSON.stringify({
                success: false,
                error: String(err)
              });
            }
          }
        }),

        page_snapshot: tool({
          description:
            "Get a snapshot of all interactive elements on the current page. Returns elements with ref IDs you can use with click and fill. Always call this before interacting with the page.",
          inputSchema: z.object({}),
          execute: async () => {
            try {
              const page = await this.ensureBrowserSession(broadcastEvent);
              broadcastEvent({
                type: "browser-status",
                status: "acting",
                message: "Reading page..."
              });
              const snapshot = await getPageSnapshot(page);
              broadcastEvent({
                type: "browser-action",
                action: "Captured page snapshot",
                step: stepCounter++
              });
              return JSON.stringify({
                success: true,
                url: page.url(),
                snapshot
              });
            } catch (err) {
              return JSON.stringify({
                success: false,
                error: String(err)
              });
            }
          }
        }),

        click: tool({
          description:
            "Click an element on the page identified by its ref number from page_snapshot.",
          inputSchema: z.object({
            ref: z
              .number()
              .describe(
                "The ref number of the element to click, from page_snapshot"
              ),
            description: z
              .string()
              .describe("Brief description of what you're clicking")
          }),
          execute: async ({ ref, description }) => {
            try {
              const page = await this.ensureBrowserSession(broadcastEvent);
              broadcastEvent({
                type: "browser-status",
                status: "acting",
                message: `Clicking: ${description}`
              });
              const locator = await resolveLocator(page, ref);
              await locator.click();
              await page.waitForTimeout(500);
              broadcastEvent({
                type: "browser-action",
                action: `Clicked: ${description}`,
                step: stepCounter++
              });
              return JSON.stringify({
                success: true,
                action: description,
                url: page.url()
              });
            } catch (err) {
              return JSON.stringify({
                success: false,
                error: String(err)
              });
            }
          }
        }),

        fill: tool({
          description:
            "Fill a text input or textarea with a value. Clears existing content first. Use the ref number from page_snapshot.",
          inputSchema: z.object({
            ref: z
              .number()
              .describe(
                "The ref number of the input element, from page_snapshot"
              ),
            value: z.string().describe("The text to type into the input"),
            description: z
              .string()
              .describe("Brief description, e.g. 'filling search box'")
          }),
          execute: async ({ ref, value, description }) => {
            try {
              const page = await this.ensureBrowserSession(broadcastEvent);
              broadcastEvent({
                type: "browser-status",
                status: "acting",
                message: description
              });
              const locator = await resolveLocator(page, ref);
              await locator.fill(value);
              broadcastEvent({
                type: "browser-action",
                action: description,
                step: stepCounter++
              });
              return JSON.stringify({
                success: true,
                action: description,
                url: page.url()
              });
            } catch (err) {
              return JSON.stringify({
                success: false,
                error: String(err)
              });
            }
          }
        }),

        press: tool({
          description:
            "Press a keyboard key. Use after filling a form to submit (Enter), navigate between fields (Tab), etc.",
          inputSchema: z.object({
            key: z
              .string()
              .describe(
                "The key to press, e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown'"
              )
          }),
          execute: async ({ key }) => {
            try {
              const page = await this.ensureBrowserSession(broadcastEvent);
              await page.keyboard.press(key);
              await page.waitForTimeout(500);
              broadcastEvent({
                type: "browser-action",
                action: `Pressed ${key}`,
                step: stepCounter++
              });
              return JSON.stringify({
                success: true,
                action: `Pressed ${key}`,
                url: page.url()
              });
            } catch (err) {
              return JSON.stringify({
                success: false,
                error: String(err)
              });
            }
          }
        }),

        scroll: tool({
          description: "Scroll the page up or down to reveal more content.",
          inputSchema: z.object({
            direction: z.enum(["up", "down"]).describe("Direction to scroll"),
            amount: z
              .number()
              .default(3)
              .describe("Number of viewport heights to scroll")
          }),
          execute: async ({ direction, amount }) => {
            try {
              const page = await this.ensureBrowserSession(broadcastEvent);
              const delta = direction === "down" ? 1 : -1;
              await page.evaluate(
                ([d, a]) => window.scrollBy(0, d * a * window.innerHeight),
                [delta, amount] as const
              );
              broadcastEvent({
                type: "browser-action",
                action: `Scrolled ${direction}`,
                step: stepCounter++
              });
              return JSON.stringify({
                success: true,
                action: `Scrolled ${direction}`
              });
            } catch (err) {
              return JSON.stringify({
                success: false,
                error: String(err)
              });
            }
          }
        }),

        extract_text: tool({
          description:
            "Extract visible text content from the current page. Use this to read information, prices, articles, etc.",
          inputSchema: z.object({
            selector: z
              .string()
              .optional()
              .describe(
                "Optional CSS selector to extract from a specific element. Omit to get all visible text."
              )
          }),
          execute: async ({ selector }) => {
            try {
              const page = await this.ensureBrowserSession(broadcastEvent);
              broadcastEvent({
                type: "browser-status",
                status: "extracting",
                message: "Extracting page content..."
              });
              const text = selector
                ? ((await page.locator(selector).textContent()) ?? "")
                : await page.evaluate(() => document.body.innerText);
              broadcastEvent({
                type: "browser-action",
                action: "Extracted content",
                step: stepCounter++
              });
              return JSON.stringify({
                success: true,
                url: page.url(),
                text: text.slice(0, 10000)
              });
            } catch (err) {
              return JSON.stringify({
                success: false,
                error: String(err)
              });
            }
          }
        }),

        ask_user: tool({
          description:
            "Ask the user for help when you are stuck or need information. Use ask_type 'action_needed' when the user needs to do something in the browser (solve CAPTCHA, log in, dismiss a popup). Use ask_type 'question' when you need a text answer (which account, what credentials, which option). After calling this tool, do NOT call any other tools — wait for the user to respond.",
          inputSchema: z.object({
            message: z
              .string()
              .describe(
                "A clear description of what you need help with, e.g. 'I need you to solve the CAPTCHA in the browser' or 'Which email account should I log in with?'"
              ),
            askType: z
              .enum(["question", "action_needed"])
              .describe(
                "'action_needed' if the user needs to do something in the browser, 'question' if you need a text answer"
              )
          }),
          execute: async ({ message, askType }) => {
            broadcastEvent({
              type: "user-action-needed",
              message,
              askType
            });
            return JSON.stringify({
              success: true,
              message: "Waiting for user response."
            });
          }
        })
      },
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Browser session management ──────────────────────────────────────

  private async ensureBrowserSession(
    broadcastEvent: (event: BrowserEvent) => void
  ): Promise<Page> {
    if (this._page && !this._page.isClosed()) {
      return this._page;
    }

    console.log("[Browser] Creating new browser session");
    broadcastEvent({
      type: "browser-status",
      status: "starting",
      message: "Launching browser..."
    });

    try {
      const { browser, page } = await createBrowser(this.env, {
        keepAlive: KEEP_ALIVE_MS
      });
      this._browser = browser;
      this._page = page;
    } catch (err) {
      console.error("[Browser] Failed to launch browser:", err);
      this._browser = null;
      this._page = null;
      throw err;
    }

    this._stopScreencast = await startScreencast(this._page, (base64) => {
      broadcastEvent({ type: "browser-screenshot", data: base64 });
    });

    const sessionId = await resolveSessionId(this.env.BROWSER);

    if (sessionId) {
      const liveViewUrl = await this.fetchLiveViewUrl(sessionId);
      if (liveViewUrl) {
        broadcastEvent({ type: "browser-liveview-url", url: liveViewUrl });
      }
    }

    console.log("[Browser] Session ready");
    return this._page;
  }

  async closeBrowserSession() {
    if (this._stopScreencast) {
      try {
        await this._stopScreencast();
      } catch {
        // best-effort
      }
      this._stopScreencast = null;
    }
    if (this._browser) {
      try {
        await this._browser.close();
      } catch {
        // best-effort
      }
    }
    this._browser = null;
    this._page = null;
  }

  private async fetchLiveViewUrl(sessionId: string): Promise<string | null> {
    const accountId = this.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = this.env.BROWSER_RENDERING_API_TOKEN;

    if (!accountId || !apiToken) {
      console.warn(
        "[Live View] Missing CLOUDFLARE_ACCOUNT_ID or BROWSER_RENDERING_API_TOKEN — live view URL unavailable"
      );
      return null;
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/devtools/browser/${sessionId}/json/list`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${apiToken}` }
      });

      if (!response.ok) {
        console.warn(
          `[Live View] Failed to fetch targets: ${response.status} ${await response.text()}`
        );
        return null;
      }

      const targets = (await response.json()) as Array<{
        devtoolsFrontendUrl?: string;
      }>;

      return targets[0]?.devtoolsFrontendUrl ?? null;
    } catch (err) {
      console.warn("[Live View] Error fetching live view URL:", err);
      return null;
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
