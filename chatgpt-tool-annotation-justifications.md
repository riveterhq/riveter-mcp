# ChatGPT plugin submission: tool annotation justifications

Paste-ready text for the "Describe why ... is set to ..." fields in the OpenAI plugin submission portal (Scan Tools step). One block per tool; the line after each label is the value to copy.

Source of truth for the values: `openWorldHint` = `x-mcp-open-world` in `public/api_docs/openapi.yaml` (11 operations: the 7 that accept a webhook URL plus the 4 that read the public web); `destructiveHint` = `x-mcp-destructive` or a `DELETE` method (`stop_run`, `update_enrichment`, `delete_enrichment`, `update_dataset`, `delete_dataset`, `delete_dataset_rows`, `update_dataset_row`, `promote_dataset_column`); `readOnlyHint` = `GET` (and the MCP-only `help` tool). 40 tools: the 39 operations of the spec plus `help`. `chatgpt-app-submission.json` carries the same values; when the spec's flags change, update both files together.

Definitions used (MCP spec): read-only = does not modify its environment; open-world = may interact with external entities outside Riveter (the public web or a caller-supplied webhook endpoint); destructive = may perform irreversible updates or deletes.

History: v1.0.0 was rejected 2026-09-08 ("annotations do not appear to match the tool's behavior") with `quick_search`, `search_agent`, `scrape`, and `create_extraction` marked open-world false. They are now true. 2026-10-22: the 14 dataset operations, `enrichments_summary`, `delete_enrichment`, `list_tools`, and `help` added for the catalog published 2026-10-12 / 2026-10-16; `enrich`, `create_enrichment`, and `build_dataset` reworded for the dataset engine.

## enrich

Read Only (False)

Starts an enrichment run: creates a run record, writes cell values onto a dataset or result rows for inline input, and consumes credits.

Open World (True)

Runs AI agents that search and read the public web to fill in each cell, and accepts an optional `webhook_url` to which Riveter POSTs the finished results.

Destructive (False)

Only creates a new run and new cell values. Never deletes rows, columns, or configuration; existing enrichments and past runs are untouched.

## get_run

Read Only (True)

Returns the status of one run by id. No state changes, no credits.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## get_run_result

Read Only (True)

Returns the result rows of one run, optionally long-polling until complete. No state changes, no credits.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## stop_run

Read Only (False)

Changes a run's state from running to stopped.

Open World (False)

Acts only on a run inside the user's Riveter account; contacts no external system.

Destructive (True)

Stopping a run is irreversible. Cells not yet processed stay empty and the run cannot be resumed.

## list_runs

Read Only (True)

Lists runs in the account with filters. No state changes, no credits.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## runs_summary

Read Only (True)

Returns aggregate counts and credit usage over the account's runs. No state changes.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## list_enrichments

Read Only (True)

Lists the saved enrichments in the account. No state changes.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## create_enrichment

Read Only (False)

Creates a new saved enrichment (task prompt, columns, tools) in the account together with the empty dataset bound to it, or answers a dataset's own enrichment.

Open World (False)

Stores configuration inside Riveter only. It does not run anything, fetch any web page, or contact any external system.

Destructive (False)

Adds new records. Existing enrichments and datasets are not changed or removed.

## get_enrichment

Read Only (True)

Returns one enrichment's configuration. No state changes.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## update_enrichment

Read Only (False)

Modifies a saved enrichment's columns, prompts, or order.

Open World (False)

Changes configuration inside Riveter only. It does not run anything, fetch any web page, or contact any external system.

Destructive (True)

Can overwrite column prompts and delete columns (`delete: true`). Deleted columns and prior configuration are not recoverable.

## delete_enrichment

Read Only (False)

Deletes a saved enrichment from the account.

Open World (False)

Acts only on a record inside the user's Riveter account; contacts no external system.

Destructive (True)

Permanently removes the enrichment and its column configuration. The deletion cannot be undone.

## build_dataset

Read Only (False)

Creates a new dataset in the account from rows the caller sends, or starts a build run that generates rows from a description and consumes credits; either way a new dataset is stored.

Open World (True)

Generating rows researches the public web, and the call accepts optional webhook URLs to which Riveter POSTs the finished build or fill.

Destructive (False)

Creates a new dataset. Existing datasets and runs are not changed or removed.

## list_datasets

Read Only (True)

Lists the datasets in the account with their columns and row counts. No state changes.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## get_dataset

Read Only (True)

Returns one dataset's columns, row count, bound enrichment, and recent runs. No state changes.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## update_dataset

Read Only (False)

Renames the dataset, changes its index column, adds, renames, or removes input and output columns, and sets the per-row budget of its enrichment.

Open World (False)

Changes configuration inside Riveter only. It does not run anything, fetch any web page, or contact any external system.

Destructive (True)

Removing a column (`delete: true`) deletes every value stored under it, and a changed prompt marks the column's cells stale. Neither is recoverable.

## delete_dataset

Read Only (False)

Deletes a dataset with every row and cell it holds.

Open World (False)

Acts only on records inside the user's Riveter account; contacts no external system.

Destructive (True)

Permanently removes the dataset, its rows, and its cells. The deletion cannot be undone.

## list_dataset_rows

Read Only (True)

Lists a dataset's rows with their input values and cells, with cursor pagination. No state changes, no credits.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## get_dataset_summary

Read Only (True)

Counts a dataset's cells by state and its most common values per column. No state changes, no credits.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only aggregate; cannot modify or delete.

## add_dataset_rows

Read Only (False)

Appends rows the caller sends to a dataset. No credits.

Open World (False)

Writes inside Riveter only. It does not fetch any web page or contact any external system.

Destructive (False)

Append-only. Existing rows and cells are never removed or overwritten; duplicate rows are skipped.

## delete_dataset_rows

Read Only (False)

Deletes up to 100 rows, named by id or position, from a dataset.

Open World (False)

Acts only on records inside the user's Riveter account; contacts no external system.

Destructive (True)

Permanently removes the named rows and their cell values. The deletion cannot be undone.

## import_dataset_rows

Read Only (False)

Appends the rows of a caller-supplied CSV to a dataset. No credits.

Open World (False)

Writes inside Riveter only. It does not fetch any web page or contact any external system.

Destructive (False)

Append-only. Existing rows and cells are never removed or overwritten; duplicate rows are skipped.

## build_dataset_rows

Read Only (False)

Starts a build run that generates additional rows for an existing dataset and may start a fill run on them; consumes credits.

Open World (True)

Researches the public web to generate the rows, and accepts optional webhook URLs to which Riveter POSTs the finished build or fill.

Destructive (False)

Append-only. Existing rows and cells are never removed or overwritten; duplicate rows are skipped.

## update_dataset_row

Read Only (False)

Sets one row's input values and output cells by hand.

Open World (False)

Writes inside Riveter only; contacts no external system.

Destructive (True)

Overwrites the row's existing input values and cell values, and a `null` clears a cell. The previous values are not recoverable.

## promote_dataset_column

Read Only (False)

Converts an output column into an input column, moving every row's value with it.

Open World (False)

Changes configuration and stored values inside Riveter only; contacts no external system.

Destructive (True)

Removes the output column and its prompt from the enrichment. The values are kept as input values, but the column's configuration is not recoverable.

## export_dataset

Read Only (True)

Renders the dataset's rows and cells as a CSV, Excel, or JSON Lines file. No state changes, no credits.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## build_configured_dataset

Read Only (False)

Starts a run of a saved dataset configuration, creating new rows and consuming credits.

Open World (True)

Researches the public web to generate the rows, and accepts an optional `webhook_url` to which Riveter POSTs the results.

Destructive (False)

Creates a new dataset. The saved configuration and prior datasets are untouched.

## run_extraction

Read Only (False)

Starts an extraction run against a saved extraction plan, creating records and consuming credits.

Open World (True)

Fetches pages from the external website named in the plan, and accepts an optional `webhook_url` to which Riveter POSTs the extracted records.

Destructive (False)

Creates a new run and records. The plan and earlier runs are not modified or deleted.

## create_extraction

Read Only (False)

Creates a new extraction plan in the account; Riveter analyzes the target site to build it, consuming credits.

Open World (True)

Fetches arbitrary public web pages at the caller-supplied URL to plan the extraction. It interacts with external websites outside Riveter, though it only reads them.

Destructive (False)

Adds a new plan. Existing plans and runs are not changed or removed.

## get_extraction

Read Only (True)

Returns one extraction plan and its readiness. No state changes.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## list_monitors

Read Only (True)

Lists scheduled monitors in the account. No state changes.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## create_monitor

Read Only (False)

Creates a recurring schedule that will run an enrichment on a cadence and may start a run immediately.

Open World (True)

Each scheduled run researches the public web, and the monitor accepts an optional `webhook_url` to which Riveter POSTs results and diff alerts.

Destructive (False)

Adds a new monitor. Existing monitors, enrichments, and results are not changed or removed.

## get_monitor

Read Only (True)

Returns one monitor's schedule and status. No state changes.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## update_monitor

Read Only (False)

Changes a monitor's schedule, enabled state, or webhook.

Open World (True)

Can set or change `webhook_url`, which directs future scheduled results to an external third-party endpoint.

Destructive (False)

Pausing or rescheduling is fully reversible by calling the tool again. Nothing is deleted and no data is lost.

## list_monitor_runs

Read Only (True)

Lists the past runs of one monitor. No state changes.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## quick_search

Read Only (False)

Creates a search run in the account and consumes credits, so it is not side-effect free.

Open World (True)

Web search: queries the open internet and returns results from arbitrary external websites. Read-only toward those sites, but the domain of interaction is the public web, not a closed system.

Destructive (False)

Creates a new run with results. Deletes or overwrites nothing.

## search_agent

Read Only (False)

Starts an agent run that browses the web to answer one prompt; creates a run record and consumes credits.

Open World (True)

An agent that searches and browses arbitrary public websites to answer the prompt. It interacts with the open web; it only reads pages and does not post, submit forms, or message anyone.

Destructive (False)

Creates a new run with results. Deletes or overwrites nothing.

## scrape

Read Only (False)

Creates a scrape run in the account and consumes credits, so it is not side-effect free.

Open World (True)

Fetches the caller-supplied URL from the public internet and returns its text. It interacts with an arbitrary external website, though it only reads it and changes nothing there.

Destructive (False)

Creates a new run with the page content. Deletes or overwrites nothing.

## get_account

Read Only (True)

Returns the account's plan, credit balance, and API key metadata. No state changes.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify account, billing, or keys.

## list_tools

Read Only (True)

Lists the research tools an enrichment may use, with their prices and whether the account may use each. No state changes.

Open World (False)

Reads from the user's own Riveter account only; contacts no external system.

Destructive (False)

Read-only lookup; cannot modify or delete.

## help

Read Only (True)

Returns reference text about using the other tools. It calls no API and reads no account data.

Open World (False)

Static documentation bundled with the tool catalog; contacts no external system.

Destructive (False)

Documentation only; cannot modify or delete.
