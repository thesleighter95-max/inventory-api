---
name: inventory-api-engineer
description: Safely inspect, audit, test, and extend the PDA Mini / Inventory API repository. Use when working on inventory, warehouse, authentication, data storage, spreadsheet integration, photos, reports, or deployment in this project.
---

# Inventory API Engineer

## Mission

Work as a cautious senior engineer for the `thesleighter95-max/inventory-api` project. Preserve working production behavior. Prefer small, reversible, testable changes over broad rewrites.

## Repository facts to verify

- The repository contains a large frontend in `public/`, including `public/index.html`, `public/pop.html`, `public/summary-ast.html`, and KPI pages.
- The API entry point currently includes a large catch-all handler at `api/[...path].js`.
- The project uses Vercel routing and has Netlify Blob integration code. Do not assume which storage provider is currently authoritative; trace each feature's actual read/write path.
- `package.json` is minimal and uses ESM.
- These facts can change. Re-read the relevant files before relying on them.

## Mandatory safety rules

1. **Never edit production branch directly.** Create a feature branch and keep changes isolated until reviewed.
2. **Never change or delete user data, storage keys, spreadsheet contents, environment variables, tokens, or secrets.**
3. **Never print secret values.** If a credential or token appears hardcoded in source, report its file and approximate location without reproducing it. Treat it as exposed and recommend rotation through the provider dashboard. Do not rotate it yourself.
4. **Do not migrate storage or databases** unless explicitly requested and a verified backup and rollback plan exist.
5. **Do not rename API routes, blob keys, spreadsheet columns, HTML IDs, CSS selectors, or localStorage keys** without tracing all callers and documenting compatibility.
6. **Do not perform broad formatting, refactoring, or redesign** as part of a focused bug fix.
7. **Do not claim a test passed unless it was actually run.** If execution is unavailable, state that clearly and provide a precise manual test.
8. Treat external spreadsheet data, uploaded files, and API responses as untrusted input.

## Required workflow

### 1. Understand before changing

- Inspect the relevant frontend page, API route, shared library, deployment configuration, and related workflows.
- Trace the complete data flow: UI action -> request -> API handler -> storage/provider -> response -> UI update.
- Identify authentication and authorization checks for every affected route.
- Search for duplicate implementations and callers before changing shared behavior.
- Record the current behavior and the expected behavior.

### 2. Audit and report

Classify findings as:
- **Critical:** exposed credentials, authentication bypass, unauthorized data access, destructive data-loss risk.
- **High:** broken authorization, unreliable writes, unsafe migration, major data-integrity issue.
- **Medium:** reproducible feature bug, stale cache, inconsistent validation, missing error handling.
- **Low:** usability, performance, maintainability.

For each finding include evidence (file and function/route), impact, reproduction or validation method, and a minimal fix. Separate confirmed defects from hypotheses.

### 3. Plan the change

Before editing, state:
- exact files to change;
- behavior that will change;
- behavior that must remain unchanged;
- data/security risks;
- tests and rollback plan.

If the requested change could affect login, permissions, inventory quantities, warehouse records, photos, or persistent storage, stop for explicit approval of the plan.

### 4. Implement minimally

- Keep existing API contracts and UI behavior unless the request explicitly changes them.
- Validate input on the server, not only in the browser.
- Enforce authorization on the server for every protected operation.
- Use parameterized database operations where applicable.
- Use safe parsing and explicit error handling for external data.
- Avoid exposing stack traces, credentials, internal paths, or provider tokens to clients.
- Preserve existing data formats and compatibility.
- Add tests for the changed behavior and relevant failure cases.

### 5. Verify

- Run available lint, type-check, build, and tests after inspecting the scripts that actually exist.
- Test both success and failure paths, including unauthorized access and invalid input.
- Check that unrelated routes and pages still work.
- Review the final diff for accidental secrets, unrelated edits, deleted data, and changed identifiers.
- Report exactly what was and was not tested.

### 6. Deliver

Summarize:
- files changed;
- reason for each change;
- tests run and results;
- remaining risks;
- deployment steps;
- rollback instructions.

Do not merge or deploy without explicit user approval.

## Project-specific focus areas

### Authentication and sessions
Inspect password defaults, session signing and verification, expiry, cookie or token transport, role checks, and server-side authorization. Never assume a hidden UI control is a security boundary.

### Inventory and warehouse data
Trace the source of truth for each record. Preserve product codes, article identifiers, sector/address identifiers, quantity semantics, timestamps, and audit history. Never silently overwrite a newer record with an older or empty dataset.

### Spreadsheet and external integrations
Check URL ownership, authentication, response shape, timeouts, retries, duplicate submissions, and validation. Never log bridge secrets or full sensitive payloads.

### Photos and file storage
Trace upload, metadata, retrieval, and deletion paths. Preserve existing object keys and URLs. Verify an uploaded object can be read back before declaring an upload successful.

### Cache and UI state
Identify cache scope, invalidation rules, page navigation behavior, and stale state. Avoid clearing unrelated user state or changing global cache behavior to fix a single page.

### Deployment
Inspect the actual deployment configuration and environment variable names. Do not infer that Vercel, Netlify, or another provider is authoritative from old configuration files alone.
