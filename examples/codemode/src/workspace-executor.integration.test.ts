import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("WorkspaceCodemodeExecutor integration", () => {
  it("runs the production endpoint and serializes durable updates", async () => {
    const rejected = await SELF.fetch("https://example.test/run");
    expect(rejected.status).toBe(405);

    const first = await SELF.fetch("https://example.test/run", { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      ok: true,
      file: "1",
      result: { result: { before: "0", after: "1" } },
    });

    const responses = await Promise.all([
      SELF.fetch("https://example.test/run", { method: "POST" }),
      SELF.fetch("https://example.test/run", { method: "POST" }),
    ]);
    const transitions = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          result: { result: { before: string; after: string } };
        };
        return `${body.result.result.before}->${body.result.result.after}`;
      }),
    );
    expect(transitions.sort()).toEqual(["1->2", "2->3"]);
  });

  it("executes providers, bytes, connectors, and preludes through the JavaScript backend", async () => {
    const response = await SELF.fetch("https://example.test/success");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: {
        bytes: [2, 3],
        binary: [true, true, [1, 2]],
        remote: { method: "lookup", args: { id: 7 } },
        local: "prelude",
        shadowedGlobal: 7,
        isUndefined: true,
      },
      logs: [],
    });
  });

  it("propagates connector pause and error controls", async () => {
    const pause = await SELF.fetch("https://example.test/pause");
    expect(await pause.json()).toMatchObject({
      error: expect.stringContaining("__CODEMODE_PAUSE__"),
    });
    const error = await SELF.fetch("https://example.test/error");
    expect(await error.json()).toMatchObject({
      error: expect.stringContaining("connector failed"),
    });

    const unsupported = await SELF.fetch("https://example.test/unsupported");
    expect(await unsupported.json()).toMatchObject({
      error: expect.stringContaining("plain JSON objects"),
    });
  });
});
