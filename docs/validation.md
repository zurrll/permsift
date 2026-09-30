# MVP 实测记录

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
