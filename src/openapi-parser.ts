import { parse as parseYaml } from "yaml";

// Numeric JSON Schema limits carried into the tool schema so clients can
// reject an over-limit call before it hits the API (e.g. `attributes`
// maxItems, `wait` maximum). `default` is deliberately NOT carried: it would
// make the MCP server send the value on every call instead of leaving the
// field out.
export interface SchemaConstraints {
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
}

export interface OpenApiParameter {
  name: string;
  in: "query" | "path" | "header";
  required: boolean;
  description: string;
  schema: { type: string; enum?: string[] } & SchemaConstraints;
}

// One node of a request-body schema, resolved ($ref-free) and recursive, so a
// nested shape like `output: { <column>: { run_when_config: { rules: [...] } } }`
// reaches the tool schema intact. Only the JSON Schema subset the specs use is
// carried: scalar types, enum, array items, object properties, and map-like
// objects (`additionalProperties`). oneOf/anyOf/allOf are not supported in
// request bodies.
export interface SchemaNode extends SchemaConstraints {
  type: string;
  description: string;
  // Required within the enclosing object.
  required: boolean;
  nullable?: boolean;
  enum?: string[];
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  // Value schema for map-like objects (keys are caller-chosen).
  additionalProperties?: SchemaNode;
  // `additionalProperties: false` in the spec. Only then may the server drop
  // keys it does not know; otherwise unknown keys pass through to the API,
  // which is the validator of record (e.g. tool-only params on a column).
  closed?: boolean;
}

export type OpenApiBodyProperty = SchemaNode;

// Stops runaway recursion on self-referencing schemas. Deeper nodes are served
// as untyped objects.
const MAX_SCHEMA_DEPTH = 8;

export interface OpenApiOperation {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  deprecated: boolean;
  // `x-mcp-destructive` spec extension. Undefined when the spec does not say,
  // so the server falls back to inferring from the HTTP method.
  destructive?: boolean;
  // `x-mcp-open-world` spec extension: the operation can push data to a
  // third-party endpoint (e.g. an optional `webhook_url`). Undefined when the
  // spec does not say; the server then treats the tool as closed-world.
  openWorld?: boolean;
  parameters: OpenApiParameter[];
  requestBodyProperties: Record<string, OpenApiBodyProperty>;
}

export interface ParseResult {
  operations: OpenApiOperation[];
  // Server-level MCP `instructions`. `info.x-mcp-instructions` when the spec
  // sets it (short, cross-tool guidance only); otherwise the full
  // `info.description`, which is written for the docs site and is long.
  instructions: string;
  // `info.x-mcp-help` topics for the generic `help` tool. Empty = no tool.
  helpTopics: Record<string, string>;
}

// Anthropic (and other providers) reject tool schemas whose property names
// don't match this pattern — and one bad name poisons the entire toolset.
// Skip any offending keys so a bad spec can never break consumers' requests.
const TOOL_PROPERTY_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

function isValidToolPropertyName(name: unknown): name is string {
  return typeof name === "string" && TOOL_PROPERTY_NAME_PATTERN.test(name);
}

function warnInvalidPropertyName(operationId: string, propertyName: unknown): void {
  console.error(
    `riveter-mcp-server: skipping property ${JSON.stringify(propertyName)} on ${operationId} — ` +
      `property names must match ${TOOL_PROPERTY_NAME_PATTERN} to be accepted by AI provider APIs`,
  );
}

function cleanDescription(desc: string | undefined): string {
  if (!desc) return "";
  return desc
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function resolveRef(spec: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
  // Resolve $ref like "#/components/schemas/Foo"
  const parts = ref.replace(/^#\//, "").split("/");
  let current: unknown = spec;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current as Record<string, unknown> | undefined;
}

// Parameters may be declared as `$ref: "#/components/parameters/Foo"`.
function resolveParameterRefs(
  spec: Record<string, unknown>,
  params: Record<string, unknown>[],
): Record<string, unknown>[] {
  return params.map((p) =>
    "$ref" in p ? resolveRef(spec, p.$ref as string) || p : p,
  );
}

const CONSTRAINT_KEYS: (keyof SchemaConstraints)[] = [
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "maxLength",
];

function extractConstraints(schema: Record<string, unknown> | undefined): SchemaConstraints {
  const constraints: SchemaConstraints = {};
  if (!schema) return constraints;
  for (const key of CONSTRAINT_KEYS) {
    const value = schema[key];
    if (typeof value === "number") constraints[key] = value;
  }
  return constraints;
}

function extractRequiredFields(schema: Record<string, unknown>): string[] {
  if (Array.isArray(schema.required)) {
    return schema.required as string[];
  }
  return [];
}

// OpenAPI 3.1 allows `type: [string, "null"]`; collapse to one type + nullable.
function primaryType(schema: Record<string, unknown>, fallback: string): { type: string; nullable: boolean } {
  const raw = schema.type;
  if (Array.isArray(raw)) {
    const nonNull = raw.filter((t) => t !== "null") as string[];
    return { type: nonNull[0] || fallback, nullable: raw.includes("null") };
  }
  if (typeof raw === "string") return { type: raw, nullable: false };
  if (schema.properties || schema.additionalProperties) return { type: "object", nullable: false };
  if (schema.items) return { type: "array", nullable: false };
  return { type: fallback, nullable: false };
}

function resolveSchema(
  spec: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return "$ref" in schema ? resolveRef(spec, schema.$ref as string) || schema : schema;
}

function buildSchemaNode(
  spec: Record<string, unknown>,
  rawSchema: Record<string, unknown>,
  required: boolean,
  operationId: string,
  depth: number,
): SchemaNode {
  const schema = resolveSchema(spec, rawSchema);
  const { type, nullable } = primaryType(schema, "string");
  // A description written next to a $ref is the call-site-specific one; prefer it.
  const description = (rawSchema.description ?? schema.description) as string | undefined;
  const node: SchemaNode = {
    type,
    description: cleanDescription(description),
    required,
    enum: schema.enum as string[] | undefined,
    ...extractConstraints(schema),
  };
  if (nullable) node.nullable = true;
  if (depth >= MAX_SCHEMA_DEPTH) return node;

  if (type === "array" && schema.items && typeof schema.items === "object") {
    node.items = buildSchemaNode(spec, schema.items as Record<string, unknown>, false, operationId, depth + 1);
  }
  if (type === "object") {
    const requiredFields = extractRequiredFields(schema);
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties) {
      node.properties = {};
      for (const [name, propSchema] of Object.entries(properties)) {
        if (!isValidToolPropertyName(name)) {
          warnInvalidPropertyName(operationId, name);
          continue;
        }
        node.properties[name] = buildSchemaNode(
          spec,
          propSchema,
          requiredFields.includes(name),
          operationId,
          depth + 1,
        );
      }
    }
    const additional = schema.additionalProperties;
    if (additional && typeof additional === "object") {
      node.additionalProperties = buildSchemaNode(
        spec,
        additional as Record<string, unknown>,
        false,
        operationId,
        depth + 1,
      );
    }
    if (additional === false) node.closed = true;
  }
  return node;
}

// `info.x-mcp-help`: topic → markdown, served by the generic `help` tool.
// Non-string values are dropped so a spec typo cannot break tool generation.
function parseHelpTopics(info: Record<string, unknown> | undefined): Record<string, string> {
  const raw = info?.["x-mcp-help"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const topics: Record<string, string> = {};
  for (const [topic, text] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidToolPropertyName(topic) || typeof text !== "string") continue;
    const cleaned = cleanDescription(text);
    if (cleaned) topics[topic] = cleaned;
  }
  return topics;
}

function formatExamples(examples: Record<string, Record<string, unknown>> | undefined): string {
  if (!examples) return "";
  let text = "";
  for (const [, example] of Object.entries(examples)) {
    const summary = (example.summary as string) || "";
    const value = example.value;
    if (value) {
      text += `\n\n**Example${summary ? ` — ${summary}` : ""}:**\n${JSON.stringify(value, null, 2)}`;
    }
  }
  return text;
}

export function parseOpenApiSpec(specText: string): ParseResult {
  const spec = parseYaml(specText) as Record<string, unknown>;

  const info = spec.info as Record<string, unknown> | undefined;
  const instructions =
    cleanDescription(info?.["x-mcp-instructions"] as string | undefined) ||
    cleanDescription(info?.description as string | undefined);
  const helpTopics = parseHelpTopics(info);

  const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths) return { operations: [], instructions, helpTopics };

  const operations: OpenApiOperation[] = [];
  const httpMethods = ["get", "post", "put", "patch", "delete"];

  for (const [path, pathItem] of Object.entries(paths)) {
    // Shared parameters declared on the path item apply to every operation;
    // operation-level parameters override them by matching name + in.
    const pathLevelParams = resolveParameterRefs(
      spec,
      (pathItem.parameters as Record<string, unknown>[] | undefined) || [],
    );

    for (const method of httpMethods) {
      const operation = pathItem[method] as Record<string, unknown> | undefined;
      if (!operation) continue;

      const operationId = operation.operationId as string | undefined;
      if (!operationId) continue;

      // Parse parameters
      const operationParams = resolveParameterRefs(
        spec,
        (operation.parameters as Record<string, unknown>[] | undefined) || [],
      );
      const inheritedParams = pathLevelParams.filter(
        (shared) => !operationParams.some((p) => p.name === shared.name && p.in === shared.in),
      );
      const rawParams = [...inheritedParams, ...operationParams].filter((p) => {
        const paramName = p.name as string;
        if (!isValidToolPropertyName(paramName)) {
          warnInvalidPropertyName(operationId, paramName);
          return false;
        }
        return true;
      });
      const parameters: OpenApiParameter[] = rawParams.map((p) => {
        let paramSchema = p.schema as Record<string, unknown> | undefined;
        if (paramSchema && "$ref" in paramSchema) {
          paramSchema = resolveRef(spec, paramSchema.$ref as string) || paramSchema;
        }
        return {
          name: p.name as string,
          in: p.in as "query" | "path" | "header",
          required: (p.required as boolean) || false,
          description: cleanDescription(p.description as string | undefined),
          schema: {
            type: (paramSchema?.type as string) || "string",
            enum: paramSchema?.enum as string[] | undefined,
            ...extractConstraints(paramSchema),
          },
        };
      });

      // Parse request body properties and examples
      const requestBodyProperties: Record<string, OpenApiBodyProperty> = {};
      let examplesText = "";
      const requestBody = operation.requestBody as Record<string, unknown> | undefined;
      if (requestBody) {
        const content = requestBody.content as Record<string, Record<string, unknown>> | undefined;
        const jsonContent = content?.["application/json"];
        if (jsonContent) {
          const schema = jsonContent.schema as Record<string, unknown> | undefined;
          if (schema) {
            const root = buildSchemaNode(spec, schema, true, operationId, 0);
            Object.assign(requestBodyProperties, root.properties || {});
          }

          const examples = jsonContent.examples as Record<string, Record<string, unknown>> | undefined;
          examplesText = formatExamples(examples);
        }
      }

      // `x-mcp-description` is the MCP-only text; `description` is written for
      // the docs site (curl samples, section headings) and is the fallback.
      const mcpDescription =
        cleanDescription(operation["x-mcp-description"] as string | undefined) ||
        cleanDescription(operation.description as string | undefined);

      operations.push({
        operationId,
        method,
        path,
        summary: (operation.summary as string) || "",
        description: mcpDescription + examplesText,
        deprecated: operation.deprecated === true,
        destructive:
          typeof operation["x-mcp-destructive"] === "boolean"
            ? (operation["x-mcp-destructive"] as boolean)
            : undefined,
        openWorld:
          typeof operation["x-mcp-open-world"] === "boolean"
            ? (operation["x-mcp-open-world"] as boolean)
            : undefined,
        parameters,
        requestBodyProperties,
      });
    }
  }

  return { operations, instructions, helpTopics };
}
