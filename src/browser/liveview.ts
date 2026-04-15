import {
  LIVE_VIEW_RETRY_ATTEMPTS,
  LIVE_VIEW_RETRY_DELAY_MS
} from "./constants";

export async function fetchLiveViewUrl(
  env: Env,
  sessionId: string
): Promise<string | null> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.BROWSER_RENDERING_API_TOKEN;

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
      return null;
    }
    const liveUrl = new URL(devtoolsUrl);
    liveUrl.searchParams.set("mode", "tab");
    return liveUrl.toString();
  } catch (err) {
    console.error("[Live View] Error fetching live view URL:", err);
    return null;
  }
}

export async function fetchLiveViewUrlWithRetry(
  env: Env,
  sessionId: string
): Promise<string | null> {
  for (let attempt = 1; attempt <= LIVE_VIEW_RETRY_ATTEMPTS; attempt++) {
    const url = await fetchLiveViewUrl(env, sessionId);
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
