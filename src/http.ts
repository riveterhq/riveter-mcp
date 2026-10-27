#!/usr/bin/env node

// Hosted entrypoint (mcp.riveterhq.com). Same tools as the stdio server, served
// over Streamable HTTP so cloud MCP clients (claude.ai, Cowork, ChatGPT) can
// reach it. Stateless: every request builds a throwaway McpServer bound to the
// caller's bearer token, which is forwarded verbatim to the Riveter API.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import type { ParseResult } from "./openapi-parser.js"
import {
  buildMcpServer,
  fetchAndParseSpec,
  DEFAULT_API_BASE_URL,
  DEFAULT_OPENAPI_SPEC_URL,
  SERVER_VERSION,
} from "./server.js"

const PORT = Number(process.env.PORT || 8080)
const OPENAPI_SPEC_URL = process.env.RIVETER_OPENAPI_URL || DEFAULT_OPENAPI_SPEC_URL
const API_BASE_URL = process.env.RIVETER_API_BASE_URL || DEFAULT_API_BASE_URL
// Must match the URL users paste into their MCP client exactly (RFC 9728
// `resource`), path included.
const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL || "https://mcp.riveterhq.com/mcp"
const OAUTH_ISSUER_URL = process.env.OAUTH_ISSUER_URL || "https://app.riveterhq.com"
// The stdio server re-reads the spec on every client restart; the hosted one
// runs for weeks, so it re-fetches on a timer to keep the "spec change = tool
// change, no redeploy" property.
const SPEC_REFRESH_INTERVAL_MS = Number(process.env.SPEC_REFRESH_INTERVAL_MS || 10 * 60 * 1000)
// OpenAI plugin directory domain verification. The portal generates a token
// per submission and expects it back, bare, at this well-known path. Unset in
// every other environment, so the route 404s.
const OPENAI_APPS_CHALLENGE = process.env.OPENAI_APPS_CHALLENGE?.trim() || ""
const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge"

const mcpPublicUrl = new URL(MCP_PUBLIC_URL)
const MCP_PATH = mcpPublicUrl.pathname
const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource"
const PROTECTED_RESOURCE_METADATA_URL = `${mcpPublicUrl.origin}${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`

let parsedSpec: ParseResult

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

function protectedResourceMetadata() {
  return {
    resource: MCP_PUBLIC_URL,
    authorization_servers: [OAUTH_ISSUER_URL],
    bearer_methods_supported: ["header"],
    scopes_supported: ["api"],
    resource_name: "Riveter",
    resource_documentation: "https://docs.riveterhq.com",
  }
}

function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (!header) return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

function respondUnauthorized(res: ServerResponse): void {
  sendJson(
    res,
    401,
    {
      error: "unauthorized",
      error_description:
        "Provide a Riveter API key as `Authorization: Bearer sk_riv_...` or connect through OAuth.",
    },
    { "WWW-Authenticate": `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}", scope="api"` },
  )
}

// Browsers send Origin; MCP clients (Anthropic, OpenAI) do not. Rejecting a
// foreign Origin blocks DNS-rebinding style calls from a web page.
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === mcpPublicUrl.host
  } catch {
    return false
  }
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!originAllowed(req)) {
    sendJson(res, 403, { error: "forbidden", error_description: "Origin not allowed" })
    return
  }

  const bearerToken = extractBearerToken(req)
  if (!bearerToken) {
    respondUnauthorized(res)
    return
  }

  const server = buildMcpServer({ parsedSpec, apiBaseUrl: API_BASE_URL, bearerToken })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on("close", () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res)
}

function isProtectedResourceMetadataPath(pathname: string): boolean {
  return (
    pathname === PROTECTED_RESOURCE_METADATA_PATH ||
    pathname === `${PROTECTED_RESOURCE_METADATA_PATH}/` ||
    pathname === `${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH}`
  )
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url || "/", mcpPublicUrl.origin).pathname

  if (pathname === "/healthz") {
    sendJson(res, 200, { status: "ok", version: SERVER_VERSION, tools: parsedSpec.operations.length })
    return
  }
  if (isProtectedResourceMetadataPath(pathname)) {
    sendJson(res, 200, protectedResourceMetadata())
    return
  }
  if (pathname === OPENAI_APPS_CHALLENGE_PATH && OPENAI_APPS_CHALLENGE) {
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" })
    res.end(OPENAI_APPS_CHALLENGE)
    return
  }
  if (pathname === MCP_PATH) {
    await handleMcpRequest(req, res)
    return
  }
  sendJson(res, 404, { error: "not_found" })
}

async function refreshSpec(): Promise<void> {
  try {
    parsedSpec = await fetchAndParseSpec(OPENAPI_SPEC_URL)
    console.error(`riveter-mcp-server: loaded ${parsedSpec.operations.length} tools from ${OPENAPI_SPEC_URL}`)
  } catch (err) {
    console.error(`riveter-mcp-server: spec refresh failed, keeping previous spec: ${err}`)
  }
}

async function main() {
  try {
    parsedSpec = await fetchAndParseSpec(OPENAPI_SPEC_URL)
  } catch (err) {
    console.error(`Failed to fetch OpenAPI spec: ${err}`)
    process.exit(1)
  }
  console.error(`riveter-mcp-server: loaded ${parsedSpec.operations.length} tools from ${OPENAPI_SPEC_URL}`)

  if (SPEC_REFRESH_INTERVAL_MS > 0) {
    setInterval(() => void refreshSpec(), SPEC_REFRESH_INTERVAL_MS).unref()
  }

  const httpServer = createServer((req, res) => {
    route(req, res).catch((err) => {
      console.error("riveter-mcp-server: request failed:", err)
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error" })
      } else {
        res.end()
      }
    })
  })

  const shutdown = () => {
    httpServer.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 10_000).unref()
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  httpServer.listen(PORT, () => {
    console.error(`riveter-mcp-server v${SERVER_VERSION} listening on :${PORT} (public URL ${MCP_PUBLIC_URL})`)
  })
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
