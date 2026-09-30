# 配置参考

配置可以使用 JSON 或 YAML。schema_version 当前为 1，未知字段和 YAML 重复键会被拒绝。YAML alias 展开被禁止。

## 场景文件

```yaml
schema_version: 1
project: .
exclude: [.git, .permsift, dist, reports]
scenarios:
  - id: build
    command: [npm, run, build]
    timeout_seconds: 120
    initial_write_grants: ['@workspace', '@cache']
    narrower_candidates:
      - from: '@workspace'
        to: ['@workspace/dist']
    assertions:
      - type: file_contains
        path: '@workspace/dist/index.js'
        text: 'demo-version'
```

project 相对场景文件所在目录解析；也可以是绝对路径。导出配置使用原项目的绝对路径，在另一台机器上使用时需要修改。

exclude 是**顶层名称**列表，默认 `.git`、`.permsift`、`dist`、`reports`。不会按这个列表删除 node_modules 中的同名子目录。列表是整体替换；如果希望包含原有 dist 输入，应从列表去掉 dist，并确保输出断言不会把需要的输入删除。

快照包括已准备好的依赖。输入中的普通文件按字节复制，不与原项目共享可写硬链接。内部符号链接转换成指向副本内部的相对链接；指向项目外部的链接、祖先循环链接和特殊文件会被拒绝。

| 场景字段 | 约束 |
| --- | --- |
| id | 以小写字母开头，仅小写字母、数字和连字符，最长 64 字符，全局唯一 |
| command | 非空字符串参数数组，不接受 NUL；适配器负责 shell 引用 |
| timeout_seconds | 1–600 秒，默认 120；超时结果为 unknown |
| initial_write_grants | 最多 32 个目录授权，允许空数组；不得重复或超过 limits |
| narrower_candidates | 最多 32 组；to 必须是 from 的严格子路径 |
| assertions | 1–64 项产物断言；退出码为 0 是额外的固定条件 |

command 中的可执行程序由受控 PATH 查找，或使用明确的绝对路径。脚本应使用相对工作区路径，避免依赖原项目的绝对路径。

## 路径别名

| 别名 | 位置和初始状态 |
| --- | --- |
| @workspace | 本轮输入快照的副本，cwd 位于这里 |
| @cache | 本轮独立空缓存，设置为 XDG_CACHE_HOME，npm 缓存放在其中 |
| @tmp | 本轮独立临时目录，也是任务的 HOME 和 TMPDIR |

子路径的每个分量只允许字母、数字、下划线、点和连字符。拒绝 `.`、`..`、通配符、空分量、环境变量展开和绝对路径。授权目录及其祖先不能是符号链接；声明过的候选目录会在运行前创建，确保不同候选有相同的目录准备状态。

写授权不自动代表读取授权的优化。读取策略始终固定；删除写授权后，运行目录通常仍可读取。

## 成功断言

所有断言路径必须位于 @workspace 下，并指向文件。原有的同路径产物在每轮开始前从副本删除，父目录会创建。验证器拒绝符号链接、非普通文件，以及超过 1 MiB 的文件。

### 文件存在和内容

```yaml
assertions:
  - type: file_exists
    path: '@workspace/dist/index.js'
  - type: file_contains
    path: '@workspace/dist/index.js'
    text: 'expected marker'
```

file_exists 也受普通文件和大小限制。仅检查存在性通常不足以证明构建正确，建议结合内容或结构化输出。

### JSON 值

```yaml
assertions:
  - type: json_equals
    path: '@workspace/dist/manifest.json'
    pointer: /smoke_test
    value: passed
```

pointer 使用 JSON Pointer 路径形式；空字符串指整个值，`~1` 表示 `/`，`~0` 表示 `~`。支持对象属性和数组索引，不访问继承属性。比较保持类型，数字 1 不等于字符串 "1"。

### 测试用例结果

```yaml
assertions:
  - type: test_results
    path: '@workspace/reports/tests.json'
    expected_tests: [empty-cart, quantity]
```

被测任务应生成如下结构：

```json
{
  "tests": [
    { "name": "empty-cart", "status": "passed" },
    { "name": "quantity", "status": "passed" }
  ]
}
```

每个预期用例必须存在；不允许重复名称；报告中的所有用例必须 passed。failed、skipped、缺失或格式错误都导致断言失败。第一版只支持这个小型约定，不会自动识别 Jest/Vitest/JUnit 的原生报告格式。

项目自己的报告仍可能撒谎，因此第一版仅面向可信或审核过的任务。宿主验证器不执行项目提供的脚本，也不加载项目插件。

## 可信 limits

必须使用 `--limits FILE` 显式指定。演示文件位于 examples/limits.json；在自己的项目中，应选用自己审核过且被测任务无法修改的位置。

```json
{
  "schema_version": 1,
  "allowed_write_roots": ["@workspace", "@cache", "@tmp"],
  "max_candidates": 30,
  "budget_seconds": 900,
  "repetitions": 3,
  "max_output_bytes": 262144,
  "max_snapshot_bytes": 500000000
}
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| allowed_write_roots | 必填 | 可变写权限上限，包含其子目录；不控制后端固定设备权限 |
| max_candidates | 30 | 整个实验最多尝试的搜索候选，允许 0；基线、恢复和最终验证不计入 |
| budget_seconds | 900 | 实验时间预算，范围 1–7200 秒 |
| repetitions | 3 | 每个任务的基线和最终验证重复次数，范围 1–10 |
| max_output_bytes | 262144 | 每个进程 stdout 与 stderr 的合计原始字节限制，超出即停止 |
| max_snapshot_bytes | 500000000 | 输入普通文件的累计大小上限 |

时间预算在各阶段检查，并限制任务执行时限；文件复制、宿主验证及后端初始化不是可抢占操作，因此不是严格的总运行时间硬上限。搜索预留基于基线耗时估算的最终验证时间。预算耗尽时，只有确实完成最终验证的候选才能写为 recommended.yaml。

## 输出和重放

`--output` 指定一个尚不存在的目录。目录位于原项目内部时，必须处于 exclude 列出的顶层目录中，避免快照递归包含自身。

- report.json：机器可读汇总和证据索引。
- report.md：适合人工审阅的摘要。
- inputs.json：规范化配置、limits、版本和输入哈希。
- evidence/*.json：每次运行的任务、探针、断言和日志。
- recommended.yaml：当前策略通过完整验证时生成。
- unverified-candidate.yaml：失败、中断或最终验证未完成时生成，不应直接作为已验证配置采用。
- report-guard：只包含随机假数据，用来测试报告目录写入保护。

doctor 使用临时内置项目，只输出检查报告，不导出可重放策略。

推荐配置重放时会重新读取 project 指向的当前内容，并重新验证，不会自动恢复历史输入。默认清理完整输入快照，仅保留其哈希和运行证据；如需保存历史输入，使用 --keep-workspaces，报告 workspaces 下的 input/ 即冻结副本。保存该副本及工具锁文件后，可以将配置 project 指向它重新运行，并比较输入哈希和环境版本。
