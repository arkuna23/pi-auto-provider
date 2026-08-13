import { join } from "node:path";
import { execSync } from "node:child_process";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { findBuiltinCandidate } from "./builtins.js";
import { loadOverrideLayer, mergeOverrideLayers, writeJsonAtomic } from "./overrides.js";
import { buildProviderModel } from "./params.js";
import { fetchModelsDev } from "./models-dev.js";
import { errorMessage } from "./jsonc.js";
import type {
  AutoProviderSpec,
  AutoModelConfig,
  BuiltinModelCandidate,
  JsonObject,
  ModelOverride,
  RefreshModelsContextLike,
  RefreshReport,
} from "../types.js";

let cacheWriteTail: Promise<void> = Promise.resolve();

export class AutoProviderManager {
  private readonly builtins: BuiltinModelCandidate[];
  private readonly reports = new Map<string, RefreshReport>();
  private readonly globalErrors: string[];
  private trustedProject = false;
  private currentCwd: string;

  constructor(
    private readonly agentDir: string,
    private readonly specs: readonly AutoProviderSpec[],
    options: { cwd?: string; builtinCandidates?: BuiltinModelCandidate[]; errors?: string[] } = {},
  ) {
    this.currentCwd = options.cwd ?? process.cwd();
    this.builtins = options.builtinCandidates ?? builtinCandidates();
    this.globalErrors = [...(options.errors ?? [])];
  }

  get providerIds(): string[] {
    return this.specs.map((spec) => spec.id);
  }

  get errors(): readonly string[] {
    return this.globalErrors;
  }

  setProjectTrust(trusted: boolean, cwd: string): void {
    this.trustedProject = trusted;
    this.currentCwd = cwd;
  }

  addError(message: string): void {
    this.globalErrors.push(message);
  }

  getReports(): readonly RefreshReport[] {
    return [...this.reports.values()];
  }

  async refresh(spec: AutoProviderSpec, context: RefreshModelsContextLike): Promise<AutoModelConfig[]> {
    const report: RefreshReport = {
      providerId: spec.id,
      modelCount: 0,
      cacheUpdated: 0,
      officialFallbacks: 0,
      defaults: 0,
      ambiguities: [],
      errors: [],
    };
    this.reports.set(spec.id, report);
    try {
      const layers = await this.loadLayers();
      const merged = mergeOverrideLayers(layers);
      report.errors.push(...merged.errors);

      const stored = storedModelsForProvider(context, spec.id);
      if (!context.allowNetwork) {
        const built = this.buildModels(spec, stored.map((model) => model.id), {
          cache: mergedLayer(layers, 0),
          user: mergedLayer(layers, 1),
          project: mergedLayer(layers, 2),
          force: false,
          fallback: new Map(stored.map((model) => [model.id, model])),
        }, report);
        report.modelCount = built.configs.length;
        report.aborted = context.signal.aborted;
        return built.configs;
      }

      const ids = await fetchRemoteModelIds(spec, context);
      let catalog: Awaited<ReturnType<typeof fetchModelsDev>> | undefined;
      const cache = mergedLayer(layers, 0);
      const user = mergedLayer(layers, 1);
      const project = mergedLayer(layers, 2);
      if (shouldLoadCatalog(this.builtins, spec, ids, cache, user, project, context.force === true)) {
        try {
          catalog = await fetchModelsDev(context.signal, context.force === true);
        } catch (error) {
          report.modelsDevError = errorMessage(error);
        }
      }

      const built = this.buildModels(spec, ids, {
        cache,
        user,
        project,
        catalog,
        force: context.force === true,
      }, report);
      report.modelCount = built.configs.length;

      if (built.cacheUpdates.size > 0) {
        report.cacheUpdated = await updateCacheFile(join(this.agentDir, "auto-models.cache.json"), built.cacheUpdates);
      }
      if (context.signal.aborted) {
        report.aborted = true;
        return built.configs;
      }
      await context.publish({
        persist: {
          models: built.runtime,
          checkedAt: Date.now(),
        },
      });
      report.aborted = context.signal.aborted;
      return built.configs;
    } catch (error) {
      if (isAbortError(error) || context.signal.aborted) {
        report.aborted = true;
        return [];
      }
      report.endpointError = errorMessage(error);
      throw error;
    } finally {
      this.reports.set(spec.id, report);
    }
  }

  private async loadLayers() {
    const cache = await loadOverrideLayer(join(this.agentDir, "auto-models.cache.json"));
    const user = await loadOverrideLayer(join(this.agentDir, "auto-models.json"));
    const project = this.trustedProject
      ? await loadOverrideLayer(join(this.currentCwd, ".pi", "auto-models.json"))
      : { path: join(this.currentCwd, ".pi", "auto-models.json"), exists: false, entries: new Map<string, ModelOverride>() };
    return [cache, user, project] as const;
  }

  private buildModels(
    spec: AutoProviderSpec,
    ids: readonly string[],
    sources: {
      cache: Map<string, ModelOverride>;
      user: Map<string, ModelOverride>;
      project: Map<string, ModelOverride>;
      catalog?: Awaited<ReturnType<typeof fetchModelsDev>>;
      force: boolean;
      fallback?: Map<string, Model<Api>>;
    },
    report: RefreshReport,
  ): { configs: AutoModelConfig[]; runtime: Model<Api>[]; cacheUpdates: Map<string, ModelOverride> } {
    const configs: AutoModelConfig[] = [];
    const runtime: Model<Api>[] = [];
    const cacheUpdates = new Map<string, ModelOverride>();
    const seen = new Set<string>();
    for (const modelId of ids) {
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      const result = buildProviderModel(spec, modelId, {
        builtins: this.builtins,
        cache: sources.cache,
        user: sources.user,
        project: sources.project,
        catalog: sources.catalog,
        force: sources.force,
      }, sources.fallback?.get(modelId));
      configs.push(result.config);
      runtime.push(result.runtime);
      if (result.report.defaults) report.defaults++;
      if (result.report.officialFallback) report.officialFallbacks++;
      if (result.report.ambiguity) report.ambiguities.push(`${modelId}: ${result.report.ambiguity}`);
      if (result.report.sourceError) report.errors.push(`${modelId}: ${result.report.sourceError}`);
      if (result.catalogEntry) cacheUpdates.set(`${spec.id}/${modelId}`, result.catalogEntry);
    }
    return { configs, runtime, cacheUpdates };
  }
}

export function buildRequestUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/v1$/i.test(path) ? `${path}/models` : `${path}/v1/models`;
  return url.toString();
}

export async function fetchRemoteModelIds(
  spec: AutoProviderSpec,
  context: Pick<RefreshModelsContextLike, "credential" | "signal">,
): Promise<string[]> {
  if (context.signal.aborted) throw abortError();
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.headers ?? {})) {
    headers[name] = resolveHeaderValue(value, context.credential?.env);
  }
  const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
  if (spec.authHeader && key) {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "authorization") delete headers[name];
    }
    headers.Authorization = `Bearer ${key}`;
  }
  const response = await fetch(buildRequestUrl(spec.baseUrl), { headers, signal: context.signal });
  if (!response.ok) throw new Error(`${spec.id}: /v1/models returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!isObject(body) || !Array.isArray(body.data)) throw new Error(`${spec.id}: /v1/models response must contain data[]`);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const [index, item] of body.data.entries()) {
    if (!isObject(item) || typeof item.id !== "string" || item.id.trim() === "") {
      throw new Error(`${spec.id}: /v1/models data[${index}].id must be a non-empty string`);
    }
    if (!seen.has(item.id)) {
      seen.add(item.id);
      ids.push(item.id);
    }
  }
  return ids;
}

function shouldLoadCatalog(
  builtins: readonly BuiltinModelCandidate[],
  spec: AutoProviderSpec,
  ids: readonly string[],
  cache: Map<string, ModelOverride>,
  user: Map<string, ModelOverride>,
  project: Map<string, ModelOverride>,
  force: boolean,
): boolean {
  if (force) return true;
  return ids.some((id) => {
    const key = `${spec.id}/${id}`;
    const builtin = Boolean(findBuiltinCandidate(builtins, id, spec.id, { officialFallback: true }).model);
    const explicitSource = typeof user.get(key)?.source === "string" || typeof project.get(key)?.source === "string";
    return (!builtin && !cache.has(key)) || explicitSource;
  });
}

function storedModelsForProvider(context: RefreshModelsContextLike, providerId: string): Model<Api>[] {
  return (context.stored?.models ?? []).filter((model) => model.provider === providerId) as Model<Api>[];
}

function mergedLayer(layers: readonly [{ entries: Map<string, ModelOverride> }, { entries: Map<string, ModelOverride> }, { entries: Map<string, ModelOverride> }], index: 0 | 1 | 2): Map<string, ModelOverride> {
  return layers[index].entries;
}

async function updateCacheFile(path: string, updates: Map<string, ModelOverride>): Promise<number> {
  const run = async () => {
    const existingLayer = await loadOverrideLayer(path);
    const entries = existingLayer.error ? new Map<string, ModelOverride>() : new Map(existingLayer.entries);
    let changed = 0;
    for (const [key, value] of updates) {
      if (JSON.stringify(entries.get(key)) !== JSON.stringify(value)) changed++;
      entries.set(key, value);
    }
    if (changed === 0) return 0;
    const ordered = Object.fromEntries([...entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
    await writeJsonAtomic(path, ordered);
    return changed;
  };
  const queued = cacheWriteTail.then(run);
  cacheWriteTail = queued.then(() => undefined, () => undefined);
  return queued;
}

export function resolveHeaderValue(value: string, env?: Record<string, string>): string {
  if (value.startsWith("!")) {
    try {
      return execSync(value.slice(1), { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      throw new Error("failed to resolve a configured header command");
    }
  }
  const dollar = "\u0000DOLLAR\u0000";
  const bang = "\u0000BANG\u0000";
  const escaped = value.replace(/\$\$/g, dollar).replace(/\$!/g, bang);
  const resolved = escaped.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, plain) => {
    const name = braced ?? plain;
    const result = env?.[name] ?? process.env[name];
    if (result === undefined) throw new Error(`missing environment variable for configured header: ${name}`);
    return result;
  });
  return resolved.replaceAll(dollar, "$").replaceAll(bang, "!");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function builtinCandidates(): BuiltinModelCandidate[] {
  const result: BuiltinModelCandidate[] = [];
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider as never) as Model<Api>[]) result.push({ provider, model });
  }
  return result;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}
