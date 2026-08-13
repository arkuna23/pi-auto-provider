import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  AutoProviderManager,
  buildRequestUrl,
  fetchRemoteModelIds,
  fetchModelsDev,
  findCatalogCandidate,
  loadOverrideLayer,
  loadModelsJson,
  resetModelsDevRequest,
  selectAutoProviders,
} from "../src/index.js";
import type { AutoProviderSpec, BuiltinModelCandidate, RefreshModelsContextLike } from "../src/types.js";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetModelsDevRequest();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("provider selection and override parsing", () => {
  it("only enables custom providers without a models property", async () => {
    const root = await tempDirectory();
    await writeFile(join(root, "models.json"), `{
      // JSONC is supported by Pi.
      "auto": { "baseUrl": "http://localhost:1234", "api": "openai-completions" },
      "empty": { "baseUrl": "http://localhost:1234", "api": "openai-completions", "models": [] },
      "explicit": { "baseUrl": "http://localhost:1234", "api": "openai-completions", "models": [{"id":"x"}] },
      "builtin": { "baseUrl": "http://localhost:1234", "api": "openai-completions" },
      "bad": { "api": "openai-completions" }
    }`);
    const loaded = await loadModelsJson(root);
    const selected = selectAutoProviders(loaded, ["builtin"]);
    assert.deepEqual(selected.providers.map((provider) => provider.id), ["auto"]);
    assert.match(selected.errors.join("\n"), /bad.*baseUrl/);
  });

  it("rejects a duplicate definition in one override file and parses model ids containing slashes", async () => {
    const root = await tempDirectory();
    const path = join(root, "auto-models.json");
    await writeFile(path, JSON.stringify({
      "provider/model/a": { contextWindow: 1 },
      provider: { "model/a": { maxTokens: 2 } },
    }));
    const duplicate = await loadOverrideLayer(path);
    assert.equal(duplicate.entries.size, 0);
    assert.match(duplicate.error ?? "", /duplicate model definition/);

    await writeFile(path, JSON.stringify({ "provider/model/a": { contextWindow: 3 } }));
    const flat = await loadOverrideLayer(path);
    assert.equal(flat.entries.get("provider/model/a")?.contextWindow, 3);

    await writeFile(path, JSON.stringify({ "": { model: { contextWindow: 3 } } }));
    const emptyProvider = await loadOverrideLayer(path);
    assert.equal(emptyProvider.entries.size, 0);
    assert.match(emptyProvider.error ?? "", /provider id must not be empty/);
  });
});

describe("refresh behavior", () => {
  it("discovers, deduplicates, enriches, persists, and restores models", async () => {
    const root = await tempDirectory();
    const requests: Array<{ url: string; headers: Headers }> = [];
    const server = await startServer((request, response) => {
      requests.push({ url: request.url ?? "", headers: new Headers(request.headers as Record<string, string>) });
      responseJson(response, { data: [{ id: "foo" }, { id: "foo" }, { id: "vendor/bar" }] });
    });
    const spec = providerSpec(server.url);
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://models.dev/api.json") {
        return new Response(JSON.stringify({
          vendor: {
            models: {
              foo: {
                id: "foo",
                name: "Foo catalog",
                reasoning: true,
                modalities: { input: ["text", "image"] },
                limit: { context: 900000, output: 12000 },
                cost: { input: 1, output: 2, cache_read: 0.1 },
                reasoning_options: [{ type: "effort", values: ["low", "high"] }],
              },
              "vendor/bar": {
                id: "vendor/bar",
                name: "Bar catalog",
                modalities: { input: ["text"] },
                limit: { context: 1000, output: 100 },
                cost: { input: 3, output: 4 },
              },
            },
          },
        }), { status: 200 });
      }
      return originalFetch(input, init);
    };
    await writeFile(join(root, "auto-models.json"), JSON.stringify({
      [`${spec.id}/foo`]: { contextWindow: 777, cost: { output: 9 } },
    }));

    const manager = new AutoProviderManager(root, [spec], { builtinCandidates: [] });
    const published: RefreshModelsContextLike[] = [];
    const context = makeContext(true, undefined, async (publication) => {
      published.push(publication as unknown as RefreshModelsContextLike);
      return true;
    }, { key: "secret", env: { TEST_HEADER: "resolved" } });
    const models = await manager.refresh(spec, context);
    assert.deepEqual(models.map((model) => model.id), ["foo", "vendor/bar"]);
    assert.equal(models[0].name, "Foo catalog");
    assert.equal(models[0].contextWindow, 777);
    assert.equal(models[0].cost.output, 9);
    assert.equal(models[1].contextWindow, 1000);
    assert.equal(published.length, 1);
    assert.equal(requests[0].url, "/v1/models");
    assert.equal(requests[0].headers.get("authorization"), "Bearer secret");
    assert.equal(requests[0].headers.get("x-test"), "resolved");
    const cache = JSON.parse(await readFile(join(root, "auto-models.cache.json"), "utf8"));
    assert.equal(cache[`${spec.id}/foo`].source, "vendor/foo");

    await writeFile(join(root, "auto-models.json"), JSON.stringify({
      [spec.id]: { foo: { contextWindow: 555 } },
    }));
    const offline = await manager.refresh(spec, makeContext(false, published[0]?.persist as never, async () => true, undefined));
    assert.equal(offline[0].contextWindow, 555);
    await closeServer(server.server);
  });

  it("does not call models.dev on a normal cache hit, but force refresh does", async () => {
    const root = await tempDirectory();
    let modelsDevCalls = 0;
    const server = await startServer((_request, response) => responseJson(response, { data: [{ id: "foo" }] }));
    const spec = providerSpec(server.url);
    globalThis.fetch = async (input, init) => {
      if (String(input) === "https://models.dev/api.json") {
        modelsDevCalls++;
        return new Response(JSON.stringify({ vendor: { models: { foo: { id: "foo", limit: { context: 2, output: 1 }, cost: {} } } } }));
      }
      return originalFetch(input, init);
    };
    const manager = new AutoProviderManager(root, [spec], { builtinCandidates: [] });
    await manager.refresh(spec, makeContext(true, undefined, async () => true, { env: { TEST_HEADER: "resolved" } }));
    assert.equal(modelsDevCalls, 1);
    await manager.refresh(spec, makeContext(true, undefined, async () => true, { env: { TEST_HEADER: "resolved" } }));
    assert.equal(modelsDevCalls, 1);
    await manager.refresh(spec, makeContext(true, undefined, async () => true, { env: { TEST_HEADER: "resolved" } }, true));
    assert.equal(modelsDevCalls, 2);
    await closeServer(server.server);
  });

  it("keeps cached parameters when an explicit catalog source cannot be refreshed", async () => {
    const root = await tempDirectory();
    const server = await startServer((_request, response) => responseJson(response, { data: [{ id: "foo" }] }));
    const spec = providerSpec(server.url);
    await writeFile(join(root, "auto-models.cache.json"), JSON.stringify({
      [`${spec.id}/foo`]: { source: "vendor/foo", contextWindow: 456 },
    }));
    await writeFile(join(root, "auto-models.json"), JSON.stringify({
      [`${spec.id}/foo`]: { source: "vendor/foo", maxTokens: 789 },
    }));
    globalThis.fetch = async (input, init) => {
      if (String(input) === "https://models.dev/api.json") throw new Error("catalog unavailable");
      return originalFetch(input, init);
    };
    const manager = new AutoProviderManager(root, [spec], { builtinCandidates: [] });
    const models = await manager.refresh(spec, makeContext(true, undefined, async () => true, { env: { TEST_HEADER: "resolved" } }));
    assert.equal(models[0].contextWindow, 456);
    assert.equal(models[0].maxTokens, 789);
    assert.match(manager.getReports()[0].modelsDevError ?? "", /catalog unavailable/);
    assert.equal(manager.getReports()[0].defaults, 0);
    await closeServer(server.server);
  });

  it("propagates /v1/models errors so Pi can retain the previous list", async () => {
    const root = await tempDirectory();
    const server = await startServer((_request, response) => responseJson(response, { error: "down" }, 503));
    const spec = providerSpec(server.url);
    const manager = new AutoProviderManager(root, [spec], { builtinCandidates: [] });
    await assert.rejects(() => manager.refresh(spec, makeContext(true, undefined, async () => true, { env: { TEST_HEADER: "resolved" } })), /HTTP 503/);
    assert.match(manager.getReports()[0].endpointError ?? "", /HTTP 503/);
    await closeServer(server.server);
  });

  it("does not read project overrides until the project is trusted", async () => {
    const root = await tempDirectory();
    const cwd = await tempDirectory();
    const server = await startServer((_request, response) => responseJson(response, { data: [{ id: "foo" }] }));
    const spec = providerSpec(server.url);
    await writeFile(join(cwd, ".pi-do-not-read"), "fixture");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(cwd, ".pi"), { recursive: true }));
    await writeFile(join(cwd, ".pi", "auto-models.json"), JSON.stringify({ [spec.id]: { foo: { contextWindow: 123 } } }));
    globalThis.fetch = async (input, init) => {
      if (String(input) === "https://models.dev/api.json") {
        return new Response(JSON.stringify({ vendor: { models: { foo: { id: "foo", limit: { context: 2, output: 1 }, cost: {} } } } }));
      }
      return originalFetch(input, init);
    };
    const manager = new AutoProviderManager(root, [spec], { cwd, builtinCandidates: [] });
    const context = makeContext(true, undefined, async () => true, { env: { TEST_HEADER: "resolved" } });
    const untrusted = await manager.refresh(spec, context);
    assert.equal(untrusted[0].contextWindow, 2);
    manager.setProjectTrust(true, cwd);
    const trusted = await manager.refresh(spec, context);
    assert.equal(trusted[0].contextWindow, 123);
    await closeServer(server.server);
  });
});

it("builds the endpoint URL without duplicate slashes", () => {
  assert.equal(buildRequestUrl("http://localhost:1234"), "http://localhost:1234/v1/models");
  assert.equal(buildRequestUrl("http://localhost:1234/v1/"), "http://localhost:1234/v1/models");
  assert.equal(buildRequestUrl("http://localhost:1234/api/v1///"), "http://localhost:1234/api/v1/models");
});

it("reports ambiguous models.dev candidates instead of guessing", () => {
  const first = { source: "a/foo", provider: "a", modelKey: "foo", data: { id: "foo" } };
  const second = { source: "b/foo", provider: "b", modelKey: "foo", data: { id: "foo" } };
  assert.match(findCatalogCandidate([first, second], "foo").ambiguity ?? "", /multiple/);
});

it("does not start a models.dev request after cancellation", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("{}", { status: 200 });
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => fetchModelsDev(controller.signal), /aborted/i);
  assert.equal(calls, 0);
});

function providerSpec(baseUrl: string): AutoProviderSpec {
  return {
    id: "test-provider",
    baseUrl,
    api: "openai-completions" as AutoProviderSpec["api"],
    apiKey: "secret",
    authHeader: true,
    headers: { "X-Test": "$TEST_HEADER", authorization: "custom" },
  };
}

function makeContext(
  allowNetwork: boolean,
  stored: RefreshModelsContextLike["stored"],
  publish: RefreshModelsContextLike["publish"],
  credential: RefreshModelsContextLike["credential"],
  force = false,
): RefreshModelsContextLike {
  return {
    allowNetwork,
    force,
    stored,
    publish,
    credential: credential ? { type: "api_key", ...credential } : undefined,
    signal: new AbortController().signal,
  };
}

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-auto-provider-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function responseJson(response: ServerResponse, value: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
