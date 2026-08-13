import type { CatalogModel, JsonObject } from "../types.js";

export const MODELS_DEV_URL = "https://models.dev/api.json";

let inFlightCatalogRequest: Promise<Map<string, CatalogModel>> | undefined;

export async function fetchModelsDev(signal?: AbortSignal, force = false): Promise<Map<string, CatalogModel>> {
  // The disk cache controls freshness across refreshes. This in-memory
  // promise is deliberately only an in-flight de-duplication window, so a
  // later cache miss can fetch a newer models.dev catalog.
  void force;
  if (signal?.aborted) throw abortError();
  if (!inFlightCatalogRequest) {
    const request = requestCatalog();
    const wrapped = request.finally(() => {
      if (inFlightCatalogRequest === wrapped) inFlightCatalogRequest = undefined;
    });
    inFlightCatalogRequest = wrapped;
  }
  return raceWithAbort(inFlightCatalogRequest, signal);
}

export function resetModelsDevRequest(): void {
  inFlightCatalogRequest = undefined;
}

export function findCatalogCandidate(
  catalog: Iterable<CatalogModel>,
  modelId: string,
  source?: string,
  providerHint?: string,
): { candidate?: CatalogModel; ambiguity?: string } {
  const candidates = [...catalog];
  if (source) {
    const exact = candidates.filter((entry) => entry.source === source);
    if (exact.length === 1) return { candidate: exact[0] };
    if (exact.length > 1) {
      const vendor = source.split("/", 1)[0];
      const preferred = exact.filter((entry) => entry.provider === vendor);
      if (preferred.length === 1) return { candidate: preferred[0] };
      return { ambiguity: `source "${source}" is ambiguous` };
    }
    return { ambiguity: `source "${source}" was not found` };
  }

  const exactSource = candidates.filter((entry) => entry.source === modelId);
  if (exactSource.length === 1) return { candidate: exactSource[0] };
  if (exactSource.length > 1) {
    const preferred = preferCatalogProvider(exactSource, providerHint, modelId);
    if (preferred.length === 1) return { candidate: preferred[0] };
    return { ambiguity: `model "${modelId}" has multiple exact sources` };
  }

  const exactModel = candidates.filter((entry) => entry.modelKey === modelId || entry.data.id === modelId);
  if (exactModel.length === 1) return { candidate: exactModel[0] };
  if (exactModel.length > 1) {
    const preferred = preferCatalogProvider(exactModel, providerHint, modelId);
    if (preferred.length === 1) return { candidate: preferred[0] };
    return { ambiguity: `model "${modelId}" has multiple vendor matches` };
  }

  const suffix = candidates.filter((entry) => entry.modelKey.endsWith(`/${modelId}`) || entry.source.endsWith(`/${modelId}`));
  if (suffix.length === 1) return { candidate: suffix[0] };
  if (suffix.length > 1) {
    const preferred = preferCatalogProvider(suffix, providerHint, modelId);
    if (preferred.length === 1) return { candidate: preferred[0] };
    return { ambiguity: `model "${modelId}" has multiple vendor matches` };
  }

  const modelVendor = modelId.includes("/") ? modelId.split("/", 1)[0] : undefined;
  if (modelVendor) {
    const vendor = candidates.filter((entry) => {
      const sourceVendor = entry.source.split("/", 1)[0];
      return sourceVendor === modelVendor && (entry.source === modelId || entry.modelKey === modelId.slice(modelId.indexOf("/") + 1));
    });
    if (vendor.length === 1) return { candidate: vendor[0] };
    if (vendor.length > 1) return { ambiguity: `model "${modelId}" has multiple vendor matches` };
  }

  return {};
}

function preferCatalogProvider(candidates: readonly CatalogModel[], hint: string | undefined, modelId: string): CatalogModel[] {
  const vendor = modelId.includes("/") ? modelId.split("/", 1)[0] : undefined;
  const hints = [vendor, hint].filter((value): value is string => Boolean(value)).flatMap((value) => [value, value.split(/[-_]/, 1)[0]]);
  return candidates.filter((entry) => hints.some((value) => entry.provider === value || entry.provider.startsWith(`${value}-`)));
}

async function requestCatalog(): Promise<Map<string, CatalogModel>> {
  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) throw new Error(`models.dev request failed with HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!isObject(body)) throw new Error("models.dev response must be an object");
  const result = new Map<string, CatalogModel>();
  for (const [provider, providerValue] of Object.entries(body)) {
    if (!isObject(providerValue) || !isObject(providerValue.models)) continue;
    for (const [modelKey, modelValue] of Object.entries(providerValue.models)) {
      if (!isObject(modelValue)) continue;
      const id = typeof modelValue.id === "string" && modelValue.id.trim() !== "" ? modelValue.id : modelKey;
      const source = id.includes("/") ? id : `${provider}/${id}`;
      const candidate: CatalogModel = { source, provider, modelKey, data: modelValue };
      const key = `${source}\u0000${provider}\u0000${modelKey}`;
      result.set(key, candidate);
    }
  }
  return result;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}
