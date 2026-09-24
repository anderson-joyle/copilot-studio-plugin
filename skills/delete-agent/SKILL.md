---
name: delete-agent
description: Delete a Copilot Studio agent's cloud resources and its msagent project records with `msagent agent delete`, after an explicit typed-name confirmation. Local files are never touched. Use when the user asks to delete, remove, or destroy a Copilot Studio agent in the cloud.
argument-hint: Optional project folder path and/or agent name
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
- **Never touches local files.** The agent workspace stays on disk.
- The cloud agents of the agent's **other** deployments are **not** deleted. They keep running as
  **orphaned targets**, and because their records are removed, msagent no longer tracks them.
- Applies only to **MCS agents** (`agentType: MCSAgent`).
- Works only on a project **registered** with the msagent CLI, which is a folder that contains
  `.config/agent.config.json` (created by `msagent agent create` or `msagent agent init`). A folder
  produced only by `pac copilot clone` is not registered.

## Rules

1. **Never run `msagent agent delete` before the user has typed the agent's exact display name in
   step 5.** This skill always passes `--non-interactive`, which makes the CLI skip its own typed-name
   confirmation, so the confirmation in this skill is the only safeguard.
2. Always pass `--json --non-interactive`, and always select the agent by `--agent-id`, never by name.
3. Never hand-edit files under `.config\` or `.mcs\`, never delete local files, and never use `pac` to
   delete an agent.
4. CLI messages and remediation text may still refer to the CLI by its former name, `ah`. Treat `ah`
   as `msagent` when you relay or act on them.

---

## Core Process

### 1. Verify the CLI (blocking on failure)

```bash
msagent --version
```

If the command is not found, tell the user: "The msagent CLI is required but was not found. Install
it, then retry." Stop.

### 2. Locate the registered project (blocking)

The **project directory** is the folder that contains `.config\agent.config.json` (the parent of
`.config`).

1. If the initial request names a folder, use it.
2. Otherwise auto-discover candidates with `Glob: **/.config/agent.config.json`.
3. If several are found, present a numbered pick-list. Never silently use the first match.
4. If none is found, or the chosen folder has no `.config\agent.config.json`, tell the user that the
   folder is not a registered msagent project and ask them for the folder of a registered project.
   Repeat until they provide one or choose to stop.

### 3. Read the project's records (local only)

```bash
msagent agent show --project "<projectDir>" --json
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

1. **Agent.** If there is one agent, use it. If there are several, present a numbered pick-list
   (`displayName`, `agentId`, `agentType`). If the initial request named an agent, match it
   case-insensitively against `displayName` or `agentId` and confirm the match. If the chosen agent's
   `agentType` is not `MCSAgent`, stop: this skill deletes only MCS agents.
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

This deletes remote resources and cannot be undone. Local files are not touched.
```

Ask the user to **type the agent's display name exactly** to confirm. If what they type (ignoring
surrounding whitespace) is not exactly `displayName`, reply "That does not match the agent name, so
nothing was deleted." and stop. An empty answer is a decline; stop.

### 6. Run the delete

Run exactly one of these once, and wait for it to complete:

```bash
msagent agent delete --project "<projectDir>" --agent-id "<agentId>" --json --non-interactive
```

```bash
msagent agent delete --project "<projectDir>" --agent-id "<agentId>" --deployment-id "<deploymentId>" --json --non-interactive
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
  longer need it.

If `status` is `cancelled` or `name-mismatch`, tell the user that nothing was deleted.

**Failure** - `{ "success": false, exitCode, errorMessage, errorKind?, remediation?, partialResult? }`.
Always surface `errorMessage` and `remediation`. Then:

| Condition | Meaning | What to do |
|---|---|---|
| `exitCode` is `3` | Not signed in, or sign-in is required and `--non-interactive` prevents it | Explain, then offer to run `msagent auth login` (opens an interactive browser sign-in). On consent, run it and wait for the user to finish, then re-run the **same** delete command once. Re-confirm (step 5) if any input changed. |
| `records-survived-cloud-delete` | The cloud agent was deleted, but its records could not be removed | Offer to re-run the same delete; the CLI documents that re-running removes the records. |
| `transport-timeout` | The request timed out and may have completed | Do not retry blindly. Re-run step 3 to see whether the record still exists, tell the user, and offer to re-run only with their consent. |
| `config-locked` | Another msagent command is writing the configuration | Ask the user to wait for it to finish, then offer to retry. |
| `project-not-found`, `config-not-found`, `agent-not-found`, `agent-ambiguous`, `agent-id-conflict`, `deployment-not-found`, `not-an-mcs-agent` | The project or selector does not match the records | Return to step 2 or 4 with the user. |
| `workspace-schema-unknown`, `workspace-identity-mismatch` | The CLI could not prove that the workspace's `.mcs` binding names this agent, so it refused to delete rather than risk deleting a different agent | Relay the remediation. Do not edit `.mcs\`, `.config\`, or project files to work around it. |
| Anything else | - | Relay `errorMessage`, `errorKind`, and `remediation` as-is and stop. |

If `partialResult` is present, summarize it for the user.

## Final answer

Keep it short and factual: which agent was deleted and from which environment, how many records were
removed, any orphaned targets, and that local files were not touched.
