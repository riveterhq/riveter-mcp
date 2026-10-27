# Riveter MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects AI assistants like Claude and Cursor to the [Riveter API](https://riveterhq.com). Run enrichments, build datasets, scrape webpages, manage monitors, and more — directly from your assistant.

Tools are generated dynamically from Riveter's [OpenAPI spec](https://docs.riveterhq.com/openapi.yaml), so they stay up to date automatically.

Two ways to connect:

- **Hosted** — `https://mcp.riveterhq.com/mcp`. Nothing to install. Works from claude.ai, Claude Desktop, Cowork, Claude mobile, ChatGPT, Claude Code, and Cursor.
- **Local (`npx`)** — this npm package, run on your machine over stdio. Use it when your client cannot reach remote servers.

## Setup

### 1a. Hosted server (no API key needed up front)

Add `https://mcp.riveterhq.com/mcp` as a custom connector and click Connect. A browser window opens on Riveter: sign in and click **Allow**. Riveter creates an API key for that connection; it is listed in [Settings → API keys](https://app.riveterhq.com/settings/api), and revoking it disconnects the client.

**Claude Code:**

```bash
claude mcp add --transport http riveter https://mcp.riveterhq.com/mcp
```

Then run `/mcp` and choose Authenticate.

**Cursor:**

```json
{
  "mcpServers": {
    "riveter": {
      "url": "https://mcp.riveterhq.com/mcp"
    }
  }
}
```

If the client cannot open a browser, pass a key as a header instead: `Authorization: Bearer sk_riv_your_key_here` (Claude Code `--header "Authorization: Bearer sk_riv_..."`, Cursor `"headers": { "Authorization": "Bearer sk_riv_..." }`).

### 1b. Local server (npx)

Get a Riveter API key at [app.riveterhq.com/settings/api](https://app.riveterhq.com/settings/api).

**Claude Desktop** — open the config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the Riveter server:

```json
{
  "mcpServers": {
    "riveter": {
      "command": "npx",
      "args": ["-y", "--prefer-online", "riveter-mcp-server@latest"],
      "env": {
        "RIVETER_API_KEY": "sk_riv_your_key_here"
      }
    }
  }
}
```

**Cursor / Windsurf** — add the same `riveter` entry to your MCP config (e.g. `~/.cursor/mcp.json`).

**Claude Code:**

```bash
claude mcp add riveter --env RIVETER_API_KEY=sk_riv_your_key_here -- npx -y riveter-mcp-server
```

**Codex:**

```bash
codex mcp add riveter --env RIVETER_API_KEY=sk_riv_your_key_here -- npx -y riveter-mcp-server
```

**Keeping the tools current:** the local server loads the API definition once, when your client starts it, and keeps that process running. After Riveter ships an API change, restart your AI client (or the MCP server from its settings page) to load the new tools. `--prefer-online riveter-mcp-server@latest` makes the same restart also pick up new server versions. The hosted server needs no restart; it reloads the API definition every 10 minutes.

## Environment variables

Local (stdio) server — `dist/index.js`:

| Variable               | Required | Default                                   | Description          |
| ---------------------- | -------- | ----------------------------------------- | -------------------- |
| `RIVETER_API_KEY`      | Yes      | —                                         | Your Riveter API key |
| `RIVETER_API_BASE_URL` | No       | `https://api.riveterhq.com/v1`            | API base URL         |
| `RIVETER_OPENAPI_URL`  | No       | `https://docs.riveterhq.com/openapi.yaml` | OpenAPI spec URL. `https://docs.riveterhq.com/openapi.legacy.yaml` serves the legacy generation instead (verb endpoints, legacy enrichments, the retired list-build operations) |

Hosted (Streamable HTTP) server — `dist/http.js`, deployed by Riveter:

| Variable                   | Default                            | Description                                                          |
| -------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `PORT`                     | `8080`                             | Listen port                                                          |
| `MCP_PUBLIC_URL`           | `https://mcp.riveterhq.com/mcp`    | Public URL, exactly as users enter it (RFC 9728 `resource`)          |
| `OAUTH_ISSUER_URL`         | `https://app.riveterhq.com`        | Authorization server advertised in the protected resource metadata   |
| `SPEC_REFRESH_INTERVAL_MS` | `600000`                           | How often the spec is re-fetched; `0` disables                        |
| `RIVETER_API_BASE_URL`, `RIVETER_OPENAPI_URL` | as above        |                                                                      |

The hosted server holds no API key. It forwards the caller's `Authorization: Bearer ...` header to the API on every call and answers `401` with a `WWW-Authenticate` challenge when the header is missing.

## How it works

On startup, the server:

1. Fetches the OpenAPI spec from `docs.riveterhq.com/openapi.yaml`
2. Parses each endpoint into an MCP tool with typed parameters and annotations (`readOnlyHint` from `GET`, `destructiveHint` from `DELETE` or the spec's `x-mcp-destructive`, `openWorldHint` from the spec's `x-mcp-open-world`)
3. Uses the spec's `info.x-mcp-instructions` as the short server-level `instructions` (the long API overview stays on the docs site); an operation's `x-mcp-description` replaces its `description` for the tool when set
4. Adds one `help` tool whose topics (column config, formats, tools, `run_when`, examples, credits, limits, errors, ...) come from the spec's `info.x-mcp-help` — long guidance is loaded only when the assistant asks for it
5. Serves the tools over stdio (local) or Streamable HTTP (hosted)

When the API docs are updated, the local server picks up the changes the next time your assistant launches, and the hosted server re-fetches the spec every 10 minutes — no rebuild or republish needed.

## Development

Source: [github.com/riveterhq/riveter-mcp](https://github.com/riveterhq/riveter-mcp). Issues welcome there.

```bash
npm install
npm test          # build + unit + stdio e2e + http e2e
npm run dev:http  # hosted server on :8080 (set MCP_PUBLIC_URL=http://localhost:8080/mcp)
```

This repository is a read-only mirror of the `mcp-server/` directory of Riveter's private monorepo, where development happens. The spec-contract tests need the monorepo's `openapi.yaml`, so they skip here. Releases are described in [`PUBLISHING.md`](PUBLISHING.md).

## Support

Questions or issues? See the [Riveter API docs](https://docs.riveterhq.com) or contact [support@riveterhq.com](mailto:support@riveterhq.com).

## License

MIT
