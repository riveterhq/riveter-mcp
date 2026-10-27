import { test } from "node:test"
import assert from "node:assert/strict"
import { parseOpenApiSpec } from "../dist/openapi-parser.js"

const FIXTURE_SPEC = `
openapi: 3.1.0
info:
  title: Fixture API
  description: Fixture for parser tests
paths:
  /items/{item_id}:
    parameters:
      - name: item_id
        in: path
        required: true
        description: Shared path-level parameter
        schema:
          type: string
    get:
      operationId: getItem
      summary: get item
      parameters:
        - name: verbose
          in: query
          required: false
          schema:
            type: boolean
        - name: wait
          in: query
          required: false
          schema:
            type: integer
            minimum: 0
            maximum: 50
            default: 50
    delete:
      operationId: deleteItem
      summary: delete item
      deprecated: true
      x-mcp-destructive: false
      parameters:
        - name: item_id
          in: path
          required: true
          description: Operation-level override
          schema:
            type: string
  /widgets:
    post:
      operationId: createWidget
      summary: create widget
      x-mcp-open-world: true
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
                  maxLength: 100
                "Bad Property Name":
                  type: string
                attributes:
                  type: array
                  items:
                    type: string
                  minItems: 1
                  maxItems: 20
                searches:
                  type: array
                  items:
                    type: object
                    properties:
                      query:
                        type: string
                        description: The search query
                      max_results:
                        type: integer
                        minimum: 1
                        maximum: 10
                    required:
                      - query
`

test("path-level shared parameters are inherited by operations", () => {
  const { operations } = parseOpenApiSpec(FIXTURE_SPEC)
  const getItem = operations.find((op) => op.operationId === "getItem")
  assert.ok(getItem)
  const itemIdParam = getItem.parameters.find((p) => p.name === "item_id")
  assert.ok(itemIdParam, "shared path-level parameter should be inherited")
  assert.equal(itemIdParam.in, "path")
  assert.equal(itemIdParam.required, true)
  assert.equal(itemIdParam.description, "Shared path-level parameter")
  assert.ok(getItem.parameters.some((p) => p.name === "verbose" && p.in === "query"))
})

test("operation-level parameters override shared ones by name + in", () => {
  const { operations } = parseOpenApiSpec(FIXTURE_SPEC)
  const deleteItem = operations.find((op) => op.operationId === "deleteItem")
  assert.ok(deleteItem)
  const itemIdParams = deleteItem.parameters.filter((p) => p.name === "item_id")
  assert.equal(itemIdParams.length, 1, "override must not duplicate the parameter")
  assert.equal(itemIdParams[0].description, "Operation-level override")
})

test("request body property names invalid for AI providers are skipped", () => {
  const { operations } = parseOpenApiSpec(FIXTURE_SPEC)
  const createWidget = operations.find((op) => op.operationId === "createWidget")
  assert.ok(createWidget)
  const propNames = Object.keys(createWidget.requestBodyProperties)
  assert.ok(propNames.includes("name"))
  assert.ok(!propNames.includes("Bad Property Name"))
})

test("array-of-object body properties surface their item shape", () => {
  const { operations } = parseOpenApiSpec(FIXTURE_SPEC)
  const createWidget = operations.find((op) => op.operationId === "createWidget")
  const searches = createWidget.requestBodyProperties.searches
  assert.equal(searches.type, "array")
  assert.equal(searches.items.type, "object")
  const itemProps = searches.items.properties
  assert.equal(itemProps.query.type, "string")
  assert.equal(itemProps.query.required, true)
  assert.equal(itemProps.query.description, "The search query")
  assert.equal(itemProps.max_results.type, "integer")
  assert.equal(itemProps.max_results.required, false)
})

test("numeric schema limits pass through; default does not", () => {
  const { operations } = parseOpenApiSpec(FIXTURE_SPEC)
  const getItem = operations.find((op) => op.operationId === "getItem")
  const wait = getItem.parameters.find((p) => p.name === "wait")
  assert.equal(wait.schema.minimum, 0)
  assert.equal(wait.schema.maximum, 50)
  assert.equal("default" in wait.schema, false)

  const createWidget = operations.find((op) => op.operationId === "createWidget")
  const { name, attributes, searches } = createWidget.requestBodyProperties
  assert.equal(name.maxLength, 100)
  assert.equal(attributes.minItems, 1)
  assert.equal(attributes.maxItems, 20)
  assert.equal(searches.items.properties.max_results.minimum, 1)
  assert.equal(searches.items.properties.max_results.maximum, 10)
  assert.equal(searches.items.properties.query.maxLength, undefined)
})

const NESTED_SPEC = `
openapi: 3.1.0
info:
  title: Nested fixture
paths:
  /enrich:
    post:
      operationId: enrich
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                output:
                  $ref: "#/components/schemas/OutputSpec"
                  description: Call-site description wins
                note:
                  type: [string, "null"]
components:
  schemas:
    OutputSpec:
      type: object
      description: Component description
      additionalProperties:
        $ref: "#/components/schemas/ColumnConfig"
    ColumnConfig:
      type: object
      properties:
        prompt:
          type: string
        run_when:
          type: string
          enum: [always, any_filled, all_filled, dynamic]
        run_when_config:
          type: object
          properties:
            match_mode:
              type: string
              enum: [all, any]
            rules:
              type: array
              items:
                type: object
                properties:
                  column:
                    type: string
                  condition:
                    type: string
                required: [column, condition]
      required: [prompt]
`

test("map-like objects and nested objects are carried recursively", () => {
  const { operations } = parseOpenApiSpec(NESTED_SPEC)
  const { output, note } = operations[0].requestBodyProperties
  assert.equal(output.type, "object")
  assert.equal(output.description, "Call-site description wins")
  assert.equal(output.properties, undefined)
  const column = output.additionalProperties
  assert.equal(column.type, "object")
  assert.equal(column.properties.prompt.required, true)
  assert.deepEqual(column.properties.run_when.enum, ["always", "any_filled", "all_filled", "dynamic"])
  const rules = column.properties.run_when_config.properties.rules
  assert.equal(rules.type, "array")
  assert.equal(rules.items.properties.column.required, true)
  assert.equal(rules.items.properties.condition.required, true)
  assert.equal(note.type, "string")
  assert.equal(note.nullable, true)
})

test("additionalProperties: false marks a node closed; open objects are not marked", () => {
  const spec = NESTED_SPEC.replace(
    "      required: [prompt]\n",
    "      required: [prompt]\n      additionalProperties: false\n",
  )
  const closedColumn = parseOpenApiSpec(spec).operations[0].requestBodyProperties.output.additionalProperties
  assert.equal(closedColumn.closed, true)
  const openColumn = parseOpenApiSpec(NESTED_SPEC).operations[0].requestBodyProperties.output.additionalProperties
  assert.equal(openColumn.closed, undefined)
})

test("info.x-mcp-help becomes helpTopics; non-string and unsafe keys are dropped", () => {
  const spec = FIXTURE_SPEC.replace(
    "description: Fixture for parser tests",
    [
      "description: Fixture for parser tests",
      "  x-mcp-help:",
      "    overview: |",
      "      # Overview",
      "",
      "",
      "",
      "      Body text.",
      "    limits: 42",
      '    "bad key!": text',
    ].join("\n"),
  )
  const { helpTopics } = parseOpenApiSpec(spec)
  assert.deepEqual(Object.keys(helpTopics), ["overview"])
  assert.equal(helpTopics.overview, "# Overview\n\nBody text.")
})

test("helpTopics is empty when the spec has no x-mcp-help", () => {
  assert.deepEqual(parseOpenApiSpec(FIXTURE_SPEC).helpTopics, {})
})

test("x-mcp-description replaces description for the tool; description is the fallback", () => {
  const spec = NESTED_SPEC.replace(
    "      operationId: enrich\n",
    "      operationId: enrich\n      description: Long docs-site text\n      x-mcp-description: Short MCP text\n",
  )
  assert.equal(parseOpenApiSpec(spec).operations[0].description, "Short MCP text")
  const fallback = NESTED_SPEC.replace(
    "      operationId: enrich\n",
    "      operationId: enrich\n      description: Long docs-site text\n",
  )
  assert.equal(parseOpenApiSpec(fallback).operations[0].description, "Long docs-site text")
})

const REF_PARAM_SPEC = `
openapi: 3.1.0
info:
  title: Ref Param API
paths:
  /runs/{id}:
    get:
      operationId: getRun
      summary: get run
      parameters:
        - $ref: "#/components/parameters/RunIdPath"
        - name: wait
          in: query
          required: false
          schema:
            type: integer
  /broken/{id}:
    get:
      operationId: getBroken
      summary: broken ref
      parameters:
        - $ref: "#/components/parameters/DoesNotExist"
components:
  parameters:
    RunIdPath:
      name: id
      in: path
      required: true
      description: The run id (run_...)
      schema:
        type: string
`

test("parameter-level $ref is resolved from components.parameters", () => {
  const { operations } = parseOpenApiSpec(REF_PARAM_SPEC)
  const getRun = operations.find((op) => op.operationId === "getRun")
  assert.ok(getRun)
  const idParam = getRun.parameters.find((p) => p.name === "id")
  assert.ok(idParam, "$ref parameter should resolve to its component")
  assert.equal(idParam.in, "path")
  assert.equal(idParam.required, true)
  assert.equal(idParam.description, "The run id (run_...)")
  assert.ok(getRun.parameters.some((p) => p.name === "wait" && p.in === "query"))
})

test("unresolvable parameter $ref is skipped, not emitted as 'undefined'", () => {
  const { operations } = parseOpenApiSpec(REF_PARAM_SPEC)
  const getBroken = operations.find((op) => op.operationId === "getBroken")
  assert.ok(getBroken)
  assert.equal(getBroken.parameters.length, 0)
  assert.ok(!getBroken.parameters.some((p) => String(p.name) === "undefined"))
})

test("operation-level deprecated flag is surfaced; absent means false", () => {
  const { operations } = parseOpenApiSpec(FIXTURE_SPEC)
  const deleteItem = operations.find((op) => op.operationId === "deleteItem")
  const getItem = operations.find((op) => op.operationId === "getItem")
  assert.equal(deleteItem.deprecated, true)
  assert.equal(getItem.deprecated, false)
})

test("x-mcp-destructive is surfaced as a boolean override; absent means undefined", () => {
  const { operations } = parseOpenApiSpec(FIXTURE_SPEC)
  const deleteItem = operations.find((op) => op.operationId === "deleteItem")
  const getItem = operations.find((op) => op.operationId === "getItem")
  assert.equal(deleteItem.destructive, false)
  assert.equal(getItem.destructive, undefined)
})

test("x-mcp-open-world is surfaced as a boolean; absent means undefined", () => {
  const { operations } = parseOpenApiSpec(FIXTURE_SPEC)
  const createWidget = operations.find((op) => op.operationId === "createWidget")
  const getItem = operations.find((op) => op.operationId === "getItem")
  assert.equal(createWidget.openWorld, true)
  assert.equal(getItem.openWorld, undefined)
})

test("instructions fall back to info.description when x-mcp-instructions is absent", () => {
  const { instructions } = parseOpenApiSpec(FIXTURE_SPEC)
  assert.equal(instructions, "Fixture for parser tests")
})

test("info.x-mcp-instructions replaces info.description as the MCP instructions", () => {
  const spec = FIXTURE_SPEC.replace(
    "description: Fixture for parser tests",
    "description: Long docs-site overview\n  x-mcp-instructions: |\n    Short cross-tool guidance.\n",
  )
  const { instructions } = parseOpenApiSpec(spec)
  assert.equal(instructions, "Short cross-tool guidance.")
})

test("every property name matches the provider-safe pattern", () => {
  const { operations } = parseOpenApiSpec(FIXTURE_SPEC)
  const pattern = /^[a-zA-Z0-9_.-]{1,64}$/
  for (const op of operations) {
    for (const p of op.parameters) assert.match(p.name, pattern)
    for (const key of Object.keys(op.requestBodyProperties)) assert.match(key, pattern)
  }
})
