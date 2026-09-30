# 改代码、改依赖后的规则回归检查

v0.4 的 check 使用历史验证过的规则运行当前项目。旧规则通过就结束，不重新做完整权限收缩；失败时，在当前配置声明的较宽规则下做对照，再尝试有依据的权限补充。

## 最短使用流程

先保存一次完整的、verified 的实验报告：

```sh
npm run build
node dist/cli.js tighten \
  --config examples/demo/read-permsift.yaml \
  --limits examples/read-limits.json \
  --output .permsift/read-baseline
```

改动项目代码，或在实验之外更新锁文件、安装依赖后，执行：

```sh
node dist/cli.js check \
  --config examples/demo/read-permsift.yaml \
  --baseline .permsift/read-baseline/report.json \
  --limits examples/read-limits.json \
  --output .permsift/read-check
```

每次 output 必须是新目录。baseline 可以是 run 或 tighten 生成的 verified 报告；保留它旁边的 inputs.json 和 evidence/，不需要保留原运行副本。单独的 recommended.yaml 缺少历史哈希、文件类型及验证证据，不能充当 baseline。

config 使用当前项目路径、任务命令和成功断言。initial_write_grants、initial_read_grants 声明用于失败对照的较宽策略，必须覆盖旧策略，并通过独立 limits 的上限检查。可以继续使用第一次 tighten 的场景文件；只有窄权限的导出文件无法提供不同的宽对照。

## 输出怎么理解

| 单个任务 status | 含义 |
| --- | --- |
| compatible | 旧规则在当前输入和断言下完成配置要求的重复验证 |
| permission_change | 旧规则失败，宽对照通过，重新运行旧规则仍失败，宽规则恢复也通过 |
| unresolved_failure | 旧规则、宽规则都失败，尚不能确认由权限变化造成 |
| inconclusive | 超时、中断、边界异常、输入/类型异常，或对照结果不稳定 |

整个报告 status 为 compatible、regressed 或 inconclusive。有未知任务时优先为 inconclusive；全部 compatible 才返回成功。有任务失败时仍继续检查其他任务，除非整体预算或中断阻止后续运行。

| CLI 退出码 | 含义 |
| --- | --- |
| 0 | 所有任务的旧规则仍兼容 |
| 1 | 有回归需要审阅，包括已找到通过验证的权限建议 |
| 2 | 参数/基线错误，或实验无法判断 |
| 130 | 用户中断 |

补充建议验证通过仍退出 1，便于 CI 提醒审阅实际权限变化。permission_change 证据只支持本次比较，不是所有任务、环境下的因果证明。

## 失败后的有限修复

拒绝日志和 stderr 中的访问路径可以生成补充候选。CommonJS 的 Cannot find module 输出也可以提示已安装包目录，或工作区中存在的相对模块文件。它们都只是假设：路径必须合法、未经过符号链接，并处于当前对照策略和可信上限内。工具不执行宿主模块解析器，也不在检查中安装依赖。

候选先运行一次，通过后按 repetitions 完整复验。只有两阶段都通过才标记 suggestion.verified=true。候选失败或 unknown 后用已通过的宽策略恢复复测；恢复不通过就记为 inconclusive。出现新的拒绝路径时可继续补充，全部实际候选共用 max_candidates 预算。

读取补充支持精确文件和目录。写入补充先尝试更具体的目录；如果需要新预建目录，先在新的统一准备状态下重新运行旧规则和宽对照。若预建目录本身让旧规则通过，结果为 inconclusive，不把目录准备变化当作已证明的权限需求。

修复仅添加相对于旧范围的新授权，不重新最小化旧规则。建议可能包含包目录或父目录，不能称为全局最小策略。无法形成合法候选或用完候选预算时，保留 permission_change 和失败证据，但不导出未验证建议。

## 报告与采用建议

- report.json / report.md：任务结果、阶段证据链接、实际次数和权限建议。
- inputs.json：当前规范化配置、limits、冻结输入哈希和基线位置。
- tasks/<任务>/<阶段>/：各阶段的完整实验报告及原始证据。
- compatible.yaml：所有任务仍通过时导出旧权限与当前任务定义。
- suggested.yaml：每个任务都有通过验证的旧规则或修复时，导出完整配置供审阅。

建议不覆盖原配置和历史报告。审阅后，可以先重放它并保存新的基线：

```sh
node dist/cli.js run \
  --config .permsift/read-check/suggested.yaml \
  --limits examples/read-limits.json \
  --output .permsift/accepted-baseline
```

之后的 check 使用 accepted-baseline/report.json，同时继续提供经过审阅的宽对照场景文件。有 unresolved_failure、未知任务或未完成修复时，不导出整份 suggested.yaml；已验证的单任务建议仍可在 JSON 中审阅。

## 比较的一致性

一次 check 只冻结当前项目一次。所有阶段使用它的独立副本并核对哈希，因此检查期间继续编辑原项目不会改变正在进行的对照；之后重放建议会重新读取最新项目。

每次实际 trial 都保留前后边界探针、新产物断言、独立缓存与临时目录、进程清理。每次旧规则和宽规则比较使用相同的目录准备。写候选需要调整准备时，报告记录各阶段的 prepared_directories，并重新建立对照。

报告标记输入哈希、Node/SRT/平台/工具版本、limits、排除目录，以及任务命令、超时和断言的变化。compatible 只说明当前记录的环境和断言通过，不表示历史环境被复现。

基线导入校验 verified 状态、配置哈希、场景记录、通过的对应证据和精确读取类型。当前输入中原文件变成目录、原输入目标消失或经过符号链接时，不把旧文件授权扩大成新目录读取。记录为目录且会按统一准备列表预建的输出目录，可以在源码快照中不存在。任务 ID 增减或 explicit/legacy 模式变化需要建立新基线。

## 可重复的代码与依赖变更演示

```sh
# 实验外安装锁定的 clsx 2.1.1，禁用生命周期脚本
npm run regression:prepare
# 所有任务、检查、建议重放均在断网的真实沙箱中运行
npm run regression:verify
```

脚本在 .permsift/regression-upgrades-* 中建立独立副本，不修改 examples 的源文件。先生成窄规则，再依次验证：原输入、无新增权限的代码改动、新增 src/format.json 读取、安装并使用真实 clsx 依赖，以及普通代码错误。

新增读取和依赖的建议均独立重放，核对输入哈希一致；代码错误要求两种规则都失败且不产生修复。summary.json 保存每项次数、时间、新增范围和报告位置。时间为单次本机观察；实测结果见 [validation.md](validation.md)。
