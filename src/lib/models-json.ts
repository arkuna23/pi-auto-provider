import { mkdir, readFile, rename, rm, stat, unlink, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { Api, Model } from "@earendil-works/pi-ai";
import { readJsonc } from "./jsonc.js";
import type { AutoModelConfig, AutoProviderSpec, JsonObject } from "../types.js";
import { mergeModel } from "./params.js";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const LOCK_STALE_MS = 30000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_WAIT_MS = 30000;

let modelsJsonWriteTail: Promise<void> = Promise.resolve();

export interface ModelsJsonUpdateResult {
  path: string;
  changed: boolean;
}

export interface ObsoleteFileCleanupResult {
  removed: string[];
  errors: string[];
}

/** Persist compact generated model definitions without treating models.json as provider configuration. */
export async function persistProviderModels(
  agentDir: string,
  spec: AutoProviderSpec,
  models: readonly AutoModelConfig[],
): Promise<ModelsJsonUpdateResult> {
  const path = join(agentDir, "models.json");
  const definitions = models.map((model) => toModelsJsonDefinition(spec, model));
  const providerFields: JsonObject = {
    api: spec.api,
    baseUrl: spec.baseUrl,
    ...(spec.compat ? { compat: cloneGeneratedMetadata(spec.compat) as JsonObject } : {}),
    ...(spec.modelOverrides !== undefined ? { modelOverrides: cloneGeneratedMetadata(spec.modelOverrides) as JsonObject } : {}),
  };
  return updateModelsJsonProviderModels(path, spec.id, definitions, providerFields, [
    ...(spec.compat === undefined ? ["compat"] : []),
    ...(spec.modelOverrides === undefined ? ["modelOverrides"] : []),
  ]);
}

export const persistModelsJsonProviderModels = persistProviderModels;
 
/** Synchronize only generated Provider metadata while preserving the existing models array. */
export async function synchronizeModelsJsonProviderMetadata(
  agentDir: string,
  spec: AutoProviderSpec,
 ): Promise<ModelsJsonUpdateResult> {
  const path = join(agentDir, "models.json");
  const providerFields: JsonObject = {
    api: spec.api,
    baseUrl: spec.baseUrl,
    ...(spec.compat !== undefined ? { compat: cloneGeneratedMetadata(spec.compat) as JsonObject } : {}),
    ...(spec.modelOverrides !== undefined ? { modelOverrides: cloneGeneratedMetadata(spec.modelOverrides) as JsonObject } : {}),
  };
  const removeProviderFields = [
    ...(spec.compat === undefined ? ["compat"] : []),
    ...(spec.modelOverrides === undefined ? ["modelOverrides"] : []),
  ];
  const run = async (): Promise<ModelsJsonUpdateResult> => withModelsJsonLock(path, async () => {
    const current = await readModelsJsonText(path);
    const value = parseModelsJson(path, current);
    if (!isObject(value)) throw new Error(`${path}: top level must be an object`);
    const providerSegments = providerObjectPath(value, spec.id, path);
    const formattingOptions = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };
    let next = current;
    for (const [key, fieldValue] of Object.entries(providerFields)) {
      next = applyEdits(next, modify(next, [...providerSegments, key], cloneGeneratedMetadata(fieldValue), formattingOptions));
    }
    for (const key of removeProviderFields) {
      next = applyEdits(next, modify(next, [...providerSegments, key], undefined, formattingOptions));
    }
    parseModelsJson(path, next);
    if (next === current) return { path, changed: false };
    await writeModelsJsonAtomic(path, next);
    return { path, changed: true };
  });
  const queued = modelsJsonWriteTail.then(run);
  modelsJsonWriteTail = queued.then(() => undefined, () => undefined);
  return queued;
}

/** Replace one provider's models array using a locked, structured JSONC edit. */
export async function updateModelsJsonProviderModels(
  path: string,
  providerId: string,
  models: readonly JsonObject[],
  providerFields: JsonObject = {},
  removeProviderFields: readonly string[] = [],
): Promise<ModelsJsonUpdateResult> {
  if (providerId.trim() === "") throw new Error(`${path}: provider id must not be empty`);
  const definitions = models.map((model, index) => validatePersistedDefinition(model, `${path}: models[${index}]`));
  const run = async (): Promise<ModelsJsonUpdateResult> => withModelsJsonLock(path, async () => {
    const current = await readModelsJsonText(path);
    const value = parseModelsJson(path, current);
    if (!isObject(value)) throw new Error(`${path}: top level must be an object`);

    const pathSegments = providerPath(value, providerId, path);
    const formattingOptions = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };
    let next = applyEdits(current, modify(current, pathSegments, definitions, formattingOptions));
    const providerSegments = pathSegments.slice(0, -1);
    for (const [key, fieldValue] of Object.entries(providerFields)) {
      next = applyEdits(next, modify(next, [...providerSegments, key], cloneGeneratedMetadata(fieldValue), formattingOptions));
    }
    for (const key of removeProviderFields) {
      next = applyEdits(next, modify(next, [...providerSegments, key], undefined, formattingOptions));
    }
    parseModelsJson(path, next);
    if (next === current) return { path, changed: false };
    await writeModelsJsonAtomic(path, next);
    return { path, changed: true };
  });
  const queued = modelsJsonWriteTail.then(run);
  modelsJsonWriteTail = queued.then(() => undefined, () => undefined);
  return queued;
}

/** Read generated static models only; provider selection always comes from auto-provider.json. */
export async function loadPersistedProviderModels(
  agentDir: string,
  spec: AutoProviderSpec,
): Promise<{ models: Model<Api>[]; error?: string }> {
  const path = join(agentDir, "models.json");
  const parsed = await readJsonc(path);
  if (!parsed.exists) return { models: [] };
  if (parsed.error) return { models: [], error: parsed.error };
  if (!isObject(parsed.value)) return { models: [], error: `${path}: top level must be an object` };

  if (Object.prototype.hasOwnProperty.call(parsed.value, "providers") && !isObject(parsed.value.providers)) {
    return { models: [], error: `${path}: providers must be an object` };
  }
  const provider = persistedProviderObject(parsed.value, spec.id);
  if (provider === undefined) return { models: [] };
  if (!isObject(provider)) return { models: [], error: `${path}: provider "${spec.id}" must be an object` };
  if (provider.models === undefined) return { models: [] };
  if (!Array.isArray(provider.models)) return { models: [], error: `${path}: provider "${spec.id}" models must be an array` };

  const models: Model<Api>[] = [];
  for (const [index, value] of provider.models.entries()) {
    try {
      models.push(toRuntimeModel(spec, value, `${path}: provider "${spec.id}" models[${index}]`));
    } catch (error) {
      return { models: [], error: errorMessage(error) };
    }
  }
  return { models };
}

/** Remove only plugin-owned legacy files. Pi's models.json and models-store.json are never targets. */
export async function cleanupObsoleteFiles(agentDir: string, cwd: string): Promise<ObsoleteFileCleanupResult> {
  const paths = new Set([
    join(agentDir, "auto-models.cache.json"),
    join(agentDir, "auto-models.json"),
    join(cwd, ".pi", "auto-models.json"),
  ]);
  const removed: string[] = [];
  const errors: string[] = [];
  for (const path of paths) {
    try {
      await unlink(path);
      removed.push(path);
    } catch (error) {
      if (isNotFound(error)) continue;
      errors.push(`${path}: ${errorMessage(error)}`);
    }
  }
  return { removed, errors };
}

function toModelsJsonDefinition(spec: AutoProviderSpec, model: AutoModelConfig): JsonObject {
  if (typeof model.id !== "string" || model.id.trim() === "") {
    throw new Error(`provider "${spec.id}" generated a model without a valid id`);
  }
  if (!Array.isArray(model.input) || model.input.some((entry) => entry !== "text" && entry !== "image")) {
    throw new Error(`provider "${spec.id}" model "${model.id}" has invalid input metadata`);
  }
  if (!isFinitePositiveNumber(model.contextWindow) || !isFinitePositiveNumber(model.maxTokens)) {
    throw new Error(`provider "${spec.id}" model "${model.id}" has invalid limits`);
  }
  if (!isObject(model.cost)) throw new Error(`provider "${spec.id}" model "${model.id}" has invalid cost metadata`);

  // Shared routing and compatibility values live on the provider entry; only model-specific values are emitted here.
  const definition: JsonObject = { id: model.id };
  const name = typeof model.name === "string" && model.name.trim() !== "" ? model.name : model.id;
  if (name !== model.id) definition.name = name;
  if (model.reasoning === true) definition.reasoning = true;
  if (model.thinkingLevelMap && Object.keys(model.thinkingLevelMap).length > 0) {
    definition.thinkingLevelMap = cloneGeneratedMetadata(model.thinkingLevelMap);
  }
  if (isObject(model.samplingParams) && Object.keys(model.samplingParams).length > 0) {
    definition.samplingParams = cloneGeneratedMetadata(model.samplingParams);
  }
  if (isStringRecord(model.headers) && Object.keys(model.headers).length > 0) {
    definition.headers = cloneGeneratedMetadata(model.headers);
  }
  if (model.input.length !== 1 || model.input[0] !== "text") definition.input = [...model.input];
  const cost = compactCost(model.cost);
  if (Object.keys(cost).length > 0) definition.cost = cost;
  if (model.contextWindow !== DEFAULT_CONTEXT_WINDOW) definition.contextWindow = model.contextWindow;
  if (model.maxTokens !== DEFAULT_MAX_TOKENS) definition.maxTokens = model.maxTokens;
  const compat = removeSharedValues(model.compat, spec.compat);
  if (isObject(compat) && Object.keys(compat).length > 0) definition.compat = compat;
  return definition;
}

function compactCost(value: JsonObject): JsonObject {
  const rates = {
    input: typeof value.input === "number" ? value.input : 0,
    output: typeof value.output === "number" ? value.output : 0,
    cacheRead: typeof value.cacheRead === "number" ? value.cacheRead : 0,
    cacheWrite: typeof value.cacheWrite === "number" ? value.cacheWrite : 0,
  };
  if (Array.isArray(value.tiers) && value.tiers.length > 0) {
    return { ...rates, tiers: cloneGeneratedMetadata(value.tiers) };
  }
  return rates;
}

function removeSharedValues(value: unknown, shared: unknown): unknown {
  if (shared === undefined) return cloneGeneratedMetadata(value);
  if (isObject(value) && isObject(shared)) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      const reduced = removeSharedValues(entry, shared[key]);
      if (reduced !== undefined) result[key] = reduced;
    }
    return result;
  }
  return JSON.stringify(value) === JSON.stringify(shared) ? undefined : cloneGeneratedMetadata(value);
}

function validatePersistedDefinition(value: JsonObject, label: string): JsonObject {
  if (typeof value.id !== "string" || value.id.trim() === "") throw new Error(`${label}.id must be a non-empty string`);
  for (const forbidden of ["provider", "apiKey", "auth", "credential"]) {
    if (Object.prototype.hasOwnProperty.call(value, forbidden)) throw new Error(`${label} contains forbidden field "${forbidden}"`);
  }
  return cloneGeneratedMetadata(value) as JsonObject;
}

function providerObjectPath(value: JsonObject, providerId: string, path: string): (string | number)[] {
  if (Object.prototype.hasOwnProperty.call(value, "providers")) {
    if (!isObject(value.providers)) throw new Error(`${path}: providers must be an object`);
    const provider = value.providers[providerId];
    if (provider !== undefined && !isObject(provider)) {
      throw new Error(`${path}: provider "${providerId}" must be an object`);
    }
    return ["providers", providerId];
  }
  if (Object.prototype.hasOwnProperty.call(value, providerId)) {
    if (!isObject(value[providerId])) throw new Error(`${path}: provider "${providerId}" must be an object`);
    return [providerId];
  }
  return ["providers", providerId];
}

function providerPath(value: JsonObject, providerId: string, path: string): (string | number)[] {
  return [...providerObjectPath(value, providerId, path), "models"];
}

function persistedProviderObject(value: JsonObject, providerId: string): unknown {
  if (Object.prototype.hasOwnProperty.call(value, "providers")) {
    if (!isObject(value.providers)) return undefined;
    return value.providers[providerId];
  }
  return value[providerId];
}

function toRuntimeModel(spec: AutoProviderSpec, value: unknown, label: string): Model<Api> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  if (typeof value.id !== "string" || value.id.trim() === "") throw new Error(`${label}.id must be a non-empty string`);
  const input: Array<"text" | "image"> = Array.isArray(value.input)
    ? value.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
    : ["text"];
  const cost = isObject(value.cost) ? cloneGeneratedMetadata(value.cost) : cloneJson(DEFAULT_COST);
  const base: AutoModelConfig = {
    id: value.id,
    name: typeof value.name === "string" && value.name.trim() !== "" ? value.name : value.id,
    api: spec.api,
    reasoning: value.reasoning === true,
    ...(isObject(value.thinkingLevelMap) ? { thinkingLevelMap: cloneGeneratedMetadata(value.thinkingLevelMap) as AutoModelConfig["thinkingLevelMap"] } : {}),
    input: input.length > 0 ? input : ["text"],
    cost: cost as AutoModelConfig["cost"],
    contextWindow: isFinitePositiveNumber(value.contextWindow) ? value.contextWindow : DEFAULT_CONTEXT_WINDOW,
    maxTokens: isFinitePositiveNumber(value.maxTokens) ? value.maxTokens : DEFAULT_MAX_TOKENS,
    ...(isObject(value.samplingParams) ? { samplingParams: cloneGeneratedMetadata(value.samplingParams) as Record<string, unknown> } : {}),
    ...(isStringRecord(value.headers) ? { headers: cloneGeneratedMetadata(value.headers) as Record<string, string> } : {}),
    ...(isObject(value.compat) || spec.compat ? { compat: mergeObjects(value.compat, spec.compat) as AutoModelConfig["compat"] } : {}),
  };
  const effective = mergeModel(base, spec.modelOverrides?.[value.id]);
  const model: Model<Api> = {
    ...effective,
    provider: spec.id,
    baseUrl: spec.baseUrl,
  } as Model<Api>;
  return model;
}

function mergeObjects(base: unknown, override: unknown): JsonObject {
  const result: JsonObject = isObject(base) ? cloneGeneratedMetadata(base) as JsonObject : {};
  if (!isObject(override)) return result;
  for (const [key, value] of Object.entries(override)) {
    result[key] = isObject(result[key]) && isObject(value) ? mergeObjects(result[key], value) : cloneGeneratedMetadata(value);
  }
  return result;
}

function parseModelsJson(path: string, text: string): unknown {
  const errors: ParseError[] = [];
  const value = parse(text.replace(/^\uFEFF/, ""), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(`${path}: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  return value;
}

async function readModelsJsonText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return "{}\n";
    throw new Error(`${path}: ${errorMessage(error)}`);
  }
}

async function writeModelsJsonAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${dirname(path)}/.${path.split("/").pop() ?? "models.json"}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, text.endsWith("\n") ? text : `${text}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Preserve the original write or rename error.
    }
    throw new Error(`${path}: ${errorMessage(error)}`);
  }
}

async function withModelsJsonLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw new Error(`${path}: failed to acquire models.json lock: ${errorMessage(error)}`);
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (!isNotFound(statError)) throw new Error(`${path}: failed to inspect models.json lock: ${errorMessage(statError)}`);
      }
      if (Date.now() >= deadline) throw new Error(`${path}: timed out acquiring models.json lock`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function cloneGeneratedMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => cloneGeneratedMetadata(entry));
  if (isObject(value)) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (["apikey", "auth", "credential", "password", "secret", "token"].includes(key.toLowerCase())) continue;
      result[key] = cloneGeneratedMetadata(entry);
    }
    return result;
  }
  return value;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
