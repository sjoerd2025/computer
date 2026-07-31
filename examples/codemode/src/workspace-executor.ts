import {
  type ConnectorBinding,
  type ExecuteOptions,
  type ExecuteResult,
  type Executor,
  normalizeCode,
  type ResolvedProvider,
  sanitizeToolName,
} from "@cloudflare/codemode";
import type { WorkspaceRuntimeValue, WorkspaceTrustedModule } from "@cloudflare/computer";

export interface ExecWorkspaceLike {
  runtime: {
    exec(
      source: string,
      options: {
        backend: string;
        cwd?: string;
        encoding: "utf8";
        input?: unknown;
        timeoutMs?: number;
      },
    ): Promise<{
      readonly id: string;
      result(): Promise<{
        status: "completed" | "failed" | "cancelled";
        stdout: string;
        stderr: string;
        value?: unknown;
      }>;
    }>;
    disposeExec(id: string, options: { backend: string }): Promise<void>;
  };
}

interface DispatchContext {
  providers: Map<string, Map<string, (...args: unknown[]) => Promise<unknown>>>;
  connectors: Map<string, ConnectorBinding["binding"]>;
}

/**
 * Trusted host dispatcher installed as ws:codemode-adapter by the Workspace
 * JavaScript backend. It exists outside Workspace core and grants only the
 * provider functions supplied for the current Codemode execution.
 */
export class WorkspaceCodemodeDispatcher implements WorkspaceTrustedModule {
  #execution?: { token: string; context: DispatchContext };

  install(token: string, providers: ResolvedProvider[], connectors: ConnectorBinding[]) {
    const providerMap = new Map<string, Map<string, (...args: unknown[]) => Promise<unknown>>>();
    for (const provider of providers) {
      const functions = new Map<string, (...args: unknown[]) => Promise<unknown>>();
      for (const [name, fn] of Object.entries(provider.fns)) {
        const sanitized = sanitizeToolName(name);
        if (functions.has(sanitized)) {
          throw new Error(
            `Codemode provider ${provider.name} has colliding tool name ${sanitized}.`,
          );
        }
        functions.set(sanitized, fn);
      }
      providerMap.set(provider.name, functions);
    }
    if (this.#execution) throw new Error("A Codemode execution is already active.");
    this.#execution = {
      token,
      context: {
        providers: providerMap,
        connectors: new Map(connectors.map((connector) => [connector.name, connector.binding])),
      },
    };
  }

  remove(token: string) {
    if (this.#execution?.token === token) this.#execution = undefined;
  }

  async call(method: string, args: WorkspaceRuntimeValue[]): Promise<WorkspaceRuntimeValue> {
    if (method !== "dispatch") throw new Error(`Unknown Codemode adapter method ${method}.`);
    const [token, kind, namespace, operation, callArgs] = args;
    if (
      typeof token !== "string" ||
      typeof kind !== "string" ||
      typeof namespace !== "string" ||
      typeof operation !== "string" ||
      !Array.isArray(callArgs)
    ) {
      throw new Error("Invalid Codemode adapter dispatch request.");
    }
    const execution = this.#execution;
    if (!execution || execution.token !== token) {
      throw new Error("Codemode execution is no longer active.");
    }
    const { context } = execution;

    let result: unknown;
    if (kind === "provider") {
      const fn = context.providers.get(namespace)?.get(operation);
      if (!fn) throw new Error(`Unknown Codemode provider call ${namespace}.${operation}.`);
      result = await fn(...callArgs.map(fromRuntimeValue));
    } else if (kind === "connector") {
      const connector = context.connectors.get(namespace);
      if (!connector) throw new Error(`Unknown Codemode connector ${namespace}.`);
      result = await connector.callTool(operation, fromRuntimeValue(callArgs[0]));
    } else {
      throw new Error(`Unknown Codemode dispatch kind ${kind}.`);
    }
    return toRuntimeValue(result);
  }
}

/** External @cloudflare/codemode Executor backed by workspace.runtime. */
export class WorkspaceCodemodeExecutor implements Executor {
  readonly #workspace: ExecWorkspaceLike;
  readonly #dispatcher: WorkspaceCodemodeDispatcher;
  readonly #backend: string;
  readonly #timeoutMs: number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: {
    workspace: ExecWorkspaceLike;
    dispatcher: WorkspaceCodemodeDispatcher;
    backend?: string;
    timeoutMs?: number;
  }) {
    this.#workspace = options.workspace;
    this.#dispatcher = options.dispatcher;
    this.#backend = options.backend ?? "codemode-javascript";
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  execute(
    code: string,
    providersOrFns: ResolvedProvider[] | Record<string, (...args: unknown[]) => Promise<unknown>>,
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    const run = this.#queue.then(
      () => this.#execute(code, providersOrFns, options),
      () => this.#execute(code, providersOrFns, options),
    );
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #execute(
    code: string,
    providersOrFns: ResolvedProvider[] | Record<string, (...args: unknown[]) => Promise<unknown>>,
    options: ExecuteOptions,
  ): Promise<ExecuteResult> {
    const providers = Array.isArray(providersOrFns)
      ? providersOrFns
      : [{ name: "codemode", fns: providersOrFns }];
    const connectors = options.connectors ?? [];
    const validationError = validateNamespaces(providers, connectors);
    if (validationError) return { result: undefined, error: validationError };

    const token = crypto.randomUUID();
    let handle: Awaited<ReturnType<ExecWorkspaceLike["runtime"]["exec"]>> | undefined;
    let output: ExecuteResult;
    try {
      this.#dispatcher.install(token, providers, connectors);
      const source = buildExecutionModule(code, providers, connectors);
      handle = await this.#workspace.runtime.exec(source, {
        backend: this.#backend,
        cwd: "/workspace",
        encoding: "utf8",
        timeoutMs: this.#timeoutMs,
        input: { token },
      });
      const result = await handle.result();
      const logs = [...lines(result.stdout), ...lines(result.stderr)];
      output =
        result.status === "completed"
          ? { result: fromRuntimeValue(result.value), logs }
          : {
              result: undefined,
              error: result.stderr || `Execution ${result.status}`,
              logs,
            };
    } catch (error) {
      output = { result: undefined, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.#dispatcher.remove(token);
    }

    if (handle) {
      try {
        await this.#workspace.runtime.disposeExec(handle.id, { backend: this.#backend });
      } catch (error) {
        return {
          result: undefined,
          error: `Failed to dispose Codemode execution: ${error instanceof Error ? error.message : String(error)}`,
          logs: output.logs,
        };
      }
    }
    return output;
  }
}

function buildExecutionModule(
  code: string,
  providers: ResolvedProvider[],
  connectors: ConnectorBinding[],
) {
  const providerProxies = providers.map(
    (provider) => `const ${provider.name} = proxy("provider", ${JSON.stringify(provider.name)});`,
  );
  const connectorProxies = connectors.map(
    (connector) =>
      `const ${connector.name} = proxy("connector", ${JSON.stringify(connector.name)});`,
  );
  const preludes = providers.flatMap((provider) => (provider.prelude ? [provider.prelude] : []));

  return `
    import { call } from "ws:codemode-adapter";
    export default async function main(input) {
      const token = input.token;
      const wrap = (type, fields) => ({ __codemode_codec__: { type, ...fields } });
      const seen = new globalThis.WeakSet();
      const encode = (value) => {
        if (value === void 0) return wrap("undefined", {});
        if (value === null || typeof value === "string" || typeof value === "boolean") return value;
        if (typeof value === "number") {
          if (!globalThis.Number.isFinite(value)) throw new globalThis.Error("Codemode values must be finite JSON-compatible values");
          return value;
        }
        if (value instanceof globalThis.Uint8Array) return wrap("bytes", { data: globalThis.Array.from(value) });
        if (value instanceof globalThis.ArrayBuffer) return wrap("array-buffer", { data: globalThis.Array.from(new globalThis.Uint8Array(value)) });
        if (globalThis.ArrayBuffer.isView(value)) return wrap("view", {
          name: value.constructor.name,
          data: globalThis.Array.from(new globalThis.Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
        });
        if (typeof value !== "object") throw new globalThis.Error("Codemode values must be finite JSON-compatible values");
        if (seen.has(value)) throw new globalThis.Error("Codemode values must be acyclic");
        seen.add(value);
        try {
          if (globalThis.Array.isArray(value)) return wrap("array", { items: value.map(encode) });
          const prototype = globalThis.Object.getPrototypeOf(value);
          if (prototype !== globalThis.Object.prototype && prototype !== null) {
            throw new globalThis.Error("Codemode values must contain plain JSON objects");
          }
          return wrap("object", { entries: globalThis.Object.entries(value).map(([key, child]) => [key, encode(child)]) });
        } finally {
          seen.delete(value);
        }
      };
      const decode = (value) => {
        if (!value || typeof value !== "object" || globalThis.Array.isArray(value)) return value;
        const keys = globalThis.Object.keys(value);
        if (keys.length !== 1 || keys[0] !== "__codemode_codec__") throw new globalThis.Error("Invalid Codemode codec envelope");
        const codec = value.__codemode_codec__;
        if (!codec || typeof codec !== "object") throw new globalThis.Error("Invalid Codemode codec envelope");
        if (codec.type === "undefined") return void 0;
        if (codec.type === "bytes" || codec.type === "array-buffer" || codec.type === "view") {
          if (!globalThis.Array.isArray(codec.data) || !codec.data.every((byte) => globalThis.Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new globalThis.Error("Invalid Codemode byte value");
          const buffer = new globalThis.Uint8Array(codec.data).buffer;
          if (codec.type === "bytes") return new globalThis.Uint8Array(buffer);
          if (codec.type === "array-buffer") return buffer;
          const constructors = new globalThis.Map([
            ["Int8Array", globalThis.Int8Array],
            ["Uint8ClampedArray", globalThis.Uint8ClampedArray],
            ["Int16Array", globalThis.Int16Array],
            ["Uint16Array", globalThis.Uint16Array],
            ["Int32Array", globalThis.Int32Array],
            ["Uint32Array", globalThis.Uint32Array],
            ["Float32Array", globalThis.Float32Array],
            ["Float64Array", globalThis.Float64Array],
            ["BigInt64Array", globalThis.BigInt64Array],
            ["BigUint64Array", globalThis.BigUint64Array],
            ["DataView", globalThis.DataView],
          ]);
          const View = constructors.get(codec.name);
          if (!View) throw new globalThis.Error("Unsupported Codemode view type");
          return codec.name === "DataView" ? new globalThis.DataView(buffer) : new View(buffer);
        }
        if (codec.type === "array" && globalThis.Array.isArray(codec.items)) return codec.items.map(decode);
        if (codec.type === "object" && globalThis.Array.isArray(codec.entries)) return globalThis.Object.fromEntries(codec.entries.map(([key, child]) => [key, decode(child)]));
        throw new globalThis.Error("Invalid Codemode codec envelope");
      };
      const proxy = (kind, namespace) => new globalThis.Proxy({}, {
        get: (target, method) => globalThis.Object.prototype.hasOwnProperty.call(target, method)
          ? target[method]
          : typeof method === "string"
          ? async (...args) => {
              const result = decode(await call("dispatch", token, kind, namespace, method, args.map(encode)));
              if (kind === "connector" && result && typeof result === "object") {
                if (result.__codemode_control__ === "pause") throw new globalThis.Error("__CODEMODE_PAUSE__");
                if (result.__codemode_control__ === "error") throw new globalThis.Error(globalThis.String(result.message));
              }
              return result;
            }
          : undefined
      });
      ${providerProxies.join("\n")}
      ${connectorProxies.join("\n")}
      ${preludes.join("\n")}
      return encode(await (${normalizeCode(code)})());
    }
  `;
}

const RESERVED_NAMESPACES = new Set(
  `input token proxy wrap seen encode decode call globalThis await break case catch class const continue
   debugger default delete do else enum export extends false finally for function if implements import
   in instanceof interface let new null package private protected public return static super switch this
   throw true try typeof var void while with yield arguments eval`.split(/\s+/),
);

function validateNamespaces(providers: ResolvedProvider[], connectors: ConnectorBinding[]) {
  const valid = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const seen = new Set<string>();
  for (const item of [...providers, ...connectors]) {
    if (!valid.test(item.name))
      return `Codemode namespace ${JSON.stringify(item.name)} is invalid.`;
    if (RESERVED_NAMESPACES.has(item.name))
      return `Codemode namespace ${JSON.stringify(item.name)} is reserved.`;
    if (seen.has(item.name)) return `Duplicate Codemode namespace ${JSON.stringify(item.name)}.`;
    seen.add(item.name);
  }
  return undefined;
}

function toRuntimeValue(value: unknown): WorkspaceRuntimeValue {
  const seen = new Set<object>();
  const convert = (item: unknown): WorkspaceRuntimeValue => {
    if (item === undefined) return codecEnvelope("undefined", {});
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      return item;
    }
    if (item instanceof Uint8Array) {
      return codecEnvelope("bytes", { data: Array.from(item) });
    }
    if (item instanceof ArrayBuffer) {
      return codecEnvelope("array-buffer", { data: Array.from(new Uint8Array(item)) });
    }
    if (ArrayBuffer.isView(item)) {
      return codecEnvelope("view", {
        name: item.constructor.name,
        data: Array.from(new Uint8Array(item.buffer, item.byteOffset, item.byteLength)),
      });
    }
    if (typeof item !== "object") {
      throw new Error("Codemode provider results must be finite JSON-compatible values.");
    }
    if (seen.has(item)) throw new Error("Codemode provider results must be acyclic.");
    seen.add(item);
    let result: WorkspaceRuntimeValue;
    if (Array.isArray(item)) {
      result = codecEnvelope("array", { items: item.map(convert) });
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error("Codemode provider results must contain plain JSON objects.");
      }
      result = codecEnvelope("object", {
        entries: Object.entries(item as Record<string, unknown>).map(([key, child]) => [
          key,
          convert(child),
        ]),
      });
    }
    seen.delete(item);
    return result;
  };
  return convert(value);
}

function codecEnvelope(
  type: "undefined" | "bytes" | "array-buffer" | "view" | "array" | "object",
  fields: Record<string, WorkspaceRuntimeValue>,
): WorkspaceRuntimeValue {
  return { __codemode_codec__: { type, ...fields } };
}

function fromRuntimeValue(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !("__codemode_codec__" in record)) {
    throw new Error("Invalid Codemode codec envelope.");
  }
  const codec = record.__codemode_codec__ as Record<string, unknown> | null;
  if (!codec || typeof codec !== "object" || Array.isArray(codec)) {
    throw new Error("Invalid Codemode codec envelope.");
  }
  if (codec.type === "undefined") return undefined;
  if (codec.type === "bytes" || codec.type === "array-buffer" || codec.type === "view") {
    if (!isByteArray(codec.data)) throw new Error("Invalid Codemode byte value.");
    const buffer = new Uint8Array(codec.data).buffer;
    if (codec.type === "bytes") return new Uint8Array(buffer);
    if (codec.type === "array-buffer") return buffer;
    return decodeView(codec.name, buffer);
  }
  if (codec.type === "array" && Array.isArray(codec.items)) {
    return codec.items.map(fromRuntimeValue);
  }
  if (codec.type === "object" && Array.isArray(codec.entries)) {
    const entries = codec.entries.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
        throw new Error("Invalid Codemode object entry.");
      }
      return [entry[0], fromRuntimeValue(entry[1])] as const;
    });
    return Object.fromEntries(entries);
  }
  throw new Error("Invalid Codemode codec envelope.");
}

function decodeView(name: unknown, buffer: ArrayBuffer): ArrayBufferView {
  const constructors = new Map<string, { new (buffer: ArrayBuffer): ArrayBufferView }>([
    ["Int8Array", Int8Array],
    ["Uint8ClampedArray", Uint8ClampedArray],
    ["Int16Array", Int16Array],
    ["Uint16Array", Uint16Array],
    ["Int32Array", Int32Array],
    ["Uint32Array", Uint32Array],
    ["Float32Array", Float32Array],
    ["Float64Array", Float64Array],
    ["BigInt64Array", BigInt64Array],
    ["BigUint64Array", BigUint64Array],
    ["DataView", DataView],
  ]);
  const View = typeof name === "string" ? constructors.get(name) : undefined;
  if (!View) throw new Error("Unsupported Codemode view type.");
  return new View(buffer);
}

function isByteArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  );
}

function lines(value: string) {
  return value.split("\n").filter(Boolean);
}
