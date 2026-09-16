---
description: Add a knowledge source (public website, SharePoint, OneDrive, or a locally uploaded file) to a locally-cloned Copilot Studio agentic-loop agent by writing the modern capabilities/knowledge YAML.
argument-hint: A URL (website / SharePoint / OneDrive) or a local file path, plus an optional name/description
allowed-tools: Read, Write, Glob, Grep, Bash(cp *), Bash(Copy-Item *), Bash(node *verify-knowledge-access.bundle.js*)
---

# Add a Knowledge Source

You are a workflow that adds a **knowledge source** to a locally-cloned **Copilot Studio
agentic-loop** agent by writing modern `capabilities/knowledge` YAML. You discover the agent,
classify the requested source, normalize its URL, and write a `*.mcs.yml` component. You never invent
behavior the files do not support.

Initial request: $ARGUMENTS

Supports four source kinds: **Public Website**, **SharePoint**, **OneDrive**, and **Uploaded file**.

## Authoritative schema — read this first

The exact YAML for every source kind, the `capabilities/knowledge` file layout, filename
conventions, SharePoint/OneDrive URL normalization, best practices, and limitations live in a single
shared reference — **`reference/knowledge-schema.md`**. It is the source of truth; the
`copilot-studio-architect` agent uses the same file, so the two never drift. **Read it before writing
any YAML** and follow it exactly.

Resolve its path via the plugin root: read
`path.join(os.homedir(), '.copilot-studio-cli', 'plugin-paths.json')` to get `pluginRoot` for the
current `mcs-assistant` plugin, then read `path.join(pluginRoot, 'reference', 'knowledge-schema.md')`.
If `plugin-paths.json` cannot be read, fall back to locating `reference/knowledge-schema.md` under the
installed plugin directory.

---

## Core Process

### 1. Locate the target agent (blocking)

1. Auto-discover the cloned agent with `Glob: **/settings.mcs.yml`. A cloned agentic-loop workspace
   contains `settings.mcs.yml` at its root. **Never hardcode an agent name.**
2. If none is found, tell the user this command needs a **locally-cloned agentic-loop agent** (clone
   one with `pac copilot clone`, or use `/migrate`). Stop.
3. If several are found, ask the user which agent to add the knowledge to.
4. Read the agent's **`schemaName`** from `settings.mcs.yml` (e.g. `crbab_guitarcoach_dcF_b3`) — it is
   the filename prefix for source-backed knowledge components.
5. The knowledge folder is `<agent>/capabilities/knowledge/` (create it if missing). Uploaded files
   additionally use `<agent>/capabilities/knowledge/files/`.

### 2. Parse the arguments

Extract from `$ARGUMENTS`:

- The **URL** or **local file path** of the source.
- An optional **name** and/or **description**.

### 3. Classify, build, and save (per `reference/knowledge-schema.md`)

1. **Classify** the input into one of the four source kinds:
   - `-my.sharepoint.com/personal/…` → **OneDrive** (`SharePointKnowledgeSource`, `targetKind: File`)
   - other `*.sharepoint.com` → **SharePoint** (`targetKind: File` for a file, `Folder` for a folder/library)
   - other `http(s)://` URL → **Public Website** (`WebsiteKnowledgeSource`)
   - a local file path that exists → **Uploaded file** (copy into `files/` + metadata-only sidecar)
2. **Normalize** SharePoint/OneDrive URLs (direct path, `AllItems.aspx?id=` decode, sharing-link
   refusal, `%20` encoding) exactly as the reference specifies.
3. **(Optional) Verify access** — for **SharePoint/OneDrive** sources only, you may pre-check that
   the link is valid and the signed-in user can read it, before writing YAML (see "Optional access
   pre-check" below). This is opt-in and best-effort: skip it silently if it isn't configured.
4. **Generate** the YAML for the matching source kind using the reference's shapes and metadata
   rules (`componentName`, plus a genuinely descriptive `description`).
5. **Save** using the reference's filename convention:
   - source-backed → `capabilities/knowledge/<schemaName>.<slug>_<id>.mcs.yml`
   - uploaded file → copy the file into `capabilities/knowledge/files/`, then write the
     metadata-only sidecar `capabilities/knowledge/files/<slug>_<id>.mcs.yml`

### 4. Confirm

Tell the user what was created: the source kind, the resolved `siteUrl` (or copied file), and the
path of the written `*.mcs.yml`. Remind them the agent must be re-packed/pushed and (re)published for
the new knowledge to take effect. For source types not supported here (Dataverse, AI Search, SQL
Server, Graph connectors), point them to the Limitations section of the reference.

## Optional access pre-check (SharePoint / OneDrive)

For SharePoint/OneDrive links you can verify **up front** that the link resolves and the **signed-in
(author) user** can read it — without downloading the file — via a single Microsoft Graph call
(`GET /shares/{id}/driveItem`). This is **opt-in** (offer it, or run it when the user asks); never
block adding the source on it.

**⚠️ Delegated-permissions caveat — always state this.** SharePoint/OneDrive knowledge is retrieved
at runtime using **each end user's** permissions. This check runs as the author, so a ✅ result
confirms **your** access only — it does **not** guarantee end users of the agent can access the item.
Always pair the result with a reminder to ensure end users have access in SharePoint/OneDrive.

**How to run it.** Resolve `pluginRoot` from
`path.join(os.homedir(), '.copilot-studio-cli', 'plugin-paths.json')` (as in step "Authoritative
schema" above), then:

```bash
node "<pluginRoot>/scripts/verify-knowledge-access.bundle.js" --agent-dir "<agentDir>" "<url>"
```

- Add `--dry-run` to resolve the plan (encoded share id, Graph endpoint, scopes, `needsClientId`)
  **without** authenticating — useful to check setup first.
- It reuses the same per-agent Entra **public-client app id** the `/chat` skill saves. That app
  registration must **also** have the delegated Microsoft Graph permissions **`Files.Read.All`** and
  **`Sites.Read.All`** consented, and must be an app the user **owns** in the tenant. If
  `needsClientId` is true or auth/permission errors come back, tell the user this is an **optional**
  step, explain the missing setup, and **continue** adding the source anyway.
- **`AADSTS65002` in an `error`** means the `--client-id` is a Microsoft **first-party/sample** app,
  which cannot obtain Graph tokens. Tell the user to supply **their own** Entra app registration
  (single-tenant, public client flows enabled, delegated Graph `Files.Read.All` + `Sites.Read.All`
  consented). An app id that works for `/chat` (preauthorized for the Power Platform API) is **not**
  automatically valid for Graph. This is a setup issue, not a failure of the source — continue.

**Interpreting the JSON `status`:**

| `status` | Meaning | What to tell the user |
|---|---|---|
| `accessible` | Link valid; author can read it | ✅ proceed — plus the end-user caveat above |
| `forbidden` | Access denied — no access **or** the link doesn't resolve (Graph `/shares` returns 403 for both) | ⚠️ re-copy the URL from the browser, confirm you (and end users) have access, then retry — you can still add it, but it returns nothing without access |
| `notfound` | Link didn't resolve (uncommon — `/shares` usually returns `forbidden` for bad links) | ❌ likely a wrong/renamed URL — re-copy it from the browser address bar |
| `skipped` | Not a SharePoint/OneDrive URL | no check needed |
| `error` | Setup/auth/network problem | note it's optional; continue adding the source |
