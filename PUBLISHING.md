# Publishing riveter-mcp-server

User-run only — never push or publish from an agent (see the repo git rules).

One codebase ships three ways:

| Where | What | How |
| --- | --- | --- |
| `github.com/riveterhq/riveter-mcp` | public source mirror of this directory (directories and awesome-lists link here) | `.github/workflows/publish-clients.yml` (`mcp-mirror` job) on push to `main` |
| npm `riveter-mcp-server` | stdio server for `npx` | `.github/workflows/publish-clients.yml` on merge to `main` (by hand: `pnpm publish`) |
| MCP Registry `io.github.CodyWatters/riveter` | `server.json`: the npm package and the hosted `remotes` entry | `mcp-publisher publish` |

The hosted server (`https://mcp.riveterhq.com/mcp`) deploys itself from the monorepo's
`main` (Render `mcp-server`), independent of all three.

## One-time setup

1. Create the public GitHub repo `riveterhq/riveter-mcp` (empty: no README, no license;
   this directory provides both). Description: "MCP server for Riveter: enrich data,
   build datasets, scrape and search the web from Claude, ChatGPT, Cursor". Website:
   `https://docs.riveterhq.com`. Topics: `mcp`, `mcp-server`, `model-context-protocol`,
   `data-enrichment`, `web-scraping`.
2. Install the publisher: `brew install mcp-publisher`.
4. The workflow's `MIRROR_PUSH_TOKEN` secret must cover `riveter-mcp`
   (`docs/releasing-api-clients.md`, "One-time setup"); the `mcp-mirror` job fails with
   `403` until it does.

## Release checklist

1. Bump the version in every place it appears (keep them equal): `package.json` `version`,
   `server.json` `version` and `packages[0].version`, `SERVER_VERSION` in `src/server.ts`.
   `sdk/scripts/check-published-versions.mjs` fails CI when they disagree.
2. Commit to the monorepo as usual (the mirror is derived from the monorepo's `main`).
3. npm: `.github/workflows/publish-clients.yml` (`npm` job) publishes the package when the
   merged version is not on npm yet (`prepublishOnly` runs build + all tests, including
   spec-contract; `docs/releasing-api-clients.md`). By hand it is `cd mcp-server && pnpm publish`.

   The registry checks that the published package's `mcpName` equals `server.json`
   `name`, so npm must go first: run step 5 only after `npm view riveter-mcp-server
   version` shows the new version.
4. Mirror: the same workflow's `mcp-mirror` job pushes one snapshot commit of this
   directory onto the mirror's `main` (`sdk/scripts/push-mirror-snapshot.sh`; the
   monorepo's commits never reach the mirror) and tags `vX.Y.Z` when the mirror lacks
   that tag. By hand, from the monorepo root on `main`:

   ```bash
   commit=$(sdk/scripts/push-mirror-snapshot.sh mcp-server git@github.com:riveterhq/riveter-mcp.git "riveter-mcp-server X.Y.Z")
   git push git@github.com:riveterhq/riveter-mcp.git "${commit}:refs/tags/vX.Y.Z"
   ```

5. MCP Registry, from `mcp-server/`:

   ```bash
   mcp-publisher login github     # browser device flow; covers io.github.CodyWatters/*; tokens land in .mcpregistry_* (gitignored)
   mcp-publisher publish
   ```

6. Verify:

   ```bash
   npm view riveter-mcp-server version mcpName
   curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.CodyWatters/riveter" | jq '.servers[].server | {name, version}'
   ```

## Registry name

The registry name is `io.github.CodyWatters/riveter`, permanently. Directories key on it,
and the registry lets only one name own `https://mcp.riveterhq.com/mcp`. 0.3.4 tried to
move to `io.github.riveterhq/riveter-mcp`, which failed with "remote URL ... is already used
by server io.github.CodyWatters/riveter" (2026-10-27). Deprecating the old entry does not free
the URL; only registry maintainers can. npm `riveter-mcp-server@0.3.4` is the one release
whose `mcpName` says `io.github.riveterhq/riveter-mcp`.
