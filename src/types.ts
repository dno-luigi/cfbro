// ── Shared types for browser events ─────────────────────────────────
// Used by both server (broadcast) and client (receive) over WebSocket.

export type BrowserStatus =
  | "starting"
  | "acting"
  | "waiting"
  | "done"
  | "error";

export type BrowserEvent =
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
  | { type: "browser-liveview-url"; url: string }
  | {
      type: "browser-handoff-started";
      handoffId: string;
      instructions: string;
      timeoutMs: number;
      url: string;
    }
  | {
      type: "browser-handoff-complete";
      handoffId: string;
      success: boolean;
      reason?: string;
    };

// ── Runtime validation ──────────────────────────────────────────────
// Validates that an unknown value from the WebSocket is a BrowserEvent.

const BROWSER_EVENT_TYPES = new Set([
  "browser-action",
  "browser-status",
  "browser-error",
  "browser-liveview-url",
  "browser-handoff-started",
  "browser-handoff-complete"
]);

export function isBrowserEvent(value: unknown): value is BrowserEvent {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.type === "string" && BROWSER_EVENT_TYPES.has(obj.type);
}
