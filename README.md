# Permsift

**用真实任务，收紧沙箱权限。**

Test tasks. Trim permissions.

Permsift 是一个面向项目任务的沙箱权限调试器。你提供可工作的初始策略和测试、构建等任务，它在干净副本中反复执行，尝试缩小读写权限，用任务断言和边界探针判断是否接受修改，并保留每一步的证据。

当前为 **v0.3，macOS 本地 CLI**。使用 Anthropic Sandbox Runtime 0.0.77 执行隔离。默认自动缩小目录写权限；声明 initial_read_grants 后，还能将项目读取范围缩到目录或具体文件。读写组合会一起复验。系统运行时、缓存和临时目录读取仍固定开放，网络保持关闭；结果限定于本次环境和测试集合，不代表全局最小权限。

## 快速开始

要求：macOS、Node.js 22 或更新版本、npm，以及系统自带的 `/usr/bin/sandbox-exec`。已在 macOS 15.8、Apple Silicon、Node.js 24.21.0 上实测。其他系统版本需先通过 doctor；Linux 和 Windows 上拒绝执行沙箱任务。

在项目目录中执行：

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js doctor
npm run demo
```

demo 不需要网络或额外下载依赖。它包含一个计算订单金额的小项目，执行实际单元测试及构建后的 smoke test。

典型结果：

```text
VERIFIED · ... executions
  test write: @workspace/reports
  build write: @workspace/dist
```

初始策略允许写整个工作区和缓存。工具将测试写入范围缩到 `reports/`，构建缩到 `dist/`，撤销不需要的缓存写权限；再尝试删除产物目录写权限时，任务失败，恢复后重新通过。基线和最终策略各独立重复三次。自动发现后还会使用统一的目录准备状态重新确认基线，因此运行次数随候选变化。

完整报告位于命令输出的 `.permsift/<experiment-id>/` 目录。每次默认使用新目录，不覆盖历史证据。

## CLI

```sh
# 检查本机真实沙箱能力，使用内置假数据和本地测试端点
node dist/cli.js doctor

# 验证初始策略
node dist/cli.js run \
  --config examples/demo/permsift.yaml \
  --limits examples/limits.json

# 自动收紧；指定目录必须尚不存在
node dist/cli.js tighten \
  --config examples/demo/permsift.yaml \
  --limits examples/limits.json \
  --output .permsift/my-experiment

# 重新验证导出的策略；project 路径由导出文件记录
node dist/cli.js run \
  --config .permsift/my-experiment/recommended.yaml \
  --limits examples/limits.json
```

也可以在构建后运行 `npm link`，使用 `permsift doctor` 等命令。项目尚未发布到 npm；package.json 的 private 标志用于避免意外发布。

`--json` 将完整报告输出到 stdout，进度仍输出到 stderr。`--keep-workspaces` 保留临时工作区，方便排查；默认清理工作区并保留报告、日志和差异。

| 退出码 | 含义 |
| --- | --- |
| 0 | 当前策略完成验证；仍需看 search_complete 判断搜索是否结束 |
| 1 | 基线任务或边界断言失败 |
| 2 | 配置错误、环境异常、超时或最终验证未完成 |
| 130 | 用户中断，已尽可能保存不完整报告 |

## 用于自己的项目

1. 在实验之外准备依赖，确认项目的测试、构建能离线运行。
2. 编写场景文件，指定命令、初始写目录以及产物断言。需要读取收缩时再声明 initial_read_grants；默认自动生成候选，可补充手工规则。
3. 在可信位置准备 limits 文件，明确批准读写授权范围和实验预算。开启读取收缩须声明 allowed_read_roots；CLI 不自动加载项目提供的最高权限。
4. 先执行 run。基线全部通过后，再执行 tighten。
5. 审阅报告和推荐策略，再用于自己的运行流程。

例子见 [场景配置](examples/demo/permsift.yaml) 和 [演示 limits](examples/limits.json)。这些 limits 适用于已审核的演示项目，真实项目需要你先审查。

**所有文件断言都描述本轮新产生的输出。** 执行前会从工作区副本删除这些输出，避免旧产物导致假通过。不要把源文件或不可替代的输入写成输出断言。原项目不受这些删除操作影响。

路径只接受 `@workspace`、`@cache`、`@tmp` 三类别名及其子路径。第一版不接受任意原始后端配置、宿主验证脚本、联网规则或自定义环境变量。

## 交付内容

- `doctor`、`run`、`tighten` 三个命令。
- 按任务独立的读写权限搜索、失败回退与恢复复测；读权限变化后重新搜索写权限。
- 自动候选及来源记录，工作区、缓存和临时目录变化，统一准备后的基线复测。
- 干净输入快照、独立缓存、输出刷新及进程组清理。
- 读取、写入、报告保护及 TCP 连接探针，配套宿主侧对照检查。
- 文件内容、JSON 值、结构化测试结果和 JUnit XML 断言。
- JSON/Markdown 报告、生效后端配置、有限日志和文件变化证据。
- 失败解释：规则变化、拒绝操作与路径、失败断言、错误摘要及恢复结果。
- 单元测试、真实 macOS 沙箱集成测试、CI 配置和可重复演示。

## 读取收缩与第三方项目

```sh
# 无额外依赖的读写收缩演示
npm run demo:read

# 下载固定提交的 clsx 并准备锁定依赖；仅准备阶段联网
npm run third-party:prepare
# 原始构建、五种产物的行为断言、权限搜索及导出规则重放
npm run third-party:verify
```

读取演示会保留构建脚本、package.json、源码文件和需要加载的 dist 目录，撤销测试脚本和配置文件等读取授权。项目内假敏感文件在初始宽规则下可读，收缩后按实际授权检查是否拒绝；它们没有被额外加入 denyRead。

旧配置继续保留整个工作区可读。initial_read_grants: [] 表示不授予任何项目文件内容读取，仍保留 cwd 目录访问和固定基础读取。写权限不隐含读取，任务若加载构建产物，也需要该产物的读取授权。详见 [读取规则说明](docs/read-permissions.md) 和 [第三方 clsx 验证](docs/third-party-clsx.md)。

## 三个代表项目

```sh
# 实验之外联网安装锁定依赖，禁用生命周期脚本
npm run examples:prepare
# 在真实沙箱中离线搜索，生成各项目报告与 summary.json
npm run examples:verify
```

这三个项目均未填写 narrower_candidates：Node 原生测试生成 JUnit 报告；esbuild 打包 TypeScript 并执行构建产物；TypeScript 增量编译产生缓存，使用并删除临时文件，再验证产物。详见 [代表项目说明](docs/representative-projects.md)。它们是随仓库提供的可运行项目，生态工具实际参与执行；第三方大型生产项目仍需另行验证。

失败后先阅读 report.md 的 **Failure explanations**，再按链接检查完整证据。拒绝日志可能缺失；报告区分“捕获到权限拒绝”和“已证明失败原因”。

## 验证代码

```sh
npm test
npm run test:integration
npm run check
```

单元测试检查配置、路径、快照、断言、搜索、进程管理和探针对照。集成测试在真实 macOS 沙箱中验证权限收紧、必要权限撤销、导出配置重放、旧产物、越界访问、超时和中断；其他系统上明确跳过集成测试，不用 mock 替代隔离验证。

## 文档

- [配置参考](docs/configuration.md)：全部字段、成功断言与 limits。
- [架构与搜索流程](docs/architecture.md)：模块、候选修改、结果状态和证据。
- [安全边界](docs/security.md)：固定权限、支持的工作负载和已知限制。
- [开发与测试](docs/development.md)：修改代码、测试分层和 CI。
- [实测记录](docs/validation.md)：本机实际运行结果与验收映射。
- [后续路线](docs/roadmap.md)：MVP 之后的验证方向。

源码以 [MIT License](LICENSE) 发布。底层 Sandbox Runtime 的许可证见其独立包；本项目通过 npm 依赖引用它。
