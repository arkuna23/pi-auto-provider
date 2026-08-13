import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { BuiltinModelCandidate } from "../types.js";
import { preferProviderByOfficialPriority } from "./provider-priority.js";

export { OFFICIAL_PROVIDER_PRIORITY } from "./provider-priority.js";

export function builtinProviderIds(): Set<string> {
  return new Set(getBuiltinProviders());
}

export function builtinModelCandidates(): BuiltinModelCandidate[] {
  const result: BuiltinModelCandidate[] = [];
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider as never) as Model<Api>[]) {
      result.push({ provider, model });
    }
  }
  return result;
}

export function findBuiltinCandidate(
  candidates: readonly BuiltinModelCandidate[],
  modelId: string,
  providerHint?: string,
  options: { officialFallback?: boolean } = {},
): { model?: Model<Api>; provider?: string; ambiguity?: string } {
  const modelVendor = modelId.includes("/") ? modelId.split("/", 1)[0] : undefined;
  const modelKey = modelVendor ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
  const exact = candidates.filter((entry) => {
    if (entry.model.id === modelId) return true;
    return Boolean(modelVendor && entry.provider === modelVendor && entry.model.id === modelKey);
  });
  if (exact.length === 1) return { model: exact[0].model, provider: exact[0].provider };
  if (exact.length > 1) {
    const preferred = preferProvider(exact, providerHint, modelId, options.officialFallback);
    if (preferred.length === 1) return { model: preferred[0].model, provider: preferred[0].provider };
    return { ambiguity: `model "${modelId}" has multiple built-in matches` };
  }

  const suffix = candidates.filter((entry) => {
    const suffixId = modelVendor ? modelKey : modelId;
    return entry.model.id.endsWith(`/${suffixId}`) && (!modelVendor || entry.provider === modelVendor);
  });
  if (suffix.length === 1) return { model: suffix[0].model, provider: suffix[0].provider };
  if (suffix.length > 1) {
    const preferred = preferProvider(suffix, providerHint, modelId, options.officialFallback);
    if (preferred.length === 1) return { model: preferred[0].model, provider: preferred[0].provider };
    return { ambiguity: `model "${modelId}" has multiple built-in matches` };
  }

  return {};
}

function preferProvider(
  candidates: readonly BuiltinModelCandidate[],
  hint: string | undefined,
  modelId: string,
  officialFallback = false,
): BuiltinModelCandidate[] {
  const vendor = modelId.includes("/") ? modelId.split("/", 1)[0] : undefined;
  const exactHints = [vendor, hint].filter((value): value is string => Boolean(value));
  const exactPreferred = candidates.filter((entry) => exactHints.includes(entry.provider));
  if (exactPreferred.length > 0) return exactPreferred;
  const hints = exactHints.flatMap((value) => [value, value.split(/[-_]/, 1)[0]]);
  const preferred = candidates.filter((entry) => hints.some((value) => entry.provider === value || entry.provider.startsWith(`${value}-`)));
  if (preferred.length > 0) return preferred;
  return officialFallback ? preferProviderByOfficialPriority(candidates) : [];
}
