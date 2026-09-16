/**
 * verify-knowledge-access.js — Opt-in pre-check for SharePoint/OneDrive knowledge links.
 *
 * Before adding a SharePoint or OneDrive file/folder as a knowledge source, this verifies two
 * things for the *signed-in (author) user*, without downloading the file:
 *   1. the link is valid (the item exists), and
 *   2. the signed-in user can read it.
 *
 * It does this with a single Microsoft Graph call:
 *     GET https://graph.microsoft.com/v1.0/shares/{shareId}/driveItem
 * where {shareId} is the "u!"-encoded item URL. A 200 means valid + accessible; 403 means the
 * item exists but the user has no access; 404 means the link is invalid / not found.
 *
 * IMPORTANT (delegated permissions): SharePoint/OneDrive knowledge is retrieved at runtime using
 * *each end user's* permissions. This check runs as the author, so a positive result confirms the
 * author's access only — it does NOT guarantee that end users of the agent can access the item.
 * The result therefore includes `checkedAs: "author"` and a note to that effect.
 *
 * Auth mirrors chat-with-agent: MSAL device-code against a public-client Entra app
 * (--client-id), reusing the per-agent app id saved in <pluginData>/chat-config.json. The app
 * registration must additionally have the delegated Microsoft Graph permissions
 * Files.Read.All and Sites.Read.All (admin- or user-consented) for the Graph call to succeed.
 *
 * Usage:
 *   node verify-knowledge-access.bundle.js --agent-dir <path> "<sharepoint-or-onedrive-url>"
 *   node verify-knowledge-access.bundle.js --agent-dir <path> --url <url> --client-id <appId>
 *   node verify-knowledge-access.bundle.js --tenant-id <guid> --client-id <appId> --url <url>
 *   node verify-knowledge-access.bundle.js --url <url> --dry-run     (encode + plan, no auth)
 *
 * Output (stdout): a single distilled JSON object:
 *   { status, url, checkedAs, item?, httpStatus?, note, ... }
 *   status ∈ "accessible" | "forbidden" | "notfound" | "skipped" | "error".
 * Diagnostics (stderr): human-readable progress + the device-code prompt.
 * Exit codes: 0 = a definitive determination was made (including forbidden/notfound/skipped),
 *             1 = an operational error (bad input, auth failure, network).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { PublicClientApplication } = require("@azure/msal-node");
const { createCachePluginWithFallback } = require("./msal-cache");

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(msg + "\n");
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function die(msg, extra) {
  emit(Object.assign({ status: "error", error: msg }, extra || {}));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Cloud -> Microsoft Graph host (national clouds use different Graph endpoints)
// ---------------------------------------------------------------------------

const GRAPH_HOST = {
  Prod: "graph.microsoft.com",
  FirstRelease: "graph.microsoft.com",
  Test: "graph.microsoft.com",
  Preprod: "graph.microsoft.com",
  Dev: "graph.microsoft.com",
  Exp: "graph.microsoft.com",
  Prv: "graph.microsoft.com",
  Gov: "graph.microsoft.us",
  GovFR: "graph.microsoft.us",
  High: "graph.microsoft.us",
  DoD: "dod-graph.microsoft.us",
  Mooncake: "microsoftgraph.chinacloudapi.cn",
};

function normalizeCloud(value) {
  if (!value) return "Prod";
  const found = Object.keys(GRAPH_HOST).find(
    (k) => k.toLowerCase() === String(value).toLowerCase()
  );
  return found || "Prod";
}

function graphHostForCloud(cloud) {
  return GRAPH_HOST[cloud] || GRAPH_HOST.Prod;
}

// Best-effort cloud inference from conn.json endpoints (default Prod). Mirrors chat-with-agent:
// only Test/Preprod/Dev are auto-detected; national clouds (Gov/DoD/China) are not inferred from
// these hosts (the patterns are ambiguous, e.g. "us-il107" in a commercial gateway host) and must
// be selected explicitly with --cloud.
function inferCloudFromConn(conn) {
  const host = `${conn.AgentManagementEndpoint || ""} ${conn.DataverseEndpoint || ""}`.toLowerCase();
  if (/preprod/.test(host)) return "Preprod";
  if (/\b(test)\b|\.test\./.test(host)) return "Test";
  if (/\bdev\b|\.dev\./.test(host)) return "Dev";
  return "Prod";
}

// ---------------------------------------------------------------------------
// Plugin data dir + saved app-registration lookup (shared with chat-with-agent)
// ---------------------------------------------------------------------------

function resolvePluginDataDir() {
  const fromEnv = process.env.CLAUDE_PLUGIN_DATA || process.env.COPILOT_PLUGIN_DATA;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  try {
    const pathsFile = path.join(os.homedir(), ".copilot-studio-cli", "plugin-paths.json");
    const parsed = JSON.parse(fs.readFileSync(pathsFile, "utf-8"));
    if (parsed.pluginData && String(parsed.pluginData).trim()) return parsed.pluginData;
  } catch {
    // fall through
  }
  return path.join(os.homedir(), ".copilot-studio-cli");
}

// Read the per-agent / per-tenant app id saved by the chat skill's setup flow.
function resolveClientId({ explicit, agentId, tenantId }) {
  if (explicit) return explicit;
  if (process.env.appClientId) return process.env.appClientId;
  try {
    const file = path.join(resolvePluginDataDir(), "chat-config.json");
    const cfg = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (agentId && cfg.agents?.[agentId]?.appClientId) return cfg.agents[agentId].appClientId;
    if (tenantId && cfg.tenantDefaults?.[tenantId]?.appClientId)
      return cfg.tenantDefaults[tenantId].appClientId;
  } catch {
    // no saved config
  }
  return null;
}

function tokenCachePath(agentId) {
  const dir = path.join(resolvePluginDataDir(), "token-cache");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // best effort
  }
  const safe = (agentId || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(dir, `${safe}.json`);
}

// Reuse the same per-agent encrypted cache slot as chat so a single sign-in serves both. The
// Graph token is cached under its own scopes within that account's MSAL cache.
function cacheAccountName(agentId) {
  const safe = (agentId || "default").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `chat-${safe}`;
}

// ---------------------------------------------------------------------------
// Agent workspace lookup (only tenantId + agentId are needed here)
// ---------------------------------------------------------------------------

function loadConn(agentDir) {
  const connPath = path.join(agentDir, ".mcs", "conn.json");
  if (!fs.existsSync(connPath)) {
    die(
      `No .mcs/conn.json at ${connPath}. Is this a Copilot Studio agent cloned with 'pac copilot clone'? ` +
        `You can instead pass --tenant-id and --client-id directly.`
    );
  }
  const conn = JSON.parse(fs.readFileSync(connPath, "utf-8"));
  return {
    conn,
    tenantId: conn.AccountInfo?.TenantId || null,
    agentId: conn.AgentId || null,
    environmentId: conn.EnvironmentId || null,
  };
}

// ---------------------------------------------------------------------------
// URL classification + Graph share-id encoding
// ---------------------------------------------------------------------------

// SharePoint/OneDrive hosts (commercial + national clouds). OneDrive for Business is a personal
// SharePoint site (host contains "-my.sharepoint").
function classifyUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { kind: "invalid", reason: "Not a valid URL." };
  }
  const host = u.hostname.toLowerCase();
  const isSpo = /\.sharepoint\.(com|us|cn|de)$/.test(host) || host.endsWith(".sharepoint-mil.us");
  if (!isSpo) {
    return {
      kind: "other",
      reason:
        "Not a SharePoint/OneDrive URL — access pre-check only applies to SharePoint and OneDrive links.",
    };
  }
  // Opaque sharing links (/:f:/, /:w:/, /:x:/, /:b:/, ...) can still be resolved by Graph /shares,
  // but our add-knowledge flow rejects them earlier because the folder path can't be extracted for
  // the YAML. We still allow verifying them here.
  const isSharing = /\/:[a-z]:\//i.test(u.pathname);
  const isOneDrive = host.includes("-my.sharepoint");
  return { kind: isOneDrive ? "onedrive" : "sharepoint", isSharing, host };
}

// Encode a URL as a Graph share id: "u!" + base64url(url) with padding removed.
// See https://learn.microsoft.com/graph/api/shares-get#encoding-sharing-urls
function encodeShareId(url) {
  const b64 = Buffer.from(url, "utf8").toString("base64");
  return "u!" + b64.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    url: null,
    agentDir: null,
    tenantId: null,
    clientId: null,
    cloud: null,
    graphScope: null,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--url":
        parsed.url = args[++i];
        break;
      case "--agent-dir":
        parsed.agentDir = args[++i];
        break;
      case "--tenant-id":
        parsed.tenantId = args[++i];
        break;
      case "--client-id":
        parsed.clientId = args[++i];
        break;
      case "--cloud":
        parsed.cloud = args[++i];
        break;
      case "--graph-scope":
        // repeatable
        parsed.graphScope = parsed.graphScope || [];
        parsed.graphScope.push(args[++i]);
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      default:
        if (!args[i].startsWith("--") && !parsed.url) parsed.url = args[i];
        break;
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Authentication (MSAL device-code, Graph scopes)
// ---------------------------------------------------------------------------

async function getGraphToken({ tenantId, clientId, scopes, accountName, fallbackCachePath }) {
  const authority = `https://login.microsoftonline.com/${tenantId}`;
  const cachePlugin = await createCachePluginWithFallback(accountName, fallbackCachePath, log);
  const app = new PublicClientApplication({
    auth: { clientId, authority },
    cache: { cachePlugin },
  });

  const accounts = await app.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const result = await app.acquireTokenSilent({ scopes, account: accounts[0] });
      log("Using cached token.");
      return result.accessToken;
    } catch {
      // fall through to device code
    }
  }

  const result = await app.acquireTokenByDeviceCode({
    scopes,
    deviceCodeCallback: (response) => {
      if (response && response.message) log(response.message);
    },
  });
  return result.accessToken;
}

// ---------------------------------------------------------------------------
// Graph call
// ---------------------------------------------------------------------------

async function checkAccess({ graphHost, shareId, token }) {
  const select = "id,name,webUrl,size,folder,file,parentReference";
  const url = `https://${graphHost}/v1.0/shares/${shareId}/driveItem?$select=${encodeURIComponent(
    select
  )}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { res, url };
}

const AUTHOR_NOTE =
  "This confirms the signed-in (author) user's access only. SharePoint/OneDrive knowledge is " +
  "retrieved at runtime using each end user's permissions, so ensure end users of the agent also " +
  "have access to this item.";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  if (!args.url) {
    die(
      'Missing URL. Pass the SharePoint/OneDrive link as a quoted string or via --url "<url>".'
    );
  }

  const cls = classifyUrl(args.url);
  if (cls.kind === "invalid") {
    die(cls.reason, { url: args.url });
  }
  if (cls.kind === "other") {
    // Not applicable — report skipped (not an error) so callers can proceed without a check.
    emit({
      status: "skipped",
      url: args.url,
      reason: cls.reason,
      note: "Public website and uploaded-file sources do not need a SharePoint/OneDrive access check.",
    });
    return;
  }

  // Resolve tenant + agent (optional) for auth.
  let tenantId = args.tenantId;
  let agentId = null;
  let cloud = args.cloud;
  if (args.agentDir) {
    const info = loadConn(path.resolve(args.agentDir));
    tenantId = tenantId || info.tenantId;
    agentId = info.agentId;
    cloud = cloud || inferCloudFromConn(info.conn);
  }
  cloud = normalizeCloud(cloud);
  const graphHost = graphHostForCloud(cloud);
  const shareId = encodeShareId(args.url);
  const scopes =
    args.graphScope && args.graphScope.length
      ? args.graphScope
      : [`https://${graphHost}/Files.Read.All`, `https://${graphHost}/Sites.Read.All`];

  const clientId = resolveClientId({ explicit: args.clientId, agentId, tenantId });

  // --dry-run: report the resolved plan (encoding, scopes, endpoint) without authenticating. This
  // lets the whole non-auth path be exercised in tests and before app-registration setup.
  if (args.dryRun) {
    emit({
      status: "ok",
      dryRun: true,
      url: args.url,
      sourceKind: cls.kind,
      isSharingLink: !!cls.isSharing,
      tenantId: tenantId || null,
      agentId: agentId || null,
      cloud,
      graphHost,
      shareId,
      graphEndpoint: `https://${graphHost}/v1.0/shares/${shareId}/driveItem`,
      scopes,
      appClientId: clientId || null,
      needsClientId: !clientId,
      checkedAs: "author",
      note: AUTHOR_NOTE,
    });
    return;
  }

  if (!tenantId) {
    die(
      "No tenant id. Pass --tenant-id <guid>, or --agent-dir <path> to a cloned agent whose " +
        ".mcs/conn.json carries the tenant id."
    );
  }
  if (!clientId) {
    die(
      "No app registration configured. Provide --client-id <appId> (an Entra public-client app " +
        "with the delegated Microsoft Graph permissions Files.Read.All and Sites.Read.All). If you " +
        "already set up the chat skill's app id for this agent, add those Graph permissions to that " +
        "same app registration.",
      { needsClientId: true, tenantId, agentId }
    );
  }

  log(`Cloud: ${cloud} (Graph: ${graphHost})`);
  log("Authenticating (device code)...");
  let token;
  try {
    token = await getGraphToken({
      tenantId,
      clientId,
      scopes,
      accountName: cacheAccountName(agentId),
      fallbackCachePath: tokenCachePath(agentId),
    });
  } catch (e) {
    const code = e && (e.errorCode || e.name);
    const msg = e && (e.errorMessage || e.message);
    die(
      `Authentication failed${code ? `: ${code}` : ""}${msg ? ` (${msg})` : ""}. The app ` +
        `registration must allow public-client (device code) flows and have the delegated Graph ` +
        `permissions Files.Read.All and Sites.Read.All consented.`
    );
  }

  log("Checking access via Microsoft Graph...");
  let res, url;
  try {
    ({ res, url } = await checkAccess({ graphHost, shareId, token }));
  } catch (e) {
    die(`Graph request failed: ${e.message}`, { graphHost });
  }

  if (res.status === 200) {
    let item = null;
    try {
      const body = await res.json();
      item = {
        name: body.name || null,
        webUrl: body.webUrl || null,
        isFolder: !!body.folder,
        isFile: !!body.file,
        size: typeof body.size === "number" ? body.size : null,
        driveId: body.parentReference?.driveId || null,
        itemId: body.id || null,
      };
    } catch {
      // still a 200 = accessible even if body parse fails
    }
    emit({
      status: "accessible",
      url: args.url,
      httpStatus: 200,
      checkedAs: "author",
      item,
      note: AUTHOR_NOTE,
    });
    return;
  }

  if (res.status === 403) {
    emit({
      status: "forbidden",
      url: args.url,
      httpStatus: 403,
      checkedAs: "author",
      note:
        "The item exists but the signed-in user does not have access to it. Verify you were granted " +
        "access in SharePoint/OneDrive, then retry. " +
        AUTHOR_NOTE,
    });
    return;
  }

  if (res.status === 404) {
    emit({
      status: "notfound",
      url: args.url,
      httpStatus: 404,
      checkedAs: "author",
      note:
        "The link could not be resolved (item not found). Check that the URL points at an existing " +
        "file or folder — open it in the browser and copy the address-bar URL.",
    });
    return;
  }

  if (res.status === 401) {
    die(
      "Graph returned 401 Unauthorized — the token was rejected. Ensure the app registration has the " +
        "delegated Graph permissions Files.Read.All and Sites.Read.All consented.",
      { httpStatus: 401, endpoint: url }
    );
  }

  // Any other status: surface a short snippet for diagnosis.
  let snippet = "";
  try {
    const text = await res.text();
    snippet = text ? ` — ${text.slice(0, 300)}` : "";
  } catch {
    // ignore
  }
  die(`Graph returned HTTP ${res.status}${snippet}`, { httpStatus: res.status, endpoint: url });
}

main().catch((e) => die(`Unexpected error: ${e.message}`));
