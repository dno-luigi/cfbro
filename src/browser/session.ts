import {
  launch,
  sessions,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
  type WorkersLaunchOptions
} from "@cloudflare/playwright";

import { startScreencast } from "../screencast";
import type { BrowserEvent } from "../types";
import { KEEP_ALIVE_MS } from "./constants";
import { fetchLiveViewUrlWithRetry } from "./liveview";

export interface BrowserState {
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  stopScreencast: (() => Promise<void>) | null;
  switchingPage: Promise<void> | null;
  knownTargetIds: Set<string>;
  sessionReady: Promise<Page> | null;
  snapshotCdp: CDPSession | null;
}

export function createBrowserState(): BrowserState {
  return {
    browser: null,
    context: null,
    page: null,
    stopScreencast: null,
    switchingPage: null,
    knownTargetIds: new Set(),
    sessionReady: null,
    snapshotCdp: null
  };
}

export async function getSnapshotCdp(state: BrowserState): Promise<CDPSession> {
  if (state.snapshotCdp) {
    return state.snapshotCdp;
  }
  state.snapshotCdp = await state.page!.context().newCDPSession(state.page!);
  return state.snapshotCdp;
}

export function invalidateSnapshotCdp(state: BrowserState): void {
  state.snapshotCdp = null;
}

export async function ensureBrowserSession(
  state: BrowserState,
  env: Env,
  broadcastEvent: (event: BrowserEvent) => void
): Promise<Page> {
  if (state.page && !state.page.isClosed()) {
    return state.page;
  }

  if (state.sessionReady) {
    return state.sessionReady;
  }

  state.sessionReady = createBrowserSession(state, env, broadcastEvent);
  try {
    return await state.sessionReady;
  } finally {
    state.sessionReady = null;
  }
}

export async function closeBrowserSession(state: BrowserState): Promise<void> {
  if (state.stopScreencast) {
    try {
      await state.stopScreencast();
    } catch {
      // best-effort
    }
    state.stopScreencast = null;
  }
  if (state.browser) {
    try {
      await state.browser.close();
    } catch {
      // best-effort
    }
  }
  state.browser = null;
  state.context = null;
  state.page = null;
  state.snapshotCdp = null;
  state.knownTargetIds.clear();
}

export async function detectAndSwitchToNewPage(
  state: BrowserState,
  currentPage: Page,
  knownPageCount: number,
  broadcastEvent: (event: BrowserEvent) => void
): Promise<void> {
  const pagesAfter = state.context?.pages() ?? [];
  const newPages = pagesAfter.filter((p) => p !== currentPage && !p.isClosed());
  if (newPages.length > 0) {
    const latest = newPages[newPages.length - 1];
    console.log(
      `[Browser] New page detected via context.pages(): ${latest.url()}`
    );
    await switchToPage(state, latest, broadcastEvent);
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
      .filter((t) => !state.knownTargetIds.has(t.targetId))
      .map((t) => t.targetId);

    state.knownTargetIds = new Set(pageTargets.map((t) => t.targetId));

    if (newTargetIds.length === 0 && pageTargets.length > knownPageCount) {
      const newestTarget = pageTargets[pageTargets.length - 1];
      const matchingPage = pagesAfter.find(
        (p) => !p.isClosed() && p.url() === newestTarget.url
      );
      if (matchingPage) {
        console.log(
          `[Browser] New page detected via CDP URL match: ${matchingPage.url()}`
        );
        await switchToPage(state, matchingPage, broadcastEvent);
        return;
      }
    }

    if (newTargetIds.length > 0) {
      console.log(
        `[Browser] New CDP target(s) detected: ${newTargetIds.join(", ")}`
      );
      try {
        const newPage = await state
          .context!.waitForEvent("page", {
            timeout: 2000
          })
          .catch(() => null);
        if (newPage && !newPage.isClosed()) {
          await switchToPage(state, newPage, broadcastEvent);
          return;
        }
      } catch {
        // waitForEvent not available or timed out
      }

      const newTarget = pageTargets.find((t) =>
        newTargetIds.includes(t.targetId)
      );
      if (newTarget) {
        const allPages = state.context?.pages() ?? [];
        const match = allPages.find(
          (p) => !p.isClosed() && p.url() === newTarget.url
        );
        if (match) {
          await switchToPage(state, match, broadcastEvent);
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

async function createBrowserSession(
  state: BrowserState,
  env: Env,
  broadcastEvent: (event: BrowserEvent) => void
): Promise<Page> {
  console.log("[Browser] Creating new browser session");
  broadcastEvent({
    type: "browser-status",
    status: "starting",
    message: "Launching browser..."
  });

  try {
    const { browser, context, page } = await createBrowser(env, {
      keepAlive: KEEP_ALIVE_MS
    });
    state.browser = browser;
    state.context = context;
    state.page = page;

    context.on("page", (newPage) => {
      switchToPage(state, newPage, broadcastEvent);
    });
  } catch (err) {
    console.error("[Browser] Failed to launch browser:", err);
    state.browser = null;
    state.context = null;
    state.page = null;
    throw err;
  }

  state.stopScreencast = await startScreencast(state.page, (base64) => {
    broadcastEvent({ type: "browser-screenshot", data: base64 });
  });

  try {
    const cdp = await state.context!.newCDPSession(state.page!);
    const { targetInfos } = await cdp.send("Target.getTargets");
    await cdp.detach();
    state.knownTargetIds = new Set(
      targetInfos.filter((t) => t.type === "page").map((t) => t.targetId)
    );
  } catch {
    state.knownTargetIds = new Set();
  }

  const sessionId = await resolveSessionId(env.BROWSER);

  if (sessionId) {
    const liveViewUrl = await fetchLiveViewUrlWithRetry(env, sessionId);
    if (liveViewUrl) {
      broadcastEvent({ type: "browser-liveview-url", url: liveViewUrl });
    }
  }

  console.log("[Browser] Session ready");
  return state.page;
}

async function switchToPage(
  state: BrowserState,
  newPage: Page,
  broadcastEvent: (event: BrowserEvent) => void
): Promise<void> {
  if (newPage === state.page || newPage.isClosed()) return;

  if (state.switchingPage) {
    await state.switchingPage;
    if (newPage === state.page) return;
  }

  const switchPromise = doSwitchToPage(state, newPage, broadcastEvent);
  state.switchingPage = switchPromise;
  try {
    await switchPromise;
  } finally {
    if (state.switchingPage === switchPromise) {
      state.switchingPage = null;
    }
  }
}

async function doSwitchToPage(
  state: BrowserState,
  newPage: Page,
  broadcastEvent: (event: BrowserEvent) => void
): Promise<void> {
  if (newPage.isClosed()) return;

  console.log(`[Browser] Switching to new page: ${newPage.url()}`);

  state.snapshotCdp = null;

  if (state.stopScreencast) {
    try {
      await state.stopScreencast();
    } catch {
      // best-effort
    }
    state.stopScreencast = null;
  }

  state.page = newPage;

  try {
    await newPage
      .waitForLoadState("domcontentloaded", { timeout: 5000 })
      .catch(() => {});
  } catch {
    // best-effort — page may already be loaded
  }

  try {
    state.stopScreencast = await startScreencast(state.page, (base64) => {
      broadcastEvent({ type: "browser-screenshot", data: base64 });
    });
  } catch (e) {
    console.error(
      "[Browser] Screencast failed on new page, retrying after delay:",
      e
    );
    await new Promise((r) => setTimeout(r, 1000));
    try {
      state.stopScreencast = await startScreencast(state.page, (base64) => {
        broadcastEvent({ type: "browser-screenshot", data: base64 });
      });
    } catch (e2) {
      console.error("[Browser] Screencast retry also failed:", e2);
    }
  }

  const title = await newPage.title().catch(() => "");
  console.log(`[Browser] Switched to page: "${title}" ${newPage.url()}`);
  broadcastEvent({
    type: "browser-status",
    status: "navigating",
    message: `Switched to new tab: ${title || newPage.url()}`
  });

  newPage.on("close", () => {
    if (state.page === newPage) {
      const pages = state.context?.pages().filter((p) => !p.isClosed()) ?? [];
      const fallback = pages.find((p) => p !== newPage);
      if (fallback) {
        switchToPage(state, fallback, broadcastEvent);
      } else {
        state.page = null;
        state.stopScreencast = null;
      }
    }
  });
}
