---
description: Add a knowledge source (public website, SharePoint, OneDrive, or a locally uploaded file) to a locally-cloned Copilot Studio agentic-loop agent by writing the modern capabilities/knowledge YAML.
argument-hint: A URL (website / SharePoint / OneDrive) or a local file path, plus an optional name/description
allowed-tools: Read, Write, Glob, Grep, Bash(cp *), Bash(Copy-Item *)
---

# Add a Knowledge Source

You are a workflow that adds a **knowledge source** to a locally-cloned **Copilot Studio
agentic-loop** agent by writing modern `capabilities/knowledge` YAML. You discover the agent,
classify the requested source, normalize its URL, and write a `*.mcs.yml` component that matches the
schema the platform produces when a source is added in the browser and cloned locally. You never
invent behavior the files do not support.

Initial request: $ARGUMENTS

Supports four source kinds: **Public Website**, **SharePoint**, **OneDrive**, and **Uploaded file**.

---

## Core Process

### 1. Locate the target agent (blocking)

1. Auto-discover the cloned agent with `Glob: **/settings.mcs.yml`. A cloned agentic-loop workspace
   contains `settings.mcs.yml` at its root. **Never hardcode an agent name.**
2. If none is found, tell the user this command needs a **locally-cloned agentic-loop agent** (clone
   one with `pac copilot clone`, or use `/migrate`). Stop.
3. If several are found, ask the user which agent to add the knowledge to.
4. Read the agent's **`schemaName`** from `settings.mcs.yml` (e.g. `crbab_guitarcoach_dcF_b3`). This
   is the filename prefix for source-backed knowledge components.
5. The knowledge folder is `<agent>/capabilities/knowledge/`. Create it if it does not exist.
   Uploaded files additionally use `<agent>/capabilities/knowledge/files/`.

### 2. Parse the arguments

Extract from `$ARGUMENTS`:

- The **URL** or **local file path** of the source.
- An optional **name** and/or **description**.

### 3. Classify the source type

Decide the source `kind` from the input:

| Input | Detected type | `source.kind` | Notes |
|---|---|---|---|
| Host contains **`-my.sharepoint.com/personal/`** | **OneDrive** | `SharePointKnowledgeSource` | OneDrive for Business is a personal SharePoint site. Always `targetKind: File`. |
| Host contains **`.sharepoint.com`** (not `-my`) | **SharePoint** | `SharePointKnowledgeSource` | `targetKind: File` for a single file, `targetKind: Folder` for a folder/library. |
| Any other **`http(s)://`** URL | **Public Website** | `WebsiteKnowledgeSource` | No `targetKind`. |
| A **local file path** that exists on disk | **Uploaded file** | *(none — sidecar only)* | Copy the file into `files/` and write a metadata-only sidecar (see step 6). |

**File vs Folder** (SharePoint/OneDrive): if the URL ends in a document (has a file extension such as
`.docx`, `.pdf`, `.pptx`, `.xlsx`, `.txt`), use `targetKind: File`. If it points at a folder or
document library, use `targetKind: Folder` and include an (empty) `additionalSearchTerms:` line.

### 4. Normalize SharePoint / OneDrive URLs

Copilot Studio needs a direct path — not a browser UI URL. Normalize before writing:

| URL pattern | Action |
|---|---|
| **Direct path** (`/sites/.../Shared%20Documents/...` or `/personal/.../Documents/...`) | **Use as-is** — already correct. |
| **`AllItems.aspx` with `?id=` param** | **Extract and decode** the `id` query parameter to get the path, then prepend the origin (`https://<host>`) to build the direct path. Drop all query params (`?id=`, `&viewid=`, etc.). |
| **Sharing link** (`/:f:/s/...`, `/:w:/...`, `/:x:/...`, `/:b:/...`) | **Cannot convert** — these are opaque tokens with no extractable path. Ask the user: *"That's a sharing link — I can't extract the folder/file path from it. Open the item in SharePoint/OneDrive, copy the URL from the browser address bar, and paste it here."* |

**Encoding:** spaces in the final `siteUrl` must be `%20` (e.g. `Shared%20Documents`, not
`Shared Documents`).

### 5. Generate the YAML and save it

Every source-backed component starts with an `mcs.metadata:` block, then
`kind: KnowledgeSourceConfiguration`, then a `source:` block. Use these exact shapes:

**Public Website** (`WebsiteKnowledgeSource`):

```yaml
mcs.metadata:
  componentName: https://en.wikipedia.org/wiki/Electric_guitar
  description: This knowledge source searches information on the web found in https://en.wikipedia.org/wiki/Electric_guitar website
kind: KnowledgeSourceConfiguration
source:
  kind: WebsiteKnowledgeSource
  siteUrl: https://en.wikipedia.org/wiki/Electric_guitar
```

**SharePoint — single file** (`targetKind: File`):

```yaml
mcs.metadata:
  componentName: Circle_of_fifths.docx
  description: This knowledge source provides information found in Circle_of_fifths.docx SharePoint.
kind: KnowledgeSourceConfiguration
source:
  kind: SharePointKnowledgeSource
  siteUrl: https://contoso.sharepoint.com/sites/MySite/Shared%20Documents/Circle_of_fifths.docx
  targetKind: File
```

**SharePoint — folder / library** (`targetKind: Folder`):

```yaml
mcs.metadata:
  componentName: Travel-Italy
  description: This knowledge source provides information found in the Travel-Italy SharePoint folder.
kind: KnowledgeSourceConfiguration
source:
  kind: SharePointKnowledgeSource
  siteUrl: https://contoso.sharepoint.com/sites/MySite/Shared%20Documents/Travel-Italy
  additionalSearchTerms:
  targetKind: Folder
```

**OneDrive — file** (`SharePointKnowledgeSource` on the `-my` personal site, `targetKind: File`):

```yaml
mcs.metadata:
  componentName: popular_guitar_brands.docx
  description: This knowledge source provides information found in popular_guitar_brands.docx.
kind: KnowledgeSourceConfiguration
source:
  kind: SharePointKnowledgeSource
  siteUrl: https://contoso-my.sharepoint.com/personal/user_contoso_onmicrosoft_com/Documents/popular_guitar_brands.docx
  targetKind: File
```

**Metadata rules:**

- `componentName` — a friendly identifier: the file name for files, or the full URL for websites.
- `description` — describe the **subject matter** the source covers, not just its name. This is what
  the orchestrator uses to decide when to search the source, so write it to be genuinely
  descriptive (e.g. *"HR leave policies and employee entitlements"* is better than *"HR docs"*).

**Filename & location** (source-backed sources):

- Save to `capabilities/knowledge/<schemaName>.<slug>_<id>.mcs.yml`.
- `<schemaName>` — the agent's schema name from step 1 (e.g. `crbab_guitarcoach_dcF_b3`).
- `<slug>` — the `componentName` with non-alphanumeric/underscore characters removed
  (e.g. `popular_guitar_brands.docx` → `popular_guitar_brandsdocx`;
  `https://en.wikipedia.org/wiki/Electric_guitar` → `httpsenwikipediaorgwikiElectric_guitar`).
- `<id>` — a short unique alphanumeric suffix (e.g. `TzEHOdEZsOmJ4QXxs0Quc`) to keep the filename
  unique. When **editing** an existing component, keep its existing filename and suffix.

### 6. Uploaded file (local file → knowledge)

When the input is a **local file path** (not a URL), add it as an uploaded-file knowledge source:

1. Copy the actual file into `capabilities/knowledge/files/` (preserve its name and extension).
2. Next to it, write a **metadata-only** sidecar named `capabilities/knowledge/files/<slug>_<id>.mcs.yml`
   (note: uploaded-file sidecars do **not** carry the `<schemaName>.` prefix, and contain **no**
   `kind:`/`source:` block):

   ```yaml
   mcs.metadata:
     componentName: electric-guitar-history.md
     description: This knowledge source searches information contained in electric-guitar-history.md
   ```

   - `componentName` — the file name with extension.
   - `<slug>` — the file name with non-alphanumeric characters removed
     (e.g. `electric-guitar-history.md` → `electricguitarhistorymd`).
3. Supported document types include PDF, Word (`.docx`), PowerPoint (`.pptx`), plain text, and
   Markdown. Ensure PDFs contain selectable text (scanned/image-only PDFs are not searchable).

### 7. Confirm

Tell the user what was created: the source kind, the resolved `siteUrl` (or copied file), and the
path of the written `*.mcs.yml`. Remind them the agent must be re-packed/pushed and (re)published for
the new knowledge to take effect.

---

## Knowledge Best Practices

- **One source per content domain.** Prefer several narrow, well-described sources over one broad
  one; avoid overlapping sources covering the same content — it degrades relevance ranking.
- **Descriptions matter.** The orchestrator reads each source's `description` to decide when to
  search it. Write it to clearly describe the subject matter covered.
- **Public websites** define a **search scope**, not a specific page, and are best kept shallow
  (a couple of path levels). The site must be publicly accessible (no login).
- **SharePoint / OneDrive permissions are enforced at runtime.** These sources use the **end user's**
  delegated permissions — each user who chats with the agent must already have access to the file or
  library in SharePoint/OneDrive, or the agent returns nothing for them. (This is why a file can work
  for the author but appear empty for other users.)
- **Content quality.** Use documents with clear headings/titles; keep each document focused on one
  topic; avoid image-only or table-only files.
- **Test after adding.** Ask the agent a representative question and verify it retrieves and cites the
  new source.

## Limitations

**This command creates Public Website, SharePoint, OneDrive, and uploaded-file knowledge sources.**

Other knowledge types must be configured through the Copilot Studio UI (they require Power Platform
setup) and then cloned locally:

- Dataverse tables
- AI Search
- SQL Server
- Microsoft Graph connectors (registered in the M365 admin center)

For those, tell the user to create the source in the portal, then re-clone/pull the agent to edit it
here.
