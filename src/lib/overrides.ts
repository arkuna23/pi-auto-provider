import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { readJsonc } from "./jsonc.js";
import type { JsonObject, ModelOverride, OverrideLayer } from "../types.js";

const OVERRIDE_FIELDS = new Set([
  "source",
  "name",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "samplingParams",
  "headers",
  "compat",
]);
const THINKING_LEVEL_FIELDS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const COST_FIELDS = new Set(["input", "output", "cacheRead", "cacheWrite", "tiers"]);
const COMPAT_FIELDS = new Set([
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "maxTokensField",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "thinkingFormat",
  "chatTemplateKwargs",
  "chatTemplateArgs",
  "cacheControlFormat",
  "openRouterRouting",
  "vercelGatewayRouting",
  "supportsOpenAIGrammarTools",
  "supportsStrictMode",
  "sendSessionAffinityHeaders",
  "deferredToolsMode",
  "sessionAffinityFormat",
  "supportsLongCacheRetention",
  "supportsToolSearch",
  "supportsEagerToolInputStreaming",
  "supportsCacheControlOnTools",
  "supportsTemperature",
  "forceAdaptiveThinking",
  "allowEmptySignature",
  "supportsStrictTools",
  "supportsToolReferences",
]);

export async function loadOverrideLayer(path: string): Promise<OverrideLayer> {
  const parsed = await readJsonc(path);
  if (!parsed.exists) return { path, exists: false, entries: new Map() };
  if (parsed.error) return { path, exists: true, entries: new Map(), error: parsed.error };
  if (!isObject(parsed.value)) {
    return { path, exists: true, entries: new Map(), error: `${path}: top level must be an object` };
  }

  const entries = new Map<string, ModelOverride>();
  try {
    for (const [key, value] of Object.entries(parsed.value)) {
      if (key.includes("/")) {
        const normalized = normalizeFlatKey(key);
        addEntry(entries, normalized, value, path);
        continue;
      }
      if (key.trim() === "") throw new Error(`${path}: provider id must not be empty`);
      if (!isObject(value)) throw new Error(`${path}: provider "${key}" must contain model objects`);
      for (const [modelId, override] of Object.entries(value)) {
        if (modelId.trim() === "") throw new Error(`${path}: model id under "${key}" must not be empty`);
        addEntry(entries, `${key}/${modelId}`, override, path);
      }
    }
  } catch (error) {
    return { path, exists: true, entries: new Map(), error: errorMessage(error) };
  }
  return { path, exists: true, entries };
}

export function mergeOverrideLayers(layers: readonly OverrideLayer[]): {
  entries: Map<string, ModelOverride>;
  errors: string[];
} {
  const entries = new Map<string, ModelOverride>();
  const errors: string[] = [];
  for (const layer of layers) {
    if (layer.error) {
      errors.push(layer.error);
      continue;
    }
    for (const [key, value] of layer.entries) entries.set(key, value);
  }
  return { entries, errors };
}

export function normalizeFlatKey(key: string): string {
  const slash = key.indexOf("/");
  if (
    slash <= 0 ||
    slash === key.length - 1 ||
    key.slice(0, slash).trim() === "" ||
    key.slice(slash + 1).trim() === ""
  ) {
    throw new Error(`invalid flat model key "${key}"`);
  }
  return `${key.slice(0, slash)}/${key.slice(slash + 1)}`;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${dirname(path)}/.${basename(path)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Preserve the original rename error.
    }
    throw error;
  }
}

function addEntry(entries: Map<string, ModelOverride>, key: string, value: unknown, path: string): void {
  if (entries.has(key)) throw new Error(`${path}: duplicate model definition "${key}"`);
  validateOverride(value, `${path}: model "${key}"`);
  entries.set(key, value as ModelOverride);
}

function validateOverride(value: unknown, label: string): asserts value is ModelOverride {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!OVERRIDE_FIELDS.has(key)) throw new Error(`${label}: invalid field "${key}"`);
  }
  if (value.source !== undefined && (typeof value.source !== "string" || value.source.trim() === "")) {
    throw new Error(`${label}.source must be a non-empty string`);
  }
  if (value.name !== undefined && typeof value.name !== "string") throw new Error(`${label}.name must be a string`);
  if (value.reasoning !== undefined && typeof value.reasoning !== "boolean") {
    throw new Error(`${label}.reasoning must be boolean`);
  }
  if (value.thinkingLevelMap !== undefined) validateThinkingLevelMap(value.thinkingLevelMap, `${label}.thinkingLevelMap`);
  if (value.input !== undefined) {
    if (!Array.isArray(value.input) || value.input.some((entry) => entry !== "text" && entry !== "image")) {
      throw new Error(`${label}.input must contain only text or image`);
    }
  }
  if (value.cost !== undefined) validateCost(value.cost, `${label}.cost`);
  for (const key of ["samplingParams", "compat"] as const) {
    if (key === "compat" && value[key] !== undefined) validateCompat(value[key], `${label}.${key}`);
    else if (value[key] !== undefined) validateObject(value[key], `${label}.${key}`);
  }
  if (value.headers !== undefined && !isStringRecord(value.headers)) {
    throw new Error(`${label}.headers must be an object of strings`);
  }
  for (const key of ["contextWindow", "maxTokens"] as const) {
    if (value[key] !== undefined && (!isFinitePositiveNumber(value[key]))) {
      throw new Error(`${label}.${key} must be a positive number`);
    }
  }
}

function validateCost(value: unknown, label: string): void {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!COST_FIELDS.has(key)) throw new Error(`${label}: invalid field "${key}"`);
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "number") throw new Error(`${label}.${key} must be a number`);
  }
  if (value.tiers !== undefined) {
    if (!Array.isArray(value.tiers)) throw new Error(`${label}.tiers must be an array`);
    for (const [index, tier] of value.tiers.entries()) {
      if (!isObject(tier)) throw new Error(`${label}.tiers[${index}] must be an object`);
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "inputTokensAbove"] as const) {
        if (typeof tier[key] !== "number") throw new Error(`${label}.tiers[${index}].${key} must be a number`);
      }
    }
  }
}

function validateThinkingLevelMap(value: unknown, label: string): void {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  for (const [key, entry] of Object.entries(value)) {
    if (!THINKING_LEVEL_FIELDS.has(key)) throw new Error(`${label}: invalid field "${key}"`);
    if (entry !== null && typeof entry !== "string") throw new Error(`${label}.${key} must be a string or null`);
  }
}

function validateCompat(value: unknown, label: string): void {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!COMPAT_FIELDS.has(key)) throw new Error(`${label}: invalid field "${key}"`);
  if (value.maxTokensField !== undefined && value.maxTokensField !== "max_tokens" && value.maxTokensField !== "max_completion_tokens") {
    throw new Error(`${label}.maxTokensField must be max_tokens or max_completion_tokens`);
  }
  for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"] as const) {
    if (value[key] !== undefined) validateObject(value[key], `${label}.${key}`);
  }
}

function validateObject(value: unknown, label: string): asserts value is JsonObject {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
