/**
 * Providers used by the official Pi/model catalog before unknown providers.
 *
 * This is only used when a custom provider has exposed an unqualified model
 * id that exists in more than one official provider. A model id's own vendor
 * prefix is still preferred before this list is consulted.
 */
export const OFFICIAL_PROVIDER_PRIORITY = [
  "openai-codex",
  "openai",
  "anthropic",
  "google",
  "deepseek",
] as const;

export function preferProviderByOfficialPriority<T extends { provider: string }>(candidates: readonly T[]): T[] {
  if (candidates.length === 0) return [];
  const providers = [...new Set(candidates.map((candidate) => candidate.provider))];
  providers.sort((left, right) => {
    const leftRank = providerRank(left);
    const rightRank = providerRank(right);
    return leftRank - rightRank || left.localeCompare(right);
  });
  const provider = providers[0];
  return candidates.filter((candidate) => candidate.provider === provider);
}

function providerRank(provider: string): number {
  const index = OFFICIAL_PROVIDER_PRIORITY.indexOf(provider as (typeof OFFICIAL_PROVIDER_PRIORITY)[number]);
  return index === -1 ? OFFICIAL_PROVIDER_PRIORITY.length : index;
}
