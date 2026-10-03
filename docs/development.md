# 开发与测试

## 安装和构建

```sh
npm ci --ignore-scripts
npm run build
npm run check
```

依赖精确固定在 package.json 和 package-lock.json。TypeScript 输出位于 dist/；源码是 CLI 入口 cli.ts 及 src/ 下的模块。工具尚未发布，直接通过 node dist/cli.js 使用。

## 依赖观察验证

```sh
# 已 examples:prepare 后：普通一次、观察两次；不运行权限搜索
npm run observe:verify
# 使用现有 medium:verify 结果的固定暖输入/种子，增加 fast-glob 两种任务
npm run observe:verify -- --medium-baseline .permsift/fast-glob-profile-XXXXXX/summary.json
```

新增 observation.test.ts 验证清单、CJS/ESM/Node 子进程、记录截断和对比；integration/observation.test.ts 验证真实写保护、前后边界、任务与记录状态分离、受控依赖变化和超时保存。CLI 观察的完整边界见 [dependency-usage.md](dependency-usage.md)。

```sh
# 类型专用受控夹具；没有权限搜索
npm run compile:verify
# 增加固定上游暖输入的直接编译
npm run compile:verify -- --medium-baseline .permsift/fast-glob-profile-XXXXXX/summary.json
```

typescript-observation.test.ts 验证直接任务配置、真实本地编译器、两种解释格式、归属、未知输出和上限、兼容对比；integration/compilation.test.ts 验证同一次沙箱编译、原始输出身份、权限/边界、类型引用与版本变化、缺输出及输出预算。TypeScript 7 的 execve 缺 footer 预期为 Node 来源不完整，不能为测试通过而忽略；编译来源仍可完整。细节见 [typescript-inputs.md](typescript-inputs.md)。

## 测试分层

第三轮的 result-summary.test.ts 验证已保存材料、原生引用、候选/恢复、回归子报告、缺口和各来源含义。`npm run results:verify` 通过公共 CLI 回放权限修复与依赖升级两条记录，不运行项目或安装。真实集成用例中的 assertSummary 使用该用例已生成的结果，核对在线保存与离线解释、Markdown 前置概览；不为核对新增 trial。接口与兼容说明见 [结果解释](result-explanations.md)。

内部模型位于 src/model/，第二轮已接入 execution-request.ts 和 execute-once.ts。model.test.ts 用真实记录投影及标明的合成反例检验身份、旧摘要、引用、未知结论和条件变化；execution.test.ts 检验完整请求、模型事实、阶段判断、索引及写入失败；两者不增加项目任务执行。回放及最小环境复现：

```sh
npm run model:verify
npm run environment:verify
# Linux/其他平台只检查保存报告，不表示后端隔离通过
npm run environment:verify -- --offline-only
```

含义、映射与验证范围见 [内部模型](model.md)、[案例](model-cases.md)、[共同执行底座](execution-foundation.md) 和 [环境检验](environment-validation.md)。最小环境脚本同时核对刚生成的 demo、全部 sidecar、原生执行模型及索引，检查真实失败候选和通过结果的独立维度。

v0.11 的 esbuild-observation.test.ts 覆盖配置、真实宿主构建与各来源关系、完整产物新鲜度、未知/损坏/超限、链接/FIFO、输入/输出/边/链上限、对比和历史导入一致性。integration/bundling.test.ts 在真实沙箱验证单次构建、权限/边界、代码与版本改动、旧记录及分块、失败和范围外输出。esbuild 与平台包作为开发依赖，测试只复制工具及明确的受控包，不复制整个宿主依赖树。

```sh
npm run bundle:verify
npm run bundle:prepare
npm run bundle:verify -- --real
```

默认受控样例进入常规 macOS CI；公开注册表与真实源码用 --real 手动验收，不让每次小改动重复联网。每个项目普通一次、观察一次、变更后观察一次，不搜索权限。真实样例及旧 CommonJS 转换适配、收获与限制见 [bundle-inputs.md](bundle-inputs.md)。

```sh
# 单元和宿主组件测试
npm test

# 真实沙箱测试，仅 macOS
npm run test:integration

# 从头运行演示
npm run demo

# 准备并在沙箱中运行三个代表项目（准备时联网）
npm run examples:prepare
npm run examples:verify

# 读取收缩演示与第三方原始构建（准备时联网）
npm run demo:read
npm run third-party:prepare
npm run third-party:verify

# 代码、依赖及普通错误的规则回归（准备时联网）
npm run regression:prepare
npm run regression:verify

# 在沙箱内安装固定 clsx，收缩域名；验证冷暖缓存与断网产物
npm run install:verify

# 中等规模上游项目（冷安装、暖搜索、导出重放）
npm run medium:prepare
npm run medium:verify

# 本机副本创建性能对照（生成 256 MiB 临时数据）
node scripts/benchmark-forks.mjs

# 构建 Permsift 自身，并启动产物验证 CLI 版本
npm run self:verify
```

| 测试文件 | 关注的问题 |
| --- | --- |
| execution.test.ts | 完整请求、权限与准备上限、条件独立、原生/导入身份一致、实际命令、目标类型、阶段结论及各保存步骤失败 |
| timing.test.ts | 单调计时、嵌套独占耗时、失败计时和聚合对账 |
| config.test.ts | 路径穿越、未知配置、最高权限、错误缩小、重复配置 |
| filesystem.test.ts | 快照独立性、依赖目录保留、内部与外部链接、哈希、输出差异 |
| install.test.ts | 精确域名与上限、安装条件、锁文件与缓存种子、固定参数、传输未知和域名搜索 |
| bundled-dependencies.test.ts | 内嵌归属、作用域/提升/环、孤立标记、下载信息、实际元数据、超限/取消、保存检查完整性 |
| sandbox-supervisor.test.ts | worker 正常退出、卡住的清理、有界终止、结果缺失和取消 |
| assertions.test.ts | 跳过测试、缺失测试、重复结果、JSON 类型、宿主读取限制、unknown |
| search.test.ts | 实际收紧、必要授权、恢复失败、预算和非单调执行路径 |
| scheduler.test.ts | 分组及拆分、延后复查、互相关联授权、相同失败线索、unknown、预算和不稳定恢复 |
| regression.test.ts | 历史基线和证据导入、当前上限、任务/模式变化、边界分类与有限修复候选 |
| discovery.test.ts | 跨基线观察合并、上限、链接、有界枚举和候选实际验证 |
| diagnostics.test.ts | 拒绝来源与路径、普通错误和超时、归因限制 |
| junit.test.ts | 嵌套报告、缺失/失败/跳过/重复用例、错误 XML、DTD 和深度上限 |
| process.test.ts | 参数引用、输出上限、超时、取消、普通后台子进程清理 |
| probes.test.ts | 不存在的资源、停机端点和夹具篡改 |
| read.test.ts | 独立读上限、候选与恢复、完整枚举、精确后端规则和读探针对照 |
| cli.test.ts | 帮助、版本、明确 limits、未知选项 |
| integration/sandbox.test.ts | 真实读写拒绝、文件收缩、读写联合非单调行为、文件替换目录、自动发现、临时操作、JUnit、准备状态复测与重放、分组恢复、读写连续变化、旧产物、超时和中断 |
| integration/regression.test.ts | 旧规则复验、读写补充、依赖解析、冻结输入、目录准备对照、多任务、预算、超时、中断和 CLI 退出码 |
| integration/install.test.ts | 本地注册表真实 npm 下载、域名拒绝与恢复、脚本禁用、断网构建、固定缓存隔离及停机重放、锁不匹配、5xx、瞬时故障与域名升级回归 |
| integration/backend-cleanup.test.ts | 真正 CONNECT 对端不结束、任务已完成时的有界清理和后续后端调用 |

单元测试可以在 Linux 上运行。集成测试在其他平台显示 skip；这表示未验证该平台，不表示隔离通过。macOS 上出现后端异常时测试应失败，不能临时改成 mock 或无条件跳过。

CI 配置包含 Linux 单元测试与 macOS 完整测试。新增 CI 文件不代表远端已执行，实际远端状态需在推送后查看。

## 添加任务案例

为示例项目增加一个能独立产生确定结果的命令，定义成功断言和初始写范围。先确认 run 多次通过，再设计一项可被缩小的授权，以及一项不能撤销的授权。

优先添加失败案例：旧产物、不完整测试结果、恢复后仍失败、超时、链接和失活的对照资源。它们能检查工具是否错误接受候选。

## 修改后端或搜索算法

- 后端固定配置改变时，检查 effective policy 和全部真实探针。
- 搜索器可以使用模拟评价函数测试决策逻辑，但不能以此替代后端集成测试。
- 不根据单次访问轨迹自动把访问升级为必要授权。
- 保留原始失败与恢复证据，unknown 不得被转换成 pass。
- 后端已按调用隔离到 worker，编排仍串行；若增加试验并发，还需处理进程清理、端点、预算与证据隔离。

## 调试失败实验

使用 `--keep-workspaces` 保留副本，报告中的 workspaces 给出绝对路径。查看失败 trial 的 evidence 文件，依次区分对照检查、探针、任务进程和产物断言。

保留的工作区不会自动重用。完成检查后，可自行清理报告所指向的本次临时目录；不要使用宽泛的 /tmp 通配符删除其他实验。

## v0.6 分阶段验收

`npm run stages:verify` 使用公开 clsx 锁定依赖，验证冷/暖缓存的独立安装写规则、任务读取收缩、安装快照复用、三次完整重放与旧规则 check。`test/installed-snapshot.test.ts` 检查键、内容/模式/链接、篡改与副本隔离；`test/integration/staged-install.test.ts` 验证真实策略切换、生成读取、必要小缓存、回归补充和最终注册表故障。旧安装和离线集成测试继续保留。结果见 [validation.md](validation.md)。

## v0.7 性能验证

耗时默认记录，不影响 verdict。并行操作必须在一个计时跨度内统计，嵌套跨度只给父项计独占时间。JSON 增加字段兼容旧历史报告。安装快照任务有两轮任务清单扫描及两次三根完整性核对；完整安装仍保留四轮清单。真实集成测试同时检查变化证据和原项目隔离。默认清理的测试在下一轮启动前检查上一轮三个根已删除，并验证私有安装快照仍可复用；保留模式继续验证多个副本可独立修改。中等项目的对比、配置适配与范围限制见 [performance.md](performance.md)。

中等项目额外提供手动触发的 medium.yml 工作流，避免在每次小改动的 CI 中加入长时间公开注册表/依赖树实测；新增配置不表示远端已经执行。

## v0.8 完整校验验证

`test/hash-scan.test.ts` 用独立 v0.7 扫描器核对不同并发下的历史摘要，覆盖大文件、空目录、Unicode、内部链接、模式、同大小内容修改及恢复时间戳、异常类型、大小上限、取消和超时。`timing.test.ts` 检查并行操作 service time 不会重复计入墙钟；真实分阶段测试仍要求每轮两次完整核对、六次根扫描和独立变化清单。

`npm run hashes:benchmark` 观察三次暖安装及交替顺序的扫描成本。`npm run search:benchmark -- --baseline <summary.json> --seconds 300` 对同一暖输入和预算运行本地 v0.7 与当前代码，结束时清理参考 checkout。完整方法与字段见 [hash-validation.md](hash-validation.md)。

## 离线报告回放

`npm run offline:verify` 只调用 compare / inspect 处理 examples/reports 中的已有真实记录投影，不安装示例依赖或启动沙箱。输出保存到新的 .permsift/offline-usage-*；检查跨任务事实、升级比较、相同报告比较和输入未变。单元 CI 的 Node 22 / 24 作业也执行此脚本。输入来源见 [样例说明](../examples/reports/README.md)。

变更覆盖新增的 offline-usage.test.ts，并扩展原观察集成用例，使同一对真实沙箱记录的 observe --baseline 与 compare 结果相同，不为比较额外执行任务。离线退出码与部分来源场景见 [离线分析](offline-usage.md)。

## 固定保护目标验证

`test/protection.test.ts` 检查配置边界、身份、完整操作/对照/阶段、缺失/类型/链接、明确放行、夹具篡改、冗余授权收益及修复提示约束。`execution.test.ts` 核对原生 wire v2 和未运行事实。`integration/protection.test.ts` 使用真实 macOS 后端验证规则例外、搜索恢复、导出重放、约定冲突、精确修复和观察；分阶段安装用例另核对共用安装、任务保护、安装快照复用及最终新安装。

`npm run protection:verify` 是一个小型公共 CLI 故事：正常构建、有/无目标成本记录、代码读取保护目标后的 check 以及无可执行 PATH 的离线 inspect。它创建独立示例和新报告目录，既有示例不会被改写。CI 的 macOS 作业已配置此流程，未声称远端 CI 已实际通过。范围和证据格式见 [保护目标](protection-goals.md)。

维护流程：`npm run maintenance:verify`（真实 macOS 公共 CLI）；纯采用/完整性反例位于 test/adoption.test.ts，真实维护位于 test/integration/maintenance.test.ts。大型入口复用现有基线，参数见 [基线采用](baseline-adoption.md)，不重复权限搜索。

## 内嵌依赖安装验证

`test/bundled-dependencies.test.ts` 验证预检归属、实际包元数据和保存检查；`test/integration/bundled-install.test.ts` 用本地注册表验证真正的 npm ci、作用域/提升包观察、禁用脚本、错误 tarball、安装成功但子包缺失、父包声明和版本失配。测试 tarball 禁用 macOS 扩展属性打包，避免夹具携带 AppleDouble 文件；生产清单仍保持未知条目的可见性。

`npm run bundled:verify` 通过公开 CLI 验证运行、采用、再检查、观察及项目清理后的离线查询。默认无需公开注册表，只做 3 次本地安装/任务，0 搜索；可选固定 glob-parent 旧上游源码与冻结锁，增加 1 次冷安装/原测试任务。全部输出写入新的 ignored 目录，不覆盖历史记录。参数和支持范围见 [内嵌依赖](bundled-dependencies.md)。macOS CI 配置了默认本地流程，未声称远端已运行。
