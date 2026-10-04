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

`morphit-mcp` is installed from source. It is **not** published on the npm
registry or as a container image: a package called `morphit-mcp` on npm, or
`morphit-mcp` on any image registry, is not from this project — do not
install it.

On a Morphit node it is already there: the guided install deploys it as the
`morphit-mcp` service (`sudo morphit-ops mcp` turns it on or off).

### From source

```sh
git clone https://git.agorise.net/agorise/morphit
cd morphit
npm install
npm run build --workspace=apps/mcp-server
node apps/mcp-server/dist/main.js
```

Wire that absolute path into your MCP client config (next
section); the server speaks stdio so the client invokes it
directly. Verify the checkout first (`git verify-tag <tag>`, see
`docs/VERIFY-YOUR-DOWNLOAD.md`) and build from a release tag.

## Configuration

For a local agent (the default `stdio` transport) one variable matters:

| Env var | Default | Purpose |
|---|---|---|
| `MORPHIT_MCP_INSTANCE_URL` | `https://morphit.io` | The Morphit instance the server queries. Switch this to use a different operator's instance (a regional one, your self-hosted one). |
| `MORPHIT_MCP_ALLOW_PRIVATE_INSTANCE` | unset | Set to `1` if that instance's host resolves to a private address (your own LAN instance, a dev setup). Otherwise such a URL is refused, as a guard against the server being pointed at internal addresses. |

No API keys. No credentials. No accounts.

The network transport (`MORPHIT_MCP_TRANSPORT=http`, what the
`morphit-mcp` service on a node runs) has more settings:
`MORPHIT_MCP_HTTP_HOST` / `_HTTP_PORT` (default `127.0.0.1:8124`),
`_ALLOWED_HOSTS`, `_ALLOWED_ORIGINS`, `_RATE_LIMIT_PER_MIN` (120),
`_MAX_BODY_BYTES`, `_MAX_CONNECTIONS` (64) and `_ALLOW_PUBLIC_BIND`.
They are described in `docs/OPERATIONS.md` §45.

## Wiring into your AI agent

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

```json
{
  "mcpServers": {
    "morphit": {
      "command": "node",
      "args": ["/absolute/path/to/morphit/apps/mcp-server/dist/main.js"],
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
      "command": "node",
      "args": ["/absolute/path/to/morphit/apps/mcp-server/dist/main.js"]
    }
  }
}
```

Always use this `node` form with the path to your own verified checkout:
there is no official npm package, so an `npx` form would run whatever
someone else publishes under that name.

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
  residential connection, that's your IP. The server has no built-in
  Tor route; to hide your address, run it on a machine whose traffic
  already goes through Tor or a VPN you trust.
- **Your AI provider sees the prompts you type and the tool results.**
  The MCP server doesn't change that calculus. If you don't want a
  hosted AI provider to see "I want to buy XMR with cash", consider a
  local LLM stack.
- **The Morphit orderbook is public on-chain.** Tool results are
  things anyone can see by visiting morphit.io. No new disclosure
  is created by querying through an AI agent — only the query
  pattern itself.

## License

AGPL-3.0-or-later, same as Morphit itself.

## Bugs + feature requests

[git.agorise.net/agorise/morphit](https://git.agorise.net/agorise/morphit/issues).
Tag with `mcp-server`. Issues there are public: report a security
problem only as described in `SECURITY.md` (a private Matrix message to
`@agorise:matrix.org`), never in an issue.

## Why MCP?

[Model Context Protocol](https://modelcontextprotocol.io) is the
emerging open standard for letting AI agents call external systems.
Published in late 2024 and adopted across commercial and open-source
AI agents through 2025. Shipping `morphit-mcp`
as MCP rather than a proprietary plugin format means every
MCP-compatible agent — present and future, commercial and self-hosted —
can access Morphit without per-agent integration work.

Federation + protocol-first integration. Morphit's whole posture in
one sentence.
