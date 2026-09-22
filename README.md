# pi-auto-provider

Pi extension that discovers models from custom OpenAI-compatible providers configured in
`auto-provider.json` and keeps a static catalog in Pi's `models.json`.

## Configuration

Configure providers in the standalone Pi agent file (`~/.pi/agent/auto-provider.json`, or
the directory selected by `PI_CODING_AGENT_DIR`):

```jsonc
{
  "providers": {
    "my-proxy": {
        "baseUrl": "http://127.0.0.1:8080",
        "api": "openai-completions",
        "apiKey": "$MY_PROXY_KEY",
        "authHeader": true,
        "headers": {
          "X-Tenant": "$MY_TENANT"
        },
        "compat": {
          "supportsStore": false
        },
        "name": "My proxy"
    }
  }
}
```

`auto-provider.json` is the only automatic-provider configuration source.

`apiKey` and header values use Pi's normal configuration-value forms:

- `$ENV_VAR` or `${ENV_VAR}` for environment values
- `!command` for a command whose stdout supplies the value
- `$$` and `$!` for literal dollar and exclamation characters
- any other string as a literal

The extension does not print configured credential values. Generated **model** entries omit
credentials; the provider entry copies configured `apiKey`, `authHeader`, `headers`, and `name`
references so Pi can load the same catalog without this extension (for example subagents that
start with `--no-extensions`).

## Refresh and restore

Run `/refresh-models` to query each configured provider's `/v1/models` endpoint and
enrich the returned ids with model metadata. A successful refresh replaces that
provider's `models` array in `models.json` and writes the same provider registration Pi needs
without this extension: `api`, `baseUrl`, configured `apiKey` / `authHeader` / `headers` /
`name` / `compat`. Model entries contain only non-default metadata such as names, capabilities,
limits, costs, and necessary compatibility data. Default values are omitted and restored when
the catalog is loaded.
Stale models are removed from that provider's array. Other providers and unrelated
provider fields are preserved.

The update uses structured JSONC edits, a file lock, and atomic replacement. A read,
parse, validation, lock, or write failure leaves the previous `models.json` intact
and is reported as a refresh error.

Pi's `models-store.json` remains a separate Pi-owned runtime cache. The extension
continues publishing refreshed models there for normal session-start offline
restoration; it does not replace or delete that file.

## Breaking change

Automatic-provider configuration in `models.json` is no longer consumed and is not
migrated. Recreate every automatic provider in `auto-provider.json`.

The obsolete plugin-owned files are removed on startup/refresh when present:

- `~/.pi/agent/auto-models.cache.json`
- `~/.pi/agent/auto-models.json`
- project `.pi/auto-models.json`

The extension never removes Pi's `models.json` or `models-store.json`. Standalone-file
connection, authentication, headers, compatibility, and naming values are the
runtime authority when stale provider fields remain physically in `models.json`.

See [CONFIG.md](./CONFIG.md) for the full contract.
