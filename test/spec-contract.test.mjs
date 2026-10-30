import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"
import { parseOpenApiSpec } from "../dist/openapi-parser.js"
import { buildMcpServer, operationIdToToolName, HELP_TOOL_NAME } from "../dist/server.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"

// Context budgets, in characters (~4 chars per token for English/markdown;
// closer to 3 for JSON). Every MCP client loads `instructions` and the full
// tools/list at session start, and some clients repeat `instructions` once
// per tool — so the instructions budget is deliberately tight.
//   instructions   850 chars  ≈ 200 tokens
//   one tool      6000 chars  ≈ 1.5K tokens
//   tools/list: the measured size of the served list plus a 2K margin, so a
//   description that grows by more than that fails here and is trimmed on purpose
//   (names + descriptions + schemas + annotations). Re-measure after a spec change
//   that adds or removes an operation and set the ceiling again: measured + 2K.
//     openapi.yaml         79,032 chars on 2026-10-30 (40 tools incl. help) ≈ 20K tokens
//     openapi.legacy.yaml  80,617 chars on 2026-10-23 (31 tools, opt-in via RIVETER_OPENAPI_URL)
//   one help topic 9000 chars ≈ 2.5K tokens (loaded only when the agent calls `help`)
const INSTRUCTIONS_MAX_CHARS = 850
const TOOL_DESCRIPTION_MAX_CHARS = 6000
const TOOLS_LIST_MAX_CHARS = 81_000
const LEGACY_TOOLS_LIST_MAX_CHARS = 83_000
const HELP_TOPIC_MAX_CHARS = 9000

// Text that belongs in the docs site / instructions, never inside a tool
// description (it would be repeated once per tool).
const SHARED_BACKGROUND_PATTERNS = [
  /## Overview/,
  /## Authentication/,
  /## Legacy endpoints/,
  /## Official SDKs/,
  /## MCP server/,
  /claude mcp add/,
  /"mcpServers"/,
]

function jsonBlocksIn(markdown) {
  return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => ({ json: m[1] }))
}

// Walks an example value alongside its SchemaNode and asserts every
// enum-typed leaf holds an allowed value. Unknown keys are ignored (open
// objects pass them through to the API).
function assertEnumsRespected(value, node, path) {
  if (value === null || value === undefined || !node) return
  if (node.enum && typeof value === "string") {
    assert.ok(node.enum.includes(value), `${path}: "${value}" is not one of ${JSON.stringify(node.enum)}`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertEnumsRespected(item, node.items, `${path}[${i}]`))
    return
  }
  if (typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    const childNode = node.properties?.[key] ?? node.additionalProperties
    assertEnumsRespected(child, childNode, `${path}.${key}`)
  }
}

async function listToolsThrough(parsedSpec) {
  const server = buildMcpServer({ parsedSpec, apiBaseUrl: "http://127.0.0.1:1", bearerToken: "x" })
  const client = new Client({ name: "spec-contract", version: "0.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const instructions = client.getInstructions() || ""
  const { tools } = await client.listTools()
  await client.close()
  await server.close()
  return { instructions, tools }
}

// The published MCP server generates its tools from the deployed copies of
// these specs (docs.riveterhq.com). Parsing the repo's real files here catches
// spec/parser drift before it ships — e.g. an unresolved $ref or a missing
// path parameter that would silently break every generated tool.
// Neither spec flags operations as deprecated today (legacy endpoints stay
// first-class for direct API users). If that decision changes, flip the
// expectation here — the server already renders deprecated ops with a
// [DEPRECATED] description marker.
//
// Only the current spec is served as MCP tools, so only it carries the
// `x-mcp-open-world` annotation contract (see `openWorldFollowsWebhookUrl`)
// and the estimate_cost contract (see `enforcesEstimateCostContract`).
//
// The docs promise "everything except get_* / list_* spends credits" and
// "every paid endpoint accepts estimate_cost + max_credits". `freeNonGetOperationIds`
// lists the non-GET operations that are free (account-local config, row and
// cell writes, cancel). A new non-GET operation must either carry estimate_cost +
// max_credits + a 200 EstimateCostResult response, or be added there on purpose.
const LEGACY_FREE_NON_GET_OPERATION_IDS = new Set(["stopRun", "createEnrichment", "updateEnrichment", "updateMonitor"])
const FREE_NON_GET_OPERATION_IDS = new Set([
  ...LEGACY_FREE_NON_GET_OPERATION_IDS,
  "deleteEnrichment",
  "updateDataset",
  "deleteDataset",
  "addDatasetRows",
  "deleteDatasetRows",
  "updateDatasetRow",
  "importDatasetRows",
  "promoteDatasetColumn",
])

const SPECS = [
  {
    url: new URL("../../public/api_docs/openapi.yaml", import.meta.url),
    everyOperationDeprecated: false,
    openWorldFollowsWebhookUrl: true,
    enforcesEstimateCostContract: true,
    freeNonGetOperationIds: FREE_NON_GET_OPERATION_IDS,
    toolsListMaxChars: TOOLS_LIST_MAX_CHARS,
    // Only the current spec ships `info.x-mcp-help` (the `help` tool).
    hasHelpTopics: true,
  },
  {
    url: new URL("../../public/api_docs/openapi.legacy.yaml", import.meta.url),
    everyOperationDeprecated: false,
    openWorldFollowsWebhookUrl: false,
    enforcesEstimateCostContract: false,
    freeNonGetOperationIds: LEGACY_FREE_NON_GET_OPERATION_IDS,
    toolsListMaxChars: LEGACY_TOOLS_LIST_MAX_CHARS,
    hasHelpTopics: false,
  },
]

const PROPERTY_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/

for (const {
  url: specUrl,
  everyOperationDeprecated,
  openWorldFollowsWebhookUrl,
  enforcesEstimateCostContract,
  freeNonGetOperationIds,
  toolsListMaxChars,
  hasHelpTopics,
} of SPECS) {
  const specName = specUrl.pathname.split("/").pop()
  // The specs live in the private monorepo (public/api_docs/). The public mirror
  // (github.com/riveterhq/riveter-mcp) ships only this directory, so skip there.
  if (!existsSync(specUrl)) {
    test(`${specName}: spec-contract (skipped: spec not in this checkout)`, { skip: true }, () => {})
    continue
  }
  const specText = readFileSync(specUrl, "utf8")
  const rawSpec = parseYaml(specText)
  const parsedSpec = parseOpenApiSpec(specText)
  const { operations, instructions, helpTopics } = parsedSpec
  const helpTopicNames = Object.keys(helpTopics)

  test(`${specName}: parses into a non-empty toolset with instructions`, () => {
    assert.ok(operations.length > 0, "no operations parsed")
    assert.ok(instructions.length > 0, "info.x-mcp-instructions / info.description missing")
    for (const op of operations) {
      assert.ok(op.operationId, `operation without operationId at ${op.method} ${op.path}`)
      assert.ok(op.description || op.summary, `${op.operationId}: no description or summary`)
    }
  })

  test(`${specName}: every path template parameter resolves to a required path param`, () => {
    for (const op of operations) {
      const placeholders = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
      for (const placeholder of placeholders) {
        const param = op.parameters.find((p) => p.name === placeholder && p.in === "path")
        assert.ok(
          param,
          `${op.operationId}: path parameter {${placeholder}} of ${op.path} did not parse — ` +
            `calls to this tool would fail with "Missing required path parameter"`,
        )
        assert.equal(param.required, true, `${op.operationId}: {${placeholder}} must be required`)
      }
    }
  })

  test(
    `${specName}: ${everyOperationDeprecated ? "every operation is marked deprecated (legacy generation)" : "no operation is marked deprecated"}`,
    () => {
      for (const op of operations) {
        assert.equal(
          op.deprecated,
          everyOperationDeprecated,
          `${op.operationId}: expected deprecated: ${everyOperationDeprecated}`,
        )
      }
    },
  )

  // openWorldHint follows the MCP spec ("may interact with an open world of
  // external entities"; web search is the spec's own example). Any operation
  // that POSTs to a caller-supplied webhook URL (`webhook_url`,
  // `dataset_webhook_url`, ...) reaches outside Riveter, so it must be marked.
  // Reading the public web (scrape, search, extraction planning) is marked by
  // hand in the spec. Account-local reads never are.
  if (openWorldFollowsWebhookUrl) {
    test(`${specName}: every operation that accepts a webhook URL has x-mcp-open-world: true`, () => {
      for (const op of operations) {
        const acceptsWebhook = Object.keys(op.requestBodyProperties).some((key) => key.endsWith("webhook_url"))
        if (!acceptsWebhook) continue
        assert.equal(op.openWorld, true, `${op.operationId}: accepts a webhook URL but lacks x-mcp-open-world: true`)
      }
    })

    test(`${specName}: no GET operation is marked open-world`, () => {
      for (const op of operations) {
        if (op.method !== "get") continue
        assert.notEqual(op.openWorld, true, `${op.operationId}: GET operations are account-local reads`)
      }
    })
  }

  // A paid tool without estimate_cost cannot be priced before it spends. The parser
  // does not carry responses, so the 200 EstimateCostResult check reads the raw spec.
  if (enforcesEstimateCostContract) {
    test(`${specName}: every paid operation carries estimate_cost + max_credits and answers a 200 EstimateCostResult`, () => {
      let paidCount = 0
      for (const op of operations) {
        if (op.method === "get") continue
        const isPaid = !freeNonGetOperationIds.has(op.operationId)
        const hasEstimateCost = "estimate_cost" in op.requestBodyProperties
        const hasMaxCredits = "max_credits" in op.requestBodyProperties
        const okResponse = rawSpec.paths?.[op.path]?.[op.method]?.responses?.["200"]
        const answersEstimateCost = JSON.stringify(okResponse ?? {}).includes("EstimateCostResult")

        if (isPaid) {
          paidCount += 1
          assert.ok(hasEstimateCost, `${op.operationId}: spends credits but has no estimate_cost body property`)
          assert.ok(hasMaxCredits, `${op.operationId}: spends credits but has no max_credits body property`)
          assert.ok(answersEstimateCost, `${op.operationId}: has no 200 response referencing EstimateCostResult`)
        } else {
          assert.ok(!hasEstimateCost && !hasMaxCredits && !answersEstimateCost, `${op.operationId}: is listed as free but carries the estimate_cost contract`)
        }
      }
      assert.ok(paidCount > 0, "no paid operation found")
    })

    test(`${specName}: no GET operation carries estimate_cost or max_credits`, () => {
      for (const op of operations) {
        if (op.method !== "get") continue
        const names = [...op.parameters.map((p) => p.name), ...Object.keys(op.requestBodyProperties)]
        assert.ok(!names.includes("estimate_cost") && !names.includes("max_credits"), `${op.operationId}: GET operations are free`)
      }
    })
  }

  test(`${specName}: all tool property names are provider-safe`, () => {
    for (const op of operations) {
      for (const p of op.parameters) {
        assert.match(p.name, PROPERTY_NAME_PATTERN, `${op.operationId}: bad parameter name ${p.name}`)
      }
      for (const key of Object.keys(op.requestBodyProperties)) {
        assert.match(key, PROPERTY_NAME_PATTERN, `${op.operationId}: bad body property ${key}`)
      }
    }
  })

  test(`${specName}: initialize instructions stay within the context budget`, async () => {
    const { instructions: served } = await listToolsThrough(parsedSpec)
    assert.ok(
      served.length <= INSTRUCTIONS_MAX_CHARS,
      `instructions are ${served.length} chars (max ${INSTRUCTIONS_MAX_CHARS}) — set a short info.x-mcp-instructions`,
    )
    for (const pattern of SHARED_BACKGROUND_PATTERNS) {
      assert.doesNotMatch(served, pattern, `instructions contain docs-site background (${pattern})`)
    }
  })

  test(`${specName}: tools/list stays within the context budget`, async () => {
    const { tools } = await listToolsThrough(parsedSpec)
    assert.equal(tools.length, operations.length + (helpTopicNames.length > 0 ? 1 : 0))
    for (const tool of tools) {
      const description = tool.description || ""
      assert.ok(
        description.length <= TOOL_DESCRIPTION_MAX_CHARS,
        `${tool.name}: description is ${description.length} chars (max ${TOOL_DESCRIPTION_MAX_CHARS})`,
      )
      for (const pattern of SHARED_BACKGROUND_PATTERNS) {
        assert.doesNotMatch(description, pattern, `${tool.name}: description repeats shared background (${pattern})`)
      }
    }
    const serialized = JSON.stringify(tools)
    assert.ok(
      serialized.length <= toolsListMaxChars,
      `tools/list is ${serialized.length} chars (max ${toolsListMaxChars})`,
    )
  })

  // Map-like body objects (e.g. `output: { <column>: {...} }`) must serve their
  // value schema, or the agent cannot see per-column fields such as `run_when`.
  test(`${specName}: map-like body objects serve their value schema`, async () => {
    const { tools } = await listToolsThrough(parsedSpec)
    const mapLike = operations.flatMap((op) =>
      Object.entries(op.requestBodyProperties)
        .filter(([, prop]) => prop.additionalProperties?.properties)
        .map(([name, prop]) => ({ op, name, prop })),
    )
    assert.ok(mapLike.length > 0, "no map-like body property with a typed value schema")
    for (const { op, name, prop } of mapLike) {
      const tool = tools.find((t) => t.name === operationIdToToolName(op.operationId))
      const served = tool.inputSchema.properties[name]?.additionalProperties?.properties
      assert.ok(served, `${tool.name}.${name}: value schema missing from served tool`)
      for (const field of Object.keys(prop.additionalProperties.properties)) {
        assert.ok(served[field], `${tool.name}.${name}.<key>.${field}: missing from served schema`)
      }
    }
  })

  if (hasHelpTopics) {
    test(`${specName}: help tool serves every x-mcp-help topic within budget`, async () => {
      assert.ok(helpTopicNames.length > 0, "info.x-mcp-help is missing or empty")
      const { tools } = await listToolsThrough(parsedSpec)
      const help = tools.find((t) => t.name === HELP_TOOL_NAME)
      assert.ok(help, "help tool not served")
      assert.deepEqual(help.inputSchema.properties.topic.enum, helpTopicNames)
      for (const [topic, text] of Object.entries(helpTopics)) {
        assert.ok(
          text.length <= HELP_TOPIC_MAX_CHARS,
          `help(${topic}) is ${text.length} chars (max ${HELP_TOPIC_MAX_CHARS}) — split the topic`,
        )
        for (const pattern of SHARED_BACKGROUND_PATTERNS) {
          assert.doesNotMatch(text, pattern, `help(${topic}) contains docs-site background (${pattern})`)
        }
      }
    })

    test(`${specName}: every JSON block in x-mcp-help parses`, () => {
      let blocks = 0
      for (const [topic, text] of Object.entries(helpTopics)) {
        for (const { json } of jsonBlocksIn(text)) {
          blocks += 1
          assert.doesNotThrow(() => JSON.parse(json), `help(${topic}) has a JSON block that does not parse:\n${json}`)
        }
      }
      assert.ok(blocks > 0, "x-mcp-help has no JSON examples")
    })

    // An example that says `"run_when": "when_filled"` would teach the agent a
    // value the API rejects. Every enum-typed field inside a help example must
    // hold a value from the same-named body property's schema.
    test(`${specName}: help examples use only enum values the tool schemas allow`, () => {
      const mapLikeBodyProps = new Map()
      for (const op of operations) {
        for (const [name, prop] of Object.entries(op.requestBodyProperties)) {
          if (prop.additionalProperties?.properties) mapLikeBodyProps.set(name, prop)
        }
      }
      assert.ok(mapLikeBodyProps.size > 0, "no map-like body property to check examples against")
      let checked = 0
      for (const [topic, text] of Object.entries(helpTopics)) {
        for (const { json } of jsonBlocksIn(text)) {
          const example = JSON.parse(json)
          for (const [name, prop] of mapLikeBodyProps) {
            if (!example || typeof example !== "object" || !example[name]) continue
            checked += 1
            assertEnumsRespected(example[name], prop, `help(${topic}).${name}`)
          }
        }
      }
      assert.ok(checked > 0, "no help example exercises a map-like body property")
    })
  }

  // Limits the API enforces (ExternalApi::Limits) must reach the tool schema
  // so a client can reject an over-limit call before it hits the API.
  test(`${specName}: array limits from the spec reach the served tool schema`, async () => {
    const { tools } = await listToolsThrough(parsedSpec)
    const withLimits = operations.filter((op) =>
      Object.values(op.requestBodyProperties).some((prop) => prop.maxItems !== undefined),
    )
    assert.ok(withLimits.length > 0, "no operation carries maxItems")
    for (const op of withLimits) {
      const tool = tools.find((t) => t.name === operationIdToToolName(op.operationId))
      assert.ok(tool, `${op.operationId}: tool not served`)
      for (const [name, prop] of Object.entries(op.requestBodyProperties)) {
        if (prop.maxItems === undefined) continue
        assert.equal(
          tool.inputSchema.properties[name]?.maxItems,
          prop.maxItems,
          `${tool.name}.${name}: maxItems missing from served schema`,
        )
      }
    }
  })
}
