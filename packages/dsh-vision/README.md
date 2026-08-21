# @kazecreator/dsh-vision

Vision bridge for text-only DSH models. When enabled, image attachments are described by a configured OpenAI-compatible VLM and the main model receives text instead. The settings section includes provider/model discovery and endpoint configuration.

```sh
dsh plugin --profile web add @kazecreator/dsh-vision
```

Use [`example.cordis.patch.yml`](./example.cordis.patch.yml) and restart. Configure `visionBaseUrl`, `visionModel`, and `visionApiKeyEnv`; the feature is opt-in with `visionEnabled: false`.
