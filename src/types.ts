// ── Shared types for browser events ─────────────────────────────────
// Used by both server (broadcast) and client (receive) over WebSocket.

export type AriaRole =
  | "alert"
  | "alertdialog"
  | "application"
  | "article"
  | "banner"
  | "blockquote"
  | "button"
  | "caption"
  | "cell"
  | "checkbox"
  | "code"
  | "columnheader"
  | "combobox"
  | "complementary"
  | "contentinfo"
  | "definition"
  | "deletion"
  | "dialog"
  | "directory"
  | "document"
  | "emphasis"
  | "feed"
  | "figure"
  | "form"
  | "generic"
  | "grid"
  | "gridcell"
  | "group"
  | "heading"
  | "img"
  | "insertion"
  | "link"
  | "list"
  | "listbox"
  | "listitem"
  | "log"
  | "main"
  | "marquee"
  | "math"
  | "menu"
  | "menubar"
  | "menuitem"
  | "menuitemcheckbox"
  | "menuitemradio"
  | "meter"
  | "navigation"
  | "none"
  | "note"
  | "option"
  | "paragraph"
  | "presentation"
  | "progressbar"
  | "radio"
  | "radiogroup"
  | "region"
  | "row"
  | "rowgroup"
  | "rowheader"
  | "scrollbar"
  | "search"
  | "searchbox"
  | "separator"
  | "slider"
  | "spinbutton"
  | "status"
  | "strong"
  | "subscript"
  | "superscript"
  | "switch"
  | "tab"
  | "table"
  | "tablist"
  | "tabpanel"
  | "term"
  | "textbox"
  | "time"
  | "timer"
  | "toolbar"
  | "tooltip"
  | "tree"
  | "treegrid"
  | "treeitem";

export type BrowserStatus =
  | "starting"
  | "navigating"
  | "acting"
  | "extracting"
  | "done"
  | "error";

export type BrowserEvent =
  | {
      type: "browser-screenshot";
      data: string; // base64 JPEG from CDP screencast
    }
  | {
      type: "browser-action";
      action: string;
      step: number;
    }
  | {
      type: "browser-status";
      status: BrowserStatus;
      message?: string;
    }
  | { type: "browser-error"; error: string }
  | { type: "browser-liveview-url"; url: string };

// ── Runtime validation ──────────────────────────────────────────────
// Validates that an unknown value from the WebSocket is a BrowserEvent.

const BROWSER_EVENT_TYPES = new Set([
  "browser-screenshot",
  "browser-action",
  "browser-status",
  "browser-error",
  "browser-liveview-url"
]);

export function isBrowserEvent(value: unknown): value is BrowserEvent {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.type === "string" && BROWSER_EVENT_TYPES.has(obj.type);
}

// ── URL validation helpers ──────────────────────────────────────────
// Prevents SSRF by blocking internal/reserved IP ranges and non-HTTP schemes.

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/, // AWS metadata endpoint range
  /^0\.0\.0\.0$/,
  /^\[::1?\]$/ // IPv6 loopback
];

export function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Only allow HTTP and HTTPS
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    // Block internal/reserved hostnames
    const hostname = parsed.hostname;
    for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
      if (pattern.test(hostname)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

// ── Base64 validation ───────────────────────────────────────────────

const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

export function isValidBase64(value: string): boolean {
  return value.length > 0 && BASE64_RE.test(value);
}
