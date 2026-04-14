import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, callable } from "agents";
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
  type WorkersLaunchOptions
} from "@cloudflare/playwright";

import { startScreencast } from "./screencast";
import { type BrowserEvent, type AriaRole, isAllowedUrl } from "./types";

// ── Constants ───────────────────────────────────────────────────────────

const KEEP_ALIVE_MS = 600_000;
const LIVE_VIEW_RETRY_ATTEMPTS = 3;
const LIVE_VIEW_RETRY_DELAY_MS = 2_000;

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
      const name = nameValue ? ` name="${nameValue}"` : "";
      const descValue = node.description?.value;
      const description = descValue ? ` description="${descValue}"` : "";
      const valValue = node.value?.value;
      const value = valValue ? ` value="${valValue}"` : "";

      lines.push(`[${ref}] role=${roleValue}${name}${description}${value}`);
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
          const roleStr = role ?? tag;
          const nameStr = ariaLabel ?? label ?? txt ?? "";
          elements.push(`[${i}] role=${roleStr} name="${nameStr}"`);
          i++;
        }
      }
      return elements.length > 0
        ? elements.join("\n")
        : "No interactive elements found.";
    });
    return text;
  }
}

// ── System prompt ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a browser automation assistant that controls a real web browser.

You have these tools:
- navigate({ url }) — Navigate to a URL (validates URL safety)
- page_snapshot({}) — Get all interactive elements on the page with their role and name
- click({ role, name }) — Click an element identified by its ARIA role and accessible name
- fill({ role, name, value }) — Type text into an input field identified by role and name
- press({ key }) — Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.)
- scroll({ direction, amount }) — Scroll the page up or down
- select_option({ role, name, value }) — Select an option in a dropdown/combobox
- check({ role, name }) — Check a checkbox or radio button
- get_text({ role, name, selector }) — Read text content from an element
- ask_user({ message }) — Ask the user for help when stuck

Workflow:
1. Use navigate() to go to a URL.
2. Use page_snapshot() to see the page — returns elements with role and name.
3. Use click(), fill(), press(), etc. to interact with elements using their role and name from the snapshot.
4. After acting, use page_snapshot() again to see the updated page.

How to use role and name from page_snapshot:
- The snapshot format is: [N] role=rolename name="accessible name"
- To click element [3] role=button name="Search": click({ role: "button", name: "Search" })
- To fill element [5] role=textbox name="Email": fill({ role: "textbox", name: "Email", value: "user@example.com" })
- To select in [7] role=combobox name="Country": select_option({ role: "combobox", name: "Country", value: "US" })

Common roles: button, link, textbox, searchbox, combobox, checkbox, radio, heading, tab, menuitem, img, listitem

IMPORTANT:
- Always call page_snapshot before interacting to get the latest element info.
- Use the exact role and name from the snapshot output.
- If an action fails, take a new page_snapshot and try again with updated info.
- After filling a form field, use press({ key: "Enter" }) to submit.

When to ask the user for help:
- If you encounter an issue you cannot resolve after 2-3 attempts (e.g., CAPTCHA, login required, unexpected popup, element not found after multiple snapshots), use the ask_user tool to request help.
- The user will interact with the browser directly, then let you know when they are done. You will automatically resume after they respond.`;

// ── Agent ───────────────────────────────────────────────────────────────

export class ChatAgent extends AIChatAgent<Env> {
  private _browser: Browser | null = null;
  private _context: BrowserContext | null = null;
  private _page: Page | null = null;
  private _stopScreencast: (() => Promise<void>) | null = null;
  private _switchingPage: Promise<void> | null = null;
  private _knownTargetIds: Set<string> = new Set();
  private _sessionReady: Promise<Page> | null = null;

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

    const tools = {
      navigate: tool({
        description:
          "Navigate the browser to a URL. Always use this instead of page.goto().",
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
        execute: async ({ url }: { url: string }) => {
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
            return { success: true, title, url: page.url() };
          } catch (err) {
            return { success: false, error: String(err) };
          }
        }
      }),

      page_snapshot: tool({
        description:
          "Get a snapshot of all interactive elements on the current page. Returns elements with role and name. Always call this before interacting with the page.",
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
            return { success: true, url: page.url(), snapshot };
          } catch (err) {
            return { success: false, error: String(err) };
          }
        }
      }),

      click: tool({
        description:
          "Click an element on the page identified by its ARIA role and accessible name. Use the role and name from page_snapshot output.",
        inputSchema: z.object({
          role: z
            .string()
            .describe("ARIA role of the element, e.g. 'button', 'link', 'tab'"),
          name: z
            .string()
            .describe(
              "Accessible name of the element from page_snapshot, e.g. 'Search'"
            )
        }),
        execute: async ({ role, name }: { role: string; name: string }) => {
          try {
            const page = await this.ensureBrowserSession(broadcastEvent);
            broadcastEvent({
              type: "browser-status",
              status: "acting",
              message: `Clicking ${role} "${name}"`
            });

            const cdp = await page.context().newCDPSession(page);
            const { targetInfos: targetsBefore } =
              await cdp.send("Target.getTargets");
            const pageTargetsBefore = targetsBefore.filter(
              (t) => t.type === "page" && t.url !== "about:blank"
            );
            await cdp.detach();

            await page
              .getByRole(role as AriaRole, { name, exact: false })
              .click();
            await page.waitForTimeout(1000);

            await this.detectAndSwitchToNewPage(page, pageTargetsBefore.length);

            broadcastEvent({
              type: "browser-action",
              action: `Clicked ${role} "${name}"`,
              step: stepCounter++
            });
            return {
              success: true,
              action: `Clicked ${role} "${name}"`,
              url: this._page?.url() ?? page.url()
            };
          } catch (err) {
            return { success: false, error: String(err) };
          }
        }
      }),

      fill: tool({
        description:
          "Type text into an input field identified by its ARIA role and accessible name. Clears existing content first. Use the role and name from page_snapshot output.",
        inputSchema: z.object({
          role: z
            .string()
            .describe(
              "ARIA role of the input, e.g. 'textbox', 'searchbox', 'combobox'"
            ),
          name: z
            .string()
            .describe(
              "Accessible name of the input from page_snapshot, e.g. 'Search'"
            ),
          value: z.string().describe("The text to type into the input")
        }),
        execute: async ({
          role,
          name,
          value
        }: {
          role: string;
          name: string;
          value: string;
        }) => {
          try {
            const page = await this.ensureBrowserSession(broadcastEvent);
            broadcastEvent({
              type: "browser-status",
              status: "acting",
              message: `Filling ${role} "${name}"`
            });
            await page
              .getByRole(role as AriaRole, { name, exact: false })
              .fill(value);
            await page.waitForTimeout(500);
            broadcastEvent({
              type: "browser-action",
              action: `Filled ${role} "${name}" with "${value}"`,
              step: stepCounter++
            });
            return {
              success: true,
              action: `Filled ${role} "${name}"`,
              url: page.url()
            };
          } catch (err) {
            return { success: false, error: String(err) };
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
        execute: async ({ key }: { key: string }) => {
          try {
            const page = await this.ensureBrowserSession(broadcastEvent);
            await page.keyboard.press(key);
            await page.waitForTimeout(500);
            broadcastEvent({
              type: "browser-action",
              action: `Pressed ${key}`,
              step: stepCounter++
            });
            return { success: true, action: `Pressed ${key}`, url: page.url() };
          } catch (err) {
            return { success: false, error: String(err) };
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
        execute: async ({
          direction,
          amount
        }: {
          direction: "up" | "down";
          amount: number;
        }) => {
          try {
            const page = await this.ensureBrowserSession(broadcastEvent);
            const delta = direction === "down" ? amount : -amount;
            await page.mouse.wheel(0, delta * 720);
            await page.waitForTimeout(500);
            broadcastEvent({
              type: "browser-action",
              action: `Scrolled ${direction}`,
              step: stepCounter++
            });
            return { success: true, action: `Scrolled ${direction}` };
          } catch (err) {
            return { success: false, error: String(err) };
          }
        }
      }),

      select_option: tool({
        description:
          "Select an option in a dropdown/combobox identified by its ARIA role and accessible name.",
        inputSchema: z.object({
          role: z
            .string()
            .describe("ARIA role, typically 'combobox' or 'listbox'"),
          name: z
            .string()
            .describe(
              "Accessible name of the select element from page_snapshot"
            ),
          value: z
            .string()
            .describe("The value or label of the option to select")
        }),
        execute: async ({
          role,
          name,
          value
        }: {
          role: string;
          name: string;
          value: string;
        }) => {
          try {
            const page = await this.ensureBrowserSession(broadcastEvent);
            broadcastEvent({
              type: "browser-status",
              status: "acting",
              message: `Selecting "${value}" in ${role} "${name}"`
            });
            await page
              .getByRole(role as AriaRole, { name, exact: false })
              .selectOption(value);
            await page.waitForTimeout(500);
            broadcastEvent({
              type: "browser-action",
              action: `Selected "${value}" in ${role} "${name}"`,
              step: stepCounter++
            });
            return {
              success: true,
              action: `Selected "${value}" in ${role} "${name}"`,
              url: page.url()
            };
          } catch (err) {
            return { success: false, error: String(err) };
          }
        }
      }),

      check: tool({
        description:
          "Check a checkbox or radio button identified by its ARIA role and accessible name.",
        inputSchema: z.object({
          role: z
            .string()
            .describe("ARIA role, typically 'checkbox' or 'radio'"),
          name: z.string().describe("Accessible name from page_snapshot")
        }),
        execute: async ({ role, name }: { role: string; name: string }) => {
          try {
            const page = await this.ensureBrowserSession(broadcastEvent);
            broadcastEvent({
              type: "browser-status",
              status: "acting",
              message: `Checking ${role} "${name}"`
            });
            await page
              .getByRole(role as AriaRole, { name, exact: false })
              .check();
            await page.waitForTimeout(500);
            broadcastEvent({
              type: "browser-action",
              action: `Checked ${role} "${name}"`,
              step: stepCounter++
            });
            return {
              success: true,
              action: `Checked ${role} "${name}"`,
              url: page.url()
            };
          } catch (err) {
            return { success: false, error: String(err) };
          }
        }
      }),

      get_text: tool({
        description:
          "Read text content from an element. Use to extract information from the page.",
        inputSchema: z.object({
          role: z
            .string()
            .optional()
            .describe("ARIA role of the element to read from"),
          name: z
            .string()
            .optional()
            .describe("Accessible name of the element from page_snapshot"),
          selector: z
            .string()
            .optional()
            .describe("CSS selector as fallback if role/name not available")
        }),
        execute: async ({
          role,
          name,
          selector
        }: {
          role?: string;
          name?: string;
          selector?: string;
        }) => {
          try {
            const page = await this.ensureBrowserSession(broadcastEvent);
            broadcastEvent({
              type: "browser-status",
              status: "extracting",
              message: "Extracting text..."
            });
            let text: string | null;
            if (role && name) {
              text = await page
                .getByRole(role as AriaRole, { name, exact: false })
                .textContent();
            } else if (selector) {
              text = await page.locator(selector).textContent();
            } else {
              text = await page.locator("body").textContent();
            }
            broadcastEvent({
              type: "browser-action",
              action: "Extracted text",
              step: stepCounter++
            });
            return {
              success: true,
              text: text?.slice(0, 10000) ?? "",
              url: page.url()
            };
          } catch (err) {
            return { success: false, error: String(err) };
          }
        }
      })
    };

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.5"),
      system: SYSTEM_PROMPT,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools: {
        ...tools,
        ask_user: tool({
          description:
            "Ask the user for help when you are stuck. The user will interact with the browser directly (e.g. solve a CAPTCHA, log in, dismiss a popup), then let you know when they are done. You will automatically resume after they respond.",
          inputSchema: z.object({
            message: z
              .string()
              .describe(
                "A clear description of what you need help with, e.g. 'I need you to solve the CAPTCHA in the browser' or 'Please log in with your credentials'"
              )
          })
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

    if (this._sessionReady) {
      return this._sessionReady;
    }

    this._sessionReady = this._createBrowserSession(broadcastEvent);
    try {
      return await this._sessionReady;
    } finally {
      this._sessionReady = null;
    }
  }

  private async _createBrowserSession(
    broadcastEvent: (event: BrowserEvent) => void
  ): Promise<Page> {
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

    const context = this._page.context();
    if (context !== this._context) {
      this._context = context;
      context.on("page", (newPage) => {
        this.switchToPage(newPage);
      });
    }

    try {
      const cdp = await context.newCDPSession(this._page);
      const { targetInfos } = await cdp.send("Target.getTargets");
      await cdp.detach();
      this._knownTargetIds = new Set(
        targetInfos.filter((t) => t.type === "page").map((t) => t.targetId)
      );
    } catch {
      this._knownTargetIds = new Set();
    }

    const sessionId = await resolveSessionId(this.env.BROWSER);

    if (sessionId) {
      const liveViewUrl = await this.fetchLiveViewUrlWithRetry(sessionId);
      if (liveViewUrl) {
        broadcastEvent({ type: "browser-liveview-url", url: liveViewUrl });
      }
    }

    console.log("[Browser] Session ready");
    return this._page;
  }

  @callable()
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
    this._context = null;
    this._page = null;
    this._knownTargetIds.clear();
  }

  private async switchToPage(newPage: Page): Promise<void> {
    if (newPage === this._page || newPage.isClosed()) return;

    if (this._switchingPage) {
      await this._switchingPage;
      if (newPage === this._page) return;
    }

    const switchPromise = this._doSwitchToPage(newPage);
    this._switchingPage = switchPromise;
    try {
      await switchPromise;
    } finally {
      if (this._switchingPage === switchPromise) {
        this._switchingPage = null;
      }
    }
  }

  private async _doSwitchToPage(newPage: Page): Promise<void> {
    if (newPage.isClosed()) return;

    console.log(`[Browser] Switching to new page: ${newPage.url()}`);

    if (this._stopScreencast) {
      try {
        await this._stopScreencast();
      } catch {
        // best-effort
      }
      this._stopScreencast = null;
    }

    this._page = newPage;

    try {
      await newPage
        .waitForLoadState("domcontentloaded", { timeout: 5000 })
        .catch(() => {});
    } catch {
      // best-effort — page may already be loaded
    }

    try {
      this._stopScreencast = await startScreencast(this._page, (base64) => {
        this.broadcast(
          JSON.stringify({ type: "browser-screenshot", data: base64 })
        );
      });
    } catch (e) {
      console.error(
        "[Browser] Screencast failed on new page, retrying after delay:",
        e
      );
      await new Promise((r) => setTimeout(r, 1000));
      try {
        this._stopScreencast = await startScreencast(this._page, (base64) => {
          this.broadcast(
            JSON.stringify({ type: "browser-screenshot", data: base64 })
          );
        });
      } catch (e2) {
        console.error("[Browser] Screencast retry also failed:", e2);
      }
    }

    const title = await newPage.title().catch(() => "");
    console.log(`[Browser] Switched to page: "${title}" ${newPage.url()}`);
    this.broadcast(
      JSON.stringify({
        type: "browser-status",
        status: "navigating",
        message: `Switched to new tab: ${title || newPage.url()}`
      })
    );

    newPage.on("close", () => {
      if (this._page === newPage) {
        const pages = this._context?.pages().filter((p) => !p.isClosed()) ?? [];
        const fallback = pages.find((p) => p !== newPage);
        if (fallback) {
          this.switchToPage(fallback);
        } else {
          this._page = null;
          this._stopScreencast = null;
        }
      }
    });
  }

  private async detectAndSwitchToNewPage(
    currentPage: Page,
    knownPageCount: number
  ): Promise<void> {
    const pagesAfter = this._context?.pages() ?? [];
    const newPages = pagesAfter.filter(
      (p) => p !== currentPage && !p.isClosed()
    );
    if (newPages.length > 0) {
      const latest = newPages[newPages.length - 1];
      console.log(
        `[Browser] New page detected via context.pages(): ${latest.url()}`
      );
      await this.switchToPage(latest);
      return;
    }

    try {
      const cdp = await currentPage.context().newCDPSession(currentPage);
      const { targetInfos } = await cdp.send("Target.getTargets");
      await cdp.detach();

      const pageTargets = targetInfos.filter(
        (t) => t.type === "page" && t.url !== "about:blank"
      );

      const newTargetIds = pageTargets
        .filter((t) => !this._knownTargetIds.has(t.targetId))
        .map((t) => t.targetId);

      this._knownTargetIds = new Set(pageTargets.map((t) => t.targetId));

      if (newTargetIds.length === 0 && pageTargets.length > knownPageCount) {
        const newestTarget = pageTargets[pageTargets.length - 1];
        const matchingPage = pagesAfter.find(
          (p) => !p.isClosed() && p.url() === newestTarget.url
        );
        if (matchingPage) {
          console.log(
            `[Browser] New page detected via CDP URL match: ${matchingPage.url()}`
          );
          await this.switchToPage(matchingPage);
          return;
        }
      }

      if (newTargetIds.length > 0) {
        console.log(
          `[Browser] New CDP target(s) detected: ${newTargetIds.join(", ")}`
        );
        try {
          const newPage = await this._context!.waitForEvent("page", {
            timeout: 2000
          }).catch(() => null);
          if (newPage && !newPage.isClosed()) {
            await this.switchToPage(newPage);
            return;
          }
        } catch {
          // waitForEvent not available or timed out
        }

        const newTarget = pageTargets.find((t) =>
          newTargetIds.includes(t.targetId)
        );
        if (newTarget) {
          const allPages = this._context?.pages() ?? [];
          const match = allPages.find(
            (p) => !p.isClosed() && p.url() === newTarget.url
          );
          if (match) {
            await this.switchToPage(match);
            return;
          }

          console.log(
            `[Browser] Navigating current page to new target URL: ${newTarget.url}`
          );
          try {
            await currentPage.goto(newTarget.url, {
              waitUntil: "domcontentloaded"
            });
          } catch (e) {
            console.warn("[Browser] Failed to navigate to new target URL:", e);
          }
        }
      }
    } catch (e) {
      console.warn("[Browser] CDP new page detection failed:", e);
    }
  }

  private async fetchLiveViewUrl(sessionId: string): Promise<string | null> {
    const accountId = this.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = this.env.BROWSER_RENDERING_API_TOKEN;

    if (!accountId || !apiToken) {
      console.error(
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
        console.error(
          `[Live View] Failed to fetch targets: ${response.status} ${await response.text()}`
        );
        return null;
      }

      const targets = (await response.json()) as Array<{
        devtoolsFrontendUrl?: string;
      }>;

      if (!targets.length) {
        console.error("[Live View] No targets returned from API");
        return null;
      }

      const devtoolsUrl = targets[0]?.devtoolsFrontendUrl ?? null;
      if (!devtoolsUrl) {
        console.error("[Live View] No devtoolsFrontendUrl in target response");
      }
      return devtoolsUrl;
    } catch (err) {
      console.error("[Live View] Error fetching live view URL:", err);
      return null;
    }
  }

  private async fetchLiveViewUrlWithRetry(
    sessionId: string
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= LIVE_VIEW_RETRY_ATTEMPTS; attempt++) {
      const url = await this.fetchLiveViewUrl(sessionId);
      if (url) return url;

      console.error(
        `[Live View] Attempt ${attempt}/${LIVE_VIEW_RETRY_ATTEMPTS} failed`
      );

      if (attempt < LIVE_VIEW_RETRY_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, LIVE_VIEW_RETRY_DELAY_MS));
      }
    }
    console.error(
      `[Live View] All ${LIVE_VIEW_RETRY_ATTEMPTS} attempts failed — live view unavailable`
    );
    return null;
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
