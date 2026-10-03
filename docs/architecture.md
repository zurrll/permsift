# 架构与搜索

```mermaid
flowchart LR
  C[场景与可信 limits] --> P[输入快照]
  P --> R[每轮干净副本]
  R --> S[Sandbox Runtime]
  S --> V[任务断言、固定边界、用户保护目标]
  V --> E[证据与报告]
  V --> D{接受收紧?}
  D -->|通过| N[下一候选]
  D -->|失败或未知| B[恢复上次配置并复测]
  B --> N
  N --> R
```

## 模块

| 文件 | 责任 |
| --- | --- |
| cli.ts | 参数、信号、退出码、doctor 内置项目 |
| src/config.ts | 严格配置校验、路径别名和可信读写权限上限 |
| src/configuration-explanation.ts | 运行前的静态配置/阶段/来源/检查范围解释；复用校验和准备，无执行后端 |
| src/filesystem.ts | 快照、路径检查、哈希、文件变化及原子 JSON 写入 |
| src/hash-scan.ts | 有界内容扫描、稳定历史摘要、文件身份核对及细分诊断 |
| src/timing.ts | 独占墙钟跨度、根扫描诊断及聚合 |
| src/installed-snapshot.ts | 私有安装快照捕获、发布、双重三根完整性核对与独立克隆 |
| src/backend.ts | macOS 后端、固定约束、清理环境变量和 SRT 生命周期 |
| src/process.ts | 参数引用、有限输出、超时、取消及进程组清理 |
| src/probes.ts | 假数据、宿主对照、本地 TCP 端点及沙箱探针 |
| src/protection.ts | 目标条件检查、独立微型夹具、批量直接操作探针及宿主对照 |
| src/protection-facts.ts | 版本化保护事实、检查操作集合、独立覆盖结论 |
| src/assertions.ts | 共用的声明式产物评价、读取/格式/内容原因；保留原验收 Check |
| src/success-materials.ts | 最终验证的可选有界产物保存、字节/来源及固定布局 |
| src/success-mutations.ts | 内存副本的具体产物扰动，保持 JSON/XML 与 suite 计数有效 |
| src/success-diagnostics.ts | 最终证据选择、未修改对照、按产物离线诊断与呈现 |
| src/junit.ts | 受限 JUnit XML 解析和用例结果验证 |
| src/discovery.ts | 有界目录枚举、跨基线观察合并和自动规则 |
| src/read-discovery.ts | 有界项目输入枚举、文件/目录读取候选及来源 |
| src/diagnostics.ts | 拒绝证据解析、路径别名和失败解释 |
| src/search.ts | 候选生成、接受、恢复复测和停止条件 |
| src/execution-request.ts | 完整可执行请求、模型角色及可信上限校验 |
| src/execute-once.ts | 一次受控执行、安装/任务检查、变化与各来源事实 |
| src/execution-phase.ts | 流程状态、精简执行结果与回归阶段判断 |
| src/execution-journal.ts | 原始证据、原生模型事实及逐轮索引的保存顺序 |
| src/experiment-report.ts | 兼容实验报告类型与纯 Markdown 呈现 |
| src/model/native-reader.ts | 原生 v1 事实、身份、引用与独立结论校验 |
| src/result-reader.ts | 保存结果及固定布局伴随材料的有界只读加载 |
| src/result-explanation.ts | 按路径/任务生成证据与行动，终端和 Markdown 共用结果 |
| src/result-output.ts | 流程完成后保存概览并前置到原详细报告 |
| src/engine.ts | 实验编排、候选/恢复、预算、快照发布、最终验证及导出 |
| src/baseline.ts | 历史规则兼容导入及已采用证据的加载分派 |
| src/adoption.ts | 最终验证证据选择、持久采用包、前序记录及原子当前选择 |
| src/terms.ts | 任务、成功条件、执行要求与逐保护目标的精确比较 |
| src/regression.ts | 当前输入冻结、逐任务约定维护、宽规则对照、有限补充及回归汇总 |
| src/install.ts | npm 锁定输入检查、缓存条件、固定安装参数、输入不变检查与传输失败分类 |
| src/sandbox-supervisor.ts / src/sandbox-worker.ts | 独立后端进程、真实结果 IPC、任务进程组、超时取消和有界代理清理 |

编排器串行执行实验。每次后端调用在独立 worker 中 initialize、执行、reset，使用唯一 invocation_id 关联拒绝事件；SRT 的 singleton 不跨调用共享。父进程记录任务进程组并控制超时/取消，等待 worker 真正退出后才继续。

第二轮将各流程接入共同 `executeOnce`，回归和观察直接使用类型化阶段事实，报告呈现从 engine 移出。每次执行同时写入 `executions/<trial-id>.json` 和索引；保存成功才允许流程接受或发布安装快照。接口、五对象关系、保存失败与兼容边界见 [共同执行底座](execution-foundation.md)。

任务完成的结果通过 IPC 发送后，清理最多等待 1 秒；CONNECT 对端不结束导致 reset 卡住时，终止这个 worker 的进程组并确认退出。父进程随后删除该 worker 独立、受保护的短路径 socket 目录。真实任务结果仍保留，backend_cleanup 明确记录 forced；缺少真实结果、worker 崩溃或清理报错保持 unknown。命令超时或取消后也会终止已记录的任务进程组，不能留下后台任务再标为通过。每次创建 worker 会增加进程启动开销，保证代理状态不会跨调用残留。

## 历史规则回归

check 导入经过验证的最终授权及其读取文件/目录类型，用当前任务定义执行。编排器只冻结当前输入一次，engine 的内部 frozenInput 接口克隆并核对哈希；原项目、共同快照、历史报告和回归汇总仍处于保护路径中。安装基线还导入域名，检查当前可信上限、对照覆盖和缓存模式；网络拒绝可生成受限补充。

旧规则通过就结束该任务；否则运行配置声明的较宽策略，再重新确认旧失败及宽策略恢复。两边都失败保持 unresolved_failure；超时、边界问题、文件类型变化和不稳定结果记为 inconclusive。

修复候选来自受限的拒绝路径及模块错误，先单次运行，再按 repetitions 完整验证。失败后恢复已通过的宽规则。新写目录需要预建时，先使用同一准备列表重新建立旧规则/宽规则对照。阶段报告保留真实 trial，回归报告单独记录环境、输入与授权差异。详见 [回归检查](regression-checks.md)。

## 一个 trial 的执行顺序

1. 从冻结快照克隆工作区，新建缓存和临时目录；warm 安装从固定输入种子克隆独立 npm 缓存。
2. 创建写入准备目录，移除旧产物；读目标必须存在。explicit 模式创建只写保护的假读文件，冻结读目标类型。
3. 检查夹具存在、内容正确、对照写入可行、网络端点健康。
4. 在候选策略下运行读取、写入、报告保护和网络探针。
5. 前置探针全部通过后，若有 install，按候选域名执行固定 npm ci --ignore-scripts，检查锁文件/清单未变并复查边界；随后重新关闭域名授权、验证断网探针，再执行任务。安装失败不执行后续命令。
6. 回收正常进程组后，在宿主上运行内置产物断言。
7. 使用同一策略再执行探针，对照检查再次确认环境健康。
8. 记录工作区、缓存和临时目录的文件变化、生效配置、有限日志和可获得的拒绝事件；基线还记录有界目录结构。

SRT 在包装命令中设置默认 TMPDIR。执行器在沙箱内以引用过的 env 参数重新设置为本轮 @tmp，避免默认共享临时目录覆盖独立临时目录；/tmp/claude 的写权限继续被拒绝。

任务与探针分别启动，每个阶段使用相同文件授权与对应网络策略。安装阶段允许候选域名，主任务阶段域名列表为空；各自保留前后探针及生效策略。探针同时验证直接 TCP 拒绝与经认证代理访问保留域名得到 403。

## 搜索方式

每个任务先独立验证初始策略。全部基线通过后，自动合并各任务所有通过基线的观察，生成输出目录组合、目录结构和拒绝线索规则，且不超过可信上限。只在这一阶段生成自动规则，搜索期间保持固定，避免环境准备状态随失败日志改变。

若自动规则需要预建目录，用冻结的目录列表重新确认基线。确认失败时停止。确认通过后，写搜索按手工规则、自动规则尝试父目录缩小，再成组或逐个撤销授权；所有比较使用相同的目录准备方式。导出配置保留准备列表。

候选通过时更新当前配置，并尝试尚未处理的操作；同级授权可以成组撤销，失败恢复后拆分。一轮内已尝试的操作延后到下一轮复查，直到完整一轮没有接受修改，或最后一次修改后剩余候选已全部实际比较。同一轮的相同失败组合可用作拆分线索，单独关联证据；下一轮清空。权限变化可能改变程序路径，不能永久保留旧失败结论。详见 [搜索效率](search-efficiency.md)。

读取搜索依据任务启动前的输入树生成候选，先删除授权再拆分保留的目录，避免展开不需要的依赖包。读权限接受变化后重新搜索写权限；写权限变化时再复查读取，没有变化则跳过已经完成的读取搜索。直到联合候选不再接受或达到限制。准备列表和读取候选在搜索前冻结；实际文件/目录类型在每轮开始时冻结，用于任务和前后探针。

候选失败或无法判定时，以之前的配置恢复复测。如果恢复也不通过，停止该轮搜索并记为不稳定，避免将环境错误归因于权限。

安装场景先撤销精确域名，再搜索写权限，不生成通配符或从锁文件自动放宽。写权限变化后重新搜索域名；域名未变时不重复已完成的写搜索。冷缓存候选、恢复和最终验证都重新安装；暖缓存始终由相同种子生成且 npm --offline。超时、传输、DNS、TLS 和注册表 5xx 属于 unknown；网络候选的安装失败没有捕获到独立域名拒绝也记 unknown。恢复通过不会将 unknown 改成必要域名结论。

没有候选、达到次数/时间预算或恢复不稳定时终止搜索。最后从干净状态完整重复所有任务。搜索只试验生成或声明的有限操作，没有穷举目录子集，也没有求全局最小解。枚举上限可能省略目录；瞬时操作可能不出现在文件差异中，两者都在报告中说明。

删除一个仍被祖先授权覆盖的规则，会记录为配置简化，不计为实际授权范围缩小。

## 三个结果维度

任务退出状态、产物断言和边界检查分别保存在 evidence 中。汇总 verdict 为：

- pass：进程正常完成且退出码 0，全部断言和探针通过。
- fail：正常完成的任务或明确边界断言未满足。
- unknown：超时、取消、输出超限、基础设施异常、探针证据缺失或无法解释。

拒绝事件用于解释结果，不单独决定需要放宽权限。某次访问被拒绝，但任务仍然完成时，拒绝可能是可选行为。拒绝事件为尽力收集，日志延迟或系统权限可能造成缺失。

diagnosis 单独分类执行未完成、边界问题、退出非零且捕获到权限拒绝、普通命令失败、退出零但断言失败。拒绝线索保留来源（系统沙箱日志或任务 stderr）及可映射的路径别名。Markdown 关联本次规则变化与恢复 verdict，缺失拒绝日志时明确说明证据不足；不将任意任务错误归因为权限。

实验 status 与 search_complete 也是独立维度。搜索预算用完后，一个已经完整重测的策略仍可标记 verified，同时 search_complete 为 false。恢复不稳定、用户中断、清理失败或最终重测失败时为 incomplete，不能输出推荐配置。

## 证据与重现

每次运行有单独 JSON 文件。顶层报告在每个 trial 和搜索决策后更新；JSON 使用临时文件加 rename，减少写入中断造成的损坏。Markdown 为便于阅读的派生文件。

输入哈希覆盖复制的文件内容、文件模式、相对路径、目录以及内部符号链接目标。配置、limits 和包含读写范围、读取目标类型与目录准备状态的可变策略也分别计算哈希。哈希帮助对照实验条件，不能替代可信存储或第三方签名。

每轮工作区通过 forkSnapshot 创建。macOS 使用系统 cp -c 的 clonefile 写时复制，Linux 文件工具测试使用 Node 的 reflink 优先选项；文件和目录仍独立，绝不使用硬链接。磁盘不支持克隆时，复制工具回退到复制字节。evidence.workspace_fork 记录策略与创建耗时；策略名称表示请求克隆，不能证明所有文件实际共享了物理块。输入冻结仍只进行一次完整内容读取和哈希，文件枚举、差异哈希、目录创建/删除的成本仍然存在。详见 [快照工作区](snapshot-workspaces.md)。

## v0.6 可选的安装/任务阶段

install.initial_write_grants 激活阶段策略。安装域名/写规则先通过完整试验搜索；已接受规则的新完整 trial 在任务前捕获 workspace/cache/tmp，整个 trial 通过才发布快照。InstalledSnapshots 绑定完整输入、环境、安装配置、策略、准备和上限，核对源/克隆内容与模式。任务候选只克隆已发布状态，任务读写联合搜索；所有最终 trial 仍走真实安装。

report.install_policies / install_searches / install_discovery 保存安装写搜索，原 policies / read_policies 为任务。installation_stats 与 evidence.installed_snapshot 明确区分新安装和复用来源。读取目录库存于安装后获取，包目录作为叶节点，不扩大 incomplete/truncated 子项。最终验证不能省略；阶段搜索是有界顺序，不声称跨阶段共同最优。run/check 共用完整执行器并在安装后核对历史依赖读取类型。

## v0.7 成本记录

Timings 记录单调时钟的独占跨度，实验聚合初始冻结、各轮操作、证据写入及末尾清理。耗时和调用数是观测字段，不参与 verdict 或必要权限判定。复用安装快照时不生成安装变化清单，仍执行两次三根完整性核对和任务前后真实内容清单；全流程试验保留安装变化。详见 [计时口径](performance.md)。

## v0.9 依赖观察

observe-command.ts 复用 engine 的 observe 模式，每个配置任务一次；不进入候选、恢复、快照搜索和推荐配置导出。执行器仅为离线任务准备内置 observation-runtime 的 CJS 预加载，backend 限定内部控制路径、追加日志目录写例外及预加载 denyWrite，清理后不保留工作副本。

dependency-inventory.ts 在任务前读取 npm 安装位置和包元数据；observation.ts 有界读回各进程/线程的 JSONL，区分解析、加载、子进程启动尝试与 footer 健康度，映射归属最长匹配安装根。引擎证据保存原始任务/边界和观察摘要，observe-command.ts 生成独立的 usage.json/md，usage-comparison.ts 比较历史观察。报告模式不能作为 regression 的 run/tighten 基线；观察不生成 Rule，不把加载升级为必需权限。

JSONL 是任务可写的合作式诊断数据，不能作为防篡改审计证据。安装/探针保持清洁环境；Task verdict 和 capture_status 分开，详细限制见 [dependency-usage.md](dependency-usage.md)。

## v0.10 编译输入

可选 scenario.observation.typescript.compiler 绑定一个项目安装根；配置限定直接 node <compiler>/bin/tsc。typescript-observation.ts 仅为 observe 生成带 explainFiles / locale en / pretty false 的实际命令，并有界解析该次 process.stdout。无需额外日志目录或读取授权，也不执行第二次编译。compiler 版本来自任务前已安装清单，文件归属按最长包根，多个解释保留；stdout 原始内容、摘要及实际命令写入 trial/compilation。

TaskObservation.compilation 为独立来源，Node capture_status 仍保持原义。observe-command 的总体 observed 要求任务及每个开启来源都通过；JSON schema 1 保留可选扩展，导入 v0.9 无 compilation 时不推断新增输入。编译来源按包/文件/解释比较，parser 和 compiler 版本、命令、限制变化单独提醒。用途只展示证据列，不自动生成互斥分类或权限候选。

## v0.11 esbuild 产物记录

esbuild-observation.ts 在 observe 的离线任务前清空声明的产物目录，恢复显式准备和断言父目录；任务后有界读回项目自己保存的完整 metafile。工具版本绑定任务前 npm 清单，路径按工作区规范化，输入按最长安装根归属；输出必须在声明范围内，检查新文件类型与大小，保留全部报告输出及 external 请求。有界输入图提供一条入口链，按包分别聚合各输出的 bytesInOutput，包括 0 的记录。虚拟/外部路径、未知归属、未完成任务或截断均明确报缺口。

TaskObservation.bundling 与模块、compilation 各自保持来源和健康度；顶层 observed 要求所有开启来源完整。esbuild-comparison.ts 比较输入/输出、包版本与贡献、链和 external，生成来源报告；loadUsage 校验引用、聚合、链和整体上限。旧 schema 1 没有 bundling 时不产生整组新增结论。原始 JSON 只记录文本摘要/字节数，规范化数据写入 trial 与 usage；保留副本可检查原文件。CLI 和报告不生成权限候选或必要性评分。见 [产物观察](bundle-inputs.md)。

预加载增加 process.execve 启动尝试，仍不记录参数/环境内容。进程替换导致没有 exit footer 时，Node 来源保持 incomplete；原生编译器可同时给出完整的 explainFiles。详细范围和版本限制见 [typescript-inputs.md](typescript-inputs.md)。

## 离线报告分析

usage-report.ts 从普通文件有界读回 schema 1 的 usage，验证实例身份和来源引用；可选保留安装清单及模块文件，使旧比较输入也能用于跨任务查看。usage-comparison.ts 由 observe --baseline 和 compare 两个入口共用；原比较输出的段落也共用，避免实现漂移。offline-usage.ts 记录各侧来源状态、纯分析退出状态及可选工件导出。usage-inspection.ts 只投影匹配名称的每任务安装实例，不制造缺失来源、用途分类或权限建议。

CLI 在加载 engine / backend 之前处理 compare / inspect，离线入口不依赖 SRT 或原项目。运行入口继续动态载入原执行器；version.ts 提供共享版本，engine 仍兼容导出 VERSION。没有改变快照、安装、边界探针、采集或搜索流程。

第五轮明确采用在执行底座之外处理，只读取已保存的最终证据并写入独立存储，不运行任务。check 同时记录历史事实和当前事实：约定变化要求审阅；新增任务独立验证、删除任务保留历史，不能迁移的任务不阻止其他任务运行。详见 [基线采用](baseline-adoption.md)。
