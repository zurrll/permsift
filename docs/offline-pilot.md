# v0.12 使用检验与接入成本

本轮先用当前报告回答具体问题，再补缺口。下面是开发者自己的工程试用，不能当作外部用户采用数据，也没有人工阅读分钟数。

## 先用已有报告找卡点

问题一：glob-parent 在 fast-glob 编译和测试任务中分别留下了什么记录？

v0.9 真实报告按 compile / compile-test 分段，每任务安装 507 个包实例，模块记录分别涉及 1 / 97 个包。glob-parent 在 compile 中没有模块记录，在 compile-test 中有一个模块文件。两段都未开启编译或打包来源，因此不能回答它是否进入编译器或产物。原 Markdown 约 1500 行，必须分开定位两段；单任务的来源表已经存在，重新包装一遍不是新增解释能力。

问题二：glob-parent 升级后，打包记录发生了什么变化？

v0.11 已经保存两个完整报告：5.1.2 → 6.0.2，JS 贡献 934 → 1560 字节，整体 JS 与 map 大小变化，工具加载集合没有改变；三个 API smoke 通过。现有比较段已经能解释它，缺的是 CLI 不能直接拿两份旧报告比较。此打包任务采用额外 CommonJS 转换和最小依赖，不是上游原构建。

据此把功能限制为 compare 和按完整名称的跨任务 inspect。来源事实、引用链及比较算法已存在，没有新增采集器或重跑任务来获得相同记录。

## 离线工程验收

仓库 [examples/reports](../examples/reports/README.md) 保存上述报告的字段投影，保留原采集条件和来源说明。`npm run offline:verify` 调用公开 CLI，检查两个问题、同报告比较及输入摘要未变；PATH 中没有外部工具，项目任务执行数 **0**、安装数 **0**。

首轮证据 `.permsift/offline-usage-20QS3U/summary.json`：五条命令的单次墙钟时间约 61–79 ms，包含 Node 启动。后续排版和边界修正后重新回放，最终证据见 validation.md。数值只是本机样本，不是普遍性能保证，更不等于节省了多少人工时间。

## 新项目：保留 glob-parent 的上游测试

为补接入成本证据，又选择 [glob-parent 6.0.2 固定提交](https://github.com/gulpjs/glob-parent/tree/26ce5ecec10c687cffb9891c108fb2d2800b9140)。源码、测试和 package.json 与该提交完全一致，git diff HEAD 为空。上游 test 脚本是 nyc / Mocha，pretest 执行 lint。

配置两个独立任务：

- upstream-tests：保留 `npm test`，仅追加 `-- --reporter xunit --reporter-options output=test.xunit`，使用既有 JUnit 断言读回新报告。报告中 20 项测试全部通过，配置明确列出 16 个预期名称；另 4 个带单引号的双引号名称未进入简易名称提取列表，因此不声称配置逐名约束了全部 20 项。保留这一验收边界，没有额外重跑来刷新统计。
- api：配置一条 Node 命令检查 glob 的父路径和普通文件父路径，写 api.json 供断言检查。这是新增的两项 API smoke，不冒充上游测试。

仅在锁文件中将 Mocha 从 7.1.2 更新为 7.2.0，仍满足原 devDependencies 范围；其余锁定安装实例版本不变。前后 config、limits、环境和采集器摘要相同，仅项目输入摘要变化。没有打开编译/打包来源，也没有权限搜索。

| 事项 | 实际代价 |
| --- | --- |
| 修改上游源码、测试、package.json | 0 行 |
| 新增构建或测试包装脚本 | 0 个 |
| 追加测试诊断选项 | reporter / reporter-options 两项 |
| 新配置 | 82 行 YAML（含两任务、安装/权限、排除项及预期测试名称） |
| 独立可信 limits | 17 行 JSON |
| 锁文件准备 | 上游没有锁；仅生成 registry 锁元数据，未在宿主安装依赖或运行生命周期脚本 |
| 观察执行 | 前后各两个任务，共 4 次，4 次沙箱冷安装 |
| 之后的 compare / inspect | 不安装、不执行项目任务 |

82 / 17 行不是不可减少的最低配置量。任务写授权使用显式工作区范围，安装写授权独立；这里验证观察接入，没有测试或声称这些授权已最小化。生成锁时曾调整 npm 参数，因为 --no-save 没有产生所需锁；没有把过程描述成无摩擦接入，也没有估算人工配置时间。

结果：每任务 435 个安装实例，测试模块记录涉及 268 个包，API 模块记录涉及 2 个包。Mocha 在测试任务记录 51 个模块文件；API 没有其模块记录。离线比较把 Mocha 版本变化列在 upstream-tests，api 的模块包增减和版本变化均为空。视图没有将这种分布自动转为“仅工具包”或撤权建议。

| 阶段 | 完整观察流程 | 上游测试 task | API task | 两任务安装分项合计 |
| --- | --- | --- | --- | --- |
| 升级前 | 137.70 s | 2.54 s | 0.16 s | 124.61 s |
| 升级后 | 77.56 s | 2.46 s | 0.18 s | 64.55 s |

两轮都是空缓存冷安装，注册表/网络耗时不同，不能从前后流程差异推导升级或采集提速。代价主要仍在生成观察记录的安装阶段；保存后的再次查询和比较没有该成本。

实际证据位于 `.permsift/native-pilot-Io8TQF/summary.json`、`observe-v6.yaml`、`limits.json`、`v6-before/`、`v6-after/`、`comparison/` 和 `mocha.md`。原项目路径只用于这次受控 checkout；这些 ignored 工件没有进入 Git。完整配置、两份固定锁文件和执行证据在该目录保留。

```sh
node dist/cli.js compare .permsift/native-pilot-Io8TQF/v6-before/usage.json .permsift/native-pilot-Io8TQF/v6-after/usage.json
node dist/cli.js inspect .permsift/native-pilot-Io8TQF/v6-after/usage.json --package mocha
```

新 checkout 可采用相同上游提交，生成 npm registry lock，配置上面的任务与断言，再将自己的两份 usage.json 交给离线命令；重新解析依赖可能改变传递版本，不能冒充这次固定锁结果。无需完整复制此实验才能使用 compare / inspect。

## 同时记录的接入失败

最初选择 [glob-parent 5.1.2 固定提交](https://github.com/gulpjs/glob-parent/tree/eb2c439de448c779b450472e591a2bc9e37e9668)，沿用原 azure-pipelines 测试脚本。它使用 nyc 13，锁文件中 bundledDependencies 的子条目没有独立 registry URL / integrity。当前安装器逐条要求这些信息，在执行前拒绝，任务执行数为 0；报告状态 incomplete / not_run，没有假报成功。

记录 `.permsift/native-pilot-Io8TQF/before/report.json` 和 `unsupported-v5.lock.json`。本轮没有放宽安装器或替换测试工具来伪造低成本接入；换用新版上游后才完成上面的试用。内嵌依赖及生命周期脚本等安装限制仍影响采用，需要独立设计，不能因为离线功能方便就忽略。

2026-10-03 第五轮后的接入修复解决了上述内嵌归属障碍。原失败记录继续保留；旧版上游和冻结锁现在可在新目录完成原 azure-pipelines 任务。首次新代码执行暴露 nyc 的临时目录写需求，最终示例明确声明 limits 内的 `@tmp`；原源码、测试和 package.json 不变，16 项测试通过。生命周期脚本仍禁用。新记录见 [安装验证](validation.md)，用法见 [内嵌依赖](bundled-dependencies.md)。

## 本轮可以确认的收益

确认了“多个长任务段落中的同名实例可以集中查看”和“两份已有记录无需再次运行任务即可比较”，并让观察条件和来源缺口随结果保留。新项目在不改上游代码的条件下能观察原测试任务，仍需锁、配置和诊断选项。

尚未确认外部用户使用率、节省的人工分钟或观察对权限搜索的节省。下一步先让使用者提出自己的变化问题，依据实际卡点决定扩展；不因新增命令继续增加数据来源或更细的权限候选。
