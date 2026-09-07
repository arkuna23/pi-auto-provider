import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  cleanupObsoleteFiles,
  loadPersistedProviderModels,
  persistModelsJsonProviderModels,
  persistProviderModels,
  updateModelsJsonProviderModels,
  synchronizeModelsJsonProviderMetadata,
} from "./lib/models-json.js";
import {
  loadAutoProviderConfig,
  selectAutoProviders,
} from "./lib/settings.js";
import { AutoProviderManager } from "./lib/refresh.js";
import type { AutoProviderSpec, JsonObject, RefreshModelsContextLike } from "./types.js";

export {
  loadAutoProviderConfig,
  selectAutoProviders,
} from "./lib/settings.js";
export {
  cleanupObsoleteFiles,
  loadPersistedProviderModels,
  persistModelsJsonProviderModels,
  persistProviderModels,
  updateModelsJsonProviderModels,
  synchronizeModelsJsonProviderMetadata,
} from "./lib/models-json.js";
export { buildRequestUrl, fetchRemoteModelIds, resolveHeaderValue, AutoProviderManager } from "./lib/refresh.js";
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
  const loaded = await loadAutoProviderConfig(agentDir);
  const selected = selectAutoProviders(loaded);
  const initialCleanup = await cleanupObsoleteFiles(agentDir, process.cwd());
  const manager = new AutoProviderManager(agentDir, selected.providers, {
    cwd: process.cwd(),
    errors: [...selected.errors, ...initialCleanup.errors],
  });
  const registered: AutoProviderSpec[] = [];

  for (const spec of selected.providers) {
    try {
      try {
        await synchronizeModelsJsonProviderMetadata(agentDir, spec);
      } catch (error) {
        manager.addError(`${loaded.path}: provider "${spec.id}" metadata synchronization failed: ${errorMessage(error)}`);
      }
      const persisted = await loadPersistedProviderModels(agentDir, spec);
      if (persisted.error) manager.addError(persisted.error);
      const initialModels = persisted.models.map((model) => toRegistrationModel(spec, model));
      const refreshModels = (context: RefreshModelsContextLike) => manager.refresh(spec, context);
      const registration = {
        ...(spec.name ? { name: spec.name } : {}),
        baseUrl: spec.baseUrl,
        api: spec.api,
        // An empty key is a keyless-provider sentinel. Pi's refresh runtime
        // otherwise skips online refreshes when a provider has no auth field.
        apiKey: spec.apiKey ?? "",
        ...(spec.headers ? { headers: spec.headers } : {}),
        ...(spec.authHeader !== undefined ? { authHeader: spec.authHeader } : {}),
        ...(spec.compat ? { compat: spec.compat } : {}),
        ...(initialModels.length > 0 ? { models: initialModels } : {}),
        refreshModels,
      } as ProviderConfig & { compat?: JsonObject };
      pi.registerProvider(spec.id, registration);
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

function toRegistrationModel(spec: AutoProviderSpec, model: Model<Api>): NonNullable<ProviderConfig["models"]>[number] {
  return {
    id: model.id,
    name: model.name || model.id,
    api: spec.api,
    baseUrl: spec.baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: [...model.input],
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.compat ? { compat: model.compat } : {}),
  };
}

function formatSummary(manager: AutoProviderManager, refreshErrors: string[]): string {
  const lines = ["auto-model-provider refresh summary"];
  for (const report of manager.getReports()) {
    lines.push(`${report.providerId}: ${report.modelCount} model(s), ${report.defaults} default parameter set(s)`);
    if (report.officialFallbacks > 0) lines.push(`  official fallback: ${report.officialFallbacks} model(s)`);
    if (report.ambiguities.length > 0) lines.push(`  ambiguous: ${report.ambiguities.join(", ")}`);
    if (report.errors.length > 0) lines.push(`  config: ${report.errors.join("; ")}`);
    if (report.modelsDevError) lines.push(`  models.dev: ${report.modelsDevError}`);
    if (report.modelsJsonError) lines.push(`  models.json: ${report.modelsJsonError}`);
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
