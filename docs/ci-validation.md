# CI 覆盖、分组与成本

2026-10-05。[分层前的 CI](https://github.com/zurrll/permsift/actions/runs/37264186143) 中，macOS 的 278 项单元、82 项集成和全部场景通过，作业耗时 1,450 秒。完整集成占 764 秒；安装两组共约 389 秒，其余约 371 秒。Linux Node 24 的唯一失败是将单机压缩比例写成跨平台门槛；Node 22 作业取消，没有完整通过结论。

重复路径案例现在先核对完整路径、解析边、包归属等还原结果，再检查该事件流的紧凑表示确实更小。47.8% 是原 macOS 样本；Linux 样本约 44%，不作为通用正确性门槛。

## 默认回归

[ci.yml](../.github/workflows/ci.yml) 的每次 push / pull_request 保留 Linux 检查。仅明确的纯文档变更省去两组 macOS；代码、配置、测试、未知文件和无法确定比较范围时，仍跑完整真实回归：

| 作业 | 范围 |
| --- | --- |
| changes | 读取整个 push 的 before → after diff，或 PR 的 merge-base → head diff；仅 README.md、CHANGELOG.md、LICENSE / LICENSE.md 和 docs 下 Markdown 白名单省去 macOS |
| unit (22)、unit (24) | 完整单元/组件、类型检查、offline/model/results 回放、离线环境检查和静态 onboarding |
| sandbox-core | macOS 完整单元；除下面两文件外的全部集成；doctor；本地注册表的 bundled 公共 CLI 流程 |
| sandbox-install | install.test.js、staged-install.test.js 的全部集成，含真实冷/暖安装、网络拒绝、恢复、快照隔离与最终新安装 |
| sandbox | 保留原检查名称；需要沙箱时两组均须通过。只有分类成功且明确为纯文档、两组均按预期 skipped 才接受文档路径，并明确输出未执行沙箱 |

分组来自 [ci-suites.mjs](../scripts/ci-suites.mjs)。所有编译后的集成文件恰好分到一组，新文件默认进入 core；缺少指定安装文件或清单异常会失败。没有改 repetitions、任务断言、探针、恢复或清理。两组运行在不同机器，组内仍串行，避免在同一主机上引入沙箱/注册表并行干扰。

改动识别由 [ci-changes.mjs](../scripts/ci-changes.mjs) 完成，checkout 保留可比较的完整历史。禁用 rename 合并，两侧路径均纳入判断；多个提交中的早期代码变更也不能被最后一次文档变更盖掉。首次 push、空/超大清单、未知事件、缺比较提交或读取异常回退到完整回归。分类作业失败时汇总失败，不能当作纯文档。有限反例使用真实临时 Git 分支/diff，并执行工作流中的实际汇总脚本检查失败、取消和缺执行。

同一工作流与分支/PR 使用 concurrency 组，新提交取消尚未完成的旧默认运行。手动场景使用独立工作流，不被默认 push 取代。当前没有实现 push/PR 去重、复杂用例选择器或存储调度；用户明确只做简单 CI 调整。Linux 单元/类型/离线检查仍在文档路径运行。

Node 矩阵关闭 fail-fast，一组失败时另一组仍有机会给出自己的结果。行为依据见 [GitHub 工作流语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstrategyfail-fast)。作业取消与成功保持区别。

本机仍可跑全套，或选择一组：

```sh
npm run test:integration
npm run test:integration:core
npm run test:integration:install
# 已构建时只列出范围，零任务执行
node scripts/run-integration.mjs all --list
```

## 原场景迁移清单

以下原步骤都保留，公开 CLI 的故事与内部接口集成分别记录；不把覆盖相似写成严格冗余。

| 原 macOS 步骤 | 当前入口 | 独立检查或条件 |
| --- | --- | --- |
| npm test / test:integration | 默认 core / 两组集成 | 全部原用例和测试参数保留 |
| model:verify | 默认 Linux 22/24 | 原保存材料、身份及迁移回放；原 macOS 重复调用移除 |
| bundled:verify | 默认 core | 公共 CLI run → adopt → check → observe → 离线 inspect；三次本地注册表新安装，零搜索 |
| environment:verify | 手动 local；默认另有 doctor 和 offline-only | 完整 demo 收缩及原生/旧模型核对保留在 local |
| maintenance:verify | 手动 local | 多次采用、修复、约定审阅、存储移动和源报告删除后的 CLI 故事 |
| success:verify | 手动 local | 保存产物与离线扰动诊断的 CLI 故事；--with-clsx 仍为原有可选入口 |
| protection:verify | 手动 local | 有/无保护目标与改动冲突的公共 CLI 对照 |
| demo:read | 手动 local | 原配置读取收缩、恢复和最终方案 |
| examples:prepare | 手动 projects 第一项 | 原锁定依赖准备，不改安装参数 |
| onboarding:verify -- --live | 手动 projects | 原 bundle-kit 接入、采用、源码改动复验、离线比较 |
| observe:verify | 手动 projects | 普通一次、观察两次的固定任务对照 |
| compile:verify | 手动 projects | 编译输入及受控改动；原可选大型基线参数仍可本机调用 |
| bundle:verify | 手动 projects | 默认夹具打包来源及受控改动；--real 仍为原有可选入口 |
| examples:verify / self:verify | 手动 projects | 三代表项目及 Permsift 自身构建的原方案验收 |
| third-party:prepare / third-party:verify | 手动 upstream | 固定 clsx 上游项目准备、收缩及验证 |
| regression:prepare / regression:verify | 手动 upstream，保持准备顺序 | 原源码/依赖变化与普通代码错误的复验故事 |
| install:verify / stages:verify | 手动 install | 公开注册表的原冷/暖安装、阶段权限搜索及复验 |
| medium、其他已有手动工作流 | 原入口不变 | 不扩大本轮触发范围 |

[scenarios.yml](../.github/workflows/scenarios.yml) 可在 Actions 中手动选择 all、local、projects、upstream 或 install；all 分为四个独立作业。每组完整保持原命令与依赖准备顺序；组内遇到失败就停止并保留原退出码，组间不因 fail-fast 取消。未知选择在执行任务前拒绝。

```sh
# 本机等价入口，需先 npm run build；会真正执行所选场景
node scripts/run-ci-scenarios.mjs local
node scripts/run-ci-scenarios.mjs all
```

发行前运行默认回归与适用的扩展组；实验底座、安装、搜索或保存语义大改时运行 all。仅默认回归绿色不表示这些扩展案例本次也已验证。

## 保存与判断成本

两个 runner 在 `.permsift/ci-*/verification.json` 保存选择范围、实际命令、退出码/信号和命令耗时；失败或中断不能由收据变成通过。命令开始后 runner 被强制杀死时可能只留下 running，不能当成完成。任务/安装/探针次数继续以各原执行报告为准，不能从测试项数或 npm 命令数换算。

runner 自身收到 SIGINT/SIGTERM 时另存 interruption_requested；即使子命令捕获信号后退出 0，验证仍为 interrupted 并停止后续命令，原始子命令退出码保留。

各作业始终尝试上传独立命名的 `.permsift/` 材料，CI 控制台保留测试日志。分组校验、准备顺序和失败/信号传播有固定反例；YAML 与所引用 npm 脚本另作静态核对。

并行主要缩短等待，通常不减少集成本身的执行总量，另有第二个 macOS 作业的启动/安装成本。扩展场景独立触发会降低每次日常提交执行的范围；需要完整验收时成本仍存在。新旧速度不能仅从上述单次计时推算，实际远端结果需另行核对。

## 简单路由与 v6 的远端收据

### 0.13.0 默认展示与交付整理

2026-10-05，代码提交 4b11e47 的 [完整 CI](https://github.com/zurrll/permsift/actions/runs/37316285582) 全部通过。Linux Node 22/24 和 macOS 各完成 300 个单元/组件用例；core 的 70 个集成与 install 的 13 个集成全部通过，0 失败、0 跳过。类型检查、既有离线回放、doctor 与 bundled 公共 CLI 流程均通过。新增 8 个展示反例未增加集成场景，权限候选、恢复与最终验证策略不变。

API 作业时间：changes 8 秒、unit (22) 48 秒、unit (24) 52 秒、sandbox-install 483 秒、sandbox-core 505 秒、sandbox 汇总 2 秒。合计是作业时间，不是用户等待时间或账单；本次不据此声称性能提升。此前 ddb3ddf 的 [运行](https://github.com/zurrll/permsift/actions/runs/37315950784) 被补充观察流程完成条件的提交取代并取消，不算完整通过。收据补写只改变文档，后续文档提交的路由结果以其 Actions 为准。

### v6 预算与简单 CI 路由

2026-10-05，代码提交 213f8b0 的 [完整代码路径 CI](https://github.com/zurrll/permsift/actions/runs/37305934821) 全部通过。Linux Node 22/24 各完成 292 项单元/组件、类型及既有离线检查；macOS core 完成 292 项单元、70 项集成、doctor 和 bundled 公共 CLI；install 完成 13 项集成。集成合计 83，0 失败、0 跳过；原 82 保留，新增一项加载/解析压力验证。changes 选择完整沙箱，sandbox 汇总成功。

| 作业 | 实际秒数 | 结果 |
| --- | ---: | --- |
| unit (24) | 46 | 通过 |
| unit (22) | 49 | 通过 |
| changes | 6 | 通过，选择完整沙箱 |
| sandbox-install | 374 | 13 项集成通过 |
| sandbox-core | 517 | 70 项集成及公共 CLI 通过 |
| sandbox | 2 | 两组成功汇总 |

从 created_at 至 updated_at 为 546 秒（9 分 6 秒）；各 job started_at 至 completed_at 相加为 994 秒（16 分 34 秒）。这包含安装、上传等流程耗时，不是付费分钟或同条件性能比较。

首轮 115566a 的 [运行](https://github.com/zurrll/permsift/actions/runs/37305064681) 在 Node 22 暴露新增压力夹具未产生预期事件的问题；Node 24 单元和安装分组已通过。夹具改用两个版本均能记录的真实 require 请求，目标和资源上限不变。本机 Node 22/24 的 7 项预算用例及修正后的沙箱压力用例通过，随后由上述完整 CI 验证。213f8b0 的 push 自动取消了旧运行尚未完成的部分，实际确认 concurrency 生效；旧取消部分不算通过。

本收据与兼容说明的纯文档提交用于验证文档路径：预期继续运行 Linux Node 22/24，两个 macOS 作业按分类 skipped，sandbox 明确说明未执行真实沙箱后接受文档路径。它只记录已有结果，不改变执行代码；实际运行状态可从该提交的 Actions 检查读取。
