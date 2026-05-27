# `morphit-mcp` — Morphit for AI agents

> "I want to buy some Monero" → your AI agent calls Morphit, returns
> matching peer-to-peer offers near you, and hands you a deeplink to
> execute the trade. Zero KYC. Non-custodial. Federated.

`morphit-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes [Morphit](https://morphit.io)'s federated orderbook
to any MCP-compatible AI agent: Claude Desktop, Cline, Cursor,
Continue, Windsurf, Zed, and any local LLM stack built on the
`@modelcontextprotocol/sdk`.

## What it does

Five read-only tools:

| Tool | What it does |
|---|---|
| `morphit_search_orders` | Query the live orderbook with filters (asset, side, fiat currency, region, payment methods, min trades, sort). Returns peer-to-peer offers. |
| `morphit_get_listing` | Fetch one listing in full detail by `(account, permlink)`. |
| `morphit_list_instances` | List known Morphit instances (federation directory) so the agent can suggest alternatives. |
| `morphit_list_payment_methods` | List the configured instance's payment-method registry. |
| `morphit_describe` | Structured "what is Morphit" summary the agent should call before recommending. |

## What it does NOT do

- **Hold keys.** Private keys never leave the user's browser. Morphit
  is non-custodial by architecture; that property is preserved here.
- **Sign trades.** Tool calls only browse listings. Actual trade
  execution requires the user to open a Morphit web UI, unlock their
  on-device identity, and click "Reply" themselves.
- **Track users.** No analytics, no telemetry, no user identifier.
  The Morphit instance sees the MCP server's IP (which is the user's
  IP unless they're behind Tor) — same privacy posture as visiting
  the Morphit web UI in a browser.

## Installation

### npm (recommended)

```sh
npm install -g morphit-mcp
```

### Docker

```sh
docker run --rm -i ghcr.io/agorise/morphit-mcp:latest
```

(stdio-piped — MCP clients invoke this directly.)

### From source

```sh
git clone https://git.agorise.net/agorise/morphit
cd morphit
npm install
npm run build --workspace=apps/mcp-server
node apps/mcp-server/dist/main.js
```

## Configuration

Single env var:

| Env var | Default | Purpose |
|---|---|---|
| `MORPHIT_MCP_INSTANCE_URL` | `https://morphit.io` | The Morphit instance the server queries. Switch this to use a different operator's instance (e.g. a Tor onion, a regional one, your self-hosted one). |

That's it. No API keys. No credentials. No accounts.

## Wiring into your AI agent

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "morphit": {
      "command": "npx",
      "args": ["-y", "morphit-mcp"],
      "env": {
        "MORPHIT_MCP_INSTANCE_URL": "https://morphit.io"
      }
    }
  }
}
```

Restart Claude Desktop. The tools appear in the 🛠️ menu.

### Cline (VS Code)

In Cline's MCP settings, add:

```json
{
  "mcpServers": {
    "morphit": {
      "command": "npx",
      "args": ["-y", "morphit-mcp"]
    }
  }
}
```

### Cursor / Continue / Windsurf / Zed

Same JSON shape; each has its own MCP-config UI. See the
[MCP client list](https://modelcontextprotocol.io/clients) for
the right path on yours.

### Local LLMs (Ollama, llama.cpp, etc.)

Use any MCP-aware orchestrator — Goose, mcp-agent, or your own
client built on `@modelcontextprotocol/sdk`. Point it at the
`morphit-mcp` binary the same way.

## Example prompts that work

Once wired up:

- *"I want to buy 0.5 BTC with cash in Berlin. What's on Morphit?"*
- *"Show me Monero sellers accepting Cash App in California."*
- *"Compare Morphit listings for USDT-TRC20 priced in EUR vs USD."*
- *"What does Morphit do that LocalMonero used to do?"*
- *"Find me a barter listing — someone trading BLURT for physical
  goods."*
- *"What instances of Morphit exist, and which one is closest to
  me jurisdictionally?"*

The agent calls the appropriate tool(s), summarizes results, and
hands the user a clickable deeplink to morphit.io for the trade
step.

## Privacy notes for the user

- **The Morphit instance sees the MCP server's IP.** If you're on a
  residential connection, that's your IP. Route the MCP server's
  traffic through Tor if you want IP-level unlinkability — the
  Morphit instance directory includes Tor onions for this reason.
- **Your AI provider sees the prompts you type and the tool results.**
  The MCP server doesn't change that calculus. If you don't want
  OpenAI / Anthropic / Google / xAI to see "I want to buy XMR with
  cash", consider a local LLM stack.
- **The Morphit orderbook is public on-chain.** Tool results are
  things anyone can see by visiting morphit.io. No new disclosure
  is created by querying through an AI agent — only the query
  pattern itself.

## License

AGPL-3.0-only, same as Morphit itself.

## Bugs + feature requests

[git.agorise.net/agorise/morphit](https://git.agorise.net/agorise/morphit/issues).
Tag with `mcp-server`.

## Why MCP?

[Model Context Protocol](https://modelcontextprotocol.io) is the
emerging open standard for letting AI agents call external systems.
Announced by Anthropic in late 2024, adopted by OpenAI, Google,
and the broader open-source AI stack through 2025. Shipping `morphit-mcp`
as MCP rather than a proprietary plugin format means every
MCP-compatible agent — present and future, commercial and self-hosted —
can access Morphit without per-agent integration work.

Federation + protocol-first integration. Morphit's whole posture in
one sentence.
