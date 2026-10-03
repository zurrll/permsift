# 从第一轮开始的环境检验

第一轮已在本机运行最小完整流程，第二轮已完成共同底座的真实集成验证，并提供可在另一环境照做的脚本。第二台机器、实际目标 CI 和独立使用者的结果尚未取得；准备了流程不代表已跨环境通过。

## 换环境怎样复现

在 macOS、Node 22 或更新版本，以及带 npm 和系统 `/usr/bin/sandbox-exec` 的环境中，在仓库根目录运行：

```sh
npm ci --ignore-scripts
npm run environment:verify
npm run model:verify
npm run offline:verify
```

environment:verify 依次通过公共 CLI 执行 doctor、最小 demo tighten、保存报告的 inspect 与 compare。它核对演示最终写权限及已知依赖差异，按步骤记录耗时、环境、失败输出与结果，始终写入新目录，不覆盖旧记录。doctor/demo 无需下载额外依赖；仓库自身 npm ci 的接入成本另计。

仅检查离线流程，或在 Linux 上验证报告可移动性：

```sh
npm run environment:verify -- --offline-only
npm run model:verify
```

离线 inspect/compare 使用不可执行的 PATH，仍由 Node 的绝对路径启动。它们不运行项目、安装或沙箱。Linux 离线通过不能替代 macOS 后端验证。

复现后保存 `.permsift/environment-validation-*/summary.json`、对应 stdout/stderr 和 doctor/demo 的 report/evidence/executions；模型回放另存 model-replay summary。第一轮旧输出的前缀为 environment-round1。首次独立接入请同时记录：首次成功前所需步骤和时间、哪个结果难理解、遇到的问题、实际改动后是否能找到所需答案。当前没有收集到这种用户反馈。

## 本机结果：2026-10-02

环境：macOS 15.8，Darwin 24.6.0，arm64，Node v24.21.0，Sandbox Runtime 0.0.77，Permsift 0.12.0。

| 流程 | 结果 | 本次墙钟时间 |
| --- | --- | --- |
| doctor | verified，1 次沙箱 trial | 0.73 s |
| demo tighten | verified、search_complete；test 写 reports，build 写 dist；28 次 trial | 17.67 s |
| inspect 保存记录 | 两任务的 glob-parent 加载记录与既有事实一致 | 0.073 s |
| compare 保存记录 | 版本与产物贡献变化一致，934 → 1560 字节 | 0.066 s |

本次 29 次沙箱 trial、0 次依赖安装；query 时间包含 Node 启动，仅是一轮工程测量，不能当作稳定性能基准。验证时并行运行了全量单元/宿主测试，可能影响耗时。证据目录为 `.permsift/environment-round1-kqNZro/`，不会提交生成的运行目录。

同一份刚生成的 demo 及全部 sidecar 也通过模型适配：独立任务结果 26 pass、2 fail，28 次边界检查均通过，原 composite verdict 保持。材料位于 `.permsift/model-live-check-LdvUlS/`；这一步直接读取保存证据，新增任务执行与安装均为 0。复现脚本现在包含同样核对。单元/宿主测试共 152 项通过，其中新增 17 项模型测试；9 份新投影与 3 份既有观察样本回放、公开离线查询、类型检查也通过。

## 第二轮本机验证：2026-10-02

相同 macOS/Node/SRT 环境下，共同底座已接入普通任务、权限搜索、回归、安装复用和三种依赖观察来源。

| 验证 | 结果 |
| --- | --- |
| 类型检查与构建 | 通过 |
| 单元/宿主测试 | 166 项通过；新增 14 项请求、原生身份与事实、阶段判断及保存故障测试 |
| macOS 完整集成范围 | 62 项用例均已验证通过，包含新加的一次真实索引写入故障 |
| 原生模型与旧记录一致性 | 在已有运行中核对 UUID 索引、任务/约定/方案身份、任务与边界事实、实际命令及来源状态 |
| 改输入后的规则维护 | 旧规则失败、宽对照、确认、有限读取补充、完整验证和导出重放通过 |
| 安装与复用 | 冷/暖缓存、域名拒绝、5xx、超时/取消、独立克隆、六次根扫描、最后重新安装及重放通过 |
| 保存的模型与离线查询 | model:verify / offline:verify 通过，0 次项目任务与安装 |

首次全量集成运行为 59/62，通过的执行行为保留；3 项新增测试辅助核对把内存报告中的 undefined 传给只接受 JSON 的模型摘要函数，修正为核对保存后的 JSON。之后连同相关观察入口重跑 6 项真实用例全部通过，并覆盖前次未到达的安装重放/回归断言。测试 runner 另外将 3 个无匹配用例的文件算为通过，不能把显示的 9 当成 9 项真实用例。不重复已通过的整套注册表故障测试。最终报告投影整理后，再用普通收缩及导出重放用例核对兼容 sidecar。

公共 CLI 最小验证也通过：doctor 1 次、demo 28 次，共 29 次 trial、0 次依赖安装；全部原生模型及索引与旧适配结论一致。doctor 约 0.66 s、demo 约 16.92 s、inspect 约 0.073 s、compare 约 0.065 s。这是一轮工程测量，没有建立新的性能对照，不能据此声称重构加速或减少用户实验次数。

公共 CLI 证据位于 `.permsift/environment-validation-TYvxjC/`；离线回放为 `.permsift/model-replay-iHyhjl/` 和 `.permsift/offline-usage-Lrypa4/`。完整/补充测试日志及验证清单另存本机 `.permsift/round2-validation-*/`；生成记录不提交 Git。新增原生事实在执行时直接产生，旧 schema_version: 1 报告、导出和退出码保持兼容。保存失败可留下尚未登记的完整文件，本轮不提供自动恢复继续运行；边界见 [执行底座](execution-foundation.md)。

## 第三轮：结果解释与材料读取检验

2026-10-03，本机同一 macOS / Node 24 环境完成：

- 单元/宿主测试 **184/184**，新增 18 项结果反例/CLI 测试；类型检查、构建及 Git 空白检查通过。
- 受影响的真实沙箱用例 **7/7**：写权限收缩和导出重放、读取修复、空读取授权、正常依赖观察、版本/加载变化、非 Node 任务与不可用模块来源、真实索引保存故障。既有用例直接核对它们已产生的在线/离线概览，未为概览核对再执行 trial。
- 最后的公共 CLI doctor 运行 **1 次 trial，0 次安装**；原 --json 仍为实验报告，保存的 summary 与 inspect 重新生成的 JSON 相同。
- results:verify 回放权限修复与 glob-parent 升级故事，**0 次项目任务、0 次安装**，源样本不变；model:verify / offline:verify 同样通过。

最终日志与公共 CLI 记录位于本机 `.permsift/round3-validation-*/verification.json`；双故事回放为 `.permsift/result-replay-HbaAwI/verification.json`，兼容回放为 `.permsift/model-replay-5mgETr/`、`.permsift/offline-usage-jKyK5x/`。生成材料不提交 Git。真实用例最后一次运行约 14.86 s，单元测试约 12.38 s；这是本轮验证用时，不是产品加速或易用性对照。

本轮改变读取、解释和呈现，没有改安装器、沙箱隔离、复制或搜索算法；不重复上一轮已通过的整套注册表故障安装测试。新概览的内容、证据位置、缺口和保存故障处理见 [结果解释](result-explanations.md)。独立使用者是否更容易理解，以及其他主机上的实际 CI，仍无结果。

## 第四轮：固定保护目标检验

2026-10-03，同一本机 macOS 15.8 arm64 / Node 24.21.0 / SRT 0.0.77 环境完成：

- 单元/宿主测试 **194/194**，新增 10 项保护/原生格式反例；类型检查、构建和 Git 空白检查通过。
- 真实沙箱用例 **14/14**（13 项受影响流程及 1 项探针中断反例）：规则父/子例外、固定目标下搜索/恢复/导出/重放、目标缺失及类型改变、任务与约定冲突、可允许的精确读取修复、依赖观察、共用/分开安装及快照复用；同时核对既有写收缩、索引保存故障、空读取、读取修复和观察结果。
- 公共 CLI protection:verify 使用正常/无目标构建、冲突后的 check 和离线 inspect，**4 次任务执行、0 次安装**。任务失败而保护通过被分别显示；没有撤销约定的修复建议。离线读取使用没有执行程序的 PATH，保存摘要与重读结果一致。
- 最后一份小样例：有目标的流程约 **0.882 s**，无目标约 **0.530 s**；保护阶段的两次检查共 **0.329 s**，每次创建 **4 个假文件**。这是单次本机样例，不是性能基准或普遍用户收益。
- results:verify / model:verify / offline:verify 的旧记录回放通过，旧对象身份保持；保护原生事实使用明确 wire v2，未声明执行保留 v1。没有重跑未受影响的整套注册表故障测试，也没有声称完整集成套件全部重跑。

本机日志为 `.permsift/round4-unit.log`、`.permsift/round4-integration.log`、`.permsift/round4-probe-interruption.log`；公共故事为 `.permsift/protection-validation-prhALQ/verification.json`。规则组合原始反例另存 `.permsift/protection-feasibility/results.json`。旧回放材料为 `.permsift/result-replay-6O1CMr/`、`.permsift/model-replay-o7fDrW/`、`.permsift/offline-usage-UHyNcf/`。生成记录不提交 Git。首批只覆盖工作区内已有普通资源的离线任务直接操作；安装阶段、其他通道和恶意任务对抗不在保护目标验证范围。实现和重跑方法见 [保护目标](protection-goals.md)。

## 未验证范围与下一次需要反馈的事

| 范围 | 当前状态 | 后续怎样补 |
| --- | --- | --- |
| 另一台受支持 macOS、不同 Node/安装路径 | 未验证；本地只有一个 Node 24 安装 | 在另一环境运行上面的最小流程，检查能力、路径及证据解释 |
| 仓库目标 CI | 配置已加入 Node 22/24 的离线回放和 macOS 最小流程；尚无此次实际 CI 结果 | 仓库当前没有 Git remote；具备运行条件后保存真实 job 与产物，不把配置当结果 |
| 未参与开发的使用者接入 | 未验证；没有独立使用记录 | 照文档首次接入，并反馈理解和配置成本 |
| 共同执行底座迁移后完整验证 | 本机已完成，见上面的第二轮记录 | 后续新增执行行为继续覆盖受影响流程；跨环境复现仍需实际结果 |

这些缺口现在登记并持续跟进。第一轮能够完成的模型、样本与本机工作照常交付；跨环境结果会反过来修正模型和第二轮接口。

## 第五轮本机检验（2026-10-03）

同一 macOS 15.8 arm64 / Node 24.21.0 / npm 11.19.0 / SRT 0.0.77 环境：

- 单元/组件 **204/204** 通过，新增 10 项采用、完整性与约定反例；构建、类型检查和 Git 空白检查通过。
- 相关真实沙箱 **23/23**（维护、原回归、保护目标三组），维护 3 项在最终条件/证据读取实现下另行复核通过。没有宣称全部安装、采集或清理集成套件重新运行。
- 公共 CLI 故事 `.permsift/maintenance-validation-fNdENI/verification.json`：9 次任务、0 安装；3 次显式采用均不执行任务，修复通过不改变当前选择；删成功检查和目标后顶层要求审阅；清理来源、移动存储并删除项目后仍能离线解释。采用与 inspect 使用无可执行 PATH。
- 大型复用 `.permsift/maintenance-validation-rATuif/verification.json`：fast-glob 固定 507 包样例复用既有 70 次/939.8 秒搜索的基线；采用保存 5 个 JSON、11,487,458 字节，约 0.68 秒，0 任务/安装。当前输入摘要相同，3 次全新安装及编译/246 项测试/产物检查通过，0 搜索候选，约 38.2 秒。单机历史与当前观察，不是同条件速度比较。
- 旧结果/模型/离线来源回放仍通过：`.permsift/result-replay-nUEdzS/`、`.permsift/model-replay-zrGJze/`、`.permsift/offline-usage-8SJxpt/`，没有重新执行这些样例项目。

实际发现大型搜索全部 sidecar 先占满原读取预算，最终证据未被读到；采用入口定向读取完整最终验证，预算和失败/未知纪律保持。声明准备目录与自动推导的执行准备分别保存和核对，后者不被误报成用户更改约定。

工程验收：通过上述实际检验。时间维度：几个月持续维护的收益未验证。使用者理解：未取得独立反馈；保护检查仍只覆盖声明的任务阶段直接操作。Node 22、另一台机器和实际 CI 结果也仍缺失；加入 CI 步骤仅表示准备了复现入口。

## 第五轮后安装接入修复（2026-10-03）

相同本机环境，最终 213 项单元/组件、77 项完整真实集成通过；末次诊断调整后新增 4 项再核对通过。`bundled:verify` 的本地公共 CLI 完成 3 次安装/任务、显式采用和清理项目后的离线读取。原失败的 glob-parent 5.1.2 / nyc 13 内嵌依赖案例现在完成 138 项安装核对、原 16 项测试和依赖观察；最终 1 次冷安装/任务、0 候选。前一次新代码试用因任务未获临时目录写权限而失败，最终示例明确配置 limits 允许的 `@tmp`，没有改上游源码或命令。证据 `.permsift/bundled-validation-3K5gyj/verification.json`，详细成本、失败轮和限制见 [验证记录](validation.md)。

纯历史模型、结果和离线回放仍通过；未扩大“跨环境已验证”的范围。另机可以运行默认 `npm run bundled:verify` 复现本地安装故事。

## 第六轮本机检验（2026-10-03）

成功条件诊断的共用验收逻辑通过完整 80 项真实沙箱回归；末次新增范围的三个用例组另确认修复方案取样、实际 observe/bundled 安装材料及可选保存失败独立。单元/组件 230 项通过。公开 CLI 故事使用 demo、固定 clsx 与结构化夹具，4 次任务、0 新安装/候选；项目清理和结果移动后仍可诊断。保存材料及具体成功条件的能力分别解释，无整体质量分数。

Linux/Node 22/另一台 macOS/远端 CI 没有新增实际执行结果，不能将 CI 中增加 success:verify 写成跨环境通过；独立使用者收益仍未验证。复现和限定见 [成功条件诊断](success-diagnostics.md)，日志及收据见 [验证记录](validation.md)。
