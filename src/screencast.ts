import type { Page } from "@cloudflare/playwright";

// ~4 frames per second
const THROTTLE_MS = 250;

/**
 * Start a CDP screencast that streams JPEG frames from the browser.
 * Uses Chrome DevTools Protocol's Page.startScreencast for real-time
 * browser view streaming (much faster than manual page.screenshot() calls).
 *
 * Returns a cleanup function that stops the screencast and detaches the
 * CDP session. Call it before closing the browser.
 *
 * Based on the official Cloudflare Stagehand example:
 * https://github.com/cloudflare/playwright/blob/main/packages/playwright-cloudflare/examples/stagehand/src/worker/screencast.ts
 */
export async function startScreencast(
  page: Page,
  onFrame: (base64: string) => void
): Promise<() => Promise<void>> {
  try {
    const cdpSession = await page.context().newCDPSession(page);
    let lastSent = 0;

    cdpSession.on("Page.screencastFrame", async (frame) => {
      const now = Date.now();
      if (now - lastSent >= THROTTLE_MS) {
        onFrame(frame.data);
        lastSent = now;
      }
      await cdpSession.send("Page.screencastFrameAck", {
        sessionId: frame.sessionId
      });
    });

    const viewport = page.viewportSize();
    await cdpSession.send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      maxWidth: viewport?.width ?? 1280,
      maxHeight: viewport?.height ?? 720
    });

    // Return cleanup function to stop the screencast gracefully
    return async () => {
      try {
        await cdpSession.send("Page.stopScreencast");
        await cdpSession.detach();
      } catch {
        // best-effort — session may already be closed
      }
    };
  } catch (e) {
    // Screencast is best-effort — don't crash if it fails
    console.warn("Failed to start screencast:", e);

    // Return a no-op cleanup since there's nothing to clean up
    return async () => {};
  }
}
