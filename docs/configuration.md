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

普通场景快照包括已准备好的依赖；install 场景必须显式排除顶层 node_modules，并在沙箱中安装。输入冻结后，各轮优先创建写时复制副本，不与原项目共享可写硬链接。内部符号链接转换成指向副本内部的相对链接；指向项目外部的链接、祖先循环链接和特殊文件会被拒绝。

| 场景字段 | 约束 |
| --- | --- |
| id | 以小写字母开头，仅小写字母、数字和连字符，最长 64 字符，全局唯一 |
| command | 非空字符串参数数组，不接受 NUL；适配器负责 shell 引用 |
| timeout_seconds | 1–600 秒，默认 120；超时结果为 unknown |
| initial_write_grants | 最多 32 个目录授权，允许空数组；不得重复或超过 limits |
| initial_read_grants | 可选，最多 32 个 @workspace 文件或目录授权；省略时工作区可读，空数组不授予项目文件内容读取 |
| install | 可选 npm 安装前置阶段；manager: npm，cache: cold/warm，registry 默认 https://registry.npmjs.org/，暖缓存须声明 cache_seed |
| initial_network_grants | 仅用于 install，最多 32 个精确小写域名；省略或空数组时安装断网，须处于独立可信上限；command 始终断网 |
| auto_read_discover | 默认 true；显式读取模式下生成输入结构候选，false 时只使用手工规则及撤销操作 |
| narrower_read_candidates | 默认空数组，最多 32 组；to 是 from 严格子路径，每组最多 32 项；须先声明 initial_read_grants |
| auto_discover | 默认 true；生成自动候选，false 时只搜索手工候选与删除操作 |
| prepare_directories | 默认空数组；统一预建目录，最多 2048 项，受 limits 上限约束；它不授予任务写权限 |
| narrower_candidates | 最多 32 组；to 必须是 from 的严格子路径 |
| assertions | 1–64 项产物断言；退出码为 0 是额外的固定条件 |

command 中的可执行程序由受控 PATH 查找，或使用明确的绝对路径。脚本应使用相对工作区路径，避免依赖原项目的绝对路径。

## 路径别名

| 别名 | 位置和初始状态 |
| --- | --- |
| @workspace | 本轮输入快照的副本，cwd 位于这里 |
| @cache | 本轮独立空缓存，设置为 XDG_CACHE_HOME，npm 缓存放在其中 |
| @tmp | 本轮独立临时目录，也是任务的 HOME 和 TMPDIR |

子路径的每个分量只允许字母、数字、下划线、点、@ 和连字符，支持 node_modules/@scope/package。拒绝 `.`、`..`、通配符、空分量、环境变量展开和绝对路径；以 .permsift-read- 开头的分量保留给探针。授权及祖先不能是符号链接。写候选目录会在运行前创建；读候选必须对应现有普通文件或目录，不会自动创建输入文件。

写授权不自动授予读取。省略 initial_read_grants 时读取保持旧行为；声明后按独立读取规则执行。删除写授权不会自动删除读取授权。详细语义见 [读取规则说明](read-permissions.md)。

install.cache 为 warm 时，将冻结输入中 cache_seed 指向的目录独立克隆到 @cache/npm；其余缓存与临时目录仍为空。种子必须是 @workspace 下的现有目录且内部不能含符号链接。记录种子内容哈希并使用 npm --offline；无法从缺失种子自动切换联网。旧安装模式不接受 initial_read_grants；声明 install.initial_write_grants 的分阶段模式可以收缩任务读取。registry 只接受 HTTPS origin；HTTP 的 localhost/127.0.0.1 origin 专供本地夹具。域名规则不带协议、通配符、端口或 URL 路径，授权匹配该精确主机的所有端口；保留域名 permsift-denied.invalid 禁止配置。见 [安装说明](dependency-install.md)。

## 自动发现候选

省略 narrower_candidates 即可使用默认自动搜索。初始基线全部通过后，工具汇总多次基线中的文件新增、修改、删除以及目录结构，覆盖 @workspace、@cache 和 @tmp。它优先尝试实际变化指向的目录组合，再尝试目录结构和可获得的拒绝线索；手工规则优先于自动规则，重复候选合并。

自动发现有深度与目录数上限。输入符号链接不作为授权目录；不符合路径别名格式的目录不参与搜索。报告 discovery 中记录来源 trial、规则、准备目录、truncated 和未覆盖范围。search_complete 只表示有限候选搜索已结束；目录枚举被截断时也不能声称覆盖了整个项目。

文件差异看不到已经删除的临时文件，也可能看不到写入相同内容的操作。工具不会直接按观察结果宣布最小权限，每个候选仍实际执行任务、断言和边界探针，失败后恢复复测。

自动规则可能新增需要预建的目录。此时工具冻结准备列表，用初始权限重新执行 discovery_baseline；通过后，候选、恢复与最终验证都使用同一列表。准备变化导致基线失败时不进行搜索。推荐配置通过 prepare_directories 保存这个运行条件，重放时应继续使用相同的可信 limits。

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

每个预期用例必须存在；不允许重复名称；报告中的所有用例必须 passed。failed、skipped、缺失或格式错误都导致断言失败。expected_tests 自身也不得重复。

### JUnit XML

```yaml
assertions:
  - type: junit
    path: '@workspace/reports/junit.xml'
    expected_tests: [normalizes accents, handles empty input]
```

支持单个 testsuite 或 testsuites 根节点及嵌套 testsuite。预期名称使用 testcase 的 name，必须在报告中恰好出现一次；同名用例有多个 classname 时，需要调整用例名使预期项全局唯一。报告中的任何 failure、error、skipped、重复 classname/name 身份、非零失败/跳过统计，或与实际用例数量不符的 tests 统计都会失败。空报告、缺失用例、格式错误和不支持的结果元素也会失败。

DTD 与自定义实体声明禁止；只处理 XML 预定义和数字字符引用。仍受 1 MiB 普通文件限制；元素数量和嵌套深度有上限。宿主读取报告，不执行其中的代码。报告的文件新鲜度由每轮删除旧文件保证，不依赖报告自填的时间戳。

Node 的 [JUnit reporter](https://nodejs.org/docs/latest-v24.x/api/test.html#test-reporters) 与 pytest 的 [--junitxml](https://docs.pytest.org/en/stable/how-to/output.html#creating-junitxml-format-files) 可生成这类报告。本机验证了 Node 原生 reporter；其他生产者须先确认报告符合以上支持范围。

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
| allowed_read_roots | 省略 | 开启显式读取模式时必填，只接受 @workspace 及其子路径，允许空数组；不约束固定基础读取 |
| allowed_network_domains | 省略 | install 场景必填，最多 64 个精确域名，允许空数组；仅安装可使用，任务命令始终断网 |
| max_candidates | 30 | 整个实验读写合计最多实际尝试的搜索候选（包括分组和拆分子组），允许 0；基线、恢复和最终验证不计入 |
| budget_seconds | 900 | 实验时间预算，范围 1–7200 秒 |
| repetitions | 3 | 每个任务的基线和最终验证重复次数，范围 1–10 |
| max_output_bytes | 262144 | 每个进程 stdout 与 stderr 的合计原始字节限制，超出即停止 |
| max_snapshot_bytes | 500000000 | 输入普通文件的累计大小上限 |
| max_discovery_depth | 3 | 自动目录枚举相对别名根的最大深度，范围 1–8 |
| max_discovery_dirs | 64 | 每次目录枚举及合并后的候选目录数上限，范围 1–512 |
| max_read_discovery_entries | 128 | 输入结构枚举的文件与目录总数上限，范围 1–2048 |
| max_read_discovery_depth | 3 | 项目读取枚举最大深度，范围 1–8；文件也计入深度 |

时间预算在各阶段检查，并限制任务执行时限；文件复制、宿主验证及后端初始化不是可抢占操作，因此不是严格的总运行时间硬上限。搜索预留基于基线耗时估算的最终验证时间。预算耗尽时，只有确实完成最终验证的候选才能写为 recommended.yaml。

## 输出和重放

`--output` 指定一个尚不存在的目录。目录位于原项目内部时，必须处于 exclude 列出的顶层目录中，避免快照递归包含自身。

- report.json：机器可读汇总和证据索引；搜索记录的 rounds/round 为复查轮次，removed_grants 为分组成员，reuses 单独关联复用的失败证据；policies/searches 记录写规则，read_policies/read_searches 记录读规则，read_modes 区分 explicit/legacy，read_discovery 记录候选来源。
- report.md：适合人工审阅的摘要。
- inputs.json：规范化配置、limits、版本和输入哈希。
- evidence/*.json：每次运行的任务、探针、断言和日志。
- recommended.yaml：当前策略通过完整验证时生成。
- unverified-candidate.yaml：失败、中断或最终验证未完成时生成，不应直接作为已验证配置采用。
- report-guard：只包含随机假数据，用来测试报告目录写入保护。

report.md 的 Failure explanations 对每个失败或未知 trial 展示规则前后变化、拒绝操作与路径、断言及边界问题、有限 stderr 摘要和恢复结果。对应 JSON 保存 diagnosis，并保留原始任务日志。stderr 来自项目，拒绝日志为尽力采集；恢复通过只支持本次比较，不是通用因果证明。

doctor 使用临时内置项目，只输出检查报告，不导出可重放策略。

推荐配置重放时会重新读取 project 指向的当前内容，并重新验证，不会自动恢复历史输入。默认清理完整输入快照，仅保留其哈希和运行证据；如需保存历史输入，使用 --keep-workspaces，报告 workspaces 下的 input/ 即冻结副本。保存该副本及工具锁文件后，可以将配置 project 指向它重新运行，并比较输入哈希和环境版本。

## check 的历史基线与对照策略

`check --config CURRENT --baseline REPORT_JSON --limits TRUSTED_FILE` 使用当前任务和历史最终授权。baseline 旁须保留 inputs.json 和 evidence/，并且该报告为 verified；当前 initial_*_grants 是失败时的宽对照，须覆盖旧规则并在可信上限内。

check 共用整体时间预算、候选数量上限和 repetitions；修复候选先单次试验，再完整重复验证。JSON 为 kind=regression 的汇总，任务状态与子报告记录分开；兼容时生成 compatible.yaml，整份补充都通过验证时生成 suggested.yaml。详见 [回归检查](regression-checks.md)。

## 分阶段安装（v0.6）

install.initial_write_grants（可选，最多 32 项）显式开启分阶段模式，空数组也开启；install.narrower_candidates 为安装写候选，install.auto_discover 默认为 true。后两项需要显式的安装写字段。顶层读写和候选字段用于任务，网络仍仅用于安装，两段写规则都必须在 allowed_write_roots 内。

原始输入、安装配置/规则、缓存条件、目录准备、上限或环境改变会使安装快照失效。本版只在一次实验内复用，最终 repetitions 和 run/check 都重新安装。旧共用策略配置和历史基线保持兼容；切换阶段/读取模式须建立新基线。完整流程、报告及生成读取限制见 [staged-permissions.md](staged-permissions.md)。

## 可选 TypeScript 编译观察（v0.10）

scenario.observation.typescript.compiler 为项目内已安装 TypeScript 包目录，如 @workspace/node_modules/typescript。仅直接 node node_modules/typescript/bin/tsc 支持；npm scripts、shell 包装、build/watch、response files 及其他诊断输出模式拒绝。字段不授予读写权限、不运行额外任务；observe 才追加 explainFiles、locale en、pretty false。run/tighten/check 命令保持。可信 max_output_bytes 同时限制诊断 stdout/stderr，超限终止；详细例子、来源语义与上限见 [typescript-inputs.md](typescript-inputs.md)。
