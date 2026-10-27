# Publishing riveter-mcp-server

User-run only — never push or publish from an agent (see the repo git rules).

One codebase ships three ways:

| Where | What | How |
| --- | --- | --- |
| `github.com/riveterhq/riveter-mcp` | public source mirror of this directory (directories and awesome-lists link here) | `.github/workflows/publish-clients.yml` (`mcp-mirror` job) on push to `main` |
| npm `riveter-mcp-server` | stdio server for `npx` | `.github/workflows/publish-clients.yml` on merge to `main` (by hand: `pnpm publish`) |
| MCP Registry `io.github.riveterhq/riveter-mcp` | `server.json`: hosted `remotes` + the npm package | `mcp-publisher publish` |

The hosted server (`https://mcp.riveterhq.com/mcp`) deploys itself from the monorepo's
`main` (Render `mcp-server`), independent of all three.

## One-time setup

1. Create the public GitHub repo `riveterhq/riveter-mcp` (empty: no README, no license;
   this directory provides both). Description: "MCP server for Riveter: enrich data,
   build datasets, scrape and search the web from Claude, ChatGPT, Cursor". Website:
   `https://docs.riveterhq.com`. Topics: `mcp`, `mcp-server`, `model-context-protocol`,
   `data-enrichment`, `web-scraping`.
2. Make your riveterhq org membership **public** (github.com/orgs/riveterhq/people →
   your row → Public). `mcp-publisher` only grants the `io.github.riveterhq/*` namespace
   to public members.
3. Install the publisher: `brew install mcp-publisher`.
4. The workflow's `MIRROR_PUSH_TOKEN` secret must cover `riveter-mcp`
   (`docs/releasing-api-clients.md`, "One-time setup"); the `mcp-mirror` job fails with
   `403` until it does.

## Release checklist

1. Bump the version in four places (keep them equal): `package.json` `version`,
   `server.json` `version` and `packages[0].version`, `SERVER_VERSION` in `src/server.ts`.
2. Commit to the monorepo as usual (the mirror is derived from the monorepo's `main`).
3. npm: `.github/workflows/publish-clients.yml` (`npm` job) publishes the package when the
   merged version is not on npm yet (`prepublishOnly` runs build + all tests, including
   spec-contract; `docs/releasing-api-clients.md`). By hand it is `cd mcp-server && pnpm publish`.

   The registry checks that the published package's `mcpName` equals `server.json`
   `name`, so npm must go first.
4. Mirror: the same workflow's `mcp-mirror` job force-pushes
   `git subtree split --prefix=mcp-server` over the mirror's `main` and tags `vX.Y.Z`
   when the mirror lacks that tag. By hand, from the monorepo root:

   ```bash
   git subtree split --prefix=mcp-server -b riveter-mcp-sync
   git push --force git@github.com:riveterhq/riveter-mcp.git riveter-mcp-sync:main
   git tag vX.Y.Z riveter-mcp-sync
   git push git@github.com:riveterhq/riveter-mcp.git vX.Y.Z
   git tag -d vX.Y.Z && git branch -D riveter-mcp-sync
   ```

5. MCP Registry, from `mcp-server/`:

   ```bash
   mcp-publisher login github     # browser device flow; tokens land in .mcpregistry_* (gitignored)
   mcp-publisher publish
   ```

6. Verify:

   ```bash
   npm view riveter-mcp-server version mcpName
   curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.riveterhq/riveter-mcp" | jq '.servers[].server | {name, version}'
   ```

## Registry name history

Versions up to 0.3.3 used `io.github.CodyWatters/riveter` and were never published to the
registry. 0.3.4 moved to `io.github.riveterhq/riveter-mcp` to match the mirror repo.
Never change the name again after the first registry publish: directories key on it.
