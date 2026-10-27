import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

// Exercises dist/http.js end to end: a fixture server plays both the OpenAPI
// spec host and the Riveter API, so every forwarded request can be inspected.
const FIXTURE_SPEC = `
openapi: 3.1.0
info:
  title: Fixture API
  description: Fixture for hosted MCP tests
paths:
  /items/{item_id}:
    get:
      operationId: getItem
      summary: get item
      parameters:
        - name: item_id
          in: path
          required: true
          schema:
            type: string
  /runs/{id}/stop:
    post:
      operationId: stopRun
      summary: stop run
      x-mcp-destructive: true
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
  /enrich:
    post:
      operationId: enrich
      summary: enrich
      x-mcp-open-world: true
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                input:
                  type: object
                webhook_url:
                  type: string
  /quick_search:
    post:
      operationId: quickSearch
      summary: quick search
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                query:
                  type: string
`

const OPENAI_APPS_CHALLENGE = "openai-verify-abc123"

let fixtureServer
let fixtureBaseUrl
let child
let mcpPort
let mcpUrl
const capturedRequests = []

async function waitForHealthz(url, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("hosted MCP server did not become healthy")
}

async function freePort() {
  const probe = createServer()
  probe.listen(0)
  await once(probe, "listening")
  const port = probe.address().port
  probe.close()
  await once(probe, "close")
  return port
}

async function connectClient(token) {
  const client = new Client({ name: "test", version: "1.0" })
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

before(async () => {
  fixtureServer = createServer((req, res) => {
    if (req.url === "/spec.yaml") {
      res.writeHead(200, { "Content-Type": "text/yaml" })
      res.end(FIXTURE_SPEC)
      return
    }
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      capturedRequests.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ request_status: "success" }))
    })
  })
  fixtureServer.listen(0)
  await once(fixtureServer, "listening")
  fixtureBaseUrl = `http://localhost:${fixtureServer.address().port}`

  mcpPort = await freePort()
  mcpUrl = `http://localhost:${mcpPort}/mcp`

  child = spawn("node", ["dist/http.js"], {
    env: {
      ...process.env,
      PORT: String(mcpPort),
      MCP_PUBLIC_URL: mcpUrl,
      OAUTH_ISSUER_URL: "https://issuer.test",
      RIVETER_OPENAPI_URL: `${fixtureBaseUrl}/spec.yaml`,
      RIVETER_API_BASE_URL: fixtureBaseUrl,
      SPEC_REFRESH_INTERVAL_MS: "0",
      OPENAI_APPS_CHALLENGE,
    },
    stdio: ["ignore", "inherit", "inherit"],
  })

  await waitForHealthz(`http://localhost:${mcpPort}/healthz`)
})

after(() => {
  child?.kill()
  fixtureServer?.close()
})

test("healthz reports the loaded tool count", async () => {
  const health = await (await fetch(`http://localhost:${mcpPort}/healthz`)).json()
  assert.equal(health.status, "ok")
  assert.equal(health.tools, 4)
})

test("OpenAI domain-verification token is served bare at its well-known path", async () => {
  const res = await fetch(`http://localhost:${mcpPort}/.well-known/openai-apps-challenge`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type"), /^text\/plain/)
  assert.equal(await res.text(), OPENAI_APPS_CHALLENGE)
})

test("request without a bearer token gets 401 pointing at the protected resource metadata", async () => {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
  assert.equal(res.status, 401)
  const challenge = res.headers.get("www-authenticate")
  assert.ok(challenge, "WWW-Authenticate header missing")
  assert.match(challenge, /^Bearer /)
  assert.ok(
    challenge.includes(`resource_metadata="http://localhost:${mcpPort}/.well-known/oauth-protected-resource/mcp"`),
    challenge,
  )
})

test("protected resource metadata is served at the root and path-suffixed well-known URLs", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const res = await fetch(`http://localhost:${mcpPort}${path}`)
    assert.equal(res.status, 200, path)
    const metadata = await res.json()
    assert.equal(metadata.resource, mcpUrl)
    assert.deepEqual(metadata.authorization_servers, ["https://issuer.test"])
    assert.deepEqual(metadata.bearer_methods_supported, ["header"])
  }
})

test("a foreign Origin header is rejected", async () => {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer sk_riv_test",
      Origin: "https://evil.example",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
  assert.equal(res.status, 403)
})

test("tools carry titles and method-derived annotations", async () => {
  const client = await connectClient("sk_riv_test")
  try {
    const { tools } = await client.listTools()
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))

    assert.equal(byName.get_item.title, "Get item")
    assert.equal(byName.get_item.annotations.readOnlyHint, true)
    assert.equal(byName.get_item.annotations.destructiveHint, false)
    assert.equal(byName.get_item.annotations.openWorldHint, false)

    assert.equal(byName.enrich.annotations.readOnlyHint, false)
    assert.equal(byName.enrich.annotations.destructiveHint, false)
    assert.equal(byName.enrich.annotations.openWorldHint, true, "x-mcp-open-world must be honored")

    assert.equal(byName.quick_search.title, "Quick search")
    assert.equal(byName.quick_search.annotations.readOnlyHint, false)
    assert.equal(byName.quick_search.annotations.openWorldHint, false, "closed-world unless the spec says otherwise")

    assert.equal(byName.stop_run.annotations.destructiveHint, true, "x-mcp-destructive must win")
  } finally {
    await client.close()
  }
})

test("the caller's bearer token is forwarded verbatim to the API", async () => {
  capturedRequests.length = 0
  const client = await connectClient("sk_riv_user_one")
  try {
    const result = await client.callTool({ name: "get_item", arguments: { item_id: "abc" } })
    assert.ok(!result.isError, JSON.stringify(result))
    assert.equal(capturedRequests.length, 1)
    assert.equal(capturedRequests[0].headers.authorization, "Bearer sk_riv_user_one")
    assert.equal(new URL(capturedRequests[0].url, fixtureBaseUrl).pathname, "/items/abc")
  } finally {
    await client.close()
  }
})

test("two callers with different tokens are isolated from each other", async () => {
  capturedRequests.length = 0
  const clientA = await connectClient("sk_riv_a")
  const clientB = await connectClient("sk_riv_b")
  try {
    await clientA.callTool({ name: "enrich", arguments: { input: { Company: ["Acme"] } } })
    await clientB.callTool({ name: "enrich", arguments: { input: { Company: ["Globex"] } } })
    const tokens = capturedRequests.map((r) => r.headers.authorization)
    assert.deepEqual(tokens, ["Bearer sk_riv_a", "Bearer sk_riv_b"])
    assert.equal(JSON.parse(capturedRequests[0].body).input.Company[0], "Acme")
    assert.equal(JSON.parse(capturedRequests[1].body).input.Company[0], "Globex")
  } finally {
    await clientA.close()
    await clientB.close()
  }
})
