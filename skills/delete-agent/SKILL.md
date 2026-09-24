---
name: delete-agent
description: Delete a Copilot Studio agent's cloud resources and its msagent project records with `msagent agent delete`, after an explicit typed-name confirmation. Works on a registered msagent project, or on a cloned agent workspace (`settings.mcs.yml` + `.mcs/conn.json`) that it first registers with `msagent agent init`. Local files are never deleted. Use when the user asks to delete, remove, or destroy a Copilot Studio agent in the cloud.
argument-hint: Optional project or agent workspace folder path and/or agent name
allowed-tools: Bash(msagent *), Read, Glob, Grep
---

# Delete a Copilot Studio Agent

You are a workflow that deletes a Copilot Studio (MCS) agent from the cloud by running the
**msagent CLI** (`msagent agent delete`). You resolve every input up front, show the user exactly
what will be deleted, require them to type the agent's name, and only then run the delete. This is a
destructive, irreversible remote operation. You never invent behavior the CLI does not support.

Initial request: $ARGUMENTS

## What the delete does (and does not do)

- Deletes **one** cloud agent in Copilot Studio, and removes the agent's `ManagedAgent` record plus
  **all** of its `AgentDeployment` records from the project's `.config/agent.config.json`.
- **Never deletes local files.** The agent workspace stays on disk. The only local file that changes
  is the project's `.config/agent.config.json`, which msagent rewrites without the removed records.
- The cloud agents of the agent's **other** deployments are **not** deleted. They keep running as
  **orphaned targets**, and because their records are removed, msagent no longer tracks them.
- Applies only to **MCS agents** (`agentType: MCSAgent`).
- `msagent agent delete` works only on a project **registered** with the msagent CLI, which is a
  folder that contains `.config/agent.config.json` (created by `msagent agent create` or
  `msagent agent init`). This skill accepts two kinds of folder:
  - A **registered project** - a folder that contains `.config/agent.config.json`.
  - An **unregistered agent workspace** - a folder that contains both `settings.mcs.yml` and
    `.mcs/conn.json`, such as a workspace cloned with the Copilot Studio VS Code extension or
    `pac copilot clone`. `.mcs/conn.json` names the cloud agent (`AgentId`) and its environment
    (`EnvironmentId`), and `settings.mcs.yml` supplies its `schemaName` and `displayName`. The skill
    first registers the workspace with `msagent agent init`, which writes
    `.config\agent.config.json` into the workspace and creates nothing in Copilot Studio, and then
    deletes it. That file stays in place after the delete.

## Rules

1. **Never run `msagent agent delete` or `msagent agent init` before the user has typed the agent's
   exact display name** (step 5, or step U2 for an unregistered workspace). This skill always passes
   `--non-interactive`, which makes the CLI skip its own typed-name confirmation, so the confirmation
   in this skill is the only safeguard.
2. Always pass `--json --non-interactive`, and always select the agent by `--agent-id`, never by name.
   Check and quote every value you substitute into a command as described in
   [Passing values to commands](#passing-values-to-commands).
3. Never hand-edit files under `.config\` or `.mcs\`, never delete local files, and never use `pac` to
   delete an agent. The only local file this skill changes is the project's
   `.config\agent.config.json`: `msagent agent delete` removes the agent's records from it, and, for an
   unregistered workspace, `msagent agent init` creates it first. Leave that file in place.
4. CLI messages and remediation text may still refer to the CLI by its former name, `ah`. Treat `ah`
   as `msagent` when you relay or act on them.

## Passing values to commands

Every value you substitute into a command comes from the user or from a local file, so treat it as
untrusted text. Both bash and PowerShell expand `$(...)`, `$name`, and backticks inside double
quotes, so a value placed in double quotes can run another command.

1. **IDs.** `agentId` and `deploymentId` must be GUIDs that match
   `^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$`; msagent generates
   them that way. If one does not match, stop and tell the user that the record's ID is not a GUID,
   so the configuration may have been edited by hand. Run nothing.
2. **Paths, names, and tenant IDs** (`projectDir`, `workspaceDir`, `projectDirectory`, `displayName`, `tenantId`, or a record name the user gives). If a value contains a double quote (`"`), a line break, or any other control character, do not construct the command; stop and report the invalid value. Otherwise, pass the value as a **single-quoted** literal, never in double quotes, and escape each single quote inside it for the shell that runs the command:
   - **bash**: replace each `'` with `'\''`. For example, `Tom's Bot` becomes `'Tom'\''s Bot'`.
   - **PowerShell**: double each ASCII `'`. For example, `Tom's Bot` becomes `'Tom''s Bot'`.

The command templates below show each value as `'<value>'`; apply these rules to every one.

---

## Core Process

### 1. Verify the CLI (blocking on failure)

```bash
msagent --version
```

If the command is not found, tell the user: "The msagent CLI is required but was not found. Install
it, then retry." Stop.

### 2. Locate the project or agent workspace (blocking)

A **registered project directory** is a folder that contains `.config\agent.config.json` (the parent
of `.config`). An **unregistered agent workspace** is a folder that contains both `settings.mcs.yml`
and `.mcs\conn.json` but no `.config\agent.config.json`. msagent places an agent workspace either at
the project root or in a direct subfolder of it.

1. **The initial request names a folder.**
   - If the folder, or its parent, contains `.config\agent.config.json`, the folder that contains
     `.config` is the registered project directory. Continue with step 3.
   - Otherwise, if the folder contains both `settings.mcs.yml` and `.mcs\conn.json`, it is an
     unregistered agent workspace. Continue with
     [Unregistered agent workspace](#unregistered-agent-workspace).
   - Otherwise, if it contains `settings.mcs.yml` but no `.mcs\conn.json`, tell the user the folder is
     not linked to a cloud agent, so there is nothing to delete, and ask for another folder.
   - Otherwise, tell the user the folder is neither a registered msagent project nor an agent
     workspace, and ask for another folder.
2. **No folder named.** Auto-discover registered projects with
   `Glob: **/.config/agent.config.json`. If any are found, present a numbered pick-list (never
   silently use the first match), then continue with step 3 using the chosen project directory.
3. **No registered project found.** Auto-discover agent workspaces with `Glob: **/.mcs/conn.json`,
   and keep only the matches whose workspace folder (the parent of `.mcs`) also contains
   `settings.mcs.yml`. If any are found, present a numbered pick-list, then continue with
   [Unregistered agent workspace](#unregistered-agent-workspace) using the chosen folder.
4. **Nothing found.** Tell the user that no registered msagent project (`.config\agent.config.json`)
   or agent workspace (`settings.mcs.yml` + `.mcs\conn.json`) was found, and ask for a folder.

Repeat until the user provides a usable folder or chooses to stop.

### 3. Read the project's records (local only)

```bash
msagent agent show --project '<projectDir>' --json
```

This reads the local configuration only and contacts nothing. The JSON envelope is
`{ success, schemaVersion, projectDirectory, configPath, agents, deployments }`:

- `agents[]` - each has `agentId`, `displayName`, `agentType`, `agentLocation`, `environmentId`
  (the agent's home environment and its default deletion target), and, when known, `mcsAgentId` and
  `mcsSchemaName`.
- `deployments[]` - each has `deploymentId`, `agentId` (its owning agent), `deploymentName`,
  `deploymentType` (the stage), and optionally `environmentId`. A deployment without
  `environmentId` targets its agent's home `environmentId`.

If `success` is `false` and `errorKind` is `project-not-found` or `config-not-found`, tell the user the
folder is not a registered msagent project and return to step 2. For any other failure, relay
`errorMessage` and `remediation` and stop. If `agents` is empty, tell the user no agents are
registered in `configPath` and return to step 2.

### 4. Choose the agent and the cloud target (blocking)

1. **Agent.**
   - **The initial request named an agent.** Match the name case-insensitively against each agent's
     `displayName` and `agentId`. Never substitute an agent the user did not name.
     - **One match** - use it, and confirm the match with the user.
     - **Several matches** - list the matching agents (`displayName`, `agentId`) and ask the user for
       the `agentId` of the one to delete. Continue only if the answer matches exactly one of them;
       otherwise stop.
     - **No match** - tell the user that no agent named "<name>" is registered in `configPath`, list
       the registered agents (`displayName`, `agentId`), and stop. Nothing is deleted.
   - **No agent named.** If there is one agent, use it. If there are several, present a numbered
     pick-list (`displayName`, `agentId`, `agentType`).
   - If the chosen agent's `agentType` is not `MCSAgent`, stop: this skill deletes only MCS agents.
2. **Cloud target.** Consider only the deployments whose `agentId` equals the chosen agent's.
   - **No deployments** - pass no deployment selector. The CLI deletes the cloud agent the
     workspace's `.mcs` binding names or, when the workspace has none, the agent that has the
     agent's schema name in its home environment.
   - **One deployment** - confirm it with the user and pass its `--deployment-id`, so that the target
     is exact.
   - **Several deployments** - present a numbered pick-list (`deploymentName`, `deploymentType`,
     environment) and ask which deployment's cloud agent to delete. Pass its `--deployment-id`.
3. **Orphans.** When a deployment is selected, every **other** deployment of this agent becomes an
   orphaned target. If there are any, list them (`deploymentName` and environment) and warn:

   > These cloud agents will **not** be deleted and will keep running, but their records will be
   > removed, so msagent will no longer track them. Remove them separately if they should not keep
   > running.

   Require the user to explicitly acknowledge this before continuing. If they do not, stop; nothing
   is deleted.

### 5. Confirm with the typed agent name (blocking)

Show a summary like this:

```text
About to delete:
  agent         <displayName> (<agentId>)
  project       <projectDir>
  cloud target  deployment "<deploymentName>" in <environmentId>
                (or, with no deployment: the workspace-bound agent / home environment <environmentId>)
  records       1 ManagedAgent + <N> AgentDeployment row(s)
  orphaned      <deploymentName in environmentId, ...> | none

This deletes remote resources and cannot be undone. Local files are not deleted; msagent only
removes this agent's records from <configPath>.
```

Ask the user to **type the agent's display name exactly** to confirm. If what they type (ignoring
surrounding whitespace) is not exactly `displayName`, reply "That does not match the agent name, so
nothing was deleted." and stop. An empty answer is a decline; stop.

### 6. Run the delete

Run exactly one of these once, and wait for it to complete:

```bash
msagent agent delete --project '<projectDir>' --agent-id '<agentId>' --json --non-interactive
```

```bash
msagent agent delete --project '<projectDir>' --agent-id '<agentId>' --deployment-id '<deploymentId>' --json --non-interactive
```

With `--json`, stdout is a single JSON document for both success and failure.

### 7. Report the result

**Success** - `{ "success": true, "status": "agent-deleted", agentId, displayName, environmentId,
deploymentId, mcsAgentAlreadyAbsent, removedAgentDeployments, orphanedTargets }`:

- Say `displayName` (`agentId`) was deleted.
- If `mcsAgentAlreadyAbsent` is `true`, no cloud agent existed, so only the records were removed.
  Otherwise, say the cloud agent was deleted from `environmentId`.
- Records removed: 1 ManagedAgent + `removedAgentDeployments` AgentDeployment row(s).
- List `orphanedTargets` (`deploymentName`, `environmentId`). This is the CLI's authoritative list,
  so use it even if it differs from the step 4 preview.
- Remind the user the local workspace is still on disk; they can remove it themselves if they no
  longer need it. The only local file that changed is `.config\agent.config.json`, which no longer
  holds this agent's records. If this run registered the workspace (see
  [Unregistered agent workspace](#unregistered-agent-workspace)), also say that the file was created
  by that registration and remains in the workspace.

If `status` is `cancelled` or `name-mismatch`, tell the user that nothing was deleted.

**Failure** - `{ "success": false, exitCode, errorMessage, errorKind?, remediation?, partialResult? }`.
Always surface `errorMessage` and `remediation`. Then:

| Condition | Meaning | What to do |
|---|---|---|
| `exitCode` is `3` | Not signed in, or sign-in is required and `--non-interactive` prevents it | Explain, then offer to run `msagent auth login` (opens an interactive browser sign-in). On consent, run it and wait for the user to finish, then re-run the **same** delete command once. Re-confirm (step 5) if any input changed. |
| `records-survived-cloud-delete` | The cloud agent was deleted, but its records could not be removed | Offer to re-run the same delete; the CLI documents that re-running removes the records. |
| `transport-timeout` | The request timed out and may have completed | Do not retry blindly. Re-run step 3 to see whether the record still exists, tell the user, and offer to re-run only with their consent. |
| `config-locked` | Another msagent command is writing the configuration | Ask the user to wait for it to finish, then offer to retry. |
| `environment-not-found`, `tenant-mismatch` | The target environment is not available to the signed-in msagent account | Relay the remediation. If the agent's tenant (for an agent workspace, `AccountInfo.TenantId` in `.mcs\conn.json`) differs from the signed-in `tenantId` reported by `msagent auth status --json`, offer to run `msagent auth login --tenant '<tenantId>'` using the shell escaping and validation in [Passing values to commands](#passing-values-to-commands), then re-run the same command once. |
| `project-not-found`, `config-not-found`, `agent-not-found`, `agent-ambiguous`, `agent-id-conflict`, `deployment-not-found`, `not-an-mcs-agent` | The project or selector does not match the records | Return to step 2 or 4 with the user. |
| `workspace-schema-unknown`, `workspace-identity-mismatch`, `untrusted-dataverse-origin` | The CLI could not prove that the workspace's `.mcs` binding names this agent in this environment, so it refused to delete rather than risk deleting a different agent | Relay the remediation. Do not edit `.mcs\`, `.config\`, or project files to work around it. |
| Anything else | - | Relay `errorMessage`, `errorKind`, and `remediation` as-is and stop. |

If `partialResult` is present, summarize it for the user.

---

## Unregistered agent workspace

Use this path when step 2 chose a folder that contains `settings.mcs.yml` and `.mcs\conn.json` but
no registered project. `msagent agent delete` cannot act on it until the workspace is registered, so
you confirm first, then register it with `msagent agent init`, then delete it.

### U1. Read the workspace identity (local only)

Read these files with the Read tool. Do not modify them.

- `<workspaceDir>\.mcs\conn.json` (JSON): `EnvironmentId`, `AgentId` (the cloud agent),
  `DataverseEndpoint`, and `AccountInfo.TenantId`.
- `<workspaceDir>\settings.mcs.yml`: the top-level `displayName` and `schemaName` values. The Read
  tool returns raw text, so resolve each value the way a YAML parser would:
  - **Double-quoted** - remove the quotes and unescape the contents (`\"` is `"`, `\\` is `\`).
  - **Single-quoted** - remove the quotes and replace each `''` with `'`.
  - **Unquoted** - drop a trailing ` #` comment and the surrounding whitespace.
  - **Anything else** - a block scalar (`|` or `>`), a value continued on the next line, a list, a
    mapping, an anchor or alias, or a key that appears more than once: treat the value as unreadable.

  You use these values only for display, the msagent record name, and the typed confirmation. msagent
  reads `settings.mcs.yml` itself for its schema-name check.

Then:

- If `EnvironmentId` or `AgentId` is missing or empty, tell the user the workspace is not linked to a
  cloud agent, so there is nothing to delete, and stop.
- If `schemaName` is missing, empty, or unreadable, stop: msagent cannot register a workspace
  without a readable `schemaName`.
- If `displayName` is missing or unreadable, stop: the workspace does not provide the exact display name required for the deletion confirmation.
- If the initial request named an agent, compare it case-insensitively with `displayName` and
  `schemaName`. If it matches neither, tell the user that this workspace holds `<displayName>`
  (`<schemaName>`), not the agent they named, and stop. Nothing is deleted.

### U2. Confirm with the typed agent name (blocking)

Show a summary like this:

```text
About to delete:
  agent         <displayName> (schema name <schemaName>)
  cloud agent   <AgentId> in environment <EnvironmentId>
  Dataverse     <DataverseEndpoint>
  workspace     <workspaceDir>
  registration  This workspace is not registered with msagent. It will first be registered with
                `msagent agent init`, which writes <workspaceDir>\.config\agent.config.json.

This deletes remote resources and cannot be undone. Local files are not deleted, and the
.config\agent.config.json created by the registration stays in the workspace.
```

Ask the user to **type the agent's display name exactly** to confirm, with the same rules as step 5:
compare the trimmed answer with `displayName` exactly, reply "That does not match the agent name, so
nothing was deleted." on a mismatch and stop, and treat an empty answer as a decline.

### U3. Register the workspace

```bash
msagent agent init --agent-name '<displayName>' --mcs-agent-source '<workspaceDir>' --json --non-interactive
```

**Success** - `{ "success": true, "status": "agent-initialized", agentId, displayName, agentType,
tenantId, environmentId, connected, projectDirectory, configPath }`.

Before deleting, verify both of these:

- `connected` is `true`, which means msagent read the workspace's `.mcs` binding; and
- `environmentId` equals `EnvironmentId` from `.mcs\conn.json` (case-insensitive).

If either check fails, **do not delete**. Tell the user msagent did not register the workspace
against the cloud agent that `.mcs\conn.json` names, so a delete could target a different agent,
and that the registration was written to `configPath`. Stop.

**Failure** - relay `errorMessage` and `remediation`. Then:

| Condition | What to do |
|---|---|
| `exitCode` is `3` | Offer to run `msagent auth login`. On consent, run it, wait for the user to finish, then re-run the same `init` command once. |
| `environment-not-found`, `tenant-mismatch` | Handle as in the step 7 table, then re-run the same `init` command once. |
| `already-registered` | The workspace is already registered. Continue with step 3, using `<workspaceDir>` as the project directory. |
| `workspace-schema-unreadable` | `settings.mcs.yml` has no `schemaName` msagent can read. Stop. |
| `project-not-found` | msagent does not see an agent workspace in the folder. Return to step 2. |
| Anything else | Relay `errorMessage`, `errorKind`, and `remediation` as-is and stop. |

### U4. Run the delete

A newly registered workspace has no deployments, so pass no deployment selector:

```bash
msagent agent delete --project '<projectDirectory>' --agent-id '<agentId>' --json --non-interactive
```

Use `projectDirectory` and `agentId` from the U3 result. The CLI deletes the cloud agent that
`.mcs\conn.json` names, after verifying that the workspace's Dataverse organization matches the
environment and that the cloud agent's schema name matches `schemaName` in `settings.mcs.yml`. Then
report the result as in step 7.

If the delete fails, the workspace is now registered: any retry is the step 7 recovery for the same
`msagent agent delete` command.

## Final answer

Keep it short and factual: which agent was deleted and from which environment, how many records were
removed, any orphaned targets, and that no local files were deleted: only `.config\agent.config.json`
changed (or, if the skill registered the workspace, was created), and it remains.
