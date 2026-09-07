import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parse } from "jsonc-parser";
import {
  AutoProviderManager,
  buildProviderModel,
  buildRequestUrl,
  cleanupObsoleteFiles,
  loadAutoProviderConfig,
  persistProviderModels,
  resetModelsDevRequest,
  resolveHeaderValue,
  selectAutoProviders,
  updateModelsJsonProviderModels,
  synchronizeModelsJsonProviderMetadata,
} from "../src/index.js";
import type { AutoProviderSpec, RefreshModelsContextLike } from "../src/types.js";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  resetModelsDevRequest();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("standalone automatic-provider configuration", () => {
  it("loads nested JSONC configuration and preserves credential references without exposing values in diagnostics", async () => {
    const root = await tempDirectory();
    const secret = "settings-secret-value";
    await writeFile(join(root, "auto-provider.json"), `{
      // Standalone automatic-provider configuration.
      "providers": {
        "sub2api": {
          "baseUrl": "http://127.0.0.1:8080",
          "api": "openai-responses",
          "apiKey": "${secret}",
          "authHeader": true,
          "headers": { "X-Token": "$TOKEN" },
          "compat": { "supportsStore": false },
          "name": "Sub2API",
          "modelOverrides": { "muse-spark-1.2-contributor": { "maxTokens": 131072 } }
        },
        "builtin": {
          "baseUrl": "http://127.0.0.1:8081",
          "api": "openai-completions"
        },
        "bad": {
          "baseUrl": "not-a-url",
          "api": "openai-completions"
        },
        "bad-headers": {
          "baseUrl": "http://127.0.0.1:8082",
          "api": "openai-completions",
          "headers": { "X-Bad": 3 }
        }
      }
    }`);

    const loaded = await loadAutoProviderConfig(root);
    const selected = selectAutoProviders(loaded, ["builtin"]);

    assert.deepEqual(selected.providers.map((provider) => provider.id), ["sub2api"]);
    assert.equal(selected.providers[0].apiKey, secret);
    assert.equal(selected.providers[0].headers?.["X-Token"], "$TOKEN");
    assert.equal(selected.providers[0].compat?.supportsStore, false);
    assert.equal(selected.providers[0].modelOverrides?.["muse-spark-1.2-contributor"]?.maxTokens, 131072);
    assert.match(selected.errors.join("\n"), /bad.*baseUrl/);
    assert.match(selected.errors.join("\n"), /bad-headers.*headers/);
    assert.doesNotMatch(selected.errors.join("\n"), new RegExp(secret));
  });

  it("ignores legacy models.json provider declarations instead of migrating them", async () => {
    const root = await tempDirectory();
    await writeFile(join(root, "models.json"), `{
      "providers": {
        "legacy-only": {
          "baseUrl": "http://127.0.0.1:8080",
          "api": "openai-completions"
        },
        "configured": {
          "baseUrl": "http://legacy.example",
          "api": "openai-completions",
          "apiKey": "legacy-secret",
          "models": [{ "id": "stale" }]
        }
      }
    }`);
    await writeFile(join(root, "auto-provider.json"), `{
      "providers": {
        "configured": {
          "baseUrl": "http://settings.example",
          "api": "openai-responses"
        }
      }
    }`);

    const loaded = await loadAutoProviderConfig(root);
    const selected = selectAutoProviders(loaded, []);
    assert.deepEqual(selected.providers.map((provider) => provider.id), ["configured"]);
    assert.equal(selected.providers[0].baseUrl, "http://settings.example");
    assert.equal(selected.providers[0].api, "openai-responses");
    assert.doesNotMatch(JSON.stringify(selected), /legacy-secret/);
  });
});

describe("models.json catalog persistence", () => {
  it("replaces stale target models while preserving unrelated providers and fields", async () => {
    const root = await tempDirectory();
    const path = join(root, "models.json");
    await writeFile(path, `{
      // Keep this comment and unrelated provider data.
      "providers": {
        "target": {
          "baseUrl": "http://legacy.example",
          "apiKey": "legacy-secret",
          "models": [{ "id": "removed" }],
          "unrelated": { "keep": true }
        },
        "other": {
          "models": [{ "id": "other-model" }],
          "customField": "preserved"
        }
      }
    }`);

    await updateModelsJsonProviderModels(path, "target", [{
      id: "new-model",
      name: "New model",
      api: "openai-responses",
      baseUrl: "http://settings.example",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 32000,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false },
    }]);

    const value = parse(await readFile(path, "utf8")) as any;
    assert.deepEqual(value.providers.target.models, [{
      id: "new-model",
      name: "New model",
      api: "openai-responses",
      baseUrl: "http://settings.example",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 32000,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false },
    }]);
    assert.equal(value.providers.target.unrelated.keep, true);
    assert.equal(value.providers.target.apiKey, "legacy-secret");
    assert.deepEqual(value.providers.other.models, [{ id: "other-model" }]);
    assert.equal(value.providers.other.customField, "preserved");
    assert.doesNotMatch(await readFile(path, "utf8"), /"provider"\s*:/);
  });

  it("writes generated definitions without credentials or internal provider identity", async () => {
    const root = await tempDirectory();
    const spec = { ...providerSpec("http://settings.example"), compat: { supportsStore: false } };
    const result = await persistProviderModels(root, spec, [{
      id: "model-a",
      name: "Model A",
      api: spec.api,
      reasoning: false,
      input: ["text"],
      contextWindow: 1000,
      maxTokens: 100,
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false },
    }]);
    assert.equal(result.changed, true);
    const text = await readFile(join(root, "models.json"), "utf8");
    const value = JSON.parse(text);
    const provider = value.providers[spec.id];
    const model = provider.models[0];
    assert.equal(provider.baseUrl, spec.baseUrl);
    assert.equal(provider.api, spec.api);
    assert.deepEqual(model, {
      id: "model-a",
      name: "Model A",
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    });
    assert.equal(model.provider, undefined);
    assert.equal(model.apiKey, undefined);
    assert.equal(model.auth, undefined);
    assert.doesNotMatch(text, /settings-secret-value|legacy-secret/);
  });

  it("leaves an invalid existing models.json unchanged on persistence failure", async () => {
    const root = await tempDirectory();
    const path = join(root, "models.json");
    const original = "{\n  \"providers\": {\n";
    await writeFile(path, original);
    await assert.rejects(
      () => updateModelsJsonProviderModels(path, "target", [{ id: "new-model" }]),
      /models\.json|Unexpected|error/i,
    );
    assert.equal(await readFile(path, "utf8"), original);
  });
});

describe("legacy cleanup and refresh", () => {
  it("removes only the three obsolete files and preserves Pi-owned files", async () => {
    const agentDir = await tempDirectory();
    const cwd = await tempDirectory();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    const obsolete = [
      join(agentDir, "auto-models.cache.json"),
      join(agentDir, "auto-models.json"),
      join(cwd, ".pi", "auto-models.json"),
    ];
    for (const path of obsolete) await writeFile(path, "{}");
    await writeFile(join(agentDir, "models.json"), "{}");
    await writeFile(join(agentDir, "models-store.json"), "{}");

    const result = await cleanupObsoleteFiles(agentDir, cwd);
    assert.equal(result.errors.length, 0);
    for (const path of obsolete) await assert.rejects(() => stat(path), /ENOENT/);
    assert.equal(await readFile(join(agentDir, "models.json"), "utf8"), "{}");
    assert.equal(await readFile(join(agentDir, "models-store.json"), "utf8"), "{}");
  });

  it("refreshes, persists static models, publishes models-store data, and restores offline", async () => {
    const root = await tempDirectory();
    const requests: Array<{ url: string; authorization: string | null; header: string | null }> = [];
    const server = await startServer((request, response) => {
      requests.push({
        url: request.url ?? "",
        authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : null,
        header: typeof request.headers["x-test"] === "string" ? request.headers["x-test"] : null,
      });
      responseJson(response, { data: [{ id: "foo" }, { id: "foo" }, { id: "vendor/bar" }] });
    });
    const spec = providerSpec(server.url);
    globalThis.fetch = async (input, init) => {
      if (String(input) === "https://models.dev/api.json") {
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
              },
            },
          },
        }));
      }
      return originalFetch(input, init);
    };
    await writeFile(join(root, "auto-models.cache.json"), "legacy cache");
    const manager = new AutoProviderManager(root, [spec], { builtinCandidates: [] });
    const published: Array<{ models: readonly unknown[] }> = [];
    const models = await manager.refresh(spec, makeContext(true, undefined, async (publication) => {
      if (publication.persist) published.push(publication.persist as unknown as { models: readonly unknown[] });
      return true;
    }, { key: "runtime-secret", env: { TEST_HEADER: "resolved-header" } }));

    assert.deepEqual(models.map((model) => model.id), ["foo", "vendor/bar"]);
    assert.equal(models[0].name, "Foo catalog");
    assert.equal(models[0].contextWindow, 900000);
    assert.equal(published.length, 1);
    assert.equal(requests[0].url, "/v1/models");
    assert.equal(requests[0].authorization, "Bearer runtime-secret");
    assert.equal(requests[0].header, "resolved-header");

    const catalog = JSON.parse(await readFile(join(root, "models.json"), "utf8"));
    const provider = catalog.providers[spec.id];
    assert.deepEqual(provider.models.map((model: { id: string }) => model.id), ["foo", "vendor/bar"]);
    assert.equal(provider.baseUrl, spec.baseUrl);
    assert.equal(provider.api, spec.api);
    assert.equal(provider.models[0].api, undefined);
    assert.equal(provider.models[0].baseUrl, undefined);
    assert.equal(provider.models[0].apiKey, undefined);
    assert.equal(provider.models[1].reasoning, undefined);
    assert.equal(provider.models[1].input, undefined);
    await assert.rejects(() => stat(join(root, "auto-models.cache.json")), /ENOENT/);

    const offlineManager = new AutoProviderManager(root, [spec], { builtinCandidates: [] });
    const restored = await offlineManager.refresh(spec, makeContext(false, undefined, async () => true, undefined));
    assert.deepEqual(restored.map((model) => model.id), ["foo", "vendor/bar"]);
    assert.equal(restored[0].api, spec.api);
    assert.equal(restored[0].name, "Foo catalog");
    await closeServer(server.server);
  });

  it("keeps the previous catalog when the provider refresh fails", async () => {
    const root = await tempDirectory();
    const spec = providerSpec("http://127.0.0.1:1");
    await writeFile(join(root, "models.json"), JSON.stringify({ providers: { [spec.id]: {
      unrelated: true,
      models: [{ id: "old", name: "Old" }],
    } } }));
    const original = await readFile(join(root, "models.json"), "utf8");
    const manager = new AutoProviderManager(root, [spec], { builtinCandidates: [] });
    await assert.rejects(
      () => manager.refresh(spec, makeContext(true, undefined, async () => true, { env: { TEST_HEADER: "resolved" } })),
      /fetch failed|ECONNREFUSED|failed/i,
    );
    assert.equal(await readFile(join(root, "models.json"), "utf8"), original);
  });
});

describe("provider metadata and credential resolution", () => {
  it("makes settings api, endpoint, and compatibility authoritative over stale models", () => {
    const spec = { ...providerSpec("http://settings.example"), api: "openai-responses" as AutoProviderSpec["api"], compat: { supportsStore: false } };
    const fallback = {
      id: "model",
      name: "Legacy model",
      api: "openai-completions" as AutoProviderSpec["api"],
      provider: spec.id,
      baseUrl: "http://legacy.example",
      reasoning: false,
      input: ["text"] as Array<"text" | "image">,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100,
      maxTokens: 10,
      compat: { supportsStore: true, supportsDeveloperRole: false },
    };
    const result = buildProviderModel(spec, "model", { builtins: [], force: false }, fallback);
    assert.equal(result.config.api, spec.api);
    assert.equal(result.runtime.baseUrl, spec.baseUrl);
    assert.equal(result.config.compat?.supportsStore, false);
    assert.equal(result.config.compat?.supportsDeveloperRole, false);
  });

  it("retains command and environment reference behavior without credential-bearing error text", () => {
    assert.equal(resolveHeaderValue("$TOKEN", { TOKEN: "resolved" }), "resolved");
    assert.equal(resolveHeaderValue("!printf command-value"), "command-value");
    assert.throws(() => resolveHeaderValue("$MISSING_TOKEN", {}), /MISSING_TOKEN/);
    assert.doesNotMatch(String(new Error("missing environment variable for configured header: MISSING_TOKEN")), /resolved|command-value/);
  });
});

it("builds endpoint URLs without duplicate slashes", () => {
  assert.equal(buildRequestUrl("http://localhost:1234"), "http://localhost:1234/v1/models");
  assert.equal(buildRequestUrl("http://localhost:1234/v1/"), "http://localhost:1234/v1/models");
  assert.equal(buildRequestUrl("http://localhost:1234/api/v1///"), "http://localhost:1234/api/v1/models");
});

function providerSpec(baseUrl: string): AutoProviderSpec {
  return {
    id: "test-provider",
    baseUrl,
    api: "openai-completions" as AutoProviderSpec["api"],
    apiKey: "runtime-secret",
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
