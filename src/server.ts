import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import {
  parseOpenApiSpec,
  type OpenApiOperation,
  type ParseResult,
  type SchemaConstraints,
  type SchemaNode,
} from "./openapi-parser.js"

export const SERVER_VERSION = "0.3.4"

export const DEFAULT_OPENAPI_SPEC_URL = "https://docs.riveterhq.com/openapi.yaml"
export const DEFAULT_API_BASE_URL = "https://api.riveterhq.com/v1"

// Flat client-side ceiling for a single API call. Kept well above the server's
// max long-poll budget (GET /runs/{id}/result?wait=N) so a long-poll never
// races this timeout — it only trips on a genuinely stalled connection.
const REQUEST_TIMEOUT_MS = 120_000

// `file://` is for local development against a spec that is not served anywhere
// (RIVETER_OPENAPI_URL=file:///…/public/api_docs/openapi.yaml with Rails down).
export async function fetchAndParseSpec(specUrl: string): Promise<ParseResult> {
  return parseOpenApiSpec(await readSpecText(specUrl))
}

async function readSpecText(specUrl: string): Promise<string> {
  if (specUrl.startsWith("file://")) {
    return readFile(fileURLToPath(specUrl), "utf8")
  }
  const res = await fetch(specUrl)
  if (!res.ok) {
    throw new Error(`Failed to fetch OpenAPI spec from ${specUrl}: ${res.status}`)
  }
  return res.text()
}

async function callApi(
  apiBaseUrl: string,
  bearerToken: string,
  method: string,
  path: string,
  queryParams?: Record<string, string>,
  body?: Record<string, unknown>,
  headerParams?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${apiBaseUrl}${path}`)
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value)
      }
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearerToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...headerParams,
  }

  const fetchOptions: RequestInit = { method: method.toUpperCase(), headers }
  if (body && (method === "post" || method === "put" || method === "patch")) {
    fetchOptions.body = JSON.stringify(body)
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(url.toString(), {
      ...fetchOptions,
      signal: controller.signal,
    })
    const text = await res.text()

    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw_response: text, status_code: res.status }
    }

    if (!res.ok) {
      return {
        error: true,
        status_code: res.status,
        ...(typeof data === "object" && data !== null ? data : { message: text }),
      }
    }

    return data
  } catch (err) {
    if (controller.signal.aborted) {
      return {
        error: true,
        status_code: 0,
        message: `Request to ${path} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
      }
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

// Workflow hints appended to tool descriptions so Claude knows the async patterns.
// Keyed by operationId. Covers the current spec (docs.riveterhq.com/openapi.yaml)
// plus legacy-only operationIds (openapi.legacy.yaml via RIVETER_OPENAPI_URL).
const WORKFLOW_HINTS: Record<string, string> = {
  // Current API — every kickoff returns a run; poll get_run, fetch get_run_result
  enrich:
    "\n\n**Workflow:** Starts an async run. Call `get_run_result` with the returned run id and `wait: 50` until status is 'success'; its `output` is the result.",
  getRun:
    "\n\n**Workflow:** Pass `wait` (seconds, max 50) to hold the request until the run finishes; repeat until `status` is 'success' or 'stopped'.",
  getRunResult:
    "\n\n**Workflow:** `output` is null until the run finishes. Pass `wait` (seconds, max 50) to long-poll instead of sleeping between calls.",
  stopRun:
    "\n\n**Workflow:** Stops a running run. The run cannot be resumed after stopping.",
  buildDataset:
    "\n\n**Workflow:** The response is the dataset and, with `prompt` + `count`, a generation `run` — poll it with `get_run`, then read the rows with `list_dataset_rows` (`auto_fill: true` researches them as they land).",
  buildConfiguredDataset:
    "\n\n**Workflow:** Starts an async run of a configured list build. Poll `get_run`; the rows land in the dataset the run's `dataset_id` names (`list_dataset_rows`), then `enrich` with it.",
  runExtraction:
    "\n\n**Workflow:** Starts an async extraction run. Poll `get_run`, then fetch the records with `get_run_result`.",
  createExtraction:
    "\n\n**Workflow:** Discovery is async but returns no run — poll `get_extraction` until `status` is 'ready', then execute with `run_extraction`.",
  createMonitor:
    "\n\n**Workflow:** Creates a scheduled monitor. Check it with `get_monitor`, pause it with `update_monitor` (enabled: false), and list its runs with `list_monitor_runs`.",
  // Legacy API (openapi.legacy.yaml), including its retired resource endpoints
  buildDatasetLegacyBody:
    "\n\n**Workflow:** Starts an async list build. Poll `get_run` until status is 'success', then fetch the rows with `get_run_result`; `auto_run_enrichment: true` enriches them in the same flow.",
  buildDatasetForEnrichment:
    "\n\n**Workflow:** Starts an async list-build run matching the enrichment's input columns (a dataset's enrichment: rows into its dataset). Poll `get_run`, then fetch rows with `get_run_result`.",
  extendDataset:
    "\n\n**Workflow:** Starts an async run that adds rows to a completed list build, or to a dataset on its `ds_...` id. Poll `get_run`, then fetch with `get_run_result`.",
  runNewEnrichment:
    "\n\n**Workflow:** This starts an async run. Use the returned `run_key` with `get_run_status` to poll until status is 'success', then `get_run_data` to retrieve results.",
  runExistingEnrichment:
    "\n\n**Workflow:** This starts an async run. Use the returned `run_key` with `get_run_status` to poll until status is 'success', then `get_run_data` to retrieve results.",
  getRunStatus:
    "\n\n**Workflow:** Poll this endpoint until `status` is 'success' or 'stopped'. Typical runs take 10-120 seconds. Poll every 5-10 seconds.",
  getRunData:
    "\n\n**Workflow:** Call this after `get_run_status` shows 'success' to get the full results.",
  monitorEnrichment:
    "\n\n**Workflow:** Creates a scheduled monitor. Use the returned `monitor_uuid` with `get_monitor_status` to check on it, or `pause_monitor` to pause it.",
  getMonitorStatus:
    "\n\n**Workflow:** Returns the monitor's schedule, enabled state, and next run time.",
  getMonitorRecentRunData:
    "\n\n**Workflow:** Returns the results from the monitor's most recent run.",
  getDatasetBuildStatus:
    "\n\n**Workflow:** Poll this endpoint until `state` is 'completed' or 'failed'. Then use `get_dataset_build_data` to get the generated rows.",
  getDatasetBuildData:
    "\n\n**Workflow:** Call this after `get_dataset_build_status` shows state 'completed' to get the generated rows.",
  stopDatasetBuild: "\n\n**Workflow:** Stops a dataset build in progress.",
  createEnrichmentFromDataset:
    "\n\n**Workflow:** Creates an enrichment from a completed dataset build. Then use `run_enrichment_from_dataset` with the same `run_key` to execute it.",
  runEnrichmentFromDataset:
    "\n\n**Workflow:** Starts an async enrichment run using the dataset as input. Use the returned `run_key` with `get_run_status` to poll until status is 'success', then `get_run_data` to retrieve results.",
}

export function operationIdToToolName(operationId: string): string {
  return operationId
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// Client UIs (Claude connectors, ChatGPT) read these to label tools and to
// decide when to ask the user for confirmation. Derived from the HTTP method,
// with the spec's `x-mcp-destructive` / `x-mcp-open-world` extensions as the
// only overrides. openWorldHint follows the MCP spec ("may interact with an
// open world of external entities" — web search is the spec's own example):
// false unless the spec says the operation reads the public web or pushes
// data out (webhook_url). OpenAI review rejected a web-search tool marked
// closed-world, so do not narrow this to "changes public state".
export function toolAnnotationsFor(op: OpenApiOperation): ToolAnnotations {
  const isReadOnly = op.method === "get"
  const isDestructive = op.destructive ?? op.method === "delete"
  return {
    title: op.summary ? capitalizeFirst(op.summary) : undefined,
    readOnlyHint: isReadOnly,
    destructiveHint: isDestructive,
    idempotentHint: isReadOnly || op.method === "put" || op.method === "delete",
    openWorldHint: op.openWorld ?? false,
  }
}

// Spec limits (minimum/maximum/maxLength) become Zod checks, which the MCP SDK
// emits as JSON Schema — so clients see the limit instead of discovering it
// through a 400.
function withNumberBounds(schema: z.ZodNumber, constraints: SchemaConstraints): z.ZodNumber {
  let bounded = schema
  if (constraints.minimum !== undefined) bounded = bounded.min(constraints.minimum)
  if (constraints.maximum !== undefined) bounded = bounded.max(constraints.maximum)
  return bounded
}

function zodScalarFor(
  type: string | undefined,
  enumValues: string[] | undefined,
  description: string,
  constraints: SchemaConstraints = {},
): z.ZodTypeAny {
  if (enumValues && enumValues.length > 0) {
    return z.enum(enumValues as [string, ...string[]]).describe(description)
  }
  switch (type) {
    case "integer":
      return withNumberBounds(z.number().int(), constraints).describe(description)
    case "number":
      return withNumberBounds(z.number(), constraints).describe(description)
    case "boolean":
      return z.boolean().describe(description)
    default: {
      const text = z.string()
      return (constraints.maxLength !== undefined ? text.max(constraints.maxLength) : text).describe(description)
    }
  }
}

// The SDK hands the handler Zod's *parsed* value, and a plain z.object strips
// unknown keys. Nested objects therefore pass unknown keys through unless the
// spec says `additionalProperties: false`, so a field the spec forgot (or a
// tool-only param) still reaches the API instead of vanishing silently.
function zodObjectFor(node: SchemaNode): z.ZodTypeAny {
  const valueSchema = node.additionalProperties ? zodFor(node.additionalProperties) : undefined
  if (!node.properties) {
    return z.record(z.string(), valueSchema ?? z.any())
  }
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [name, child] of Object.entries(node.properties)) {
    const field = zodFor(child, name)
    shape[name] = child.required ? field : field.optional()
  }
  const object = z.object(shape)
  if (valueSchema) return object.catchall(valueSchema)
  return node.closed ? object : object.catchall(z.unknown())
}

function zodArrayFor(node: SchemaNode): z.ZodTypeAny {
  let list = z.array(node.items ? zodFor(node.items) : z.any())
  if (node.minItems !== undefined) list = list.min(node.minItems)
  if (node.maxItems !== undefined) list = list.max(node.maxItems)
  return list
}

// Recursive body-schema → Zod. Nested objects (including map-like ones such
// as `output: { <column>: {...} }`) keep their shape so the served tool schema
// shows every supported field instead of an untyped object.
function zodFor(node: SchemaNode, fallbackDescription = ""): z.ZodTypeAny {
  const description = node.description || fallbackDescription
  let schema: z.ZodTypeAny
  if (node.enum && node.enum.length > 0) {
    schema = z.enum(node.enum as [string, ...string[]])
  } else if (node.type === "array") {
    schema = zodArrayFor(node)
  } else if (node.type === "object") {
    schema = zodObjectFor(node)
  } else {
    schema = zodScalarFor(node.type, undefined, "", node)
  }
  if (node.nullable) schema = schema.nullable()
  return description ? schema.describe(description) : schema
}

function buildZodShape(
  params: OpenApiOperation["parameters"],
  bodyProps: OpenApiOperation["requestBodyProperties"],
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const param of params) {
    const fieldSchema = zodScalarFor(
      param.schema.type,
      param.schema.enum,
      param.description || param.name,
      param.schema,
    )
    shape[param.name] = param.required ? fieldSchema : fieldSchema.optional()
  }

  for (const [name, prop] of Object.entries(bodyProps)) {
    if (shape[name]) continue
    const fieldSchema = zodFor(prop, name)
    shape[name] = prop.required ? fieldSchema : fieldSchema.optional()
  }

  return shape
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) }
}

export interface RiveterMcpServerConfig {
  parsedSpec: ParseResult
  apiBaseUrl: string
  // Sent verbatim as `Authorization: Bearer <token>` on every API call. A Riveter
  // API key (`sk_riv_...`) today; the OAuth flow issues the same kind of token.
  bearerToken: string
}

function registerOperation(server: McpServer, op: OpenApiOperation, config: RiveterMcpServerConfig): void {
  const toolName = operationIdToToolName(op.operationId)
  const hint = WORKFLOW_HINTS[op.operationId] || ""
  const deprecationNotice = op.deprecated
    ? "[DEPRECATED] This endpoint still works but has a preferred successor — see the API documentation for the replacement.\n\n"
    : ""
  const description =
    deprecationNotice + (op.summary ? `${op.summary}\n\n` : "") + op.description + hint

  const shape = buildZodShape(op.parameters, op.requestBodyProperties)
  const annotations = toolAnnotationsFor(op)

  const pathParamNames = new Set(op.parameters.filter((p) => p.in === "path").map((p) => p.name))
  const queryParamNames = new Set(op.parameters.filter((p) => p.in === "query").map((p) => p.name))
  const headerParamNames = new Set(op.parameters.filter((p) => p.in === "header").map((p) => p.name))

  server.registerTool(
    toolName,
    { title: annotations.title, description, inputSchema: shape, annotations },
    async (args: Record<string, unknown>) => {
      let resolvedPath = op.path
      const queryParams: Record<string, string> = {}
      const bodyParams: Record<string, unknown> = {}
      const headerParams: Record<string, string> = {}

      for (const [key, value] of Object.entries(args)) {
        if (value === undefined) continue
        if (pathParamNames.has(key)) {
          resolvedPath = resolvedPath.replaceAll(`{${key}}`, encodeURIComponent(String(value)))
        } else if (queryParamNames.has(key)) {
          queryParams[key] = String(value)
        } else if (headerParamNames.has(key)) {
          headerParams[key] = String(value)
        } else {
          bodyParams[key] = value
        }
      }

      const unresolvedPlaceholder = resolvedPath.match(/\{[^}]+\}/)
      if (unresolvedPlaceholder) {
        return textResult(
          `Missing required path parameter ${unresolvedPlaceholder[0]} for ${op.path}`,
          true,
        )
      }

      try {
        const result = await callApi(
          config.apiBaseUrl,
          config.bearerToken,
          op.method,
          resolvedPath,
          Object.keys(queryParams).length > 0 ? queryParams : undefined,
          Object.keys(bodyParams).length > 0 ? bodyParams : undefined,
          Object.keys(headerParams).length > 0 ? headerParams : undefined,
        )
        return textResult(JSON.stringify(result, null, 2))
      } catch (err) {
        return textResult(
          `API request failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        )
      }
    },
  )
}

export const HELP_TOOL_NAME = "help"

// Generic reference-docs tool: topics and text come from the spec's
// `info.x-mcp-help`, so the server knows nothing about what they say. Keeps
// long-form guidance (column config, formats, examples) out of tools/list and
// loads it only when the agent asks.
function registerHelpTool(server: McpServer, helpTopics: Record<string, string>): void {
  const topics = Object.keys(helpTopics)
  if (topics.length === 0) return

  server.registerTool(
    HELP_TOOL_NAME,
    {
      title: "help",
      description:
        "Reference docs for using Riveter well. Call before writing an `output` column spec or when an error mentions a limit. " +
        `Topics: ${topics.join(", ")}.`,
      inputSchema: { topic: z.enum(topics as [string, ...string[]]).describe("Which topic to read") },
      annotations: {
        title: "help",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ topic }: { topic: string }) => {
      const others = topics.filter((t) => t !== topic)
      return textResult(`${helpTopics[topic]}\n\n---\nOther topics: ${others.join(", ")}`)
    },
  )
}

// One McpServer per bearer token. Cheap to build (the spec is already parsed),
// so the HTTP entrypoint creates one per request; stdio builds one for the process.
export function buildMcpServer(config: RiveterMcpServerConfig): McpServer {
  const server = new McpServer(
    { name: "riveter", version: SERVER_VERSION },
    { instructions: config.parsedSpec.instructions },
  )

  const operations = config.parsedSpec.operations
  for (const op of operations) {
    registerOperation(server, op, config)
  }

  const helpNameTaken = operations.some((op) => operationIdToToolName(op.operationId) === HELP_TOOL_NAME)
  if (helpNameTaken) {
    console.error(`riveter-mcp-server: an operation is already named "${HELP_TOOL_NAME}"; skipping x-mcp-help`)
  } else {
    registerHelpTool(server, config.parsedSpec.helpTopics)
  }

  return server
}
