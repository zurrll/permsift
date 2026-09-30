# 实测记录

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
