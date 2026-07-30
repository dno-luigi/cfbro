# Agent Browsing

An AI agent that controls a real web browser using the Agents SDK browser tools, running on Cloudflare Workers. Ask it to browse the web, fill forms, extract information, and more — all through a chat interface with a live browser view.

Built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/), [Workers AI](https://developers.cloudflare.com/workers-ai/), and [Browser Run](https://developers.cloudflare.com/browser-rendering/).

## Features

- **CDP-powered browser automation** — The agent writes Chrome DevTools Protocol code to navigate, click, type, scroll, and extract data from any public website
- **Live browser view** — Real-time interactive browser view via Live View
- **Native human-in-the-loop** — Browser Run hands control to the user for CAPTCHAs, login screens, sensitive input, and approvals, then resumes automatically when the user selects Done or Failed
- **Real-time** — WebSocket connection with automatic reconnection and message persistence

## Quick start

```bash
git clone https://github.com/harshil1712/agent-browsing.git
cd agent-browsing
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) and ask the agent to browse the web.

Try these prompts:

- **"Search for iPhone 17 on Amazon"**
- **"Find a hotel in Lisbon"**
- **"Book a table at the Famous Indian Restaurant"**

## Project structure

```
src/
  server.ts      # Chat agent with Agents SDK browser tools
  app.tsx         # Chat UI with browser view panel
  prompt.ts       # System prompt for the agent
  types.ts        # Shared types and validation
  client.tsx      # React entry point
  styles.css      # Tailwind + Kumo styles
```

## How it works

The agent uses Workers AI (`@cf/moonshotai/kimi-k2.5`) to understand your requests and control a headless browser via the Chrome DevTools Protocol:

1. **browser_execute** — Run CDP JavaScript code against a live browser
2. **browser_markdown** — Read a web page as Markdown
3. **browser_extract** — Extract structured data from a page with AI
4. **browser_links** — List all links on a page
5. **browser_scrape** — Scrape specific elements by CSS selector
6. **browser_handoff** — Start a native Browser Run handoff and wait for the user to select Done or Failed

The agent writes CDP code to interact with the browser directly, using a persistent session that survives across chat messages.

## Configuration

No secrets are required. The browser binding and worker loader binding are configured in `wrangler.jsonc`.

## Deploy

```bash
npm run deploy
```

## Tech stack

- [Cloudflare Workers](https://developers.cloudflare.com/workers/) — Serverless execution
- [Workers AI](https://developers.cloudflare.com/workers-ai/) — AI model inference (no API key needed)
- [Browser Run](https://developers.cloudflare.com/browser-rendering/) — Headless browser on the edge
- [Agents SDK](https://developers.cloudflare.com/agents/) — Durable Object-based agent framework with browser tools
- [Kumo](https://developers.cloudflare.com/kumo/) — Cloudflare's design system

## License

MIT
