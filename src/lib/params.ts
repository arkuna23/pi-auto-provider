import type { Api, Model } from "@earendil-works/pi-ai";
import { findBuiltinCandidate } from "./builtins.js";
import { findCatalogCandidate } from "./models-dev.js";
import type {
  AutoProviderSpec,
  AutoModelConfig,
  BuiltinModelCandidate,
  CatalogModel,
  JsonObject,
  ModelOverride,
  ParameterReport,
} from "../types.js";

export interface ParameterSources {
  builtins: readonly BuiltinModelCandidate[];
  catalog?: Map<string, CatalogModel>;
  force: boolean;
}

export interface BuiltModelResult {
  config: AutoModelConfig;
  persistedConfig: AutoModelConfig;
  runtime: Model<Api>;
  report: ParameterReport;
}

export const DEFAULT_MODEL_PARAMS: AutoModelConfig = {
  id: "",
  name: "",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 16384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function buildProviderModel(
  spec: AutoProviderSpec,
  modelId: string,
  sources: ParameterSources,
  fallback?: Model<Api>,
): BuiltModelResult {
  const builtinMatch = findBuiltinCandidate(sources.builtins, modelId, spec.id, { officialFallback: true });
  const base = builtinMatch.model
    ? fromPiModel(modelId, spec.api, builtinMatch.model)
    : fallback
      ? fromPiModel(modelId, spec.api, fallback)
      : { ...DEFAULT_MODEL_PARAMS, id: modelId, name: modelId, api: spec.api };
  let params = base;
  const report: ParameterReport = {
    defaults: !builtinMatch.model && !fallback,
    officialFallback: Boolean(builtinMatch.model && builtinMatch.provider && builtinMatch.provider !== spec.id),
    ...(builtinMatch.ambiguity ? { ambiguity: builtinMatch.ambiguity } : {}),
  };

  if (sources.catalog && (sources.force || !builtinMatch.model)) {
    const match = findCatalogCandidate(sources.catalog.values(), modelId, undefined, spec.id, { officialFallback: true });
    if (match.candidate) {
      params = fromCatalogModel(modelId, spec.api, match.candidate.data, spec.compat);
      report.defaults = false;
      report.officialFallback = report.officialFallback || !match.candidate.source.startsWith(`${spec.id}/`);
      report.source = match.candidate.source;
    } else if (match.ambiguity) {
      if (builtinMatch.model || fallback) {
        report.ambiguity = match.ambiguity;
      } else {
        params = { ...DEFAULT_MODEL_PARAMS, id: modelId, name: modelId, api: spec.api };
        report.ambiguity = match.ambiguity;
        report.defaults = true;
      }
    }
  }

  const persistedConfig = ensureModelShape(params, modelId, spec.api, spec.compat);
  const effectiveConfig = ensureModelShape(mergeModel(persistedConfig, spec.modelOverrides?.[modelId]), modelId, spec.api);
  const runtime: Model<Api> = {
    ...effectiveConfig,
    provider: spec.id,
    baseUrl: spec.baseUrl,
  } as Model<Api>;
  return { config: effectiveConfig, persistedConfig, runtime, report };
}

export function fromCatalogModel(
  modelId: string,
  api: Api,
  data: JsonObject,
  providerCompat?: JsonObject,
): AutoModelConfig {
  const limit = isObject(data.limit) ? data.limit : {};
  const cost = isObject(data.cost) ? data.cost : {};
  const rawInput = isObject(data.modalities) ? data.modalities.input : undefined;
  const input = Array.isArray(rawInput)
    ? (rawInput as unknown[]).filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
    : [];
  return {
    id: modelId,
    name: typeof data.name === "string" && data.name.trim() ? data.name : modelId,
    api,
    reasoning: data.reasoning === true,
    input: input.length > 0 ? input : ["text"],
    contextWindow: positiveNumber(limit.context) ?? DEFAULT_MODEL_PARAMS.contextWindow,
    maxTokens: positiveNumber(limit.output) ?? DEFAULT_MODEL_PARAMS.maxTokens,
    cost: mapCost(cost),
    thinkingLevelMap: mapThinkingLevels(data.reasoning_options),
    compat: mapCompat(data, providerCompat),
  };
}

export function fromPiModel(modelId: string, api: Api, model: Model<Api>): AutoModelConfig {
  return {
    id: modelId,
    name: model.name || modelId,
    api,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: [...model.input],
    cost: cloneCost(model.cost),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.samplingParams ? { samplingParams: { ...model.samplingParams } } : {}),
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat ? { compat: cloneObject(model.compat) } : {}),
  };
}

export function mergeModel(base: AutoModelConfig, override?: ModelOverride): AutoModelConfig {
  if (!override) return { ...base };
  const result: AutoModelConfig = { ...base };
  if (override.name !== undefined) result.name = override.name;
  if (override.reasoning !== undefined) result.reasoning = override.reasoning;
  if (override.input !== undefined) result.input = [...override.input];
  if (override.contextWindow !== undefined) result.contextWindow = override.contextWindow;
  if (override.maxTokens !== undefined) result.maxTokens = override.maxTokens;
  if (override.thinkingLevelMap !== undefined) {
    result.thinkingLevelMap = { ...result.thinkingLevelMap, ...override.thinkingLevelMap };
  }
  if (override.cost !== undefined) result.cost = deepMerge(result.cost, override.cost) as AutoModelConfig["cost"];
  if (override.samplingParams !== undefined) result.samplingParams = deepMerge(result.samplingParams, override.samplingParams);
  if (override.compat !== undefined) result.compat = deepMerge(result.compat, override.compat) as AutoModelConfig["compat"];
  if (override.headers !== undefined) result.headers = { ...result.headers, ...override.headers };
  return result;
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base;
  if (Array.isArray(override)) return [...override] as T;
  if (isObject(base) && isObject(override)) {
    const output: JsonObject = { ...base };
    for (const [key, value] of Object.entries(override)) output[key] = deepMerge(output[key], value);
    return output as T;
  }
  return override as T;
}

function ensureModelShape(
  params: AutoModelConfig,
  modelId: string,
  api: Api,
  providerCompat?: JsonObject,
): AutoModelConfig {
  return {
    ...DEFAULT_MODEL_PARAMS,
    ...params,
    id: modelId,
    name: params.name || modelId,
    api,
    // Settings-backed provider compatibility is authoritative over stale model data.
    compat: providerCompat ? (deepMerge(params.compat, providerCompat) as AutoModelConfig["compat"]) : params.compat,
    cost: {
      ...DEFAULT_MODEL_PARAMS.cost,
      ...params.cost,
    },
  };
}

function mapCost(cost: JsonObject): AutoModelConfig["cost"] {
  const result: AutoModelConfig["cost"] = {
    input: finiteNumber(cost.input) ?? 0,
    output: finiteNumber(cost.output) ?? 0,
    cacheRead: finiteNumber(cost.cache_read ?? cost.cacheRead) ?? 0,
    cacheWrite: finiteNumber(cost.cache_write ?? cost.cacheWrite) ?? 0,
  };
  if (Array.isArray(cost.tiers)) {
    result.tiers = cost.tiers.flatMap((value) => {
      if (!isObject(value)) return [];
      const tier = isObject(value.tier) ? value.tier : {};
      const threshold = positiveNumber(tier.size ?? value.inputTokensAbove);
      if (threshold === undefined) return [];
      return [{
        input: finiteNumber(value.input) ?? result.input,
        output: finiteNumber(value.output) ?? result.output,
        cacheRead: finiteNumber(value.cache_read ?? value.cacheRead) ?? result.cacheRead,
        cacheWrite: finiteNumber(value.cache_write ?? value.cacheWrite) ?? result.cacheWrite,
        inputTokensAbove: threshold,
      }];
    });
  }
  return result;
}

function mapThinkingLevels(value: unknown): AutoModelConfig["thinkingLevelMap"] {
  if (!Array.isArray(value)) return undefined;
  const effort = value.find((entry) => isObject(entry) && entry.type === "effort");
  if (!effort || !Array.isArray((effort as JsonObject).values)) return undefined;
  const values = new Set(
    ((effort as JsonObject).values as unknown[]).filter((entry): entry is string => typeof entry === "string"),
  );
  const levels = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const result: Record<string, string | null> = {};
  if (values.has("none")) result.off = "none";
  for (const level of levels) if (values.has(level)) result[level] = level;
  return Object.keys(result).length > 0 ? result : undefined;
}

function mapCompat(data: JsonObject, providerCompat?: JsonObject): AutoModelConfig["compat"] {
  const result: JsonObject = providerCompat ? cloneObject(providerCompat) : {};
  if (data.temperature === false) result.supportsTemperature = false;
  if (isObject(data.interleaved) && typeof data.interleaved.field === "string") {
    result.requiresReasoningContentOnAssistantMessages = true;
  }
  return Object.keys(result).length > 0 ? (result as AutoModelConfig["compat"]) : undefined;
}

function cloneCost(value: Model<Api>["cost"]): AutoModelConfig["cost"] {
  return JSON.parse(JSON.stringify(value)) as AutoModelConfig["cost"];
}

function cloneObject<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
