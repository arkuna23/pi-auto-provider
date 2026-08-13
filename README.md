# pi-auto-provider

Pi extension that discovers models from custom OpenAI-compatible providers whose
`models.json` entry omits the `models` property. It keeps Pi's provider settings
intact and stores parameter enrichment in `auto-models.cache.json`.

Install the package as a Pi extension, then use `/refresh-models` to perform an
online refresh. User overrides live in `auto-models.json`; trusted project
overrides live in `.pi/auto-models.json`.

An automatic provider is a custom entry in `models.json` with no `models` key:

```jsonc
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

The extension never writes `models.json`; discovered catalogs are persisted in
Pi's `models-store.json`, while parameter enrichment is kept in the generated
`auto-models.cache.json` file.

See [CONFIG.md](./CONFIG.md) for detailed configuration.
