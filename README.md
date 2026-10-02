# Permsift

**用真实任务，收紧沙箱权限。**

Test tasks. Trim permissions.

Permsift 是一个面向项目任务的沙箱权限调试器。你提供可工作的初始策略和安装、测试、构建等任务，它在干净副本中反复执行，尝试缩小文件和安装网络权限，用任务断言和边界探针判断是否接受修改，并保留每一步的证据。

当前为 **v0.12，本地 CLI（任务执行限 macOS）**。使用 Anthropic Sandbox Runtime 0.0.77 执行隔离。支持目录写权限、可选的项目文件读取收缩，以及 npm 安装阶段的精确域名撤销。安装后断网测试和构建，冷缓存与固定暖缓存分别验证。显式分阶段配置可分别收缩安装写权限和任务读写，任务候选复用本次实验内的安装快照，最终仍重新安装完整验收。工作区优先使用写时复制，保持各轮文件独立。改代码、锁文件或依赖后，可用 check 验证旧规则并尝试受限补充。系统运行时、缓存和临时目录读取仍固定开放；结果限定于本次环境和测试集合，不代表全局最小权限。

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

## 读取已有报告，不再运行项目

```sh
# 比较两份已经保存的 usage.json
node dist/cli.js compare before/usage.json after/usage.json
# 把一个包在所有任务中的记录放到一起
node dist/cli.js inspect usage.json --package glob-parent
# 仓库自带真实记录投影；无需准备或安装示例项目
node dist/cli.js inspect examples/reports/fast-glob-tasks.json --package glob-parent
npm run offline:verify
```

compare / inspect 不需要 config、limits、原项目或沙箱，默认输出 Markdown，--json 输出结构化结果。compare 可用 --output NEW_DIRECTORY 保存 comparison.json/md；它与 observe --baseline 共用比较逻辑。各任务、安装实例和来源健康度分别展示，明确区分未采集、不完整、没有记录和贡献 0 字节。差异不是自动回归判定；离线分析不能替代执行验证。用法和退出码见 [离线分析](docs/offline-usage.md)，接入与收益检验见 [使用记录](docs/offline-pilot.md)。

## 依赖使用观察

`observe` 每个任务运行一次，记录已安装的 npm 包、Node 模块加载与本次解析来源；可比较改动前后的新增加载和版本变化。v0.10 可为直接运行项目内 tsc 的任务开启编译输入观察，解释声明文件等为何进入同一次编译，并单独比较输入包、文件和原因变化。v0.11 可读回同一次任务新生成的 esbuild metafile，解释输入、全部报告输出、每个包的字节贡献、引入链及外部引用，并比较前后变化。不启动权限搜索。

```sh
node dist/cli.js observe --config examples/projects/bundle-kit/observe.yaml --limits examples/limits.json
# 用上一次 usage.json 对比当前观察
node dist/cli.js observe --config examples/projects/bundle-kit/observe.yaml --limits examples/limits.json --baseline .permsift/PREVIOUS/usage.json
```

示例需先 `npm run examples:prepare`。报告位于 usage.md / usage.json，任务断言和真实边界证据仍在 report.md。模块观察需要 Node 22.15+ 或 23.5+；类型、任意资源读取和原生工具内部不由模块钩子覆盖。**没有模块加载记录，不表示依赖无用或可以删除。** 编译输入和打包记录是另两种证据，各列不能相加成“实际用了几个包”，也不能据此认定某包仅是工具或可以撤权。详见 [依赖使用报告](docs/dependency-usage.md)、[TypeScript 编译输入](docs/typescript-inputs.md)、[esbuild 产物依赖](docs/bundle-inputs.md) 和 [收益取舍](docs/value-and-scope.md)。

```sh
# 准备固定上游源码；安装发生在 observe 的沙箱内
npm run medium:prepare
node dist/cli.js observe --config examples/third-party/fast-glob/observe.yaml --limits examples/third-party/fast-glob/limits.json
```

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

# 改代码或准备好更新后的依赖后，验证旧规则
node dist/cli.js check \
  --config examples/demo/permsift.yaml \
  --baseline .permsift/my-experiment/report.json \
  --limits examples/limits.json
```

也可以在构建后运行 `npm link`，使用 `permsift doctor` 等命令。项目尚未发布到 npm；package.json 的 private 标志用于避免意外发布。

`--json` 将完整报告输出到 stdout，进度仍输出到 stderr。`--keep-workspaces` 保留临时工作区，方便排查；默认清理工作区并保留报告、日志和差异。

| 退出码 | 含义 |
| --- | --- |
| 0 | 当前策略完成验证；check 表示兼容，tighten 仍需看 search_complete；observe 表示任务通过且范围内记录已读回 |
| 1 | 基线任务或边界断言失败，或 check 发现需要审阅的回归 |
| 2 | 配置错误、环境异常、超时、验证未完成、check 无法判断或 observe 记录不完整 |
| 130 | 用户中断，已尽可能保存不完整报告 |

## 用于自己的项目

1. 明确测试、构建任务及成功条件。已准备依赖的项目离线运行；安装场景提供受支持的锁文件、缓存条件与域名上限。
2. 编写场景文件，指定命令、初始写目录以及产物断言。需要读取收缩时再声明 initial_read_grants；默认自动生成候选，可补充手工规则。
3. 在可信位置准备 limits 文件，明确批准读写授权范围和实验预算。开启读取收缩须声明 allowed_read_roots；CLI 不自动加载项目提供的最高权限。
4. 先执行 run。基线全部通过后，再执行 tighten。
5. 审阅报告和推荐策略，再用于自己的运行流程。

例子见 [场景配置](examples/demo/permsift.yaml) 和 [演示 limits](examples/limits.json)。这些 limits 适用于已审核的演示项目，真实项目需要你先审查。

**所有文件断言都描述本轮新产生的输出。** 执行前会从工作区副本删除这些输出，避免旧产物导致假通过。不要把源文件或不可替代的输入写成输出断言。原项目不受这些删除操作影响。

路径只接受 `@workspace`、`@cache`、`@tmp` 三类别名及其子路径。当前支持受限的安装域名列表，不接受任意原始后端配置、宿主验证脚本或自定义环境变量。

## 交付内容

- `doctor`、`run`、`tighten`、`check`、`observe` 五个命令。
- 规则回归检查：冻结当前输入、验证旧规则、宽规则对照和经过复验的补充建议。
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

## 沙箱内安装依赖

```sh
# 真实 npm ci、域名收缩、断网测试/构建、冷暖缓存和导出重放
npm run install:verify

# 只运行冷缓存的收缩任务
node dist/cli.js tighten \
  --config examples/install/permsift.yaml \
  --limits examples/install/limits.json
```

例子固定 clsx 2.1.1。安装阶段运行 npm ci --ignore-scripts，尝试撤销 example.org 和 registry.npmjs.org；冷缓存保留实际需要的下载域名。已有缓存从明确的固定种子独立克隆，npm --offline 安装，得到的无网络规则只适用于该缓存条件。随后执行 4 项依赖行为检查并生成构建产物，任务命令始终断网。

首版支持 npm、v2/v3 锁文件和注册表 tarball；旧安装配置保留完整工作区读取；分阶段配置支持任务读取收缩。暂不支持私有凭据、项目 .npmrc、Git/file 依赖、npm workspaces 或依赖生命周期脚本。详见 [安装与网络权限](docs/dependency-install.md)。

## 分阶段安装与任务权限

```sh
npm run stages:verify
```

在 install 内声明 initial_write_grants 后，该字段用于安装，顶层 initial_write_grants / initial_read_grants 用于安装后的任务。任务获得独立规则，能够撤销不需要的依赖写权限和包读取；确需依赖内缓存时可保留小目录。安装规则固定后的任务候选从验证过的安装状态克隆，减少重复 npm ci；最终重复验证和 run/check 仍从原始输入重新安装。

导出一份包含两段规则的配置，报告区分实际安装次数与快照复用次数。旧 v0.5 安装配置保留共用写规则行为。见 [分阶段说明](docs/staged-permissions.md) 与 [示例](examples/staged-install/permsift.yaml)。

## 中等规模项目与耗时统计

```sh
# 下载固定提交并放入锁文件、任务脚本，不在宿主安装依赖
npm run medium:prepare
# 沙箱内冷安装验证、固定暖缓存搜索、导出重放
npm run medium:verify
```

这个例子使用 fast-glob 3.3.3，锁定 507 个依赖项，编译上游 TypeScript、运行全部 246 项单元测试，并验证构建 API。适配脚本明确跳过依赖声明文件的兼容检查，仍检查项目源码；上游 .npmrc 被排除，使用随例子提交的锁文件。

report.md 新增耗时表，report.json 与每轮证据记录复制、完整性哈希、变化清单、安装、任务、边界探针等分项。复用安装状态的任务保留完整性核对和任务前后清单，省去不存在的安装阶段清单；默认逐轮清理副本，最终仍重新安装。见 [实测方法与配置成本](docs/performance.md)。

## 验证代码

改代码或改依赖后的检查详见 [回归检查](docs/regression-checks.md)。旧规则通过时只做配置要求的重复验证；权限变化、普通任务失败和未知结果分别记录。经过复验的补充建议保存为 suggested.yaml，便于审阅和重放。

```sh
# 安装演示的固定依赖，再验证代码、真实依赖和普通错误的变化
npm run regression:prepare
npm run regression:verify
```

```sh
npm test
npm run test:integration
npm run check
```

单元测试检查配置、路径、快照、断言、搜索、进程管理和探针对照。集成测试在真实 macOS 沙箱中验证权限收紧、必要权限撤销、导出配置重放、旧产物、越界访问、超时和中断；其他系统上明确跳过集成测试，不用 mock 替代隔离验证。

## 文档

- [整体重构计划](docs/refactoring-plan.md)：共同实验底座、两条独立使用路径、多轮交付与迁移验收。
- [第一轮内部模型](docs/model.md)：五对象、身份与缺失含义、旧数据适配及结论判断表。
- [共同执行底座](docs/execution-foundation.md)：第二轮接口、流程与报告分工、原生执行事实、保存和安装复用时序。
- [两条模型使用案例](docs/model-cases.md)：真实权限回归与依赖观察记录的离线回放。
- [早期环境检验](docs/environment-validation.md)：本机结果、换环境复现步骤及未验证范围。
- [耗时与中等规模实测](docs/performance.md)：计时口径、可复现对比与配置限制。
- [完整校验与一致性](docs/hash-validation.md)：有界扫描、历史摘要兼容、暖安装观察及同预算对照。
- [配置参考](docs/configuration.md)：全部字段、成功断言与 limits。
- [架构与搜索流程](docs/architecture.md)：模块、候选修改、结果状态和证据。
- [搜索效率](docs/search-efficiency.md)：成组撤销、延后复查和同项目次数对比。
- [快照工作区](docs/snapshot-workspaces.md)：写时复制、跨轮隔离、回退与本机对照。
- [分阶段权限](docs/staged-permissions.md)：独立安装写规则、安装快照复用、任务读取与完整重放。
- [安装与网络权限](docs/dependency-install.md)：安装阶段、冷暖缓存、域名上限和断网验证。
- [规则回归检查](docs/regression-checks.md)：代码与依赖变化后的验证、对照和建议采用。
- [安全边界](docs/security.md)：固定权限、支持的工作负载和已知限制。
- [开发与测试](docs/development.md)：修改代码、测试分层和 CI。
- [实测记录](docs/validation.md)：本机实际运行结果与验收映射。
- [后续路线](docs/roadmap.md)：MVP 之后的验证方向。

源码以 [MIT License](LICENSE) 发布。底层 Sandbox Runtime 的许可证见其独立包；本项目通过 npm 依赖引用它。
