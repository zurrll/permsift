# 原任务接入与按包解释：实现和实测

2026-10-05，v0.12 后的本机工作树。对应 [修订计划](real-task-plan.md)。本轮两次交付已实现；没有扩大权限搜索、增加编译采集器或修改沙箱后端。

## 可以怎样使用

原有 lint、类型检查和测试命令可以明确以退出码验收：

```yaml
assertions:
  - type: exit_code
    value: 0
```

只有正常完成且退出码 0 才通过。空 assertions 仍拒绝；任务检查不绕过边界、安装核对或保护要求。退出码与文件条件可共同使用，采用后的成功条件变化仍要求审阅。没有文件目标的条件不参与产物清理、保存和扰动诊断。无需下载的配置为 [examples/demo/exit-code.yaml](../examples/demo/exit-code.yaml)：

```sh
npm run build
node dist/cli.js explain --config examples/demo/exit-code.yaml --limits examples/limits.json
# 真正执行时仍使用沙箱；默认 limits 会重复三次
node dist/cli.js run --config examples/demo/exit-code.yaml --limits examples/limits.json
```

新观察记录的 `inspect --package NAME` 同时展示安装声明关系、入口/文件结构及本次解析/加载记录。资料在执行前保存，复用已有清单，不另遍历一次依赖树。旧记录没有这些事实时显示未保存；查询不会补读现在的项目。用法与边界见 [配置](configuration.md) 和 [离线查询](offline-usage.md)。

## execa 原命令验收

输入是已准备好依赖的 execa 10.0.1，源码提交 `8017b279e19347efaf2587711c2d57dbd4330740`，原项目 Git 工作区干净。679 个实际安装实例、568 个包名，没有 package-lock。仅靠源码提交不能重建这份精确安装输入，因此记录了冻结摘要；不把它写成冷安装复现。

使用 `npm run lint`（xo）和 `npm run type`（tsd && tsc），没有拆掉 tsd，没有改上游源码/命令或制造验收产物。两项都配置 exit_code: 0。任务断网，写权限为 @workspace、@cache，默认整个工作区可读；没有额外保护声明。排除 .git、Permsift 材料及之前人为产生的 lint-report.json、tsc.tsbuildinfo、tsd-result.txt、coverage，保留现有 node_modules 和其中的缓存。

Node 24.21.0、npm 11.19.0、macOS Darwin 24.6.0 / arm64、Sandbox Runtime 0.0.77。limits 为 repetitions: 1、max_candidates: 0、budget_seconds: 1800、max_snapshot_bytes: 1,000,000,000；普通与观察使用同一配置和上限。

| 执行 | 项目命令数 | lint / type | 固定边界 | 整体成本 | 任务阶段 |
| --- | ---: | --- | --- | ---: | ---: |
| 普通 run | 2 | 均通过 | 均通过 | 55.97 秒 | 33.99 秒 |
| observe | 2 | 均通过 | 均通过 | 57.20 秒 | 33.97 秒 |

共四次项目命令，0 安装、0 搜索候选；没有额外定向 lint 或直接 tsc 重跑。前后边界探针是额外沙箱调用，不能把“四次命令”写成所有底层调用总数。

配置、limits 和冻结输入摘要分别为：

```text
config   d95e5b8da6efd7c80d3acf71c94306cc0107d7e2eaeb5375441c86791fcb9b4c
limits   4de36e0a6c3df4b18c284c0f1b2c164334710edde79f5e8640a4b6430947511a
snapshot def9be07caedd3899b2fc1d3a196279aeca64495b80383e002354f9181d85592
prepared e71b64f6ab57ce8595d967479ed156815fd33da27381dac279356f6a27dc725f
```

两次模式前三个摘要相同；观察两任务的 prepared 文件清单摘要也相同。每个任务使用独立副本及空的 @cache/@tmp，现有 node_modules/.cache 来自同一冻结输入，没有将普通任务的写入带给观察任务。操作系统文件缓存和时序未控制；这是单机顺序对照，57.20 − 55.97 = 1.23 秒不能泛化为稳定观察开销。观察流程另有约 7.91 秒清单、6.37 秒克隆、4.93 秒冻结等成本。

本机原始材料位于仓库忽略目录 `.permsift/execa-2026-10-05/`：config.json、limits.json、normal/、observed/、acceptance-facts.json 和两个按包查询文本。完整记录约 4.39 MB，不纳入源码仓库。

## 采集结果和保留的缺口

两任务的安装清单均完整，普通 node_modules/.cache 已记录为辅助目录。lint 保存 196 个加载包实例；type 保存 109 个。type 的模块采集完整；普通 npm 脚本没有开启直接 tsc 编译采集，因此两项的编译来源仍为未采集，不能把模块记录当作类型输入。

lint 观察为 incomplete，observe 退出 2；它与任务/边界通过并列。新诊断明确区分：

- 主线程日志 5,255 个事件、1,991,528 字节，有 footer，原因 byte_limit。2,000,000 字节预算中预留 8,192 字节给控制记录；这次没有触及 10,000 事件上限。提高事件上限不会解决它。
- 同一进程的 worker 日志 304 条记录、88,059 字节，缺 footer，原因 missing_footer。任务正常退出不能补出结束证据；本轮没有判断 worker 是怎样被结束的。
- npm 的 shell 子进程不受模块钩子完整覆盖，继续列为覆盖范围限制。

因此本轮完成了定位所需的诊断表达，没有声称修好了全部 lint 采集。未提高上限或把缺 footer 当成完整。旧材料只有 truncated 而没有原因时继续显示原因未保存。

按包摘要还发现部分其他包的 exports 声明超过 64 项，保留局部缺口；不会把它传播为目标包结构缺失。实施验收期间另修正了嵌套 .bin、普通 .cache、辅助锁文件和合成读探针的结构归属，固定反例验证这些内容不算包代码。最初实测材料仍保留原有局部摘要，不重写历史记录或为此重跑任务。

## 两个查询现在能回答什么

七个 type-fest 的声明/布局父依赖和磁盘内容如下。每个均有 0 个已识别 JS、非声明 TS、原生或 Wasm 文件；“其他”包括元数据和文档，不能省略它们后断言包没有用途。

| 版本 | 直接声明父依赖 | 声明文件 | 其他文件 | 本次加载 |
| --- | --- | ---: | ---: | --- |
| 0.21.3 | ansi-escapes | 43 | 3 | 无记录 |
| 4.41.0 | make-asynchronous | 166 | 4 | 无记录 |
| 0.18.1 | meow | 31 | 3 | 无记录 |
| 0.8.1 | read-pkg-up | 16 | 3 | 无记录 |
| 0.6.0 | read-pkg | 11 | 3 | 无记录 |
| 0.13.1 | serialize-error | 25 | 3 | 无记录 |
| 5.10.0 | xo | 218 | 4 | 无记录 |

根路径把这些版本分别连到 tsd、xo 或 ava 等项目声明：例如根 → tsd → meow → type-fest@0.18.1；根 → ava → supertap → serialize-error → type-fest@0.13.1。0.8.1 / 0.6.0 没有保存到 types 入口声明，但确实含声明文件。安装路径、版本和结构是确定的保存事实；是否被 tsd 编译使用仍未知，不能给出删除结论。

eslint-visitor-keys 三个实例均含三个 JS、三个声明和三个其他文件，lint 中各有两个加载文件；type 没有记录。直接声明与实际解析来源可分别看：

| 版本 | 声明父依赖 | lint 中保留的外部解析来源 |
| --- | --- | --- |
| 3.4.3 | @eslint-community/eslint-utils | eslint-utils/index.mjs |
| 4.2.1 | @stylistic/eslint-plugin、其嵌套 espree | eslint-plugin/dist/utils.js、该 espree/espree.js |
| 5.0.1 | eslint、顶层 espree、@typescript-eslint/visitor-keys | 顶层 espree/espree.js |

另外保留各实例内部 index.js → visitor-keys.js 的边。声明父依赖多于实际外部解析来源是合法结果；lint trace 有缺口，不能推出其他父依赖本次没有使用它。

这十个实例及十三条直接父关系已与只读 `npm ls type-fest eslint-visitor-keys --all --json --long`、原 package.json 和独立磁盘文件核对一致。生产采集和离线查询不调用 npm ls；这次调用属于开发核对，0 安装、0 项目脚本。

将单份 usage.json 复制到临时目录，以 Node 文件权限禁止读原项目，PATH 中无外部工具，仍能查出两任务各七个 type-fest 的关系和结构。返回 2 来自已保存 lint 缺口，符合原退出策略。旧 obs3 查询显示三任务的关系/结构均 not_saved，没有补读项目。

## 工程验证与收益边界

- 完整单元/组件测试最终 272/272，约 16.24 秒；随实现变更做了四次完整回归，累计约 67 秒。覆盖非零/超时/缺过程、文件与退出码共同验收、嵌套版本、循环/可选/peer、非 .js 代码、结构缺口、损坏引用/计数、真实事件/字节上限和 trace 状态矛盾。
- 相关 macOS 集成 30/30：执行/收缩/采用/复验、成功条件变更、产物诊断、保护目标及模块/编译/构建来源。两组约 25.50 秒与 62.83 秒；固定夹具中的任务、恢复和探针与四次 execa 命令分别计算，不把测试项数当作任务数。
- 离线公开样例验证通过；新配置的 explain 通过且执行/安装数为 0。没有重跑全部联网安装演示；CI 分层仍暂缓。

已兑现的是少了人为成功标记的接入步骤，以及“谁引入这个安装版本、它含哪些内容、哪些来源留下记录”的具体答案。没有实际删除/升级决定，没有独立读者理解度或人工分钟测量。trace 的两个缺口仍需单独研究；增加更多任务或采集器不保证能解释所有未记录包。
