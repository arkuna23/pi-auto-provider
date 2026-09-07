import { join } from "node:path";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { readJsonc } from "./jsonc.js";
import type { AutoProviderSpec, JsonObject, AutoProviderConfig, ModelOverride } from "../types.js";

export interface AutoProviderConfigLoadResult {
  path: string;
  providers: Map<string, AutoProviderConfig>;
  errors: string[];
}

/** Load automatic-provider declarations from the standalone JSONC config. */
export async function loadAutoProviderConfig(agentDir: string): Promise<AutoProviderConfigLoadResult> {
  const path = join(agentDir, "auto-provider.json");
  const parsed = await readJsonc(path);
  if (!parsed.exists) return { path, providers: new Map(), errors: [] };
  if (parsed.error) return { path, providers: new Map(), errors: [parsed.error] };
  if (!isObject(parsed.value)) return { path, providers: new Map(), errors: [`${path}: top level must be an object`] };

  const providerObject = parsed.value.providers;
  if (providerObject === undefined) return { path, providers: new Map(), errors: [] };
  if (!isObject(providerObject)) {
    return { path, providers: new Map(), errors: [`${path}: providers must be an object`] };
  }

  const providers = new Map<string, AutoProviderConfig>();
  const errors: string[] = [];
  for (const [providerId, value] of Object.entries(providerObject)) {
    if (!isObject(value)) {
      errors.push(`${path}: provider "${providerId}" must be an object`);
      continue;
    }
    const overrideErrors = validateModelOverrides(value.modelOverrides, `${path}: providers."${providerId}".modelOverrides`);
    if (overrideErrors.length > 0) {
      errors.push(...overrideErrors);
      continue;
    }
    providers.set(providerId, value as AutoProviderConfig);
  }
  return { path, providers, errors };
}

export function selectAutoProviders(
  config: AutoProviderConfigLoadResult,
  builtinProviderIds: Iterable<string> = getBuiltinProviders(),
): { providers: AutoProviderSpec[]; errors: string[] } {
  const builtins = new Set(builtinProviderIds);
  const providers: AutoProviderSpec[] = [];
  const errors = [...config.errors];
  for (const [id, value] of config.providers) {
    if (builtins.has(id)) continue;
    if (id.trim() === "") {
      errors.push(`${config.path}: provider id must not be empty`);
      continue;
    }
    const label = `${config.path}: providers."${id}"`;
    if (typeof value.baseUrl !== "string" || !isHttpUrl(value.baseUrl)) {
      errors.push(`${label} has no valid baseUrl`);
      continue;
    }
    if (typeof value.api !== "string" || value.api.trim() === "") {
      errors.push(`${label} has no valid api`);
      continue;
    }
    const api = value.api as Api;
    if (!getApiProvider(api)) {
      errors.push(`${label} has unsupported api`);
      continue;
    }
    if (value.name !== undefined && typeof value.name !== "string") {
      errors.push(`${label}.name must be a string`);
      continue;
    }
    if (value.apiKey !== undefined && typeof value.apiKey !== "string") {
      errors.push(`${label}.apiKey must be a string`);
      continue;
    }
    if (value.headers !== undefined && !isStringRecord(value.headers)) {
      errors.push(`${label}.headers must be an object of strings`);
      continue;
    }
    if (value.authHeader !== undefined && typeof value.authHeader !== "boolean") {
      errors.push(`${label}.authHeader must be a boolean`);
      continue;
    }
    if (value.compat !== undefined && !isObject(value.compat)) {
      errors.push(`${label}.compat must be an object`);
      continue;
    }
    const overrideErrors = validateModelOverrides(value.modelOverrides, `${label}.modelOverrides`);
    if (overrideErrors.length > 0) {
      errors.push(...overrideErrors);
      continue;
    }
    providers.push({
      id,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      baseUrl: value.baseUrl,
      api,
      ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey } : {}),
      ...(isStringRecord(value.headers) ? { headers: value.headers } : {}),
      ...(typeof value.authHeader === "boolean" ? { authHeader: value.authHeader } : {}),
      ...(isObject(value.compat) ? { compat: value.compat } : {}),
      ...(value.modelOverrides ? { modelOverrides: value.modelOverrides as Record<string, ModelOverride> } : {}),
    });
  }
  return { providers, errors };
}

const MODEL_OVERRIDE_FIELDS = new Set([
  "name", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow",
  "maxTokens", "samplingParams", "headers", "compat",
 ]);
const COST_FIELDS = new Set(["input", "output", "cacheRead", "cacheWrite", "tiers"]);
const THINKING_LEVEL_FIELDS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function validateModelOverrides(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!isObject(value)) return [`${label} must be an object keyed by model id`];
  const errors: string[] = [];
  for (const [modelId, override] of Object.entries(value)) {
    const modelLabel = `${label}."${modelId}"`;
    if (modelId.trim() === "") {
      errors.push(`${label}: model id must not be empty`);
      continue;
    }
    if (!isObject(override)) {
      errors.push(`${modelLabel} must be an object`);
      continue;
    }
    for (const key of Object.keys(override)) {
      if (!MODEL_OVERRIDE_FIELDS.has(key)) errors.push(`${modelLabel}: invalid field "${key}"`);
    }
    if (override.name !== undefined && typeof override.name !== "string") errors.push(`${modelLabel}.name must be a string`);
    if (override.reasoning !== undefined && typeof override.reasoning !== "boolean") {
      errors.push(`${modelLabel}.reasoning must be boolean`);
    }
    if (override.thinkingLevelMap !== undefined) errors.push(...validateThinkingLevelMap(override.thinkingLevelMap, `${modelLabel}.thinkingLevelMap`));
    if (override.input !== undefined && (!Array.isArray(override.input) || override.input.length === 0 || override.input.some((entry) => entry !== "text" && entry !== "image"))) {
      errors.push(`${modelLabel}.input must be a non-empty array containing only text or image`);
    }
    if (override.cost !== undefined) errors.push(...validateCost(override.cost, `${modelLabel}.cost`));
    for (const key of ["contextWindow", "maxTokens"] as const) {
      if (override[key] !== undefined && !isFinitePositiveNumber(override[key])) {
        errors.push(`${modelLabel}.${key} must be a positive number`);
      }
    }
    for (const key of ["samplingParams", "compat"] as const) {
      if (override[key] !== undefined && !isObject(override[key])) errors.push(`${modelLabel}.${key} must be an object`);
    }
    if (override.headers !== undefined && !isStringRecord(override.headers)) {
      errors.push(`${modelLabel}.headers must be an object of strings`);
    }
  }
  return errors;
}

function validateThinkingLevelMap(value: unknown, label: string): string[] {
  if (!isObject(value)) return [`${label} must be an object`];
  const errors: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!THINKING_LEVEL_FIELDS.has(key)) errors.push(`${label}: invalid field "${key}"`);
    if (entry !== null && typeof entry !== "string") errors.push(`${label}.${key} must be a string or null`);
  }
  return errors;
}

function validateCost(value: unknown, label: string): string[] {
  if (!isObject(value)) return [`${label} must be an object`];
  const errors: string[] = [];
  for (const key of Object.keys(value)) if (!COST_FIELDS.has(key)) errors.push(`${label}: invalid field "${key}"`);
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (value[key] !== undefined && !isFiniteNumber(value[key])) errors.push(`${label}.${key} must be a finite number`);
  }
  if (value.tiers !== undefined) {
    if (!Array.isArray(value.tiers)) {
      errors.push(`${label}.tiers must be an array`);
    } else {
      for (const [index, tier] of value.tiers.entries()) {
        const tierLabel = `${label}.tiers[${index}]`;
        if (!isObject(tier)) {
          errors.push(`${tierLabel} must be an object`);
          continue;
        }
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "inputTokensAbove"] as const) {
          if (!isFiniteNumber(tier[key]) || (key === "inputTokensAbove" && (tier[key] as number) < 0)) {
            errors.push(`${tierLabel}.${key} must be a finite number`);
          }
        }
      }
    }
  }
  return errors;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isFinitePositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}
function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
