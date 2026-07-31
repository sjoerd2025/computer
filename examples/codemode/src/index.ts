import { DurableObject } from "cloudflare:workers";
import { type ResolvedProvider, runCode } from "@cloudflare/codemode";
import { type DurableObjectStorageLike, Workspace } from "@cloudflare/computer";
import { IsolateJavaScriptBackend } from "@cloudflare/computer/backends/javascript";

import {
  type ExecWorkspaceLike,
  WorkspaceCodemodeDispatcher,
  WorkspaceCodemodeExecutor,
} from "./workspace-executor.js";

const ROOT = "/workspace";
const EXAMPLE_FILE = `${ROOT}/codemode.txt`;

export class CodemodeExample extends DurableObject<Env> {
  readonly #workspace: Workspace;
  readonly #executor: WorkspaceCodemodeExecutor;
  #ready?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const dispatcher = new WorkspaceCodemodeDispatcher();
    this.#workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      waitUntil: ctx.waitUntil.bind(ctx),
      backends: [
        new IsolateJavaScriptBackend({
          id: "codemode-javascript",
          loader: env.LOADER,
          root: ROOT,
          access: "read-write",
          trustedModules: { "ws:codemode-adapter": dispatcher },
        }),
      ],
    });
    this.#executor = new WorkspaceCodemodeExecutor({
      workspace: this.#workspace as unknown as ExecWorkspaceLike,
      dispatcher,
    });
  }

  async run() {
    await this.#ensureReady();
    const code = `async () => {
      const fs = await import("node:fs/promises");
      const before = await fs.readFile(${JSON.stringify(EXAMPLE_FILE)}, "utf8");
      const after = String(await demo.next(Number(before)));
      await fs.writeFile(${JSON.stringify(EXAMPLE_FILE)}, after);
      return { before, after };
    }`;
    const providers: ResolvedProvider[] = [
      {
        name: "demo",
        fns: { next: async (value) => (Number(value) + 1) % 1_000_000 },
      },
    ];
    let result: { result?: unknown; logs?: string[]; error?: string };
    try {
      result = await runCode({ executor: this.#executor, providers, code });
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    const file = await this.#workspace.fs.readFile(EXAMPLE_FILE, "utf8");
    return { ok: result.error === undefined, file, result };
  }

  #ensureReady() {
    if (this.#ready) return this.#ready;
    const ready = (async () => {
      await this.#workspace.fs.mkdir(ROOT, { recursive: true });
      try {
        await this.#workspace.fs.stat(EXAMPLE_FILE);
      } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
        await this.#workspace.fs.writeFile(EXAMPLE_FILE, "0");
      }
    })();
    const guarded = ready.catch((error) => {
      if (this.#ready === guarded) this.#ready = undefined;
      throw error;
    });
    this.#ready = guarded;
    return guarded;
  }
}

interface CodemodeExampleStub {
  run(): Promise<{ ok: boolean; [key: string]: unknown }>;
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/run") {
      return new Response("POST /run to execute the Codemode example.\n", {
        status: 405,
        headers: { allow: "POST", "content-type": "text/plain; charset=utf-8" },
      });
    }
    try {
      const stub = env.CodemodeExample.get(
        env.CodemodeExample.idFromName("example"),
      ) as unknown as CodemodeExampleStub;
      const result = await stub.run();
      return Response.json(result, { status: result.ok ? 200 : 422 });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;
