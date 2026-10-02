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

## 未验证范围与下一次需要反馈的事

| 范围 | 当前状态 | 后续怎样补 |
| --- | --- | --- |
| 另一台受支持 macOS、不同 Node/安装路径 | 未验证；本地只有一个 Node 24 安装 | 在另一环境运行上面的最小流程，检查能力、路径及证据解释 |
| 仓库目标 CI | 配置已加入 Node 22/24 的离线回放和 macOS 最小流程；尚无此次实际 CI 结果 | 仓库当前没有 Git remote；具备运行条件后保存真实 job 与产物，不把配置当结果 |
| 未参与开发的使用者接入 | 未验证；没有独立使用记录 | 照文档首次接入，并反馈理解和配置成本 |
| 共同执行底座迁移后完整验证 | 本机已完成，见上面的第二轮记录 | 后续新增执行行为继续覆盖受影响流程；跨环境复现仍需实际结果 |

这些缺口现在登记并持续跟进。第一轮能够完成的模型、样本与本机工作照常交付；跨环境结果会反过来修正模型和第二轮接口。
