# 运行前理解配置

`explain` 读取场景与显式指定的可信 limits，使用执行器同一套 schema、策略校验、安装阶段派生与初始目录准备规则。它不执行项目命令、不安装、不复制或扫描项目、不初始化沙箱，也不创建报告目录。仅将 `project` 相对配置文件解析成现有真实路径。

```sh
node dist/cli.js explain --config examples/demo/permsift.yaml --limits examples/limits.json
node dist/cli.js explain --config examples/demo/permsift.yaml --limits examples/limits.json --for tighten
node dist/cli.js explain --config examples/projects/bundle-kit/observe.yaml --limits examples/limits.json --for observe
node dist/cli.js explain --config tasks.yaml --limits /absolute/path/trusted-limits.json --for check --json
```

`--for` 默认为 `run`。退出 0 表示静态配置检查通过；退出 2 表示文件、格式、schema、声明关系或项目路径有问题。它不表示任务通过或运行环境可用；环境检验仍用 `doctor`，实际任务仍用对应执行命令。没有 `--output`、`--baseline` 或工作区/产物保存选项；如需留存预览，可以重定向 stdout。

## 会解释什么

- 配置、可信上限的实际文件位置，项目真实路径及排除的顶层目录。
- 每个任务的命令 argv、超时、初始可变读写、始终断网的任务网络和固定保护目标。
- 安装与任务是否共用写权限、安装网络、禁用生命周期脚本、冷/暖缓存和暖安装的 `--offline`。
- 声明、继承和行为默认的来源。例如省略 `initial_read_grants` 是旧式工作区整体可读，显式 `[]` 只取消可变工作区读取；固定基础读取仍然保留。
- 由 schema 填充的默认字段逐项列出；JSON 的 `normalized` 保存解析后的配置/limits，授权的 `origin` 另标明行为默认与继承。解释不写回配置或改变已有身份。
- 初始目录准备，包括手工候选端点；即使当前模式不搜索，这些目录仍参与准备。自动发现可能在运行后再增加目录，预览不猜测。
- 每轮从隔离副本删除的断言产物；observe 整体清空的 esbuild 产物目录。不要把任务输入声明成产物。
- 按产物集中列出检查、指定值/文本/预期测试及覆盖范围。`file_exists` 不检查内容；`test_results` / JUnit 要求所有报告测试通过，包括非预期项；报告诚实与否未在这里验证。
- 当前模式启用的搜索/采集。配置里有候选或采集字段，不表示 run 会搜索或采集。TypeScript 的诊断参数只在 observe 加到命令中。

**limits 是上限，不是自动授权。** 安装固定工作区读取、缓存/临时目录与后端基础系统读取不受可变读取上限约束。预览不是完整生成的系统策略；具体文件类型、运行时路径和展开权限以真实证据为准。固定保护声明作用于任务，安装不使用任务保护目标。

## 执行次数的口径

| 模式 | 计划任务次数 | 安装计划 | 未包含的工作 |
| --- | --- | --- | --- |
| run | 任务数 × repetitions | 安装场景数 × repetitions | 探针、保护检查、快照/哈希等 |
| observe | 每任务一次 | 每个有安装声明的任务一次 | 采集、清单、探针等；没有任务间安装共享 |
| tighten | 初始基线与最终验证：任务数 × repetitions × 2 | 对应基线与最终新安装 | 目录准备确认、候选、恢复、复查及探针等 |
| check | 无法仅由当前配置确定 | 无法静态确定 | 历史基线；旧规则失败后的宽对照/修复 |

这些是条件成立时的安排，不是硬上限、费用估算或已执行次数。安装失败可能导致任务未执行，失败/取消/预算耗尽也可能提前停止。`max_candidates: 0` 仍可进行基线和最终验证；候选上限不限制所有沙箱调用。check 预览授权只用于当前宽对照/修复输入，不能理解成历史实际方案。

## 错误与尚未检查的部分

格式/schema 错误带源文件和字段路径，例如 `scenarios.0.assertions.0.path`。策略关系复用实际校验器，按任务定位，例如 `scenarios.0` 并引用可信 limits；每任务先报第一个策略关系错误，修正后再次 explain。JSON 错误报告仍包含 `status: invalid` 和执行/安装 0 次。

这里不读项目 package.json、锁文件、缓存、保护/读取目标或产物内容；不检查输入大小、输出目录位置、工具是否可执行、锁布局支持性或后端能力。静态通过仍可能在执行预检或任务中失败。缺少历史材料和动态事实不会被补造成通过。

## 复现与收益界限

```sh
npm run onboarding:verify
# 已准备 bundle-kit 依赖之后，本机真实沙箱的一项目两路径检验
npm run onboarding:verify -- --live
```

默认只解释仓库中的权限、显式读取、安装、分阶段安装及构建观察配置，另检验越过可信上限的反例；项目执行/安装均为 0。live 使用 bundle-kit 的原构建命令和成功条件，建立基线、观察、改动副本源码、check、再次观察并离线比较。无权限搜索、无新安装；已有工具依赖的准备成本另列。

记录配置适配、实际任务数、来源和耗时，不用 CLI 耗时或配置行数推断节省了多少人工时间。目前可验证的收益是配置关系、默认权限、产物清理和检查范围能在执行前看到；是否降低新用户接入时间、减少无效运行，仍需独立用户数据。
