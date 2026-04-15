import { tool } from "ai";
import { z } from "zod";
import type { Page, CDPSession } from "@cloudflare/playwright";

import { type AriaRole, type BrowserEvent, isAllowedUrl } from "../types";
import { getPageSnapshot } from "../browser/snapshot";

export interface ToolDeps {
  getPage: () => Promise<Page>;
  getCurrentPageUrl: () => string | undefined;
  broadcastEvent: (event: BrowserEvent) => void;
  getSnapshotCdp: () => Promise<CDPSession>;
  invalidateSnapshotCdp: () => void;
  detectAndSwitchToNewPage: (
    currentPage: Page,
    knownPageCount: number
  ) => Promise<void>;
}

export function createTools(deps: ToolDeps) {
  let stepCounter = 1;

  const {
    getPage,
    getCurrentPageUrl,
    broadcastEvent,
    getSnapshotCdp,
    invalidateSnapshotCdp,
    detectAndSwitchToNewPage
  } = deps;

  return {
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
          const page = await getPage();
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
          const page = await getPage();
          broadcastEvent({
            type: "browser-status",
            status: "acting",
            message: "Reading page..."
          });
          const cdp = await getSnapshotCdp();
          const snapshot = await getPageSnapshot(page, cdp);
          broadcastEvent({
            type: "browser-action",
            action: "Captured page snapshot",
            step: stepCounter++
          });
          return { success: true, url: page.url(), snapshot };
        } catch (err) {
          invalidateSnapshotCdp();
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
          const page = await getPage();
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
          await page.waitForLoadState("domcontentloaded").catch(() => {});

          await detectAndSwitchToNewPage(page, pageTargetsBefore.length);

          broadcastEvent({
            type: "browser-action",
            action: `Clicked ${role} "${name}"`,
            step: stepCounter++
          });
          return {
            success: true,
            action: `Clicked ${role} "${name}"`,
            url: getCurrentPageUrl() ?? page.url()
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
          const page = await getPage();
          broadcastEvent({
            type: "browser-status",
            status: "acting",
            message: `Filling ${role} "${name}"`
          });
          await page
            .getByRole(role as AriaRole, { name, exact: false })
            .fill(value);
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
          const page = await getPage();
          await page.keyboard.press(key);
          await page.waitForLoadState("domcontentloaded").catch(() => {});
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
          const page = await getPage();
          const delta = direction === "down" ? amount : -amount;
          await page.mouse.wheel(0, delta * 720);
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
          .describe("Accessible name of the select element from page_snapshot"),
        value: z.string().describe("The value or label of the option to select")
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
          const page = await getPage();
          broadcastEvent({
            type: "browser-status",
            status: "acting",
            message: `Selecting "${value}" in ${role} "${name}"`
          });
          await page
            .getByRole(role as AriaRole, { name, exact: false })
            .selectOption(value);
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
        role: z.string().describe("ARIA role, typically 'checkbox' or 'radio'"),
        name: z.string().describe("Accessible name from page_snapshot")
      }),
      execute: async ({ role, name }: { role: string; name: string }) => {
        try {
          const page = await getPage();
          broadcastEvent({
            type: "browser-status",
            status: "acting",
            message: `Checking ${role} "${name}"`
          });
          await page
            .getByRole(role as AriaRole, { name, exact: false })
            .check();
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
          const page = await getPage();
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
    }),

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
  };
}
