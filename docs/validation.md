# 实测记录

## 第七轮工程收口：干净试用包与外部项目维护 — 2026-10-03

同一本机 macOS 15.8 arm64 / Node 24.21.0 / npm 11.19.0 / SRT 0.0.77。最终单元/组件 **249/249**，新增 4 项试用材料/失败计数检验、3 项 JUnit 数字引用反例、1 项诊断解码一致性检验；类型、脚本语法与 Git 空白检查通过。日志 `.permsift/trial-unit-final.log`。定向真实 Node JUnit reporter / 陈旧输出删除 / 跳过项拒绝 **1 项通过**，见 `trial-junit-integration.log`，未重跑完整 80 项集成套件。

最终干净接入收据 `.permsift/clean-trial-bJOmX2/verification.json`：从源码包解压，确认没有 node_modules / dist / .git / .permsift，按清单验证字节与模式，在新 npm 缓存安装并构建工具。按两份入门执行 doctor、demo 的 run/inspect/adopt/源码变化/check，以及 bundle-kit 的两次 observe/inspect/源码变化/compare；**14 次项目任务、0 次沙箱安装、0 搜索**，工具宿主安装 1 次、示例准备 2 次，doctor 另计 1 次。包含外部流程的本次墙钟 74.23 秒，属于单次工程记录，不是性能基准或人工省时。

外部收据 `.permsift/clean-trial-bJOmX2/external-maintenance/verification.json`：glob-parent 6.0.2 固定提交 `26ce5ecec10c687cffb9891c108fb2d2800b9140`，保留原 npm test / pretest lint / nyc，仅追加 xunit 输出参数。1 份任务配置、1 份 limits、0 命令包装、0 上游源码/测试改动；20 个预期测试名字均在，全部报告项通过，index.js 与 test/ 的固定任务写禁止目标在前后直接对照中通过。

两份固定锁文件只改变 Mocha 7.1.2 → 7.2.0；在新副本显式准备两版缓存，禁用脚本，清理宿主 node_modules，然后冻结同一种子。run / observe-before / check-after / observe-after 各独立新安装，四次命令均包含 --offline，种子摘要均为 `1e574d498b5d407813197db830cf1594e346640abccf3ba56ad208d418398f54`。**4 次沙箱新安装、4 次原测试任务、0 候选**；宿主缓存准备 2 次约 8.15 秒，外部流程共 54.85 秒。

| 当前固定缓存样本 | 观察结果 |
| --- | --- |
| 每次沙箱安装 | 1.45–1.59 秒；仍从锁文件重新安装，不复用宿主 node_modules |
| 原测试任务 | 1.76–2.02 秒 |
| 两目标的前后直接保护检查 | 每次 0.33–0.36 秒 |
| 一次建立/观察/复验 CLI 总等待 | 10.64–11.74 秒；含快照、清单校验、探针、保存和清理 |
| 原始清单扫描 | 普通 run / 两次 observe 各约 3.59–3.71 秒，5 次扫描 |
| 离线采用记录 / Mocha 查询 / 比较 | 各 0.08–0.13 秒，不增加安装/任务 |

check 返回 compatible，配置、limits 和保护目标未改变；采用指针直到显式 adopt 才改变。两次观察各 435 个安装实例、268 个模块加载包，唯一记录的包版本变化为 Mocha；类型/打包来源未采集，不把另外 167 个包判作无用。删除临时项目后采用记录、包查询和比较仍可读，usage 摘要保持。完整上游源码字节与模式不变。另对保存的真实 Mocha 报告做离线 diagnose，未修改对照为 20/20；合法失败、删项、改名和重名被内容检查拒绝，空文件独立为格式错误。收据 `trial-mocha-diagnosis.json`，0 新任务/安装。

**失败与调整同样保留**：最初冷流程 `.permsift/clean-trial-DzHQT0/` 安装约 74.39 秒、原测试和保护通过，但四个带引号的测试名未匹配。固定 fast-xml-parser 的默认实体处理没有解码数字引用；修复为仅 XML 预定义/数字引用的一次解码，验收与诊断共用，不开启额外 HTML 名字，不双重解码，非法字符和 DTD 仍拒绝。旧 16 名称记录不倒填为已经检查全部 20 名称。

随后 `.permsift/clean-trial-aik5RB/` 冷安装约 150.63 秒超时，0 次任务，正确保持 incomplete / 未知；没有判作权限不足或自动重试。后续明确选择既有固定暖缓存条件，冷失败不被覆盖，也不声称冷安装已稳定通过。三次接入尝试各跑了 14 次入门任务和一次 doctor；外部累计 **2 次冷安装尝试（1 次任务）、4 次暖新安装（4 次任务）**，另有 2 次显式宿主缓存准备。早期工具/示例准备重复与开发回归不混入最终试用预算。

提供 `trial:bundle`、`trial:verify`、`external:verify` 与 [试用/反馈材料](trial.md)。最终源码包补充文档时，另检查全部执行源码与已验证包的摘要一致，未为文档变动重新下载依赖。任务执行仍限 macOS；另一主机、Node 22 与独立使用者没有新增结果。工程流程完成不代替新用户理解度、长期维护收益和独立反馈。

## 第七轮首个交付：配置解释与两条入口 — 2026-10-03

本机 macOS 15.8 arm64 / Node 24.21.0 / npm 11.19.0 / SRT 0.0.77。最终单元/组件 **241/241**，新增 10 项配置解释反例与 1 项 CLI 检验；类型、脚本语法和 Git 空白检查通过。日志 `.permsift/onboarding-unit-delivery.log`。验证默认来源、初始授权与上限、空读取、安装继承、模式安排、产物检查、错误定位和输入不变；公共 CLI 在禁止子进程、HTTP/HTTPS/socket 与 fetch 的环境中完成解释。

受影响的真实 macOS 用例定向 **3 项通过**：原写收缩与导出重放、单次观察与边界、分阶段读写收缩/安装快照/最终新安装。日志 `.permsift/onboarding-integration.log` 中前两项是实际沙箱用例，另有一条未匹配名称的文件加载，不计入；分阶段用例用正确名称单独通过，见 `.permsift/onboarding-staged-integration.log`。本轮没有重跑完整 80 项集成套件。

默认公共 CLI 收据 `.permsift/onboarding-validation-FoXlb8/verification.json`：8 个现有配置/模式加 1 个越界反例，0 项目执行、0 安装。配置/limits 摘要保持，错误带来源；静态检查不验证动态输入或输出目录。

真实两路径收据 `.permsift/onboarding-validation-OTG7r1/verification.json`：bundle-kit 原构建命令与 smoke 条件，初始验证、源码变化后的 check、两次 observe，共 **4 次任务、0 新安装、0 搜索候选**。演示依赖此前单独准备；本轮未再次下载。1 份任务配置、1 份独立 limits，调整副本 project 及验收 repetitions=1/max_candidates=0/budget_seconds=120，0 命令包装，0 原任务命令修改。

实际初始准备与解释一致；新增输入 `@workspace/src/onboarding-input.ts` 被同次构建 metafile 和离线比较指出，旧 dist 写范围继续 compatible。原项目保持，删临时项目后采用记录与依赖查询/比较仍可读；usage 摘要不变。四个执行 CLI 各约 1.03–1.05 秒，只是本机样本，分项保留在 report.json，不能推导节省人工时间。

首次 live 脚本复制将 npm 相对内部 symlink 转成指向原树的外部链接，预检正确拒绝（0 次任务/安装），记录 `.permsift/onboarding-validation-OYlqmh/verification.json`。脚本修正为 verbatimSymlinks 后通过，未放宽快照限制。静态解释只解析 project、不扫描输入树，没有将该输入问题当成已验证。

两条入门、配置解释与 CI 复现步骤已完成；远端 CI、Linux/Node 22/另一台 macOS 和独立用户接入没有新增实际结果。共享声明按实际重复另行决定，长期维护与新用户收益仍待验证。复现见 [配置解释](configuration-explanation.md)。

## 第六轮：成功条件诊断 — 2026-10-03

本机 macOS 15.8 arm64 / Node 24.21.0 / npm 11.19.0 / SRT 0.0.77。最终单元/组件 **230/230**，完整真实沙箱集成 **80/80**；随后补强材料来源、完整对照及修复取样等反例，新增范围定向 **3/3** 通过，不重复累计。构建、类型、脚本语法及 Git 空白检查通过。日志 `.permsift/success-unit-delivery.log`、`success-integration-all.log`、`success-integration-final-repaired.log`。

新增 16 项单元/宿主反例和 1 项 CLI 检查：共用评价器分开缺失/无法读取/格式/语义原因，保存 Check 结构不变；合法 JSON 值修改、pointer 转义/根值/原型形状键，以及删文字拼接后重新形成标记的反例；JSON/JUnit 失败、预期项删除/改名、重复身份及非预期项的实际含义。JUnit 的嵌套计数、转义及 classname 保持。受控完整原生报告检验最终重复次数、所选方案/阶段、共享路径的个别/共同结果、字节/身份损坏、未修改对照失败、未保存和旧 JSON-only 记录。该组原生报告明确为合成，不能当作真实后端执行。

三个真实沙箱用例组验证：tighten 只保存第一轮最终方案产物、不保存初始基线/候选/恢复，清理项目和移动结果后可读；默认 run 不保存、check 使用兼容或修复方案的完整最终证明；observe 使用实际任务材料，真实本地 bundled npm 安装后的产物可诊断，保存目录被占用时原任务仍通过并明确 not_saved。第一次补充修复夹具从显式读模式切换到了旧模式，得到预期的“读取模式改变”不可比较结果；修正夹具保持模式一致后，权限补充及最终取样通过。前一次日志保留为 `success-integration-final.log`，不把它算作通过。

公开 CLI 故事 `.permsift/success-validation-bNoPHq/verification.json`：

| 案例 | 任务 / 新安装 / 候选 | 确认的行为 |
| --- | --- | --- |
| demo 原测试与构建 | 2 / 0 / 0 | 预期测试失败、删项、改名及重复被语义拒绝，空结构化报告因格式拒绝；受检 JSON 值改变被发现，单独保留文字可接受时明确说明范围 |
| JSON 与 JUnit 结构化夹具 | 1 / 0 / 0 | 非预期测试失败仍被发现，删除非预期项可继续接受；XML suite 计数与实际内容一致 |
| 固定 clsx 原始构建及 smoke | 1 / 0 / 0 | 五条存在检查接受空文件；仍说明原命令做了 8 项行为检查，本次未重跑这些检查，不能推断整个任务接受空产物 |

共 **4 次任务、0 次新安装、0 候选**；clsx 使用已准备依赖，准备开销未计入故事。固定上游提交 `925494cf31bcd97d3337aacd34e659e80cae7fe2`，原构建和命令未改。demo 保存 880 字节、复制分项约 2.34 ms，clsx 保存 1687 字节、约 3.02 ms；两次完整 CLI 诊断约 93 / 89 ms，含 Node 启动，不是普遍性能基准。最初收据把时间字段误命名为 saved_bytes，随后从原 sidecar 读回实际字节并纠正字段，无新执行；原日志保留。

最终代码对这三份已有结果经公开 CLI 再次离线诊断，限制 PATH 不提供外部命令，所有源文件内容哈希保持；0 任务/安装。记录在 `.permsift/success-validation-bNoPHq/delivery-offline.json`，对应 `*-delivery-diagnostic/`。demo 项目已删除，结果已移动；这些步骤不改原执行结论或采用基线。

历史模型、结果解释和来源离线回放通过，均 0 项目执行/安装：`.permsift/model-replay-kRQBx7/`、`result-replay-HaKgjl/`、`offline-usage-mW2i8A/`。工程验收证明已知事实能被准确解释；独立使用者改善检查、报告诚实性、任务内部测试、其他环境/Node 22/远端 CI 及人工分钟收益没有因此得到证明。预算与复现见 [成功条件诊断](success-diagnostics.md)。

## 第五轮后：内嵌依赖安装接入修复 — 2026-10-03

本机 macOS 15.8 arm64 / Node 24.21.0 / npm 11.19.0 / SRT 0.0.77。最终单元/组件 **213/213** 通过，新增 8 项内嵌归属/元数据/保存证明及 1 项安装诊断反例。完整真实沙箱集成 **77/77** 通过，新增 4 项用例组；末次诊断及示例整理后再次核对新增 4 项通过，不重复累计。构建、类型检查、脚本语法与 Git 空白检查通过。日志 `.permsift/bundled-unit-final.log`、`bundled-full-integration.log`、`bundled-integration-final.log`。

反例覆盖：孤立 inBundle、错误归属、缺父包 SRI、链接和异常路径、声明冲突、子包缺失/名称/版本不同、父包声明不同、超限/取消/超时，以及保存检查缺失、重复、错误名称或失败。真实 npm ci 在缺少声称的内嵌包时确实退出 0，工具的独立安装核对仍阻止任务；即使配置的文件存在断言通过，trial 也不能通过。父 tarball SRI 错误和未授权注册表继续被阻止；父/子 postinstall 不执行。

公共 CLI 证据 `.permsift/bundled-validation-3K5gyj/verification.json`：

| 案例 | 新安装 / 任务 | 结果 |
| --- | --- | --- |
| 本地父 tarball、作用域子包及内部提升的传递包 | 3 / 3，0 候选 | run → adopt → check → observe；每次只请求一个父 tarball，3 个实例均有模块加载记录，原项目未变，清理项目后仍能离线 inspect |
| glob-parent 5.1.2 固定提交及原锁 | 1 / 1，0 候选 | 137 个内嵌实例、1 个父包，共 138 项安装核对通过；518 个实际安装实例，193 个有模块记录；原 azure-pipelines 的 16 项测试全部通过且全部逐名检查 |

真实案例固定提交 `eb2c439de448c779b450472e591a2bc9e37e9668`，沿用此前被拒绝的锁；源码、测试和 package.json 改动为 0，未增加 reporter 参数或测试包装脚本。全流程单次约 **50.90 秒**，安装分项 **44.69 秒**，task **1.48 秒**；并行有开发测试，含网络/注册表开销，不能当作性能基准。新增 package.json 核对包含在安装分项，没有新增项目执行或权限候选。

首次新代码试用 `.permsift/bundled-validation-jF3jvZ/glob-parent/observe/` 的安装及 138 项核对已经通过，但 nyc 13 的 spawn-wrap 因 `@tmp` 创建权限被拒绝，原任务失败。最终新示例在独立 limits 已允许的范围内明确声明 `@tmp` 写权限，保持原工作区写声明和原命令；工具没有替用户自动扩权。两次真实试用合计 2 次冷安装/任务，不把失败轮隐藏成“首次成功”。更早旧代码的 0 次执行预检拒绝仍保存在原试用记录中。

旧模型、结果解释和离线来源回放通过，项目执行及安装数均为 0：`.permsift/model-replay-Y7Ezxh/`、`.permsift/result-replay-7QwRnd/`、`.permsift/offline-usage-yXGSj1/`。实际收益是解除这个已知接入障碍、保留真实命令并观察内嵌包；生命周期脚本、更多安装布局、其他机器/Node 22/远端 CI 与独立使用者收益仍未验证。复现及支持边界见 [内嵌依赖](bundled-dependencies.md)。

另外复制本次真实 run 的保存材料，在副本中分别删除、重复和改成失败的安装核对；实际 result / baseline 两个读回入口均拒绝这些“仍声称通过”的材料。恢复副本后保留验证记录 `.permsift/bundled-proof-UIx6mg/verification.json`，0 项目执行/安装，原报告未改动。

## v0.12 — 2026-10-02

全量单元/宿主组件 **135 项通过**，相关真实 macOS 观察/编译/打包集成 **16 项通过**，均 0 失败、0 跳过。末次读回边界整理后相关 **32 项组件测试通过**；不重复累计。日志 `.permsift/v0.12-unit-delivery.log`、`.permsift/v0.12-integration-delivery.log`、`.permsift/v0.12-reader-final.log`。构建、类型检查、脚本语法与 diff 检查通过；远端 CI 未执行。

新增 10 项单元/CLI 用例覆盖共享比较/渲染、已有输入不变与导出不覆盖、旧来源缺失/失败/未执行、作用域/嵌套及同版本不同实例、安装但无记录、来源不完整与明确 0、未保存清单/文件、损坏/重复/冲突身份/越界模块、32 MB/符号链接/目录/FIFO、CLI 参数/JSON/退出码和 Markdown 转义。既有真实观察比较用例同时校验离线与 observe --baseline 结果完全一致，不增加项目执行次数。129 个原生启动覆盖提示仍可导入，没有误用 issues 的 128 条上限截断覆盖说明。

### 默认离线回放

`npm run offline:verify` 的末次证据 `.permsift/offline-usage-ZinKBM/summary.json`，日志 `.permsift/v0.12-offline-delivery.log`。读取仓库中有来源说明的真实报告字段投影，检查 fast-glob 跨任务 glob-parent 记录、934 → 1560 字节升级比较、当前包记录、同报告比较和输入摘要不变。公开 CLI 在没有外部工具的 PATH 下完成；项目任务执行数 0，安装数 0。

### 新项目接入及升级

固定 glob-parent 6.0.2 上游提交 `26ce5ecec10c687cffb9891c108fb2d2800b9140`，源码、测试与 package.json 不变；保留 npm test（含原 pretest lint），追加 xunit reporter 两项诊断参数。新配置 82 行，独立 limits 17 行；锁文件仅生成元数据，宿主没有安装依赖。另配置两项 API smoke。

前后各执行两个任务，各冷安装一次，共 4 次任务 / 4 次真实沙箱安装。报告均 observed，每任务 435 个已安装实例；上游测试和 API 模块记录分别涉及 268 / 2 个包。两次 JUnit 均读回 **20 项通过测试**，明确预期名称列表覆盖其中 16 项，不声称逐名约束全部 20 项。Mocha 7.1.2 → 7.2.0 是锁文件唯一安装版本变化，模块比较只在 upstream-tests 列出该变化；API 模块增减及版本变化为空。配置、limits、环境和采集器摘要一致。离线 compare / inspect 读取完整原报告成功，未增加安装或任务执行。

完整观察流程前后 137.70 / 77.56 s，其中两任务安装分项合计 124.61 / 64.55 s；测试 task 2.54 / 2.46 s，API task 0.16 / 0.18 s。空缓存冷安装受网络影响，不能据此报告升级或观察提速。证据 `.permsift/native-pilot-Io8TQF/summary.json`、`comparison/comparison.md`、`mocha.md` 及 v6-before / v6-after 完整报告。

最初 glob-parent 5.1.2 的 nyc 13 包含内嵌依赖，锁中子条目缺少当前安装器要求的独立 URL / integrity，在任务前被拒绝，执行数 0；失败报告和锁保留，未放宽安装能力。配置成本、采用障碍和收益界限见 [使用检验](offline-pilot.md)，命令/状态见 [离线分析](offline-usage.md)。证明已有事实能集中查找和重复比较；没有外部用户人工时间或权限试验节省数据。

## v0.11 — 2026-10-02

单元/宿主组件 125 项、真实 macOS 沙箱 61 项不同用例通过，0 失败、0 跳过，合计 186。完整集成套件先通过 60 项；末次新增更窄规则的导出兼容检查，并复跑全部 6 项打包集成，因此不重复累计复跑。日志 `.permsift/v0.11-unit-delivery.log`、`.permsift/v0.11-integration.log`、`.permsift/v0.11-bundling-delivery.log`。构建、类型检查、脚本语法与文档链接检查通过；远端 CI 未运行。

新增 8 项单元/宿主用例验证来源配置、真实构建/模块关系、应用/间接/纯类型/代码移除/external/动态分块、0 字节记录、空格/Unicode 产物名、全文摘要身份、陈旧/未知/损坏/超大记录、链接/FIFO、输入/输出/边/链上限、部分执行、历史报告引用/聚合/链一致性、来源缺失和前后比较。新增 6 项真实集成验证单次构建、既有授权/边界/断网、变更引入链与版本、旧 metafile/分块不能替代新文件、失败保留部分记录、范围外输出不获得权限，以及普通较窄规则和导出配置不被未使用的观察设置阻断。

### 解释产物与一次真实升级

`npm run bundle:verify -- --real` 每个项目普通一次、观察一次、改动后观察一次，没有权限搜索。成功实测证据 `.permsift/bundle-inputs-NwlbFo/summary.json`，日志 `.permsift/v0.11-bundle-delivery.log`。早期直接打包旧 TypeScript 源码的尝试失败，记录在 `.permsift/v0.11-bundle-verification.log`；最终显式语法转换保留其 CommonJS 语义，不把构建兼容错误归因于权限。

| 项目 | 安装包实例 | Node 加载包 | metafile 输入文件 | 输入包实例 | 报告输出 |
| --- | --- | --- | --- | --- | --- |
| 受控应用样例 | 9 | 2 | 4 | 3 | 4（入口、延迟分块及两份 map） |
| 固定 fast-glob 源码的适配打包任务 | 20 | 2 | 73 | 17 | 2（JS 与 map） |

受控样例加载工具 esbuild 与 smoke 执行的 external-pkg；app-a、shared、lazy-pkg 的打包输入由独立来源记录。app-a 是纯转发输入，贡献为 0，shared 在主输出贡献 17 字节，lazy-pkg 在单独输出贡献 19 字节。type-only 和未使用的 dropped 不进入该次 metafile；不能由此判定可删除。替换 app-a → app-b 并改变 shared 元数据版本后，工具/外置加载集合保持、输入包和 shared 引入链变化，0 字节记录与“没有记录”保持区别。产物字节数不变，报告没有声称内容相同。

真实项目使用 fast-glob 3.3.3 固定提交 `48687898dd26d4e935a0e5ecf6720e7c5aeac15d` 的原样 src/fixtures/LICENSE，加最小锁定运行依赖与 TypeScript 4.9.5/esbuild 0.28.2 工具。先用 transpileModule 保留旧 CommonJS 导入及 ES2017 字段语义，再打包；不是类型检查或上游 npm run build，未重跑上游 246 项测试。同步/异步/流式产物 API 各核对固定 9 个文件，安装在沙箱内、任务断网。

来源链示例：`src/index.ts → src/utils/index.ts → src/utils/pattern.ts → glob-parent/index.js → is-glob/index.js → is-extglob/index.js`。glob-parent 从 5.1.2 升至 6.0.2 后，Node 加载工具仍是 esbuild/typescript；17 个打包输入包没有整组增减，版本变化准确落在 glob-parent。其 JS 贡献 **934 → 1560 字节**，整体 JS **195084 → 195710**、map **333614 → 334602** 字节，输出引用不变，三种 API smoke 继续通过。用户可以据此定位升级审阅范围，体积变化不能证明风险、必要性或因果解释。

| 项目 | 普通 / 观察任务耗时 | 普通 / 观察完整流程耗时 | 普通 / 观察安装阶段 |
| --- | --- | --- | --- |
| 受控样例 | 438.80 / 417.29 ms | 905.77 / 877.06 ms | 无安装 |
| fast-glob 适配任务 | 740.85 / 732.21 ms | 40.49 / 11.09 s | 38.52 / 9.09 s |

这些是单机顺序样本；冷安装分别使用空缓存，但注册表/网络耗时明显不同，不能据流程差异声称采集加速，也不能与原先 507 开发包的编译任务比较。开发验收额外运行普通对照，日常 observe 一任务一次，前后比较不重跑旧任务。证明了来源和一次升级影响可被解释；尚无外部用户人工时间或自动权限候选收益数据。

### 实际 CLI 与历史来源兼容

bundle-kit 使用新增 observe.yaml，读取 v0.9 模块报告作基线，退出 0，模块包没有变化；旧记录无打包来源，打包比较明确 unavailable，没有假报整组新增。证据 `.permsift/v0.11-cli-bundle/usage.json`，终端日志 `.permsift/v0.11-cli-bundle.stdout.log`。

fast-glob 使用公开冷安装配置及 --json，退出 0；stdout 是合法 usage JSON，2 个加载工具、73 个输入、17 个输入包、2 个输出均 captured。与相同基线的打包输入、版本、输出、贡献、链和 external 差异全部为空，来源条件无缺口；进度仅在 stderr。证据 `.permsift/v0.11-cli-real/usage.json`，日志 `.permsift/v0.11-cli-real.stdout.json`。最终导入校验读回上述报告及受控/真实变更的六份 usage；说明与范围见 [bundle-inputs.md](bundle-inputs.md)。

## v0.10 — 2026-10-02

单元/宿主组件 117 项、完整真实 macOS 沙箱集成 55 项通过，0 失败、0 跳过；末次编译解析/导入一致性修改后复跑全部 10 项观察与编译集成通过。合计 172 个不同用例，不重复累计复跑。构建、类型检查与 97 个文档本地链接检查通过；日志 `.permsift/v0.10-unit-delivery.log`、`.permsift/v0.10-integration.log`、`.permsift/v0.10-observation-delivery.log`。远端 CI 未运行。

新增 6 个单元/宿主组件用例覆盖：直接任务配置与拒绝的模式、真实 TypeScript 7.0.2 的类型专用/ambient 输入及编译产物 smoke、经典两空格与原生三空格解释、作用域/嵌套归属、缺输出/未知格式/截断/失败/时间与数量边界，以及 v0.9 基线兼容和包/文件/原因/版本对比。新增 4 个真实集成用例验证一次沙箱编译与 stdout 身份、产物/边界/写例外、类型引用与版本变化、陈旧文件不能替代缺失 stdout、可信输出上限停止任务。

### 解释真实任务中的类型输入

`npm run compile:verify -- --medium-baseline .permsift/fast-glob-profile-3chtEs/summary.json` 不搜索权限：小型受控夹具普通一次、观察一次、改类型引用后观察一次；固定 fast-glob 暖输入普通编译一次、观察编译一次。末次证据 `.permsift/compiler-inputs-hdWTUK/summary.json`，日志 `.permsift/v0.10-compile-delivery.log`。各来源独立健康度，不能将计数相加成“实际用包总数”。

| 项目 / 编译器 | 安装包实例 | 有 Node 模块加载记录的包 | 编译输入文件 | 编译输入包实例 | 编译来源 / 模块来源 |
| --- | --- | --- | --- | --- | --- |
| 受控类型夹具 / 7.0.2 | 5 | 1 | 66 | 3 | captured / incomplete |
| fast-glob / 4.9.5 | 507 | 1 | 216 | 25 | captured / captured |

fast-glob 的 25 个输入包包含 11 个 @types，及依赖自身提供的声明文件。`@types/micromatch/index.d.ts` 的解释包含从 `@workspace/src/utils/pattern.ts` 导入；`@types/node/index.d.ts` 包含由 `@nodelib/fs.macchiato/out/dirent.d.ts` 的类型引用引入。这补上原来只能看到 TypeScript JS 加载的缺口，不表示 216 个文件都进入了产物或具有必要读权限。示例任务仅直接编译，不执行 Mocha；v0.9 的 compile-test 验证仍保留。

夹具的 type-a/type-b JS 入口会抛错，但 source 仅 import type，编译产物 smoke 验证 answer({value:42})=42。改引用到 type-b 并将 @types/ambient-a 版本从 1.0.0 改为 2.0.0 后，模块加载包集合保持，编译来源准确报告 type-b 新出现、type-a 不再记录及 ambient 版本变化；不将编译输入视为执行模块。

本机 TypeScript 7.0.2 的 Node 包装层通过 execve 替换成原生编译器，66 个解释输入完整收到；Node 日志缺 footer。记录 execve 启动尝试与原生覆盖缺口，模块捕获与顶层保持 incomplete，不为“通过”降低日志完整性要求。类型专用声明和平台包标准库各按实际安装根归属。原始 stdout、实际命令、包版本、采集上限和摘要均保存。

### 成本与边界

末次固定 fast-glob 单任务全流程普通 12.38 s、观察 12.57 s；task 分项普通 944.64 ms、观察 940.76 ms，含后端启动/退出。受控夹具全流程 1.37 / 1.34 s、task 549.37 / 553.24 ms。每个观察任务仍只有一轮编译；输出解释没有启动第二次编译。单机顺序样本不构成普遍开销保证，也不能与 v0.9 的两个任务约 25 秒直接比较。

本次验证收益是解释类型输入和受控改动；尚未证明节省人工时间或降低权限搜索次数。诊断文本未知/损坏/超限保留部分记录并提示；无 stdout 不能解释为零输入，旧说明文件不会被读取。实际功能与局限见 [typescript-inputs.md](typescript-inputs.md)，产品取舍见 [value-and-scope.md](value-and-scope.md)。

实际 CLI 使用新的上游冷安装 observe.yaml、旧 v0.9 usage 基线执行一次，退出 0；产物、模块与编译来源均通过，仍为 216 个文件/25 个包。旧基线没有编译采集，比较记 unavailable，新增输入包计数为 0；不把能力新增当成项目依赖新增。证据 `.permsift/v0.10-cli-cold/`、`.permsift/v0.10-cli-cold.stdout.log` 和 stderr 日志。

实际 CLI --json 再用固定暖输入与上述 v0.10 冷报告比较，退出 0、stdout 为合法 dependency_usage JSON；编译包/文件/版本/解释变化均为 0，当前 usage 能由严格基线导入器读回。配置、安装条件和输入变化仍在公共 conditions/warnings 中保留，编译来源没有额外条件变化。证据 `.permsift/v0.10-cli-json/`、`.permsift/v0.10-cli-json.stdout.json`。

## v0.9 — 2026-10-02

新增依赖使用观察，不运行权限搜索。单元/宿主组件 111 项通过；真实 macOS 完整集成 50 项通过，新增失败后继续其他任务用例及末次观察采集修改后复跑全部 6 项观察集成通过，合计覆盖 51 个不同真实集成用例。0 失败、0 跳过。类型检查/构建通过；日志 `.permsift/v0.9-unit-delivery.log`、`.permsift/v0.9-integration.log`、`.permsift/v0.9-observation-delivery.log`。开发测试证明实现约定，测试总数不作为用户收益指标。

固定夹具核对 npm 提升/作用域/嵌套重复版本与锁中未安装的可选条目；CJS、ESM、Node 子进程和默认 worker 继承；稳定加载列表/解析关系；未用包不被观察；事件上限、文件上限、缺 footer、损坏/链接日志、非文件 URL 内容不被记录，以及前后版本/加载变化。真实集成核对每任务一次、产物与前后边界、任务日志目录写例外和预加载 denyWrite、无推荐配置、观察不能作为 check 基线、清空子进程观察环境的可见缺口、shell 任务 pass 与 unavailable 分开、失败任务继续其他场景、超时保存部分记录。

### 用户收益与覆盖的真实例子

`npm run observe:verify -- --medium-baseline .permsift/fast-glob-profile-tM7NH1/summary.json` 使用已有固定暖输入/种子，不重新搜索；每项目普通执行一次、观察两次。证据 `.permsift/dependency-usage-gYHkTJ/summary.json` 与各项目 usage.json，日志 `.permsift/v0.9-usage-verification.log`。

| 项目 / 配置任务 | 实际安装实例 | 包名去重 | 观察到模块加载的包实例 | 未观察到模块加载 | 收到记录的 Node 进程/线程 |
| --- | --- | --- | --- | --- | --- |
| bundle-kit / build | 2 | 2 | 1 | 1 | 1 |
| fast-glob / compile | 507 | 381 | 1 | 506 | 1 |
| fast-glob / compile-test | 507 | 381 | 97 | 410 | 3 |

两次观察的安装归属、加载包/文件与解析关系完全相同，输入摘要与普通执行相同；任务断言和边界均通过，范围内日志完整。fast-glob 的 compile 只观察到 TypeScript 的 JS 加载，compile-test 还观察到 Mocha 及本轮间接依赖；仍执行原 verify.cjs 的编译、精确 246 项测试和构建 API 断言。能解释 `glob-parent` 这条真实关系：`@workspace/out/utils/pattern.js → @workspace/node_modules/glob-parent/index.js`，而非仅提供 97 这个总数。

这些数字不表示编译只使用一个依赖，也不表示剩余 410/506 个包可删除：声明、资源和其他文件读取不由模块钩子覆盖。bundle-kit 观察到 esbuild 包装层的加载及原生二进制启动尝试；`@esbuild/darwin-arm64` 在未观察列表，却提供实际使用的二进制，报告明确列为覆盖盲区。bundle-kit 锁文件 27 个包位置，仅实际安装 2 个；未安装的平台记录不被算进已安装分母。fast-glob 本次 507 个锁位置均实际安装。

受控集成改动让原未加载的 unused 出现在观察列表，并把同安装位置 alpha 从 1.0.0 改为 2.0.0，前后对比分别显示新增观察和版本变化。没有自动删除依赖或转换成权限候选。

### 成本观察

| 配置任务 | 普通 task 分项 | 首次观察 task 分项 | 第二次观察 task 分项 |
| --- | --- | --- | --- |
| bundle-kit / build | 1116.34 ms | 2037.63 ms | 433.30 ms |
| fast-glob / compile | 954.77 ms | 930.32 ms | 940.06 ms |
| fast-glob / compile-test | 1237.23 ms | 1273.91 ms | 1241.05 ms |

两个 fast-glob 任务各执行一次的全流程：普通 24.57 s、观察 25.54 s、重复观察 24.89 s，包含独立的固定暖安装、副本、变化扫描、边界和清理。不是用 25 秒替代原 70 次权限搜索获得相同结论：观察只回答本次模块加载。bundle-kit 全流程 1.63 / 2.46 / 0.85 s；单次差异较大，不能据此承诺普遍低开销。task 分项含后端启动/退出；清单/日志收集另外计时，顺序与文件系统状态也影响成本。

本版收益验证落在来源解释、任务区别、受控变化发现和已知盲区；尚未量化外部用户的人工排查时间，也没有证明观察驱动收缩能大幅减少试验。CI 加入默认 bundle-kit 观察验证，远端未运行。具体范围见 [dependency-usage.md](dependency-usage.md)，取舍见 [value-and-scope.md](value-and-scope.md)。

实际 CLI 的 observe --json --baseline 已验证退出 0、stdout 为独立 dependency_usage JSON、同输入对比无新增/移除/版本变化；证据 `.permsift/v0.9-cli-observe/` 与 `.permsift/v0.9-cli-observe.stdout.json`。末次日志读回修正保留损坏尾行之前的有效记录，部分报告仍为 incomplete。

## v0.8 — 2026-10-02

单元/宿主组件 102 项、真实 macOS 沙箱 45 项，共 147 项通过，0 失败、0 跳过；npm run check 与 build 通过。新增历史摘要兼容、同大小内容修改及恢复时间戳、文件/目录权限、内部/外部/循环/悬空链接、大文件分块、空文件/目录、大小上限、取消/超时、异常类型、读取中增长拒绝/关闭与诊断聚合检查。源及副本两次完整三根核对均保留。日志：.permsift/v0.8-unit-delivery.log、.permsift/v0.8-integration.log；末次诊断计数修正后额外复跑全部分阶段测试，见 .permsift/v0.8-staged-delivery.log。测量跨 2026-10-01/02，版本交付日期为 2026-10-02。

### 有界扫描与暖安装诊断

诊断使用同一上轮 fast-glob 暖配置/固定种子，真实安装三次，编译、精确 246 项单元测试及构建 API 均通过。安装后、任务夹具/离线探针前的 workspace 哈希三次相同；cache 三次不同，变化为 npm 时间戳日志；tmp 三次不同，每次对比有 543 个 Node 编译缓存文件内容变化。不能据此声称“同源码/锁文件/缓存条件”等于整份安装状态相同，也不能把三次观察当成所有未来安装的保证。

在同一份完成任务的树上交替三组扫描，每次旧参考/并发 4/并发 8 的三根摘要都一致。中位数：

| 夹具 | 旧参考 | 并发 4 | 并发 8 |
| --- | --- | --- | --- |
| 256 个小文件、一个 2 MiB 文件及内部链接 | 23.73 ms | 12.64 ms | 11.55 ms |
| 实际工作区、缓存与临时目录三根 | 2511.15 ms | 1687.13 ms | 1484.57 ms |

本次已访问树的扫描中位数减少约 40.88%。第一组旧参考的三根墙钟约 2466.14 ms，其中 digest 同步更新约 106.45 ms（4.32%），realpath 约 728.55 ms、readFile 约 950.72 ms，另有属性/目录查询及编排。这支持优先改善 I/O 调度；新扫描的并行 service time 不可相加当墙钟。新文件打开后仍核对身份/模式/大小，内容逐字节读取，无缓存摘要或结构性校验替代。

该树处于已访问状态，且包含本轮任务产物，不是新克隆后首次扫描的严格成本模型。诊断开启额外安装观察扫描，不参与生产搜索时间对比。证据：.permsift/hash-benchmark-7O7H16/summary.json；方法见 [hash-validation.md](hash-validation.md)。

上述差异是在初始安装写权限 @workspace/@cache/@tmp 下观察的。补测同一冻结输入、已验证的安装规则（只写 @workspace/node_modules）三次，workspace/cache/tmp 的摘要全部相同，且与搜索捕获状态一致；每轮仍完成编译、246 项测试与构建 API。安装规则本身会影响日志/编译缓存能否生成，不能将初始宽规则下的差异套用到收紧后的规则。三次一致仍只是该条件下的观察。完整两组证据：.permsift/hash-benchmark-A8ftX0/summary.json；再次交替扫描的三根摘要全部一致，旧参考/并发 8 中位数约 2488 / 1498 ms。

### 相同 300 秒预算

固定 v0.7 提交 0b457b5 与当前 v0.8，顺序使用同一输入、种子、配置、平台、Node/npm/后端；两边候选上限均改为 200，时间上限均为 300 秒。共同前缀 19 个 trial 的阶段/四类权限/结论相同，最终各三次全新暖安装通过。

| 项目 | v0.7 | v0.8 |
| --- | --- | --- |
| 实际墙钟 | 297.67 s | 299.05 s |
| Trial / 候选 / 恢复 | 22 / 12 / 3 | 24 / 13 / 4 |
| verified / search_complete | verified / false | verified / false |

本次多完成一个候选及恢复，但最终权限没有变小：安装只写 node_modules、安装无网络、任务只写 out/reports、读取仍为 @workspace。读取搜索因预算停止，32 条规则/枚举限制未变化。因此不宣称速度等于更紧权限或搜索已完成。两轮实测时间不是同一秒停止，均保留最终验收；运行顺序及文件系统缓存会影响时间。证据：.permsift/search-budget-r4tOqc/summary.json；临时 v0.7 checkout 已删除。

### 与上轮相同候选的整轮对照

使用 v0.7 的同一冻结源码/种子/配置/limits，仍是 40 个候选、1800 秒上限。输入、后端环境、每一轮阶段/四类权限/结论、最终规则和 search_complete 全部一致。

| 项目 | v0.7 | v0.8 |
| --- | --- | --- |
| Trial / 候选 / 恢复 | 70 / 40 / 23 | 70 / 40 / 23 |
| 实际 npm / 快照复用 | 15 / 55 | 15 / 55 |
| 总时间（含清理，重放/check 另计） | 19.48 min | 15.66 min |
| 完整性哈希 | 448.60 s | 205.49 s |
| 克隆 | 271.27 s | 279.05 s |
| 变化清单 | 256.06 s | 260.01 s |
| 清理 | 53.37 s | 53.78 s |

总墙钟 1168747.00 → 939810.19 ms，减少 19.59%，约 3.82 分钟；hash 分项减少约 54.19%。完整核对仍是 112 批、336 次根扫描，实际读取约 19.11 GB（十进制累计，含重复读取），未完成扫描为 0；小文件缓冲峰值 8。克隆 198 次、清单 169 批和探针 224 次保持。扫描计算/I/O 的优化没有降低校验频率，也没有少跑失败后的恢复。

最终只写 out/reports，安装只写 node_modules，固定暖种子下无安装网络，任务读取仍为 7 个范围、包含整块 node_modules。status verified、search_complete false，仍受 40 个候选及读取表达/枚举限制。编译、246 项单元测试和 API/新产物断言保持。导出重放三次 verified，check 三次新安装 compatible；证据：.permsift/fast-glob-profile-tM7NH1/summary.json 与 comparison.json。

这是与上轮保存证据的单机顺序观察，不是同时受控运行的性能保证；扫描微基准的已访问状态与整轮克隆状态不同。相同配置和结论可核对，不能将 19.59% 外推为所有项目的收益。当前克隆和变化清单已经比内容哈希耗时更多，进一步收益应继续看全流程。

另用当前执行器直接导入 v0.7 的历史 verified 报告，三次完整暖安装返回 compatible，无新搜索。证据：.permsift/v0.8-historical-check/ 与 .permsift/v0.8-historical-check.log；不是只导入 v0.8 自身的新报告。

## v0.7 — 2026-10-01

单元/宿主组件 94 项、真实 macOS 沙箱 45 项，共 **139 项通过，0 失败、0 跳过**。npm run check 与 build 通过。真实测试新增检查逐轮清理、私有快照继续复用、两轮任务清单与完整安装清单保留、源/克隆双重核对，以及 unknown 安装耗时记录。日志：.permsift/v0.7-unit-delivery.log、.permsift/v0.7-integration-delivery.log。

### 固定中等规模项目

fast-glob 3.3.3 / commit `48687898dd26d4e935a0e5ecf6720e7c5aeac15d`，固定 507 项注册表依赖，检查项目源码、生成编译产物、运行全部 246 项单元测试，再验证同步/异步构建 API。冷运行结束时工作区含 16,608 个普通文件、1,620 个目录、35 个内部链接，文件内容约 117.6 MiB；npm 缓存约 22.7 MiB。工作区统计包含项目、依赖和本轮产物，不表示全是 node_modules，也不表示物理磁盘占用。

第一份冷基线在依赖声明类型检查处失败，记录在 .permsift/fast-glob-profile-uw1xSW/cold/，没有成为性能基线。适配脚本明确加入 --skipLibCheck，仍检查 src；上游 .npmrc 排除并提交固定锁文件。完整范围与配置成本见 [performance.md](performance.md)。

### 同条件优化前后

优化前保留 v0.6 的四轮变化清单/末尾集中清理路径，加入同口径计时；优化后为 v0.7。使用同一冻结输入、配置、固定缓存种子、limits、Node/npm/后端和平台。每一轮阶段、四类权限与结论、最终规则及搜索完成状态全部一致。

| 项目 | 优化前 | 优化后 |
| --- | --- | --- |
| 实际 trial / 候选 / 恢复 | 70 / 40 / 23 | 70 / 40 / 23 |
| 真实 npm / 安装状态复用 | 15 / 55 | 15 / 55 |
| 状态 / search_complete | verified / false | verified / false |
| 总时间（含副本清理，不含重放/check） | 28.67 分钟 | 19.48 分钟 |
| 变化清单 | 706.88 秒 | 256.06 秒 |
| 完整性哈希 | 441.59 秒 | 448.60 秒 |
| 克隆 | 282.37 秒 | 271.27 秒 |
| 副本清理 | 143.57 秒 | 53.37 秒 |
| 实际安装 | 29.69 秒 | 29.03 秒 |
| 任务命令 | 71.19 秒 | 68.03 秒 |
| 边界探针 | 42.43 秒 | 39.69 秒 |

本机顺序观察总耗时减少 32.06%，约 9.19 分钟。55 次快照任务的清单批次由 220 降为 110，清单耗时由 622.91 降为 185.09 秒。完整安装仍保留原清单，完整性哈希 112 个批次、克隆 198 次、边界检查 224 次均保持；默认副本逐轮删除，末尾清理改为 71 次分布清理，累计由 143.57 降至 53.37 秒。保留工作区模式继续保留所有轮次。

这些是单次本机观察，受文件系统缓存和后台负载影响。基线早期准备/安装阶段曾与一项小型集成测试短时重叠，快照任务阶段及优化后测量没有该项并发；总时间百分比不是严格受控的性能基准，也不外推为所有项目的速度保证。可核对消除的扫描次数、活跃副本上限和相同的权限/结论。

40 个候选上限耗尽，读取清单也 truncated，最终结果经过三次完整新安装验收，但未穷尽搜索；不声称依赖各包均已最小化。最终安装只写 @workspace/node_modules、使用固定暖种子且无网络；任务只写 @workspace/out 和 @workspace/reports，读取 fixtures、node_modules、out、package.json、src、tsconfig.json、verify.cjs。node_modules 仍作为一个读取范围，受到 32 条规则和完整目录替换要求限制。

最终代码还使用原始第三方项目从空缓存真实安装三次，状态 verified（约 70.34 秒，npm 执行 3 次，未复用安装状态）；精确 246 项单元测试及新构建断言均通过。证据为 .permsift/v0.7-medium-cold-delivery/，CLI 总时间与最大分项展示已实际运行。

优化前后各导出重放三次通过，冻结输入哈希与各自搜索相同；优化后 check 用三次新安装返回 compatible。优化后的导出重放约 36.30 秒；这与 19.48 分钟的首次搜索是不同的成本。

值得继续观察：这个项目的任务快照试验仍比单次固定暖缓存重新安装的完整试验昂贵，完整性哈希约 448.60 秒已成为最大分项。安装复用次数不能自动换算为省时；本轮保留固定安装状态的比较语义，不据此省略完整性校验或擅自切换搜索输入。

证据：优化前 .permsift/fast-glob-profile-3chtEs/summary.json；优化后 .permsift/fast-glob-profile-QZ1h0c/summary.json 与 comparison.json。该目录保留固定种子、配置、导出策略和各轮证据，临时工作区按各自选项清理。远端 GitHub Actions 未执行。

## v0.6 — 2026-10-01

本机环境同 v0.5：macOS 15.8 / arm64、Node 24.21.0、npm 11.19.0、SRT 0.0.77。显式分阶段模式分别执行安装写规则和任务读写；安装后快照只用于本次实验的任务候选，完整基线、安装候选、最终验证、run/check 继续真实安装。

### 公开 npm 分阶段流程

最终代码运行 `npm run stages:verify`，证据位于 `.permsift/staged-workflow-1oZDcF/summary.json`。

| 条件 | 状态 | Trial | 候选 | npm 执行 | 任务快照复用 | 搜索耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| 冷缓存搜索 | verified，complete=true | 60 | 33 | 23 | 37 | 77.349 s |
| 固定暖缓存搜索 | verified，complete=true | 55 | 32 | 15 | 40 | 51.051 s |

冷缓存安装写范围为 @workspace/node_modules 和 @cache/npm，域名仅 registry.npmjs.org；暖缓存安装只需 @workspace/node_modules，域名为空。两种任务写范围均为 @workspace/dist 和 @workspace/reports；读取只保留 verify.cjs、package.json 和 node_modules/clsx。真实任务及边界探针断网，没有继承安装依赖目录写规则。

冷/暖搜索各建立一份通过完整来源 trial 的安装快照。60 个冷试验中只有 23 次调用 npm，37 次任务候选/恢复从固定安装状态克隆；55 个暖试验中 15 次调用 npm，40 次复用。保留源安装及来源 trial、三根哈希和实际生效策略；复用记录不伪装成新的 npm 执行。

两种导出各从原始输入完整重新安装并重放 3 次，均 verified、输入哈希一致、复用次数 0；冷规则 check 为 compatible，3 次完整安装。搜索、重放与回归合计 124 个 trial（47 次 npm 执行、77 次任务快照复用）。这包含了比 v0.5 更多的读取和分阶段候选，运行范围不同；以上单次耗时不能当作与 v0.5 等价的加速基准。

冷输入 SHA-256：5a74e97176c1289834e99b3d34cfd739bffc56a8c13511d5156027f2912efe56。暖输入 SHA-256：27c3ced2972c4cfe59d3f956040472e950109d84e8b935dda841c3f461ef4df7。暖种子 SHA-256：b84293233753fbe28bf49e75166c995912ce82893e6d12d7a3817970ecd0f220。种子来自该次冷安装，两个缓存条件单独验证。

### 隔离、失效与回归证据

新增真实 macOS 测试覆盖：

- 安装可以写依赖，任务仅写产物；未使用包读取被撤销，独立副本原地修改和删除不会污染下一轮或原项目。
- 确实需要 node_modules/.cache 的任务只保留该小目录；撤销后失败、恢复通过，npm ci 后重新准备目录可完整重放。
- 任务开始读取另一已安装依赖后，check 提供经过完整重复验证的读取补充，并保持安装写策略。
- 快照任务候选成功、最终注册表停机时，实际安装为 unknown，最终验证不成立、没有 recommended.yaml。
- 历史生成文件/目录类型在当前安装后核对，类型变化不会把精确文件授权默默扩大。

组件测试覆盖完整输入/环境/缓存/规则/上限/准备对快照键的影响、未发布快照拒绝、内容和目录模式篡改拒绝、链接逃逸、取消与副本隔离，以及完整新安装证据的基线导入约束。

npm 夹具包含 tar 提取的 ._ 文件，完整性核对暴露 macOS cp 的丢项行为。已补齐此类数据，并用普通 ._ 文件和真实 npm 安装确认哈希一致。额外枚举后的 256 MiB 克隆对照中，普通复制 1718/958/760 ms，克隆 293/295/295 ms；中位数 958 → 295 ms，来源隔离检查全部通过。仍只测工作区创建，文件哈希和执行成本不在这项比较中；本机观察不证明物理块共享。新结果保存于 `.permsift/fork-benchmark-v0.6.json`，默认 fork-benchmark.json 是最近一次运行结果。

### 最终检查

`npm run check`、构建、93 项单元/组件与 45 项真实 macOS 集成测试全部通过，合计 138 项，0 失败、0 跳过。原有 40 项真实测试保留，包括共用写模式安装、读写搜索、网络故障、旧规则回归及中断。依赖枚举优先级仅用于新分阶段模式；最终调整后 10 项读取/快照定向检查通过。另导入 v0.3.1 第三方 clsx 历史基线，3 次 compatible，输入哈希未变，日志为 `.permsift/v0.6-historical-clsx.log`。

日志：`.permsift/v0.6-unit-delivery.log`、`.permsift/v0.6-integration-final.log`、`.permsift/v0.6-public-stages-delivery.log`、`.permsift/v0.6-fork-benchmark.log`。公开流程各子报告、暖种子和独立实验项目位于 staged-workflow-1oZDcF；记录留在 Git 忽略目录。

CI 已加入 stages:verify 并调整时间上限，远端 CI 尚未运行。分阶段配置、条件搜索和仍保留的读取范围见 [staged-permissions.md](staged-permissions.md)。

---

## v0.5 — 2026-09-30

环境为 macOS 15.8 / arm64、Node.js 24.21.0、npm 11.19.0、SRT 0.0.77、TypeScript 7.0.2。新增依赖安装仍复用这个固定后端，没有自行实现新的沙箱。

### 快照副本创建

运行 `node scripts/benchmark-forks.mjs`，使用 2,048 个模拟依赖文件及一个大文件，总逻辑大小 256 MiB，轮换先后顺序各测三次。旧 fs.cp 为 2,027 / 1,227 / 1,209 ms，macOS 克隆优先为 347 / 300 / 302 ms；中位数 1,227 → 302 ms，约减少 75.4%。每次创建后原地写大文件、删除 node_modules，源内容检查全部通过。

这只测创建副本，不含哈希、任务或清理，也不证明所有文件的物理块实际共享。独立 inode、模式、内部链接、跨轮修改/删除、嵌套/既有目标保护及取消另由文件组件测试覆盖。输入第一次冻结仍读内容；回归阶段克隆共同快照并核对相同哈希。

### 真实公开 npm 安装

`npm run install:verify` 在 `.permsift/install-workflow-g5Lwis/` 完成固定 clsx 2.1.1 的真实 HTTPS 下载、四项行为断言和产物验证。

| 阶段 | 状态 | Trial | 候选 | 最终安装域名 |
| --- | --- | --- | --- | --- |
| 冷缓存搜索 | verified，search_complete=true | 38 | 18 | registry.npmjs.org |
| 冷缓存独立重放 | verified | 3 | 0 | registry.npmjs.org |
| 旧规则回归 | compatible | 3 | 0 | registry.npmjs.org |
| 固定暖缓存搜索 | verified，search_complete=true | 32 | 16 | 无 |
| 暖缓存独立重放 | verified | 3 | 0 | 无 |

合计 79 个 trial。冷缓存最终写范围为 @workspace/node_modules、@workspace/dist、@workspace/reports 和 @cache/npm；暖缓存可进一步撤销缓存写授权。example.org 被实际撤销并通过；撤销下载主机时保留独立代理拒绝和成功恢复。每个真正的 task 生效域名列表为空，暖缓存安装命令带 --offline。两种独立重放分别与各自搜索的输入哈希一致，源项目没有产生 node_modules 或构建目录。

冷缓存输入 SHA-256 为 5a74e97176c1289834e99b3d34cfd739bffc56a8c13511d5156027f2912efe56。暖缓存包含固定种子，输入哈希不同，不将两者合并为相同条件。完整哈希和种子来源记录于 summary.json 及各阶段报告。

本机冷搜索约 91.1 秒，暖搜索约 41.3 秒，仅为一次观察，未包含各自重放和回归时间。每次都保留实际探针和安装；写时复制没有跳过冷下载。

后端私有 socket 目录清理接入后，又使用最终代码独立重放两种规则，各 3 次全部 verified，输入哈希仍相同。另导入 v0.3.1 固定提交第三方 clsx 的历史基线，3 次 compatible，输入哈希未变；旧读取范围和写授权保持有效。

### 代理清理与失败案例

公开 HTTPS 试验曾出现命令已退出、SRT reset 仍等待 CONNECT 半关闭连接的问题。未完成的报告已明确改记 incomplete，不作为基线。后端改为每次调用独立 worker，真实结果发送后清理最多等待 1 秒；父进程终止卡住的 worker、等待其退出并删除独立 socket 目录。命令结果缺失、超时、取消或清理错误仍为 unknown。

真实本地 CONNECT 夹具故意保留对端半连接，验证命令完成、forced 清理、管理目录消失以及下一次后端调用正常完成。另有 worker 组件测试覆盖正常退出、缺少结果、挂住清理和取消。

本地 npm 注册表真实测试覆盖：冷缓存实际下载、未授权主机拒绝与恢复、生命周期脚本未运行、安装后断网、暖缓存独立副本及注册表停机重放、锁文件不匹配与旧产物、5xx、瞬时故障恢复、新下载主机的对照/补充/重放，以及安装超时和取消。未知候选不会直接接受；后续条件变化可以通过新的真实试验再撤销。

### 留存与使用范围

最终 `npm run check`、构建、85 项单元/组件测试及 40 项真实 macOS 沙箱测试全部通过，合计 125 项，0 失败、0 跳过。日志为 `.permsift/v0.5-unit-delivery.log` 和 `.permsift/v0.5-integration-delivery.log`；包含全部既有读写、回归、预算、超时和中断用例。

- 早期副本对照值记录于上表；`.permsift/fork-benchmark.json` 为最近运行结果，会更新。
- `.permsift/install-workflow-g5Lwis/summary.json` 保存 79 次安装流程的汇总与各阶段入口。
- `.permsift/delivery-v0.5-install-cold-replay-final/`、`delivery-v0.5-install-warm-replay-final/` 保存最终代码复验。
- `.permsift/delivery-v0.5-historical-clsx-check/` 保存历史基线兼容复验。
- `.permsift/v0.5-install-worker-delivery.log` 保存完整公开演示输出。

报告、缓存种子与实验项目位于 Git 忽略目录。CI 已加入安装演示并调整时间上限；未将未运行的远端 CI 算作通过。安装场景暂时保留工作区读取、共用安装和后续命令的文件写策略，支持 npm 注册表 tarball；私有凭据、生命周期脚本、workspaces 和其他包管理器不在此次范围。见 [安装说明](dependency-install.md) 和 [快照工作区](snapshot-workspaces.md)。

## v0.4 — 2026-09-30

环境为 macOS 15.8、arm64、Node.js 24.21.0、SRT 0.0.77。新增 check 的回归编排，复用真实执行器和原有边界探针。

| 检查 | 本机实际结果 |
| --- | --- |
| npm test | 70 项通过，0 失败、0 跳过 |
| npm run test:integration | 32 项真实沙箱测试通过，0 失败、0 跳过 |
| npm run check / build | 成功 |
| npm run regression:prepare | 按锁文件安装真实 clsx 2.1.1，禁用生命周期脚本 |
| npm run regression:verify | 五种状态按预期分类，两份权限建议各独立重放 3 次，输入哈希相同 |
| 历史 clsx v0.3.1 规则 | 导入旧报告成功；3 次试验 compatible，输入哈希与旧报告一致，未做完整收缩 |

演示先对独立项目完成 27 个 trial 的初始收缩，得到 build.cjs、src/input.json 的读取与 dist 写权限，再修改该项目：

| 当前改动 | 任务结论 | check 的实际 trial | 修复候选 | 建议 |
| --- | --- | --- | --- | --- |
| 无改动 | compatible | 3 | 0 | 旧规则继续使用 |
| 不需要新增权限的代码改动 | compatible | 3 | 0 | 输入哈希变化，旧规则仍通过 |
| 新增 src/format.json 读取 | permission_change | 10 | 1 | 增加该文件精确读取 |
| 安装并使用 clsx 2.1.1 | permission_change | 14 | 3 | 增加项目 package.json、clsx/package.json 和 clsx/dist/clsx.js 的精确读取 |
| 普通代码错误 | unresolved_failure | 2 | 0 | 旧规则和宽规则都失败，无修复导出 |

10/14 个 trial 包含旧失败、宽对照、旧失败重新确认、宽规则恢复，以及候选和完整重复验证；独立建议重放的 3 次另计。新增读取、依赖两项共增加 6 个重放 trial，检查部分共 32 个 trial。演示总共 27 个初始收缩 + 32 个检查 + 6 个重放 trial。

两种 compatible 检查本机单次分别约 0.64/0.66 秒，源码新增读取约 2.09 秒，新增依赖约 3.10 秒，普通错误约 0.47 秒。以上检查耗时不含独立重放，仅为单次观察，不是性能基准。实际次数也受日志线索、任务及配置影响。

新增 13 项真实测试覆盖：旧规则复验、新文件读取、已安装依赖、普通任务失败、检查期间原项目变化、历史精确文件变成目录、候选预算、CLI JSON 与退出码、新写目录的统一准备复查、单纯预建目录引起的行为变化、多任务继续检查、超时和中断，以及历史读取包含预建输出目录时的兼容导入。旧 19 项真实沙箱测试也全部通过。

历史 clsx 检查继续使用 v0.3.1 的 .permsift/clsx-read-aHNMNf/search/report.json，保留同一组读写权限。源码快照不包含 dist，但旧报告记录的目录准备会在每轮创建它；没有将合法的预建输出读取误判为缺失源输入，也没有把旧文件授权扩大成目录。

本机交付证据：

- .permsift/regression-upgrades-DnyNdu/summary.json，以及各检查、初始收缩和独立重放报告。
- .permsift/delivery-v0.4-clsx-check-final/report.json、report.md 和 compatible.yaml。
- .permsift/v0.4-unit-final.log 与 .permsift/v0.4-integration-final.log。

报告与第三方安装副本留在忽略目录，未纳入 Git。使用步骤见 [回归检查](regression-checks.md)。CI 已加入依赖准备与回归演示，未把未运行的远端 CI 算作通过。此轮没有实现联网安装搜索或其他平台沙箱执行。

---

## v0.3.1 — 2026-09-30

环境仍为 macOS 15.8、arm64、Node.js 24.21.0、SRT 0.0.77。此轮只优化搜索调度，没有减少基线和最终重复次数、失败恢复或每次实际运行的前后边界检查。

| 检查 | 本机实际结果 |
| --- | --- |
| npm test | 60 项通过，0 失败、0 跳过 |
| npm run test:integration | 19 项真实沙箱测试通过，0 失败、0 跳过 |
| npm run check / build | 成功 |
| 读取演示 | 50 个搜索 trial，verified，search_complete=true；另重放 3 次，输入哈希相同 |
| 固定提交第三方 clsx | 89 个搜索 trial，verified，search_complete=true；另重放 3 次，输入哈希相同 |
| 原有三个代表项目 | 45 个搜索 trial + 9 个重放 trial，全通过，最终写规则与旧版相同 |

与 v0.3.0 的 clsx 报告比较：

| 指标 | v0.3.0 | v0.3.1 |
| --- | --- | --- |
| 搜索总 trial，含基线与最终验证 | 190 | 89 |
| 实际候选 | 105 | 49 |
| 失败后的恢复复测 | 76 | 31 |
| 基线、准备确认、最终验证 | 9 | 9 |
| 独立导出重放 | 3 | 3 |
| 搜索加重放耗时 | 66,442 ms | 30,833 ms |

减少 101 个 trial，约 53.2%。对比脚本确认输入快照、配置、limits、系统/Node/SRT 版本和最终读写权限一致，两次搜索均 verified 且 search_complete=true。耗时仅为本机各一次观察，包含重放，受系统负载和缓存影响，不是性能基准，也不保证其他项目同样加速。

最终 clsx 写权限仍只有 @workspace/dist；项目读取仍是 bin/index.js、dist、node_modules/source-map、node_modules/terser、package.json、src/index.js、src/lite.js。上游提交仍为 925494cf31bcd97d3337aacd34e659e80cae7fe2，构建及 smoke 范围与旧版相同，没有扩大验证范围。

clsx 实际执行 16 次读权限分组候选，读取搜索共 2 轮；5 次相同失败组合仅作为本轮拆分线索，单独关联旧证据，不计为新 trial。31 次实际候选失败各有通过的恢复，最终实验没有 unknown。依赖枚举仍 truncated=true，有限搜索完成不表示全局最小。

新增测试覆盖分组成功及失败拆分、关联权限共同撤销、权限变化后延后复查、候选预算、不稳定恢复、unknown 不作复用线索，以及最后一次修改之后已经完成比较时省略重复收尾轮。真实测试验证大量未用输入的批量收缩、必要文件在最终规则下重新撤销失败并恢复，及读→写→读连续变化仍触发复查。

读取演示的最终范围也与旧版相同，搜索从 70 个 trial 降到 50 个；原有 slug-kit、bundle-kit、cached-build 分别仍为 13、14、18 个 trial，小项目此轮没有减少次数。

最终源码的本机证据保存在忽略目录：

- .permsift/clsx-read-aHNMNf/summary.json、comparison.json，以及 search/replay 报告；比较基线是 .permsift/clsx-read-l8wpQh/summary.json。
- .permsift/delivery-v0.3.1-read-final/ 与 .permsift/delivery-v0.3.1-read-replay-final/。
- .permsift/representative-projects-ESgT7j/summary.json。

复现和比较命令见 [搜索效率](search-efficiency.md)。原始报告和第三方副本未纳入 Git；远端 CI 未作为本机通过项。

---

## v0.3 — 2026-09-30

环境为 macOS 15.8、arm64、Node.js 24.21.0、SRT 0.0.77。以下均为本机实际运行；未将远端 CI 算作通过。

| 检查 | 结果 |
| --- | --- |
| npm test | 49 项通过，0 失败、0 跳过 |
| npm run test:integration | 17 项真实沙箱测试通过，0 失败、0 跳过 |
| npm run check / build | 成功 |
| 读取演示 | 70 个 trial，verified，search_complete=true；另重放 3 次，输入哈希相同 |
| 固定提交第三方 clsx | 190 个搜索 trial，另重放 3 次，全部最终验证通过，search_complete=true，输入哈希相同 |
| 原有三个代表项目回归 | 45 个搜索 trial + 9 个重放 trial，全通过，写规则与 v0.2 相同 |

新增真实测试验证：目录逐级缩到必要文件，必要输入撤销后失败且恢复通过；写授权不隐含未授权文件读取；空读授权可执行仅使用内置模块的内联命令；读取变化影响可选缓存写入时会重新收缩写权限；不存在或符号链接读目标为 unknown；文件被任务替换为目录后，后置探针不会把精确授权扩大为子树授权。

| 任务 | 最终项目读取 | 最终可变写入 |
| --- | --- | --- |
| invoice 构建 + smoke | package.json、scripts/build.mjs、src/invoice.js、dist 目录 | dist 目录 |
| clsx 原始构建 + 五种产物 smoke | package.json、bin/index.js、src/index.js、src/lite.js、dist、node_modules/terser、node_modules/source-map | dist 目录 |

clsx 固定提交为 925494cf31bcd97d3337aacd34e659e80cae7fe2，版本 2.1.1。未修改上游构建源码，未运行完整上游测试套件。依赖安装在沙箱实验外完成；构建、产物行为断言及权限搜索断网运行。详见 [第三方验证说明](third-party-clsx.md)。

读取演示尝试 35 个读写候选，26 次拒绝各有通过的恢复；clsx 尝试 105 个候选，76 次拒绝各有通过的恢复。两次最终实验均没有 unknown。clsx 的依赖枚举深度限制在包目录，truncated=true；完成有限候选不表示得到全局最小策略。单次 clsx 搜索及重放约 66.4 秒，仅为本机观察，不是性能基准。

基线下项目内假文件按整目录授权可读，最终规则下根目录、src，以及 clsx 的 bin/test 假文件均得到 EPERM。这些假文件仅被禁止写入，没有添加 denyRead 例外。系统/运行时、缓存、临时读取和 cwd 目录访问仍固定，未参与最小化。

最终源码的完整本机证据：

- .permsift/delivery-v0.3-read-final/ 与 .permsift/delivery-v0.3-read-replay/。
- .permsift/clsx-read-l8wpQh/summary.json 及 search/report.md、replay/report.md。
- .permsift/representative-projects-Ocskux/summary.json。

原始 JSON 和下载的第三方副本留在忽略目录，未纳入 Git；可按 README 重跑。第一次较深的第三方探索用完 150 个候选预算，最终保留策略仍完成复验，但 search_complete=false；随后调整读取候选顺序与依赖枚举深度，最终版本完成有限搜索。

---

## v0.2 — 2026-09-30

环境仍为 macOS 15.8、arm64、Node.js 24.21.0、npm 11.19.0、SRT 0.0.77、TypeScript 7.0.2。JUnit 解析依赖 fast-xml-parser 5.11.2，包版本与锁文件均固定。

| 检查 | 本机实际结果 |
| --- | --- |
| npm ci --ignore-scripts | 成功；审计报告 0 个漏洞 |
| npm test | 44 项通过，0 失败、0 跳过 |
| npm run test:integration | 12 项真实 macOS 沙箱测试通过，0 失败、0 跳过 |
| npm run check | 成功 |
| doctor | 本轮独立任务、对照与前后边界检查通过 |
| 自动 demo | 28 个 trial，verified，search_complete=true；不填写手工候选 |
| 三个代表项目 | 45 个搜索 trial、9 个导出配置重放 trial，全部 verified |
| Permsift 自身构建 | 20 个 trial，verified，最终仅 @workspace/dist |

新覆盖的问题包括：跨基线观察合并、目录枚举上限与链接排除、候选数量约束、瞬时临时写入、JUnit 原生报告与跳过/旧报告、准备变化导致基线失败，以及写授权被删后仍需保留的预建目录能通过导出配置重放。

报告展示系统日志与 stderr 拒绝线索的不同来源、操作和路径，任务失败断言及恢复 verdict。普通命令失败、超时和退出零但断言失败分别解释，不将日志缺失当成访问不存在。

三个代表项目的配置均省略 narrower_candidates。slug-kit 场景文件 10 行，bundle-kit 与 cached-build 各 14 行，包含任务、初始授权和产物断言；这些行数只说明示例配置大小，不是人类准备成本的测量。

| 项目 | 搜索 trial | 最终可变写权限 | 必要授权撤销失败并恢复 |
| --- | --- | --- | --- |
| Node 原生测试 slug-kit | 13 | @workspace/reports | 1 次 |
| esbuild bundle-kit | 14 | @workspace/dist | 1 次 |
| TypeScript cached-build | 18 | @cache/typescript、@tmp/compiler、@workspace/dist | 3 次 |

这三项是可运行的代表项目，使用真实测试运行器和编译工具。安装依赖在实验外完成，任务全程断网、缓存每轮为空。依赖目录枚举因深度或路径格式限制出现 truncated 时，报告如实标记；search_complete 只描述有限候选已搜索完。

本机交付演示证据在 .permsift/delivery-v0.2-demo/，doctor 在 .permsift/delivery-v0.2-doctor/。代表项目通过 npm run examples:verify 生成独立报告及 summary.json；实测汇总位于本轮 representative-projects-* 目录。完整 JSON 和原始日志留在忽略目录，不纳入 Git；可以按 README 重跑。

本轮代表项目汇总为 .permsift/representative-projects-BMjjth/summary.json：搜索单次本机耗时分别约 3.6 秒、7.7 秒、19.8 秒，不含重放时间；这些是单次观察而非性能基准。导出配置均从干净状态重放 3 次，并核对冻结输入哈希一致。自构建证据为 .permsift/2026-09-30T07-38-14-235Z-9febc85e/，实际启动构建后的 CLI 并验证版本。

v0.2 尚未验证第三方生产项目长期升级、读取权限最小化、开放网络或其他操作系统。CI 已配置这些检查，但本地通过不等于远端 CI 已执行。

---

## v0.1 历史交付记录

日期：2026-09-30。以下是本地实际执行结果，未把尚未运行的 GitHub Actions 算作通过。

## 环境

| 项目 | 值 |
| --- | --- |
| Permsift | 0.1.0 |
| macOS | 15.8 |
| 架构 | arm64 / Apple Silicon |
| Node.js | 24.21.0 |
| npm | 11.19.0 |
| Sandbox Runtime | 0.0.77 |
| TypeScript | 7.0.2 |

## 执行结果

| 检查 | 结果 |
| --- | --- |
| npm ci --ignore-scripts | 成功，lockfile 可重装 |
| npm run build | 成功 |
| npm run check | 成功 |
| npm test | 31 项通过，0 失败、0 跳过 |
| npm run test:integration | 8 项通过，0 失败、0 跳过 |
| doctor | 真实任务和前后边界检查通过 |
| demo tighten | 20 个 trial 完成，verified，search_complete=true |

## 演示的实际策略变化

| 任务 | 初始可变写权限 | 最终可变写权限 |
| --- | --- | --- |
| test | @workspace、@cache | @workspace/reports |
| build | @workspace、@cache | @workspace/dist |

每个任务分别完成：

1. 初始策略从干净状态运行 3 次。
2. 将整个工作区写授权缩小到对应输出目录，通过。
3. 删除缓存写授权，通过。
4. 删除输出目录写授权，失败；恢复上一策略后通过。
5. 最终策略从干净状态运行 3 次。

两个任务合计 20 个 trial。每个正常 trial 都包括前后探针、宿主对照、任务执行和产物断言。固定基础权限仍存在，上表只描述参与搜索的写授权。

本机交付证据位于项目的 .permsift/delivery-demo/ 和 .permsift/delivery-doctor/。这些临时路径和原始日志未纳入 Git；其他机器可按 README 重新生成。

## 与验收目标的对应

| 验收问题 | 覆盖位置 |
| --- | --- |
| 收紧真实写范围，仍完成任务 | 示例演示、真实集成测试 |
| 必要授权撤销后失败，恢复后成功 | search 单元测试、真实集成测试 |
| 旧产物导致假通过 | 真实集成测试 |
| 跳过、缺失或重复测试用例 | assertions 单元测试 |
| 假敏感文件不存在 | probes 单元测试 |
| 网络端点停机 | probes 单元测试 |
| 链接越界 | filesystem 单元测试、真实输入快照集成测试 |
| 报告位置禁止写入 | 每次正常真实执行的 report_unwritable 探针 |
| 超时与普通后台子进程 | process 单元测试、真实超时集成测试 |
| 恢复配置也失败 | search 单元测试 |
| 重叠授权不夸大权限缩小 | search 单元测试 |
| 候选预算停止但最终验证完成 | 真实集成测试 |
| 总时间预算耗尽 | 真实集成测试 |
| 用户中断 | CLI 真实集成测试，退出码 130 |
| 导出配置可再次运行 | 真实集成测试 |

尚未实测 Linux 后端、其他 macOS 版本、网络放行、任意恶意项目、不同真实项目的长期升级行为。这些不属于本轮已完成能力。
