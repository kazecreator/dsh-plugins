# @kazecreator/dsh-usage

显示 DeepSeek API 余额，并统计当前 DSH 实例产生的本地 token 用量。用量来自 DSH 的 `assistant/message` 事件，成本按插件内的 DeepSeek 价格表估算；余额使用 DSH credentials 中的 `DEEPSEEK_API_KEY` 请求公开的 `/user/balance` 接口。

插件不读取浏览器登录态、不打开 `platform.deepseek.com`，也不需要 DeepSeek 平台 `userToken`。注意：本地统计只覆盖当前 DSH 实例记录到的 DeepSeek 请求，不包含其他客户端或其他 API key 产生的账单。

```sh
dsh plugin --profile web add @kazecreator/dsh-usage
```

使用 [`example.cordis.patch.yml`](./example.cordis.patch.yml) 并重启。功能默认关闭，可在用量面板中开启；运行时状态保存在 `$DSH_HOME/storages/dsh-usage/`。

配置：

```yaml
- insert:
    - id: dsh-usage
      name: '@kazecreator/dsh-usage'
      config:
        usageEnabled: false
        balanceRefreshMs: 60000
        providerId: deepseek-official
```

`providerId` 用于限定统计范围，默认只统计 `deepseek-official`。统计数据保存在 `storages/dsh-usage/usage/YYYY-MM-DD.json`，价格表可通过同目录的 `pricing.json` 覆盖。
