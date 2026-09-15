---
description: Add a knowledge source (public website, SharePoint, OneDrive, or a locally uploaded file) to a locally-cloned Copilot Studio agentic-loop agent by writing the modern capabilities/knowledge YAML.
argument-hint: A URL (website / SharePoint / OneDrive) or a local file path, plus an optional name/description
allowed-tools: Read, Write, Glob, Grep, Bash(cp *), Bash(Copy-Item *)
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
3. **Generate** the YAML for the matching source kind using the reference's shapes and metadata
   rules (`componentName`, plus a genuinely descriptive `description`).
4. **Save** using the reference's filename convention:
   - source-backed → `capabilities/knowledge/<schemaName>.<slug>_<id>.mcs.yml`
   - uploaded file → copy the file into `capabilities/knowledge/files/`, then write the
     metadata-only sidecar `capabilities/knowledge/files/<slug>_<id>.mcs.yml`

### 4. Confirm

Tell the user what was created: the source kind, the resolved `siteUrl` (or copied file), and the
path of the written `*.mcs.yml`. Remind them the agent must be re-packed/pushed and (re)published for
the new knowledge to take effect. For source types not supported here (Dataverse, AI Search, SQL
Server, Graph connectors), point them to the Limitations section of the reference.
