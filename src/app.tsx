import {
  Component,
  Suspense,
  useCallback,
  useState,
  useEffect,
  useRef,
  type ReactNode
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { isToolUIPart, getToolName } from "ai";
import type { UIMessage } from "ai";
import {
  Button,
  Badge,
  InputArea,
  Empty,
  Surface,
  Text
} from "@cloudflare/kumo";
import { Streamdown } from "streamdown";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  GlobeIcon,
  ArrowClockwiseIcon,
  CheckCircleIcon,
  WarningCircleIcon,
  ImageIcon,
  ListIcon,
  BellIcon,
  BellSlashIcon,
  HandPointingIcon
} from "@phosphor-icons/react";
import { type BrowserStatus, isBrowserEvent } from "./types";

// ── Small components ──────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

// ── Status badge ──────────────────────────────────────────────────────

function BrowserStatusBadge({ status }: { status: BrowserStatus | "idle" }) {
  const config: Record<
    string,
    { variant: "primary" | "secondary" | "destructive"; label: string }
  > = {
    idle: { variant: "secondary", label: "Idle" },
    starting: { variant: "primary", label: "Starting..." },
    acting: { variant: "primary", label: "Working..." },
    waiting: { variant: "primary", label: "Your turn" },
    done: { variant: "secondary", label: "Done" },
    error: { variant: "destructive", label: "Error" }
  };
  const c = config[status] || config.idle;
  return <Badge variant={c.variant}>{c.label}</Badge>;
}

// ── Tool rendering ────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  browser_execute: "Browser execute",
  browser_markdown: "Read page",
  browser_extract: "Extract data",
  browser_links: "List links",
  browser_scrape: "Scrape elements",
  browser_handoff: "Human handoff"
};

const TOOL_IN_PROGRESS: Record<string, string> = {
  browser_execute: "Running browser code...",
  browser_markdown: "Reading page...",
  browser_extract: "Extracting data...",
  browser_links: "Listing links...",
  browser_scrape: "Scraping elements...",
  browser_handoff: "Waiting for human action..."
};

function toolOutputSummary(toolName: string, output: unknown): string {
  try {
    const o = typeof output === "string" ? JSON.parse(output) : output;
    if (!o?.success && o?.error) return `Error: ${o.error}`;
    switch (toolName) {
      case "browser_execute":
        return o?.result
          ? (typeof o.result === "string"
              ? o.result
              : JSON.stringify(o.result)
            ).slice(0, 120)
          : "Executed";
      case "browser_markdown":
        return o?.markdown ? `Read ${o.markdown.length} chars` : "Read page";
      case "browser_extract":
        return o?.data ? "Extracted data" : "Extracted";
      case "browser_links":
        return o?.links ? `Found ${o.links.length} links` : "Listed links";
      case "browser_scrape":
        return o?.elements
          ? `Scraped ${o.elements.length} elements`
          : "Scraped";
      case "browser_handoff":
        return o?.success
          ? "Handoff completed"
          : `Handoff failed${o?.reason ? `: ${o.reason}` : ""}`;
      default:
        return o?.success ? "Done" : JSON.stringify(o).slice(0, 120);
    }
  } catch {
    return String(output).slice(0, 120);
  }
}

function ToolPartView({ part }: { part: UIMessage["parts"][number] }) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);
  const label = TOOL_LABELS[toolName] ?? toolName;

  if (part.state === "output-available") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2 mb-1">
            <GearIcon size={14} className="text-kumo-inactive" />
            <Text size="xs" variant="secondary" bold>
              {label}
            </Text>
            <Badge variant="secondary">Done</Badge>
          </div>
          <div className="font-mono break-words">
            <Text size="xs" variant="secondary">
              {toolOutputSummary(toolName, part.output)}
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-amber-500/30 bg-amber-500/5">
          <div className="flex items-center gap-2">
            <HandPointingIcon
              size={14}
              weight="fill"
              className="text-amber-500"
            />
            <Text size="xs" variant="secondary">
              {TOOL_IN_PROGRESS[toolName] ?? "Working..."}
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  return null;
}

// ── Browser View Panel ────────────────────────────────────────────────

function BrowserPanel({
  actions,
  browserStatus,
  statusMessage,
  error,
  liveViewUrl
}: {
  actions: Array<{ action: string; step: number }>;
  browserStatus: BrowserStatus | "idle";
  statusMessage: string;
  error: string | null;
  liveViewUrl: string | null;
}) {
  const actionsEndRef = useRef<HTMLDivElement>(null);
  const [showActions, setShowActions] = useState(true);

  // Detect Chrome browser for Live View warning
  const isChrome =
    typeof navigator !== "undefined" &&
    /Chrome/.test(navigator.userAgent) &&
    !/Edg/.test(navigator.userAgent);

  useEffect(() => {
    actionsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [actions]);

  const isActive = browserStatus !== "idle" && browserStatus !== "done";

  return (
    <div className="flex flex-col h-full">
      {/* Panel Header */}
      <div className="px-4 py-3 border-b border-kumo-line flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <GlobeIcon size={18} className="text-kumo-accent" />
          <Text size="sm" bold>
            Browser View
          </Text>
          <BrowserStatusBadge status={browserStatus} />
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          icon={showActions ? <ImageIcon size={14} /> : <ListIcon size={14} />}
          onClick={() => setShowActions(!showActions)}
          aria-label={showActions ? "Hide actions" : "Show actions"}
        />
      </div>

      {/* Status message */}
      {statusMessage && isActive && (
        <div className="px-4 py-2 border-b border-kumo-line bg-kumo-control">
          <div className="flex items-start gap-2">
            <ArrowClockwiseIcon
              size={12}
              className="text-kumo-accent animate-spin shrink-0 mt-0.5"
            />
            <span className="break-words">
              <Text size="xs" variant="secondary">
                {statusMessage}
              </Text>
            </span>
          </div>
        </div>
      )}

      {/* Error bar */}
      {error && (
        <div className="px-4 py-2 border-b border-kumo-line bg-red-500/10">
          <div className="flex items-start gap-2">
            <WarningCircleIcon
              size={12}
              className="text-red-500 shrink-0 mt-0.5"
            />
            <span className="break-words whitespace-pre-wrap">
              <Text size="xs" variant="secondary">
                {error}
              </Text>
            </span>
          </div>
        </div>
      )}

      {/* Chrome warning banner for Live View */}
      {liveViewUrl && !isChrome && (
        <div className="px-4 py-2 border-b border-kumo-line bg-yellow-500/10">
          <div className="flex items-start gap-2">
            <WarningCircleIcon
              size={12}
              className="text-yellow-500 shrink-0 mt-0.5"
            />
            <span className="break-words">
              <Text size="xs" variant="secondary">
                Live View is optimized for Chrome. Other browsers may have
                limited functionality.
              </Text>
            </span>
          </div>
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <div
          className={`flex-1 overflow-auto ${showActions && actions.length > 0 ? "basis-3/5" : ""}`}
        >
          {liveViewUrl ? (
            <iframe
              src={liveViewUrl}
              className="w-full h-full border-0"
              title="Browser Live View"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-kumo-inactive">
              <div className="text-center space-y-2">
                <GlobeIcon size={48} className="mx-auto opacity-30" />
                <Text size="sm" variant="secondary">
                  No browser activity yet
                </Text>
                <Text size="xs" variant="secondary">
                  Ask me to browse the web and the view will appear here
                </Text>
              </div>
            </div>
          )}
        </div>

        {/* Action log */}
        {showActions && actions.length > 0 && (
          <div className="basis-2/5 border-t border-kumo-line overflow-auto">
            <div className="px-3 py-2 border-b border-kumo-line bg-kumo-control sticky top-0">
              <Text size="xs" bold variant="secondary">
                Action Log ({actions.length} steps)
              </Text>
            </div>
            <div className="px-3 py-2 space-y-1.5">
              {actions.map((a) => (
                <div key={a.step} className="flex items-start gap-2">
                  <div className="shrink-0 mt-0.5">
                    <CheckCircleIcon
                      size={12}
                      className="text-kumo-success"
                      weight="fill"
                    />
                  </div>
                  <div className="min-w-0 break-words">
                    <Text size="xs" variant="secondary">
                      <span className="font-mono text-kumo-inactive mr-1.5">
                        {a.step}.
                      </span>
                      {a.action}
                    </Text>
                  </div>
                </div>
              ))}
              <div ref={actionsEndRef} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Notification Toggle ────────────────────────────────────────────────

function NotificationToggle() {
  const [enabled, setEnabled] = useState(() => {
    return localStorage.getItem("notifications") === "enabled";
  });
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "denied"
  );

  const toggle = useCallback(async () => {
    if (!enabled && permission !== "granted") {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== "granted") return;
    }
    const next = !enabled;
    setEnabled(next);
    localStorage.setItem("notifications", next ? "enabled" : "disabled");
  }, [enabled, permission]);

  const icon =
    enabled && permission === "granted" ? (
      <BellIcon size={16} weight="fill" />
    ) : (
      <BellSlashIcon size={16} />
    );

  return (
    <Button
      variant={enabled ? "primary" : "secondary"}
      shape="square"
      icon={icon}
      onClick={toggle}
      aria-label={
        enabled && permission === "granted"
          ? "Notifications on"
          : "Notifications off"
      }
    />
  );
}

// ── User Action Banner ─────────────────────────────────────────────────

function UserActionBanner({ message }: { message: string }) {
  return (
    <div className="px-5 py-3 bg-amber-500/10 border-t border-amber-500/30">
      <div className="flex items-start gap-3">
        <HandPointingIcon
          size={20}
          weight="fill"
          className="text-amber-500 shrink-0 mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <div className="text-amber-600 dark:text-amber-400">
            <Text size="sm" bold>
              Action needed in browser
            </Text>
          </div>
          <div className="mt-0.5">
            <Text size="sm" variant="secondary">
              {message}
            </Text>
          </div>
          <div className="mt-1">
            <Text size="xs" variant="secondary">
              Complete the action in Browser View, then select Done or Failed.
            </Text>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main chat ─────────────────────────────────────────────────────────

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Browser state
  const [browserActions, setBrowserActions] = useState<
    Array<{ action: string; step: number }>
  >([]);
  const [browserStatus, setBrowserStatus] = useState<BrowserStatus | "idle">(
    "idle"
  );
  const [browserStatusMessage, setBrowserStatusMessage] = useState("");
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [liveViewUrl, setLiveViewUrl] = useState<string | null>(null);
  const [activeHandoff, setActiveHandoff] = useState<{
    handoffId: string;
    instructions: string;
  } | null>(null);

  const agent = useAgent({
    agent: "ChatAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onMessage: useCallback((message: MessageEvent) => {
      try {
        const raw: unknown = JSON.parse(String(message.data));

        // Validate the message is a known BrowserEvent before processing
        if (!isBrowserEvent(raw)) return;

        if (raw.type === "browser-action") {
          setBrowserActions((prev) => [
            ...prev,
            { action: raw.action, step: raw.step }
          ]);
        } else if (raw.type === "browser-status") {
          setBrowserStatus(raw.status);
          if (raw.message) {
            setBrowserStatusMessage(raw.message);
          }
          // Clear actions on new task start
          if (raw.status === "starting") {
            setBrowserActions([]);
            setBrowserError(null);
            setLiveViewUrl(null);
            setActiveHandoff(null);
          }
        } else if (raw.type === "browser-error") {
          setBrowserError(raw.error);
        } else if (raw.type === "browser-liveview-url") {
          setLiveViewUrl(raw.url);
        } else if (raw.type === "browser-handoff-started") {
          setLiveViewUrl(raw.url);
          setActiveHandoff({
            handoffId: raw.handoffId,
            instructions: raw.instructions
          });
          const notificationsEnabled =
            localStorage.getItem("notifications") === "enabled";
          if (
            notificationsEnabled &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            const notification = new Notification("Agent needs your help", {
              body: raw.instructions
            });
            notification.onclick = () => {
              window.focus();
              notification.close();
            };
          }
        } else if (raw.type === "browser-handoff-complete") {
          setActiveHandoff(null);
          if (!raw.success) {
            setBrowserError(raw.reason ?? "The browser handoff failed.");
          }
        }
      } catch {
        // Not JSON or not our event — ignore
      }
    }, [])
  });

  const { messages, sendMessage, clearHistory, stop, isStreaming } =
    useAgentChat({ agent, throttle: 50 });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [input, isStreaming, sendMessage]);

  const handleClear = useCallback(async () => {
    clearHistory();
    setBrowserActions([]);
    setBrowserStatus("idle");
    setBrowserStatusMessage("");
    setBrowserError(null);
    setLiveViewUrl(null);
    setActiveHandoff(null);
    try {
      await agent.call("closeBrowserSession");
    } catch {
      // best-effort — session may not exist
    }
  }, [clearHistory, agent]);

  return (
    <div className="flex flex-col h-screen bg-kumo-elevated">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              <span className="mr-2">
                <GlobeIcon size={22} className="inline-block" weight="bold" />
              </span>
              Agent Browsing
            </h1>
            <Badge variant="secondary">
              <GlobeIcon size={12} weight="bold" className="mr-1" />
              Live View
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </div>
            <ThemeToggle />
            <NotificationToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={handleClear}
              disabled={isStreaming}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      {/* Main content: Chat + Browser View */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Chat */}
        <div className="flex flex-col w-1/2 border-r border-kumo-line">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto">
            <div className="px-5 py-6 space-y-5">
              {messages.length === 0 && (
                <Empty
                  icon={<GlobeIcon size={32} />}
                  title="What should I browse?"
                  contents={
                    <div className="flex flex-wrap justify-center gap-2">
                      {[
                        "Search for iPhone 16 on Amazon",
                        "Find top stories on Hacker News",
                        "Look up the weather in San Francisco",
                        "Search for React tutorials on Google"
                      ].map((prompt) => (
                        <Button
                          key={prompt}
                          variant="outline"
                          size="sm"
                          disabled={isStreaming}
                          onClick={() => {
                            sendMessage({
                              role: "user",
                              parts: [{ type: "text", text: prompt }]
                            });
                          }}
                        >
                          {prompt}
                        </Button>
                      ))}
                    </div>
                  }
                />
              )}

              {messages.map((message: UIMessage, index: number) => {
                const isUser = message.role === "user";
                const isLastAssistant =
                  message.role === "assistant" && index === messages.length - 1;

                return (
                  <div key={message.id} className="space-y-2">
                    {/* Tool parts */}
                    {message.parts.filter(isToolUIPart).map((part) => (
                      <ToolPartView key={part.toolCallId} part={part} />
                    ))}

                    {/* Text parts */}
                    {message.parts
                      .filter((part) => part.type === "text")
                      .map((part, i) => {
                        const text = (part as { type: "text"; text: string })
                          .text;
                        if (!text) return null;

                        if (isUser) {
                          return (
                            <div key={i} className="flex justify-end">
                              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                                {text}
                              </div>
                            </div>
                          );
                        }

                        return (
                          <div key={i} className="flex justify-start">
                            <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                              <Streamdown
                                className="sd-theme rounded-2xl rounded-bl-md p-3"
                                controls={false}
                                isAnimating={isLastAssistant && isStreaming}
                              >
                                {text}
                              </Streamdown>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                );
              })}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Input */}
          <div className="border-t border-kumo-line bg-kumo-base shrink-0">
            {activeHandoff && (
              <UserActionBanner message={activeHandoff.instructions} />
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
              className="px-5 py-4"
            >
              <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
                <InputArea
                  ref={textareaRef}
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${el.scrollHeight}px`;
                  }}
                  placeholder="Tell me what to browse..."
                  disabled={!connected || isStreaming}
                  rows={1}
                  className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
                />
                {isStreaming ? (
                  <Button
                    type="button"
                    variant="secondary"
                    shape="square"
                    aria-label="Stop generation"
                    icon={<StopIcon size={18} />}
                    onClick={stop}
                    className="mb-0.5"
                  />
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    aria-label="Send message"
                    disabled={!input.trim() || !connected}
                    icon={<PaperPlaneRightIcon size={18} />}
                    className="mb-0.5"
                  />
                )}
              </div>
            </form>
          </div>
        </div>

        {/* Right: Browser View */}
        <div className="w-1/2 bg-kumo-base">
          <BrowserPanel
            actions={browserActions}
            browserStatus={browserStatus}
            statusMessage={browserStatusMessage}
            error={browserError}
            liveViewUrl={liveViewUrl}
          />
        </div>
      </div>
    </div>
  );
}

// ── Error Boundary ────────────────────────────────────────────────────
// Prevents the entire app from white-screening on unexpected runtime errors.

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center h-screen">
          <div className="text-center space-y-3 max-w-md px-6">
            <WarningCircleIcon size={48} className="mx-auto text-kumo-danger" />
            <Text size="lg" bold>
              Something went wrong
            </Text>
            <Text size="sm" variant="secondary">
              {this.state.error.message}
            </Text>
            <Button
              variant="secondary"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </ErrorBoundary>
  );
}
