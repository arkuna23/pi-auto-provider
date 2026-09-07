import type {
  Api,
  Model,
  ModelsStoreEntry,
} from "@earendil-works/pi-ai";
import type { ProviderModelConfig as PiProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type JsonObject = Record<string, unknown>;

export interface ModelOverride extends JsonObject {
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: Array<"text" | "image">;
  cost?: JsonObject;
  contextWindow?: number;
  maxTokens?: number;
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: JsonObject;
}

export interface AutoProviderConfig extends JsonObject {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: JsonObject;
  modelOverrides?: Record<string, ModelOverride>;
}

export interface CatalogModel {
  source: string;
  provider: string;
  modelKey: string;
  data: JsonObject;
}

export interface BuiltinModelCandidate {
  provider: string;
  model: Model<Api>;
}

export interface ParameterReport {
  defaults: boolean;
  officialFallback?: boolean;
  ambiguity?: string;
  source?: string;
  sourceError?: string;
}

export interface RefreshReport {
  providerId: string;
  modelCount: number;
  officialFallbacks: number;
  defaults: number;
  ambiguities: string[];
  errors: string[];
  modelsDevError?: string;
  endpointError?: string;
  modelsJsonError?: string;
  aborted?: boolean;
}

export type AutoModelConfig = PiProviderModelConfig & {
  samplingParams?: Record<string, unknown>;
};

export interface StoredProviderModels {
  models: readonly Model<Api>[];
  checkedAt?: number;
}

export interface AutoProviderSpec {
  id: string;
  name?: string;
  baseUrl: string;
  api: Api;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: JsonObject;
  modelOverrides?: Record<string, ModelOverride>;
}

export interface RefreshModelsContextLike {
  credential?: { type: string; key?: string; env?: Record<string, string> };
  stored?: Readonly<ModelsStoreEntry>;
  publish(publication: {
    persist?: ModelsStoreEntry | null;
    update?: () => void;
  }): Promise<boolean>;
  allowNetwork: boolean;
  force?: boolean;
  signal: AbortSignal;
}
