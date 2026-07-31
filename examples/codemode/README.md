# Codemode on Computer

This example implements Codemode's `Executor` contract on the Computer JavaScript runtime:

```text
@cloudflare/codemode.runCode
  → WorkspaceCodemodeExecutor
  → workspace.runtime
  → codemode-javascript
  → ws:codemode-adapter
  → execution-scoped providers and connectors
```

Codemode stays outside `@cloudflare/computer`. The example installs one private trusted module on a dedicated `IsolateJavaScriptBackend`; general-purpose JavaScript executions never receive that authority. The adapter is reference code rather than a compatibility-stable package.

## Trust model

Each execution receives an unguessable token that selects only its supplied providers and connectors. The executor serializes calls, the dispatcher rejects overlapping tokens, and authority is revoked before retained execution cleanup. Caller code cannot choose a Workspace, backend, trusted-module implementation, or provider set.

Keep the dedicated backend out of untrusted backend allowlists. Trusted provider operations must honor their own deadlines and idempotency requirements: revocation blocks new calls but cannot roll back or forcibly stop a call the host already admitted.

The adapter transports finite, acyclic values, including typed binary values and `undefined`, through tagged envelopes. It rejects malformed envelopes, unsupported values, inherited tool names, namespace collisions, and cyclic provider results.

> [!WARNING]
> The HTTP endpoint is a local harness, not a public API. It intentionally has no authentication. A production service must derive Workspace identity from an authenticated tenant, authorize every operation, and enforce request, execution, and provider quotas.

## Run locally

From the repository root:

```bash
npm install
npm run dev --workspace @example/computer-codemode
```

In another terminal:

```bash
curl -X POST http://127.0.0.1:8787/run
```

Each call runs deterministic Codemode-generated JavaScript, invokes a host provider, and updates `/workspace/codemode.txt` through durable `node:fs/promises`.

## Validate

```bash
npm run typecheck --workspace @example/computer-codemode
npm test --workspace @example/computer-codemode
```

The tests cover provider and connector dispatch, execution-token isolation and cleanup, namespace safety, connector controls, provider preludes, malformed and cyclic values, binary and `undefined` transport, runtime failures, and retained-execution disposal. The integration suite runs through a real Workerd Worker Loader backend.

If this adapter becomes a supported consumer API, extract it into a separately versioned Computer–Codemode integration package rather than moving Codemode into Computer core.
