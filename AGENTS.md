# mcp-server

The MCP server for the public API, shipped two ways from one codebase: the npm package [`riveter-mcp-server`](https://www.npmjs.com/package/riveter-mcp-server) (stdio, users run it via `npx`) and the hosted Streamable HTTP service at `https://mcp.riveterhq.com/mcp` (Render web service `mcp-server` in the root `render.yaml`, built from `Dockerfile`). Git rules: see root [`AGENTS.md`](../AGENTS.md) — diffs only, never commit/merge/push. Publishing to npm is user-run only.

## How it works

**Design contract** (full version: [`.cursor/rules/mcp-server.mdc`](../.cursor/rules/mcp-server.mdc)): this is a generic OpenAPI-to-MCP bridge. It must contain no endpoint-specific code — to change a tool, change the spec.

- `src/server.ts` — shared core: fetch + parse `https://docs.riveterhq.com/openapi.yaml` (served from [`../public/api_docs/`](../public/api_docs/) by the `api_docs` static site in `render.yaml`), generate one MCP tool per `operationId` (`src/openapi-parser.ts`), and `buildMcpServer({ parsedSpec, apiBaseUrl, bearerToken })`. Tool annotations are derived generically: `title` from `summary`, `readOnlyHint` from `GET`, `destructiveHint` from `DELETE` or the spec extension `x-mcp-destructive`, `openWorldHint` from the spec extension `x-mcp-open-world` (default false; set on operations that read the public web or accept a `*webhook_url`). Server `instructions` = the spec's `info.x-mcp-instructions` (short, cross-tool guidance; fallback `info.description`). A tool's description = the operation's `x-mcp-description` when set (MCP-only text), else `description`. `info.x-mcp-help` (topic → markdown) is served by one generic `help` tool with a `topic` enum — long-form guidance and worked examples live there, not in tool descriptions. Nested body objects forward unknown keys to the API unless the spec marks them `additionalProperties: false`.
- `src/index.ts` — stdio entrypoint (npm `bin`). One server for the process, bearer token = `RIVETER_API_KEY`.
- `src/http.ts` — hosted entrypoint. Stateless Streamable HTTP at `MCP_PUBLIC_URL`'s path (`/mcp`): every request builds a throwaway server bound to the caller's `Authorization: Bearer ...` token and forwards it verbatim to the API. No token → `401` + `WWW-Authenticate: Bearer resource_metadata=...`. Serves `/.well-known/oauth-protected-resource` (and the `/mcp`-suffixed form) pointing at `OAUTH_ISSUER_URL`, plus `/healthz`. Re-fetches the spec every `SPEC_REFRESH_INTERVAL_MS` (10 min). Rejects foreign `Origin` headers. Holds no secrets.
- Spec changes reach users at their next MCP client restart (stdio) or within 10 minutes (hosted) — no republish or redeploy needed. Republish/redeploy only for parser/behavior changes.
- `RIVETER_OPENAPI_URL` also takes a `file://` URL (`fetchAndParseSpec` reads it from disk), for a spec that is not served anywhere. Local development reads the Rails dev server's copy instead: the gitignored `.cursor/mcp.json` `riveter-local` entry (stdio) and the root `Procfile.dev` `mcp_server` process (`pnpm run dev:http:local`, hosted mode on :8080 with `RIVETER_API_BASE_URL=http://localhost:3000/v1`) both point at `http://localhost:3000/api_docs/openapi.yaml`.
- The hosted server is also the tool source of Rails' in-app assistant (`Assistant::McpServerUrl`, `ASSISTANT_MCP_SERVER_URL` = `https://mcp.riveterhq.com/mcp`), an ordinary MCP client of it with a per-turn bearer (a signed `ast_` token the Rails API accepts next to `sk_riv_` keys; the server forwards it verbatim like any bearer).
- The catalog is the current spec's 38 operations plus `help`: the dataset operations under the `Datasets` tag, the legacy pipeline reachable only through a legacy id (the response then carries `legacy`), and the list-building operations that only reach the legacy generation (`build_dataset_legacy_body`, `extend_dataset`, `build_dataset_for_enrichment`, `enrichments_summary`) in `openapi.legacy.yaml`, served only when `RIVETER_OPENAPI_URL` points at it. The API answers `403 feature_not_enabled` for an account that has not migrated to Datasets, and the message, the `datasets` / `errors` help topics, and the tag description say to open Datasets in the app and click "Migrate to Datasets". Nothing is `deprecated: true`. `chatgpt-app-submission.json` and `chatgpt-tool-annotation-justifications.md` list the same 39 tools with annotations derived from the spec; update them with the spec's flags.
- `test/spec-contract.test.mjs` parses the repo's real `openapi.yaml` and `openapi.legacy.yaml`, and fails if a spec change would break tool generation (unresolved path params, provider-unsafe property names) or blow the context budgets (instructions ≤ 850 chars, tool description ≤ 6000 chars, `tools/list` ≤ the measured size + 2K per spec — the constants and their measurement dates are in the test —, no docs-site sections repeated per tool). Run it whenever either changes; after adding or removing an operation, re-measure and set the ceiling again. `test/spec-source.test.mjs` covers the `file://` source.

## Run / test

```bash
pnpm --filter riveter-mcp-server test        # build + unit + stdio e2e + http e2e + spec-contract
pnpm --filter riveter-mcp-server typecheck
pnpm --filter riveter-mcp-server dev:http    # hosted server on :8080 (set MCP_PUBLIC_URL=http://localhost:8080/mcp)
```

Env vars: stdio — `RIVETER_API_KEY` (required), `RIVETER_API_BASE_URL`, `RIVETER_OPENAPI_URL`. Hosted — `PORT`, `MCP_PUBLIC_URL`, `OAUTH_ISSUER_URL`, `SPEC_REFRESH_INTERVAL_MS`, plus the two shared URL vars. See `README.md`.

## Publish

1. Bump the version in three places: `package.json`, `server.json` (two fields), and `SERVER_VERSION` in `src/server.ts`. `sdk/scripts/check-published-versions.mjs` fails CI when they disagree or when `src/` changed without a bump.
2. Merge to `main`. `.github/workflows/publish-clients.yml` (`npm` job) publishes the package when that version is not on npm yet — `prepublishOnly` runs build + all tests first; auth is npm trusted publishing (OIDC) or the `NPM_TOKEN` secret (`docs/releasing-api-clients.md`). Before merging, check the package's Trusted Publisher on npmjs.com is validated (not expired; a new one lasts 48 hours unpublished). Never publish from an agent (repo git rules); by hand it is `cd mcp-server && pnpm publish`.
3. MCP registry (`server.json`) publishes are by hand with `mcp-publisher` (`mcp-publisher login github && mcp-publisher publish` from this directory); its `.mcpregistry_*` tokens are gitignored and must never be committed. `server.json` lists the npm `packages` entry and the hosted `remotes` entry; publish it only after the npm version is out, because the registry checks the package's `mcpName` against `server.json` `name`.
4. The hosted service deploys itself from `main` (Render, `autoDeployTrigger: commit`).
5. The public source mirror `github.com/riveterhq/riveter-mcp` is the same workflow's `mcp-mirror` job (one snapshot commit of this directory onto the mirror's `main` per change, `sdk/scripts/push-mirror-snapshot.sh`, tagged `v<version>` when new; the monorepo's commits never reach the mirror). The registry name is `io.github.CodyWatters/riveter`, permanently (it owns the hosted URL in the registry; the move to `io.github.riveterhq/riveter-mcp` was refused). The one-time repo setup is by hand: [`PUBLISHING.md`](PUBLISHING.md).

## How to regenerate

Rebuild from: `package.json`, `Dockerfile`, `src/server.ts`, `src/index.ts`, `src/http.ts`, `src/openapi-parser.ts`, `test/`, `../render.yaml` (`mcp-server` service), `../Procfile.dev` (`mcp_server`), `../public/api_docs/openapi.yaml`, `../public/api_docs/openapi.legacy.yaml`.

Last verified: 2026-10-27
