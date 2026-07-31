import type { WorkspaceRuntimeValue } from "@cloudflare/computer";
import { describe, expect, it, vi } from "vitest";

import {
  type ExecWorkspaceLike,
  WorkspaceCodemodeDispatcher,
  WorkspaceCodemodeExecutor,
} from "./workspace-executor.js";

function workspaceReturning(
  result: Awaited<ReturnType<Awaited<ReturnType<ExecWorkspaceLike["runtime"]["exec"]>>["result"]>>,
): ExecWorkspaceLike {
  return {
    runtime: {
      async exec() {
        return { id: "execution", result: async () => result };
      },
      async disposeExec() {},
    },
  };
}

const bytes = (data: number[]): WorkspaceRuntimeValue => ({
  __codemode_codec__: { type: "bytes", data },
});
const view = (name: string, data: number[]): WorkspaceRuntimeValue => ({
  __codemode_codec__: { type: "view", name, data },
});
const array = (items: WorkspaceRuntimeValue[]): WorkspaceRuntimeValue => ({
  __codemode_codec__: { type: "array", items },
});
const object = (entries: Array<[string, WorkspaceRuntimeValue]>): WorkspaceRuntimeValue => ({
  __codemode_codec__: { type: "object", entries },
});

const completed = (value?: unknown) => ({
  status: "completed" as const,
  stdout: "",
  stderr: "",
  value,
});

describe("WorkspaceCodemodeDispatcher", () => {
  it("dispatches providers and connectors within one execution token", async () => {
    const dispatcher = new WorkspaceCodemodeDispatcher();
    const provider = vi.fn(async (value: unknown) => {
      expect(value).toEqual(new Uint8Array([1, 2]));
      return new Uint8Array([3, 4]);
    });
    const connector = vi.fn(async () => ({ ok: true }));
    dispatcher.install(
      "token",
      [{ name: "tools", fns: { bytes: provider } }],
      [{ name: "remote", binding: { callTool: connector } }],
    );

    await expect(
      dispatcher.call("dispatch", ["token", "provider", "tools", "bytes", [bytes([1, 2])]]),
    ).resolves.toEqual(bytes([3, 4]));
    await expect(
      dispatcher.call("dispatch", [
        "token",
        "connector",
        "remote",
        "lookup",
        [object([["id", 1]])],
      ]),
    ).resolves.toEqual(object([["ok", true]]));
    expect(connector).toHaveBeenCalledWith("lookup", { id: 1 });

    dispatcher.remove("token");
    await expect(
      dispatcher.call("dispatch", ["token", "provider", "tools", "bytes", []]),
    ).rejects.toThrow("no longer active");
  });

  it("rejects malformed binary envelopes without corrupting legitimate tag-shaped objects", async () => {
    const dispatcher = new WorkspaceCodemodeDispatcher();
    const echo = vi.fn(async (value) => value);
    dispatcher.install("token", [{ name: "tools", fns: { echo } }], []);
    await expect(
      dispatcher.call("dispatch", [
        "token",
        "provider",
        "tools",
        "echo",
        [bytes(["invalid" as unknown as number])],
      ]),
    ).rejects.toThrow("Invalid Codemode byte value");
    await expect(
      dispatcher.call("dispatch", [
        "token",
        "provider",
        "tools",
        "echo",
        [view("constructor", [1, 2])],
      ]),
    ).rejects.toThrow("Unsupported Codemode view type");

    const tagShaped = object([
      [
        "__codemode_codec__",
        object([
          ["type", "bytes"],
          ["data", array([1, 2])],
        ]),
      ],
      ["keep", true],
    ]);
    await expect(
      dispatcher.call("dispatch", ["token", "provider", "tools", "echo", [tagShaped]]),
    ).resolves.toEqual(tagShaped);
  });

  it("admits only one execution token at a time", async () => {
    const dispatcher = new WorkspaceCodemodeDispatcher();
    dispatcher.install("one", [{ name: "tools", fns: { value: async () => 1 } }], []);
    expect(() =>
      dispatcher.install("two", [{ name: "tools", fns: { value: async () => 2 } }], []),
    ).toThrow("already active");

    dispatcher.remove("wrong-token");
    await expect(
      dispatcher.call("dispatch", ["one", "provider", "tools", "value", []]),
    ).resolves.toBe(1);
    dispatcher.remove("one");
    dispatcher.install("two", [{ name: "tools", fns: { value: async () => 2 } }], []);
    await expect(
      dispatcher.call("dispatch", ["one", "provider", "tools", "value", []]),
    ).rejects.toThrow("no longer active");
    await expect(
      dispatcher.call("dispatch", ["two", "provider", "tools", "value", []]),
    ).resolves.toBe(2);
  });

  it("does not expose inherited methods and permits supplied prototype-shaped names", async () => {
    const dispatcher = new WorkspaceCodemodeDispatcher();
    const constructorTool = vi.fn(async () => "supplied");
    dispatcher.install("token", [{ name: "tools", fns: { constructor: constructorTool } }], []);
    await expect(
      dispatcher.call("dispatch", ["token", "provider", "tools", "toString", []]),
    ).rejects.toThrow("Unknown Codemode provider call");
    await expect(
      dispatcher.call("dispatch", ["token", "provider", "tools", "constructor", []]),
    ).resolves.toBe("supplied");
  });

  it("rejects sanitized function collisions and cyclic results", async () => {
    const dispatcher = new WorkspaceCodemodeDispatcher();
    expect(() =>
      dispatcher.install(
        "collision",
        [{ name: "tools", fns: { "a-b": async () => null, a_b: async () => null } }],
        [],
      ),
    ).toThrow("colliding tool name");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    dispatcher.install("cycle", [{ name: "tools", fns: { cycle: async () => cyclic } }], []);
    await expect(
      dispatcher.call("dispatch", ["cycle", "provider", "tools", "cycle", []]),
    ).rejects.toThrow("acyclic");
  });
});

describe("WorkspaceCodemodeExecutor", () => {
  it("serializes executions so bearer tokens never overlap", async () => {
    const tokens: string[] = [];
    const resolvers: Array<(value: ReturnType<typeof completed>) => void> = [];
    const disposed: string[] = [];
    const workspace: ExecWorkspaceLike = {
      runtime: {
        async exec(_source, options) {
          tokens.push((options.input as { token: string }).token);
          return {
            id: `execution-${tokens.length}`,
            result: () => new Promise((resolve) => resolvers.push(resolve)),
          };
        },
        async disposeExec(id) {
          disposed.push(id);
        },
      },
    };
    const dispatcher = new WorkspaceCodemodeDispatcher();
    const executor = new WorkspaceCodemodeExecutor({ workspace, dispatcher });
    const first = executor.execute("async () => tools.value()", [
      { name: "tools", fns: { value: async () => 1 } },
    ]);
    const second = executor.execute("async () => tools.value()", [
      { name: "tools", fns: { value: async () => 2 } },
    ]);
    await vi.waitFor(() => expect(tokens).toHaveLength(1));
    await expect(
      dispatcher.call("dispatch", [tokens[0], "provider", "tools", "value", []]),
    ).resolves.toBe(1);

    resolvers[0]?.(completed(null));
    await first;
    await vi.waitFor(() => expect(tokens).toHaveLength(2));
    await expect(
      dispatcher.call("dispatch", [tokens[0], "provider", "tools", "value", []]),
    ).rejects.toThrow("no longer active");
    await expect(
      dispatcher.call("dispatch", [tokens[1], "provider", "tools", "value", []]),
    ).resolves.toBe(2);
    resolvers[1]?.(completed(null));
    await second;
    expect(disposed).toEqual(["execution-1", "execution-2"]);
  });

  it("removes execution authority after runtime failure", async () => {
    let token = "";
    const dispatcher = new WorkspaceCodemodeDispatcher();
    const workspace: ExecWorkspaceLike = {
      runtime: {
        async exec(_source, options) {
          token = (options.input as { token: string }).token;
          throw new Error("runtime failed");
        },
        async disposeExec() {},
      },
    };
    const executor = new WorkspaceCodemodeExecutor({ workspace, dispatcher });
    await expect(
      executor.execute("async () => tools.echo(1)", [
        { name: "tools", fns: { echo: async (value) => value } },
      ]),
    ).resolves.toMatchObject({ error: "runtime failed" });
    await expect(
      dispatcher.call("dispatch", [token, "provider", "tools", "echo", [1]]),
    ).rejects.toThrow("no longer active");
  });

  it("returns failed, cancelled, and rejected runtime outcomes as Executor errors", async () => {
    const dispatcher = new WorkspaceCodemodeDispatcher();
    const failed = new WorkspaceCodemodeExecutor({
      dispatcher,
      workspace: workspaceReturning({
        status: "failed",
        stdout: "before\n",
        stderr: "boom\n",
      }),
    });
    await expect(failed.execute("async () => null", [])).resolves.toEqual({
      result: undefined,
      error: "boom\n",
      logs: ["before", "boom"],
    });
    const cancelled = new WorkspaceCodemodeExecutor({
      dispatcher,
      workspace: workspaceReturning({
        status: "cancelled",
        stdout: "",
        stderr: "",
      }),
    });
    await expect(cancelled.execute("async () => null", [])).resolves.toMatchObject({
      error: "Execution cancelled",
    });
    let rejectedToken = "";
    const disposeRejected = vi.fn(async () => undefined);
    const rejected = new WorkspaceCodemodeExecutor({
      dispatcher,
      workspace: {
        runtime: {
          async exec(_source, options) {
            rejectedToken = (options.input as { token: string }).token;
            return {
              id: "rejected",
              result: async () => Promise.reject(new Error("stream rejected")),
            };
          },
          disposeExec: disposeRejected,
        },
      },
    });
    await expect(rejected.execute("async () => null", [])).resolves.toMatchObject({
      error: "stream rejected",
    });
    expect(disposeRejected).toHaveBeenCalledWith("rejected", {
      backend: "codemode-javascript",
    });
    await expect(
      dispatcher.call("dispatch", [rejectedToken, "provider", "tools", "echo", []]),
    ).rejects.toThrow("no longer active");
  });

  it("reports retained execution cleanup failures", async () => {
    const dispatcher = new WorkspaceCodemodeDispatcher();
    const executor = new WorkspaceCodemodeExecutor({
      dispatcher,
      workspace: {
        runtime: {
          async exec() {
            return { id: "execution", result: async () => completed(42) };
          },
          async disposeExec() {
            throw new Error("storage unavailable");
          },
        },
      },
    });

    await expect(executor.execute("async () => 42", [])).resolves.toEqual({
      result: undefined,
      error: "Failed to dispose Codemode execution: storage unavailable",
      logs: [],
    });
  });

  it("rejects duplicate or reserved namespaces and decodes byte results", async () => {
    const dispatcher = new WorkspaceCodemodeDispatcher();
    const executor = new WorkspaceCodemodeExecutor({
      dispatcher,
      workspace: workspaceReturning(completed(bytes([7, 8]))),
    });
    await expect(
      executor.execute("async () => null", [{ name: "same", fns: {} }], {
        connectors: [{ name: "same", binding: { callTool: async () => null } }],
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining("Duplicate") });
    await expect(
      executor.execute("async () => null", [{ name: "encode", fns: {} }]),
    ).resolves.toMatchObject({ error: expect.stringContaining("reserved") });
    await expect(
      executor.execute("async () => null", [{ name: "class", fns: {} }]),
    ).resolves.toMatchObject({ error: expect.stringContaining("reserved") });
    await expect(executor.execute("async () => null", [])).resolves.toEqual({
      result: new Uint8Array([7, 8]),
      logs: [],
    });
  });
});
