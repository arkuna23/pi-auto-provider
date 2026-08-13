# Configuration

This document describes how to configure **pi-auto-provider** in detail.

pi-auto-provider discovers models from custom OpenAI-compatible providers whose
`models.json` entry omits the `models` property. It never writes `models.json`;
discovered catalogs are persisted in Pi's `models-store.json`, while parameter
enrichment is kept in a generated `auto-models.cache.json` file.

## Files

| File | Purpose | Managed by |
|------|---------|------------|
| `~/.pi/agent/models.json` | Defines automatic providers (source of truth). | You |
| `~/.pi/agent/auto-models.json` | User overrides for discovered model parameters. | You |
| `.pi/auto-models.json` | Trusted project overrides. | You (project) |
| `~/.pi/agent/auto-models.cache.json` | Generated parameter cache. | The extension |

`~/.pi/agent/` is Pi's agent directory; it can be relocated with the
`PI_CODING_AGENT_DIR` environment variable.

## 1. Enabling an automatic provider

An **automatic provider** is a custom entry in `models.json` that has **no
`models` key**. The extension selects every such entry that is not a built-in
provider and that has a valid `baseUrl` and a supported `api`.

Minimal example:

```jsonc
// ~/.pi/agent/models.json
{
  "providers": {
    "my-proxy": {
      "baseUrl": "http://127.0.0.1:8080",
      "api": "openai-completions",
      "apiKey": "$MY_PROXY_KEY",
      "authHeader": true
    }
  }
}
```

`models.json` supports JSONC (comments and trailing commas). Entries are
ignored as automatic providers if they are built-in provider ids or if they
declare their own `models` property.

### Provider fields

| Field | Required | Description |
|-------|----------|-------------|
| `baseUrl` | Yes | HTTP(S) endpoint. The extension appends `/v1/models` (or `/models` when the path already ends in `/v1`) to discover model ids. |
| `api` | Yes | Streaming API to use, e.g. `openai-completions`. Must be a registered API. |
| `name` | No | Display name for the provider. |
| `apiKey` | No | Literal, environment interpolation, or shell command (see [Value resolution](#value-resolution)). |
| `authHeader` | No | When `true`, add `Authorization: Bearer <key>` from the resolved credential. |
| `headers` | No | Custom headers; values use the same resolution syntax as `apiKey`. |
| `compat` | No | Provider-level compatibility defaults applied to every discovered model. |

The `api` value must map to a registered API implementation. The common choices
are `openai-completions`, `openai-responses`, `anthropic-messages`,
`mistral-conversations`, `google-generative-ai`, `google-vertex`, and
`bedrock-converse-stream`.

### Value resolution

`apiKey` and `headers` values support the same syntax as Pi's `models.json`:

- **Environment interpolation:** `$ENV_VAR` or `${ENV_VAR}` (also works inside
  larger literals).
- **Shell command:** `!command` at the start executes the command and uses its
  stdout, e.g. `!op read 'op://vault/item/credential'`.
- **Escapes:** `$$` emits a literal `$`; `$!` emits a literal `!`.
- **Literal:** any other string is used directly.

## 2. How parameters are resolved

For each discovered model id, parameters come from the following sources, in
increasing priority:

1. **Built-in catalog** — a built-in model with a matching id.
2. **Generated cache** (`auto-models.cache.json`) — parameters saved from a
   previous refresh.
3. **models.dev catalog** — fetched online when no built-in or cached entry
   exists, or on a forced refresh.
4. **User overrides** (`auto-models.json`).
5. **Project overrides** (`.pi/auto-models.json`, trusted projects only).

When no source provides parameters, defaults are used:

```jsonc
{
  "reasoning": false,
  "input": ["text"],
  "contextWindow": 128000,
  "maxTokens": 16384,
  "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
}
```

For custom providers, matching a model against Pi's official catalogs is the
fallback when the proxy itself does not provide parameter metadata. A vendor
prefix in the model id wins first; for an unqualified id with multiple
official matches, the deterministic order is
`openai-codex > openai > anthropic > google > deepseek > other provider ids`.
Unknown models continue to use the defaults above.

## 3. User overrides (`auto-models.json`)

Place overrides in `~/.pi/agent/auto-models.json`. Overrides are keyed by
`providerId/modelId`. Two shapes are accepted and may be mixed:

```jsonc
// Flat keys
{
  "my-proxy/gpt-4o": { "contextWindow": 128000 }
}
```

```jsonc
// Nested providers
{
  "my-proxy": {
    "gpt-4o": { "contextWindow": 128000 }
  }
}
```

Model ids containing slashes (e.g. `vendor/bar`) are supported in both shapes;
in the nested form they simply appear as a nested key.

Duplicate definitions for the same model in one file are rejected.

## 4. Project overrides (`.pi/auto-models.json`)

A trusted project may commit `.pi/auto-models.json` using the same schema as
`auto-models.json`. Project overrides are applied after user overrides and win
over them. They are **only loaded when the project is trusted**; otherwise the
file is ignored.

## 5. Override fields

Every override is an object whose keys may be any of the following. Unknown
fields are rejected.

| Field | Type | Description |
|-------|------|-------------|
| `source` | string | Explicit models.dev source id (see [Explicit source mapping](#explicit-source-mapping)). |
| `name` | string | Human-readable display name. |
| `reasoning` | boolean | Whether the model supports extended thinking. |
| `thinkingLevelMap` | object | Maps pi thinking levels to provider values (see below). |
| `input` | array | Input modalities: `"text"` and/or `"image"`. |
| `contextWindow` | number | Context window size in tokens (positive). |
| `maxTokens` | number | Maximum output tokens (positive). |
| `cost` | object | Per-million-token rates and optional tiers (see below). |
| `samplingParams` | object | Free-form object merged verbatim into request bodies. |
| `headers` | object | Extra request headers (string values). |
| `compat` | object | API compatibility flags (see below). |

### `thinkingLevelMap`

Keys are pi thinking levels: `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`. Values are tristate:

| Value | Meaning |
|-------|---------|
| string | Level is supported and this value is sent to the provider. |
| `null` | Level is unsupported and hidden. |
| omitted | Default mapping applies. |

```jsonc
{
  "my-proxy/deepseek-v4-pro": {
    "reasoning": true,
    "thinkingLevelMap": {
      "minimal": null,
      "low": null,
      "medium": null,
      "high": "high",
      "max": "max"
    }
  }
}
```

### `cost`

Rates are per million tokens. Tiers provide alternate complete rate sets when
total input usage exceeds `inputTokensAbove`; the highest matching threshold
wins.

```jsonc
{
  "my-proxy/model": {
    "cost": {
      "input": 5,
      "output": 30,
      "cacheRead": 0.5,
      "cacheWrite": 6.25,
      "tiers": [
        {
          "inputTokensAbove": 272000,
          "input": 10,
          "output": 45,
          "cacheRead": 1,
          "cacheWrite": 12.5
        }
      ]
    }
  }
}
```

Each tier requires `input`, `output`, `cacheRead`, `cacheWrite`, and
`inputTokensAbove`.

### `compat`

Compatibility flags for the selected API. Valid fields:

| Field | Description |
|-------|-------------|
| `supportsStore` | Provider supports the `store` field. |
| `supportsDeveloperRole` | Use the `developer` role instead of `system`. |
| `supportsReasoningEffort` | Provider supports `reasoning_effort`. |
| `supportsUsageInStreaming` | Supports `stream_options: { include_usage: true }`. |
| `maxTokensField` | `"max_completion_tokens"` or `"max_tokens"`. |
| `requiresToolResultName` | Include `name` on tool result messages. |
| `requiresAssistantAfterToolResult` | Insert an assistant message after tool results. |
| `requiresThinkingAsText` | Convert thinking blocks to plain text. |
| `requiresReasoningContentOnAssistantMessages` | Include empty `reasoning_content` on replayed assistant messages. |
| `thinkingFormat` | Thinking parameter scheme (`openrouter`, `deepseek`, `together`, `qwen`, `chat-template`, `qwen-chat-template`, …). |
| `chatTemplateKwargs` | `chat_template_kwargs` values for `thinkingFormat: "chat-template"`. |
| `chatTemplateArgs` | `chat_template_args` values for `thinkingFormat: "baseten"`. |
| `cacheControlFormat` | Anthropic-style `cache_control` markers (currently `"anthropic"`). |
| `openRouterRouting` | OpenRouter provider routing preferences (object, sent as-is). |
| `vercelGatewayRouting` | Vercel AI Gateway routing config (object). |
| `supportsOpenAIGrammarTools` | Whether grammar-constrained tools are emitted. |
| `supportsStrictMode` | Whether strict JSON-schema function tools are accepted. |
| `sendSessionAffinityHeaders` | Send session-affinity headers when caching is enabled. |
| `deferredToolsMode` | Provider-specific deferred tool serialization (currently `"kimi"`). |
| `sessionAffinityFormat` | Session-affinity header format (`openai`, `openai-nosession`, `openrouter`). |
| `supportsLongCacheRetention` | Provider accepts long cache retention. |
| `supportsToolSearch` | Provider supports tool search. |
| `supportsEagerToolInputStreaming` | Accepts per-tool `eager_input_streaming` (Anthropic). |
| `supportsCacheControlOnTools` | Accepts `cache_control` markers on tool definitions (Anthropic). |
| `supportsTemperature` | Provider supports the temperature parameter. |
| `forceAdaptiveThinking` | Send adaptive thinking payloads (Anthropic). |
| `allowEmptySignature` | Replay empty thinking signatures as `signature: ""` (Anthropic). |
| `supportsStrictTools` | Accepts strict JSON-schema tool definitions (Anthropic). |
| `supportsToolReferences` | Provider supports tool references. |

Provider-level `compat` (in `models.json`) is merged under model-level
`compat`, so a model can override individual flags.

## 6. Explicit source mapping

Discovered model ids are matched against the models.dev catalog automatically.
When the match is ambiguous or wrong, pin the exact models.dev source with the
`source` field:

```jsonc
{
  "my-proxy/alias-name": {
    "source": "openai/gpt-4o"
  }
}
```

`source` is the full models.dev id (`provider/modelId`). The model's parameters
are then taken from that catalog entry. If the catalog cannot be reached, the
best previously known parameters are kept and the unresolved source is reported
in the refresh summary.

## 7. Refreshing models

- **Startup:** on `session_start` the extension performs an offline refresh,
  restoring models from `models-store.json` without network access.
- **Online refresh:** run `/refresh-models` to query each provider's
  `/v1/models` endpoint, refresh the models.dev catalog when needed, persist
  discovered parameters to `auto-models.cache.json`, and publish the model list
  to Pi.

A forced online refresh (`/refresh-models`) always re-fetches the models.dev
catalog.

## 8. Generated cache

The extension maintains `~/.pi/agent/auto-models.cache.json` automatically. It
stores per-model parameter enrichments keyed by `providerId/modelId` and is
written atomically. Treat it as generated output — put your changes in
`auto-models.json` or `.pi/auto-models.json` instead.
