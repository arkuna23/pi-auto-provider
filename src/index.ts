import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadModelsJson, selectAutoProviders } from "./lib/models-json.js";
import { AutoProviderManager } from "./lib/refresh.js";
import type { AutoProviderSpec, RefreshModelsContextLike } from "./types.js";

export { loadModelsJson, selectAutoProviders } from "./lib/models-json.js";
export { loadOverrideLayer, mergeOverrideLayers, normalizeFlatKey } from "./lib/overrides.js";
export { buildRequestUrl, fetchRemoteModelIds, AutoProviderManager } from "./lib/refresh.js";
export { fetchModelsDev, findCatalogCandidate, resetModelsDevRequest } from "./lib/models-dev.js";
export {
  DEFAULT_MODEL_PARAMS,
  buildProviderModel,
  deepMerge,
  fromCatalogModel,
  fromPiModel,
  mergeModel,
} from "./lib/params.js";

export default async function autoProviderExtension(pi: ExtensionAPI): Promise<void> {
  const agentDir = getAgentDir();
  const loaded = await loadModelsJson(agentDir);
  const selected = selectAutoProviders(loaded);
  const manager = new AutoProviderManager(agentDir, selected.providers, {
    cwd: process.cwd(),
    errors: selected.errors,
  });
  const registered: AutoProviderSpec[] = [];

  for (const spec of selected.providers) {
    try {
      const refreshModels = (context: RefreshModelsContextLike) => manager.refresh(spec, context);
      pi.registerProvider(spec.id, {
        ...(spec.name ? { name: spec.name } : {}),
        baseUrl: spec.baseUrl,
        api: spec.api,
        // An empty key is a keyless-provider sentinel. Pi's refresh runtime
        // otherwise skips online refreshes when a provider has no auth field.
        apiKey: spec.apiKey ?? "",
        ...(spec.headers ? { headers: spec.headers } : {}),
        ...(spec.authHeader !== undefined ? { authHeader: spec.authHeader } : {}),
        refreshModels,
      });
      registered.push(spec);
    } catch (error) {
      manager.addError(`${loaded.path}: provider "${spec.id}" registration failed: ${errorMessage(error)}`);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    manager.setProjectTrust(ctx.isProjectTrusted(), ctx.cwd);
    if (registered.length === 0) return;
    try {
      const result = await ctx.modelRegistry.refresh({
        providers: registered.map((spec) => spec.id),
        allowNetwork: false,
        force: false,
        signal: ctx.signal,
      });
      if (result.errors.size > 0) {
        notify(ctx, [...result.errors.values()].map((error) => error.message).join("; "), "warning");
      }
    } catch (error) {
      notify(ctx, `auto-model-provider: ${errorMessage(error)}`, "warning");
    }
  });

  pi.registerCommand("refresh-models", {
    description: "Refresh automatic provider model catalogs",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (registered.length === 0) {
        notify(ctx, formatSummary(manager, []), "warning");
        return;
      }
      if (ctx.hasUI) ctx.ui.setStatus("auto-model-provider", "Refreshing model catalogs...");
      try {
        const result = await ctx.modelRegistry.refresh({
          providers: registered.map((spec) => spec.id),
          allowNetwork: true,
          force: true,
          signal: ctx.signal,
        });
        const errors = [...result.errors.values()].map((error) => error.message);
        notify(ctx, formatSummary(manager, errors), errors.length > 0 ? "warning" : "info");
      } catch (error) {
        notify(ctx, `auto-model-provider: ${errorMessage(error)}`, "error");
      } finally {
        if (ctx.hasUI) ctx.ui.setStatus("auto-model-provider", undefined);
      }
    },
  });
}

function formatSummary(manager: AutoProviderManager, refreshErrors: string[]): string {
  const lines = ["auto-model-provider refresh summary"];
  for (const report of manager.getReports()) {
    lines.push(`${report.providerId}: ${report.modelCount} model(s), ${report.cacheUpdated} parameter cache update(s), ${report.defaults} default parameter set(s)`);
    if (report.ambiguities.length > 0) lines.push(`  ambiguous: ${report.ambiguities.join(", ")}`);
    if (report.errors.length > 0) lines.push(`  config: ${report.errors.join("; ")}`);
    if (report.modelsDevError) lines.push(`  models.dev: ${report.modelsDevError}`);
    if (report.endpointError) lines.push(`  provider: ${report.endpointError}`);
  }
  for (const error of manager.errors) lines.push(`error: ${error}`);
  for (const error of refreshErrors) lines.push(`refresh error: ${error}`);
  return lines.join("\n");
}

function notify(ctx: Pick<ExtensionContext, "hasUI" | "ui">, message: string, type: "info" | "warning" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
