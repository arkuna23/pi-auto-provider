import { execSync } from "node:child_process";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { findBuiltinCandidate } from "./builtins.js";
import {
  cleanupObsoleteFiles,
  loadPersistedProviderModels,
  persistProviderModels,
} from "./models-json.js";
import { buildProviderModel } from "./params.js";
import { fetchModelsDev } from "./models-dev.js";
import { errorMessage } from "./jsonc.js";
import type {
  AutoProviderSpec,
  AutoModelConfig,
  BuiltinModelCandidate,
  CatalogModel,
  JsonObject,
  RefreshModelsContextLike,
  RefreshReport,
} from "../types.js";

export class AutoProviderManager {
  private readonly builtins: BuiltinModelCandidate[];
  private readonly reports = new Map<string, RefreshReport>();
  private readonly globalErrors: string[];
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

  setProjectTrust(_trusted: boolean, cwd: string): void {
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
      officialFallbacks: 0,
      defaults: 0,
      ambiguities: [],
      errors: [],
    };
    this.reports.set(spec.id, report);
    try {
      const cleanup = await cleanupObsoleteFiles(this.agentDir, this.currentCwd);
      report.errors.push(...cleanup.errors);

      const stored = storedModelsForProvider(context, spec.id);
      if (!context.allowNetwork) {
        let fallback = new Map(stored.map((model) => [model.id, model]));
        let ids = stored.map((model) => model.id);
        if (ids.length === 0) {
          const persisted = await loadPersistedProviderModels(this.agentDir, spec);
          if (persisted.error) {
            report.modelsJsonError = persisted.error;
            throw new Error(persisted.error);
          }
          fallback = new Map(persisted.models.map((model) => [model.id, model]));
          ids = persisted.models.map((model) => model.id);
        }
        const built = this.buildModels(spec, ids, {
          catalog: undefined,
          force: false,
          fallback,
        }, report);
        report.modelCount = built.configs.length;
        if (context.signal.aborted) {
          report.aborted = true;
          return built.configs;
        }
        if (built.persistedConfigs.length > 0) await this.persistModels(spec, built.persistedConfigs, report);
        report.aborted = context.signal.aborted;
        return built.configs;
      }

      const ids = await fetchRemoteModelIds(spec, context);
      let catalog: Map<string, CatalogModel> | undefined;
      if (shouldLoadCatalog(this.builtins, spec, ids, context.force === true)) {
        try {
          catalog = await fetchModelsDev(context.signal, context.force === true);
        } catch (error) {
          report.modelsDevError = errorMessage(error);
        }
      }

      const built = this.buildModels(spec, ids, {
        catalog,
        force: context.force === true,
      }, report);
      report.modelCount = built.configs.length;
      if (context.signal.aborted) {
        report.aborted = true;
        return built.configs;
      }
      // Publish Pi's separate runtime cache first. If that operation fails, the
      // static catalog remains untouched and the refresh is reported as failed.
      const published = await context.publish({
        persist: {
          models: built.runtime,
          checkedAt: Date.now(),
        },
      });
      if (!published || context.signal.aborted) {
        report.aborted = context.signal.aborted;
        return built.configs;
      }
      await this.persistModels(spec, built.persistedConfigs, report);
      report.aborted = context.signal.aborted;
      return built.configs;
    } catch (error) {
      if (isAbortError(error) || context.signal.aborted) {
        report.aborted = true;
        return [];
      }
      if (!report.modelsJsonError) report.endpointError = errorMessage(error);
      throw error;
    } finally {
      this.reports.set(spec.id, report);
    }
  }

  private async persistModels(spec: AutoProviderSpec, models: readonly AutoModelConfig[], report: RefreshReport): Promise<void> {
    try {
      await persistProviderModels(this.agentDir, spec, models);
    } catch (error) {
      report.modelsJsonError = errorMessage(error);
      throw error;
    }
  }

  private buildModels(
    spec: AutoProviderSpec,
    ids: readonly string[],
    sources: {
      catalog?: Map<string, CatalogModel>;
      force: boolean;
      fallback?: Map<string, Model<Api>>;
    },
    report: RefreshReport,
  ): { configs: AutoModelConfig[]; persistedConfigs: AutoModelConfig[]; runtime: Model<Api>[] } {
    const configs: AutoModelConfig[] = [];
    const persistedConfigs: AutoModelConfig[] = [];
    const runtime: Model<Api>[] = [];
    const seen = new Set<string>();
    for (const modelId of ids) {
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      const result = buildProviderModel(spec, modelId, {
        builtins: this.builtins,
        catalog: sources.catalog,
        force: sources.force,
      }, sources.fallback?.get(modelId));
      configs.push(result.config);
      persistedConfigs.push(result.persistedConfig);
      runtime.push(result.runtime);
      if (result.report.defaults) report.defaults++;
      if (result.report.officialFallback) report.officialFallbacks++;
      if (result.report.ambiguity) report.ambiguities.push(`${modelId}: ${result.report.ambiguity}`);
      if (result.report.sourceError) report.errors.push(`${modelId}: ${result.report.sourceError}`);
    }
    return { configs, persistedConfigs, runtime };
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
  force: boolean,
): boolean {
  if (force) return ids.length > 0;
  return ids.some((id) => !findBuiltinCandidate(builtins, id, spec.id, { officialFallback: true }).model);
}

function storedModelsForProvider(context: RefreshModelsContextLike, providerId: string): Model<Api>[] {
  return (context.stored?.models ?? []).filter((model) => model.provider === providerId) as Model<Api>[];
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
