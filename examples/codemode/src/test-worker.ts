import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { DurableObjectStorageLike, WorkspaceRuntimeLoader } from "@cloudflare/computer";
import { Workspace } from "@cloudflare/computer";
import { IsolateJavaScriptBackend } from "@cloudflare/computer/backends/javascript";

import exampleHandler, { CodemodeExample } from "./index.js";
import {
  type ExecWorkspaceLike,
  WorkspaceCodemodeDispatcher,
  WorkspaceCodemodeExecutor,
} from "./workspace-executor.js";

export { CodemodeExample };

interface Env {
  LOADER: WorkerLoader;
  TestHost: DurableObjectNamespace<TestHost>;
  CodemodeExample: DurableObjectNamespace<CodemodeExample>;
}

export class TestHost extends DurableObject<Env> {
  readonly #dispatcher = new WorkspaceCodemodeDispatcher();
  readonly #executor: WorkspaceCodemodeExecutor;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      waitUntil: ctx.waitUntil.bind(ctx),
      backends: [
        new IsolateJavaScriptBackend({
          id: "codemode-javascript",
          loader: env.LOADER as unknown as WorkspaceRuntimeLoader,
          trustedModules: { "ws:codemode-adapter": this.#dispatcher },
        }),
      ],
    });
    this.#executor = new WorkspaceCodemodeExecutor({
      workspace: workspace as unknown as ExecWorkspaceLike,
      dispatcher: this.#dispatcher,
    });
  }

  run(mode: "success" | "pause" | "error" | "unsupported") {
    const code =
      mode === "success"
        ? `async () => {
            const bytes = await tools.bytes(new globalThis.Uint8Array([1, 2]));
            const binary = await tools.binary([new globalThis.ArrayBuffer(4), new globalThis.Int16Array([1, 2])]);
            const remote = await connector.lookup({ id: 7 });
            return {
              bytes: globalThis.Array.from(bytes),
              binary: [binary[0] instanceof globalThis.ArrayBuffer, binary[1] instanceof globalThis.Int16Array, globalThis.Array.from(binary[1])],
              remote,
              local: tools.local(),
              shadowedGlobal: await Uint8Array.echo(7),
              isUndefined: (await tools.undefinedValue()) === undefined
            };
          }`
        : mode === "unsupported"
          ? `async () => tools.echo(new Date())`
          : `async () => connector.${mode}({})`;
    return this.#executor.execute(
      code,
      [
        {
          name: "tools",
          fns: {
            echo: async (value) => value,
            undefinedValue: async () => undefined,
            bytes: async (value) => {
              if (!(value instanceof Uint8Array)) throw new Error("expected bytes");
              return value.map((byte) => byte + 1);
            },
            binary: async (value) => {
              if (
                !Array.isArray(value) ||
                !(value[0] instanceof ArrayBuffer) ||
                !(value[1] instanceof Int16Array)
              )
                throw new Error("expected binary types");
              return value;
            },
          },
          prelude: "tools.local = () => 'prelude';",
        },
        {
          name: "Uint8Array",
          fns: { echo: async (value) => value },
        },
      ],
      {
        connectors: [
          {
            name: "connector",
            binding: {
              async callTool(method, args) {
                if (method === "pause") return { __codemode_control__: "pause" };
                if (method === "error") {
                  return { __codemode_control__: "error", message: "connector failed" };
                }
                return { method, args };
              },
            },
          },
        ],
      },
    );
  }
}

export default class extends WorkerEntrypoint<Env> {
  override async fetch(request: Request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/run") return exampleHandler.fetch(request, this.env);
    const mode = pathname.slice(1) as "success" | "pause" | "error" | "unsupported";
    const host = this.env.TestHost.get(this.env.TestHost.idFromName("test"));
    return Response.json(await host.run(mode));
  }
}
