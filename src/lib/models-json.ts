import { join } from "node:path";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { readJsonc } from "./jsonc.js";
import type { AutoProviderSpec, JsonObject, ModelsJsonProviderConfig } from "../types.js";

export interface ModelsJsonLoadResult {
  path: string;
  providers: Map<string, ModelsJsonProviderConfig>;
  errors: string[];
}

export async function loadModelsJson(agentDir: string): Promise<ModelsJsonLoadResult> {
  const path = join(agentDir, "models.json");
  const parsed = await readJsonc(path);
  if (!parsed.exists) return { path, providers: new Map(), errors: [] };
  if (parsed.error) return { path, providers: new Map(), errors: [parsed.error] };
  if (!isObject(parsed.value)) return { path, providers: new Map(), errors: [`${path}: top level must be an object`] };

  // Pi 0.84 stores provider definitions under `providers`. Accepting the
  // legacy direct-map shape as a compatibility fallback is harmless and keeps
  // the extension usable with older local fixtures.
  let providerObject: JsonObject;
  if (Object.prototype.hasOwnProperty.call(parsed.value, "providers")) {
    if (!isObject(parsed.value.providers)) {
      return { path, providers: new Map(), errors: [`${path}: providers must be an object`] };
    }
    providerObject = parsed.value.providers;
  } else {
    providerObject = parsed.value;
  }

  const providers = new Map<string, ModelsJsonProviderConfig>();
  const errors: string[] = [];
  for (const [providerId, value] of Object.entries(providerObject)) {
    if (!isObject(value)) {
      errors.push(`${path}: provider "${providerId}" must be an object`);
      continue;
    }
    providers.set(providerId, value as ModelsJsonProviderConfig);
  }
  return { path, providers, errors };
}

export function selectAutoProviders(
  config: ModelsJsonLoadResult,
  builtinProviderIds: Iterable<string> = getBuiltinProviders(),
): { providers: AutoProviderSpec[]; errors: string[] } {
  const builtins = new Set(builtinProviderIds);
  const providers: AutoProviderSpec[] = [];
  const errors = [...config.errors];
  for (const [id, value] of config.providers) {
    if (builtins.has(id) || Object.prototype.hasOwnProperty.call(value, "models")) continue;
    if (typeof value.baseUrl !== "string" || !isHttpUrl(value.baseUrl)) {
      errors.push(`${config.path}: provider "${id}" has no valid baseUrl`);
      continue;
    }
    if (typeof value.api !== "string" || value.api.trim() === "") {
      errors.push(`${config.path}: provider "${id}" has no valid api`);
      continue;
    }
    const api = value.api as Api;
    if (!getApiProvider(api)) {
      errors.push(`${config.path}: provider "${id}" has unsupported api "${value.api}"`);
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
    });
  }
  return { providers, errors };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
