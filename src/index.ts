#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  buildMcpServer,
  fetchAndParseSpec,
  DEFAULT_API_BASE_URL,
  DEFAULT_OPENAPI_SPEC_URL,
} from "./server.js"

const OPENAPI_SPEC_URL = process.env.RIVETER_OPENAPI_URL || DEFAULT_OPENAPI_SPEC_URL
const API_BASE_URL = process.env.RIVETER_API_BASE_URL || DEFAULT_API_BASE_URL
const API_KEY = process.env.RIVETER_API_KEY || ""

async function main() {
  if (!API_KEY) {
    console.error(
      "RIVETER_API_KEY environment variable is required. Get one at https://app.riveterhq.com/settings/api",
    )
    process.exit(1)
  }

  let parsedSpec
  try {
    parsedSpec = await fetchAndParseSpec(OPENAPI_SPEC_URL)
  } catch (err) {
    console.error(`Failed to fetch OpenAPI spec: ${err}`)
    process.exit(1)
  }

  const server = buildMcpServer({ parsedSpec, apiBaseUrl: API_BASE_URL, bearerToken: API_KEY })
  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  console.error("Fatal error:", err)
  process.exit(1)
})
