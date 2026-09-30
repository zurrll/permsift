# 实测记录

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
