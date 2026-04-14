# AI Browser Use

An AI agent that controls a real web browser using Playwright, running on Cloudflare Workers. Ask it to browse the web, fill forms, extract information, and more — all through a chat interface with a live browser view.

Built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/), [Workers AI](https://developers.cloudflare.com/workers-ai/), and [@cloudflare/playwright](https://developers.cloudflare.com/browser-rendering/).

## Features

- **Browser automation** — Navigate, click, type, scroll, and extract text from any public website
- **Live browser view** — Real-time screencast of the browser alongside the chat
- **Interactive Live View** — Full Chrome DevTools access for inspecting DOM, debugging JS, and monitoring network requests
- **Human-in-the-loop** — The agent asks for help when it encounters CAPTCHAs, login screens, or unexpected issues
- **SSRF protection** — Internal and reserved IP addresses are blocked to prevent server-side request forgery
- **Real-time** — WebSocket connection with automatic reconnection and message persistence

## Quick start

```bash
git clone https://github.com/harshil/ai-browser-use.git
cd ai-browser-use
npm install
cp .env.example .env
# Edit .env with your Cloudflare credentials
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) and ask the agent to browse the web.

Try these prompts:

- **"Search for iPhone 16 on Amazon"**
- **"Find top stories on Hacker News"**
- **"Look up the weather in San Francisco"**

## Project structure

```
src/
  server.ts      # Chat agent with Playwright browser tools
  app.tsx        # Chat UI with browser view panel
  screencast.ts  # CDP screencast for real-time browser streaming
  types.ts       # Shared types, SSRF protection, validation
  client.tsx     # React entry point
  styles.css     # Tailwind + Kumo styles
```

## How it works

The agent uses Workers AI (`@cf/moonshotai/kimi-k2.5`) to understand your requests and control a headless browser via Playwright tools:

1. **navigate** — Go to a URL
2. **page_snapshot** — Get a list of interactive elements with ref IDs
3. **click** — Click an element by its ref number
4. **fill** — Type text into an input field
5. **press** — Press keyboard keys (Enter, Tab, Escape, etc.)
6. **scroll** — Scroll the page up or down
7. **extract_text** — Read visible text content from the page
8. **ask_user** — Ask for help when stuck (CAPTCHAs, logins, etc.)

The agent follows an observe-act loop: it takes a page snapshot to "see" the page, then interacts with elements by their ref IDs, and takes another snapshot to verify the result.

## Configuration

### Required secrets

Set these in your `.env` file for local development, or via `wrangler secret put` for production:

| Variable                      | Description                                           |
| ----------------------------- | ----------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`       | Your Cloudflare Account ID (found in the dashboard)   |
| `BROWSER_RENDERING_API_TOKEN` | API token with "Browser Rendering - Edit" permissions |

The Live View feature requires both secrets. Without them, the app still works with the screencast-only view.

### Create the API token

1. Go to [API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click "Create Token"
3. Use the "Custom token" template
4. Grant **Browser Rendering - Edit** permission
5. Copy the token into your `.env` file

## Deploy

```bash
npm run deploy
```

Then set the secrets on your deployed Worker:

```bash
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put BROWSER_RENDERING_API_TOKEN
```

## Tech stack

- [Cloudflare Workers](https://developers.cloudflare.com/workers/) — Serverless execution
- [Workers AI](https://developers.cloudflare.com/workers-ai/) — AI model inference (no API key needed)
- [Browser Rendering](https://developers.cloudflare.com/browser-rendering/) — Headless browser on the edge
- [@cloudflare/playwright](https://developers.cloudflare.com/browser-rendering/) — Playwright bindings for Workers
- [Agents SDK](https://developers.cloudflare.com/agents/) — Durable Object-based agent framework
- [Kumo](https://developers.cloudflare.com/kumo/) — Cloudflare's design system

## License

MIT
