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
  ChatCircleDotsIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  GlobeIcon,
  ArrowClockwiseIcon,
  CheckCircleIcon,
  WarningCircleIcon,
  ImageIcon,
  ListIcon
} from "@phosphor-icons/react";
import { type BrowserStatus, isBrowserEvent, isValidBase64 } from "./types";

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
    navigating: { variant: "primary", label: "Navigating..." },
    acting: { variant: "primary", label: "Acting..." },
    extracting: { variant: "primary", label: "Extracting..." },
    done: { variant: "secondary", label: "Done" },
    error: { variant: "destructive", label: "Error" }
  };
  const c = config[status] || config.idle;
  return <Badge variant={c.variant}>{c.label}</Badge>;
}

// ── Tool rendering ────────────────────────────────────────────────────

function ToolPartView({ part }: { part: UIMessage["parts"][number] }) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);

  if (part.state === "output-available") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2 mb-1">
            <GearIcon size={14} className="text-kumo-inactive" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Done</Badge>
          </div>
          <div className="font-mono">
            <Text size="xs" variant="secondary">
              {(() => {
                try {
                  const output =
                    typeof part.output === "string"
                      ? JSON.parse(part.output)
                      : part.output;
                  if (output?.success) {
                    return `Browsed ${output.pageTitle || output.url} (${output.totalSteps} steps)`;
                  }
                  if (output?.error) {
                    return `Error: ${output.error}`;
                  }
                  return JSON.stringify(output, null, 2);
                } catch {
                  return String(part.output).slice(0, 200);
                }
              })()}
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2">
            <GlobeIcon size={14} className="text-kumo-accent animate-pulse" />
            <Text size="xs" variant="secondary">
              Browsing the web...
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
  screenshot,
  actions,
  browserStatus,
  statusMessage,
  error
}: {
  screenshot: string | null;
  actions: Array<{ action: string; step: number }>;
  browserStatus: BrowserStatus | "idle";
  statusMessage: string;
  error: string | null;
}) {
  const actionsEndRef = useRef<HTMLDivElement>(null);
  const [showActions, setShowActions] = useState(true);

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
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            icon={
              showActions ? <ImageIcon size={14} /> : <ListIcon size={14} />
            }
            onClick={() => setShowActions(!showActions)}
            aria-label={showActions ? "Show screenshot" : "Show actions"}
          />
        </div>
      </div>

      {/* Status message */}
      {statusMessage && isActive && (
        <div className="px-4 py-2 border-b border-kumo-line bg-kumo-control">
          <div className="flex items-center gap-2">
            <ArrowClockwiseIcon
              size={12}
              className="text-kumo-accent animate-spin"
            />
            <Text size="xs" variant="secondary">
              {statusMessage}
            </Text>
          </div>
        </div>
      )}

      {/* Error bar */}
      {error && (
        <div className="px-4 py-2 border-b border-kumo-line bg-red-500/10">
          <div className="flex items-center gap-2">
            <WarningCircleIcon size={12} className="text-red-500" />
            <Text size="xs" variant="secondary">
              {error}
            </Text>
          </div>
        </div>
      )}

      {/* Content area */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Screenshot */}
        <div
          className={`flex-1 overflow-auto ${showActions && actions.length > 0 ? "basis-3/5" : ""}`}
        >
          {screenshot ? (
            <img
              src={`data:image/jpeg;base64,${screenshot}`}
              alt="Browser screenshot"
              className="w-full h-auto"
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
              {actions.map((a, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="shrink-0 mt-0.5">
                    <CheckCircleIcon
                      size={12}
                      className="text-kumo-success"
                      weight="fill"
                    />
                  </div>
                  <div className="min-w-0">
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

// ── Main chat ─────────────────────────────────────────────────────────

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Browser state
  const [browserScreenshot, setBrowserScreenshot] = useState<string | null>(
    null
  );
  const [browserActions, setBrowserActions] = useState<
    Array<{ action: string; step: number }>
  >([]);
  const [browserStatus, setBrowserStatus] = useState<BrowserStatus | "idle">(
    "idle"
  );
  const [browserStatusMessage, setBrowserStatusMessage] = useState("");
  const [browserError, setBrowserError] = useState<string | null>(null);

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

        if (raw.type === "browser-screenshot") {
          // Validate base64 payload before injecting into a data URI
          if (isValidBase64(raw.data)) {
            setBrowserScreenshot(raw.data);
          }
        } else if (raw.type === "browser-action") {
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
            setBrowserScreenshot(null);
            setBrowserError(null);
          }
        } else if (raw.type === "browser-error") {
          setBrowserError(raw.error);
        }
      } catch {
        // Not JSON or not our event — ignore
      }
    }, [])
  });

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming" || status === "submitted";

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

  const handleClear = useCallback(() => {
    clearHistory();
    setBrowserScreenshot(null);
    setBrowserActions([]);
    setBrowserStatus("idle");
    setBrowserStatusMessage("");
    setBrowserError(null);
  }, [clearHistory]);

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
              AI Browser
            </h1>
            <Badge variant="secondary">
              <ChatCircleDotsIcon size={12} weight="bold" className="mr-1" />
              Stagehand
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
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={handleClear}
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
            screenshot={browserScreenshot}
            actions={browserActions}
            browserStatus={browserStatus}
            statusMessage={browserStatusMessage}
            error={browserError}
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
