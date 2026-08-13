import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { BuiltinModelCandidate } from "../types.js";

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
): { model?: Model<Api>; ambiguity?: string } {
  const exact = candidates.filter((entry) => entry.model.id === modelId);
  if (exact.length === 1) return { model: exact[0].model };
  if (exact.length > 1) {
    const preferred = preferProvider(exact, providerHint, modelId);
    if (preferred.length === 1) return { model: preferred[0].model };
    return { ambiguity: `model "${modelId}" has multiple built-in matches` };
  }

  const suffix = candidates.filter((entry) => entry.model.id.endsWith(`/${modelId}`));
  if (suffix.length === 1) return { model: suffix[0].model };
  if (suffix.length > 1) {
    const preferred = preferProvider(suffix, providerHint, modelId);
    if (preferred.length === 1) return { model: preferred[0].model };
    return { ambiguity: `model "${modelId}" has multiple built-in matches` };
  }

  return {};
}

function preferProvider(candidates: readonly BuiltinModelCandidate[], hint: string | undefined, modelId: string): BuiltinModelCandidate[] {
  const vendor = modelId.includes("/") ? modelId.split("/", 1)[0] : undefined;
  const hints = [vendor, hint].filter((value): value is string => Boolean(value)).flatMap((value) => [value, value.split(/[-_]/, 1)[0]]);
  const preferred = candidates.filter((entry) => hints.some((value) => entry.provider === value || entry.provider.startsWith(`${value}-`)));
  return preferred;
}
