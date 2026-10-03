# 成功条件诊断

`diagnose` 解释已有产物断言能够发现哪些具体变化。它在宿主上读取可选保存的小文件，先重放未修改材料的检查，再对内存副本做扰动；不会重新安装、运行任务、改变权限、实验结论或采用基线。

## 使用

```sh
npm run build
# 在本来需要的执行中选择保存材料；run/tighten/check/observe 均支持
node dist/cli.js run --config examples/demo/permsift.yaml \
  --limits examples/limits.json --save-artifacts --output .permsift/demo-with-artifacts
node dist/cli.js diagnose .permsift/demo-with-artifacts
node dist/cli.js diagnose .permsift/demo-with-artifacts --json
node dist/cli.js diagnose .permsift/demo-with-artifacts --output .permsift/demo-diagnostic
# 无外部注册表的公开 CLI 工程验收：demo + 结构化报告夹具
npm run success:verify
# 另加固定 clsx 原始构建；prepare 独立联网安装，不计入诊断成本
npm run third-party:prepare
npm run success:verify -- --with-clsx
```

`--output` 必须是新目录，保存 `diagnostic.json` 和 `diagnostic.md`，不覆盖历史结果。诊断完成返回 0，即使某项扰动继续被接受；材料缺失、对照无法通过或预算不足返回 2。诊断退出码不替代原任务验收退出码。离线入口不加载执行后端，不要求 macOS 或项目仍存在。

默认不保存产物。显式 `--save-artifacts` 会复制断言目标文件的完整字节，不只是检查过的字段；文件保存在权限受限的实验结果目录中，跟随该目录保存和清理。旧报告不自动补材料，也不寻找原工作区或强制重新运行。

## 取哪次产物

- tighten：最终方案的第一轮通过的 `final` 验证；不取初始基线、搜索候选或恢复实验。
- run：本次方案第一轮通过的 `baseline`，它就是该模式的最终验证。
- observe：本次实际 `observe` 执行，一任务一次。
- check：兼容旧方案的 `old`、新任务的 `new`，或者所选建议的最后一个 `repair-verify-*` 子报告。控制方案及 repair 搜索不作为诊断材料。

每个任务只保存一轮。诊断先核对所需的全部最终重复验证、任务/断言定义、所选权限方案、执行及材料身份，再显示取样的执行编号、阶段、方案 ID 和重复次数。流程未完整通过时，不把已保存的某个通过副本当成最终依据。某轮保存失败也不改取另一轮。

`artifacts/<trial>/manifest.json` 记录来源和保存预算；`00.bin` 等文件保存实际字节。最终 sidecar 的 `success_artifacts` 关联 manifest 内容哈希；每份字节独立校验 SHA-256。读取只允许这个固定布局，拒绝重复/无关目标、路径穿越和链接。它检验保存材料的一致性，不认证报告生产者。

采用基线仍只保留有界验证 JSON，不复制可选产物。`diagnose` 读取 adopted baseline 会明确显示 `not_saved`；要诊断应选原执行结果。它不会沿采用记录中的历史源路径查找材料。

## 按产物解释

同一路径可能有多个断言。报告按产物路径列出断言索引和定义、未修改对照、具体扰动、每条检查的结果与原因，以及该路径检查和全部已保存产物断言的共同结果。索引对应原配置顺序，两个检查同名但 JSON pointer 不同时仍可区分。

| 扰动 | 适用对象 | 解释范围 |
| --- | --- | --- |
| 删除产物 | 所有目标 | 文件缺失是否被拒绝 |
| 清空字节 | 所有目标 | 存在检查是否接受空文件，结构化检查是否因格式无效拒绝 |
| 删除被检查文字 / 只保留文字 | file_contains | 具体文字检查及其范围；仅剩标记不自动代表业务结果错误 |
| 改被检查 JSON 值 | json_equals | 有效 JSON 中指定 pointer 的值是否被发现；保留 JSON 类型比较和 pointer 转义语义 |
| 通过改失败 | test_results / junit | 报告中的失败是否被发现 |
| 删除预期项 / 改预期名字 | test_results / junit | 明确要求的测试是否齐全 |
| 重复测试身份 | test_results / junit | 对应格式的重复判定；JSON 按名字，JUnit 按 classname 与名字 |
| 非预期项改失败 / 删除非预期项 | 材料实际有非预期项时 | 所有报告测试仍须通过；预期列表是必须存在的子集，不要求所有其他测试永远存在 |

修改 JSON 后重新序列化；JUnit 修改后同步已有的各层 suite 计数，保留合法 XML。未出现非预期项时，相应扰动明确为不适用，不编造原报告中的测试。

先确认完整未扰动材料的整组产物断言通过，再做扰动。任何必要产物未保存、字节/来源不匹配、未修改对照失败时，保留局部读回结果但不输出扰动结论。这不是拿生成失败或坏材料当成“检查严格”。

## 为什么被拒绝

任务验收继续使用原 `pass/fail/unknown` 及原生 Check 结构。新执行 sidecar 另外保存 `assertion_evaluations`，离线诊断使用同一个断言评价器，原因分开记录：

- `satisfied`：满足该项检查。
- `content_mismatch`：格式可评价，但值、文字或测试条件不符合。
- `invalid_format`：JSON/XML 或已支持报告结构无法解析/不合法。
- `missing_file`：任务目标缺失，或诊断刻意删除了该副本。
- `unreadable_file`：任务验收无法安全读取目标。

诊断自己打不开保存材料、遇到链接、哈希不符或预算不足，是 `not_saved` / `inconclusive`，不是某条断言发现了内容问题。被清空的 JSON 拒绝原因是格式；有效 JSON 值变更的拒绝原因是内容。两者都能阻止验收，但说明的是不同能力。

## 预算与成本

每个取样任务最多保存 16 个文件，单文件 1 MiB，总计 2 MiB，读取使用 2 秒协作式预算；保存失败明确记录，不改变已有 trial 的 verdict。源文件、普通文件类型、链接及读取期间变化都受核对，不能以空副本冒充读取成功。整个结果最多 16 个任务；多目标超过预算会留下缺口。

离线诊断最多评价 256 个扰动，材料读取和逐项评价使用 5 秒协作式预算。它不是对同步解析器的强制进程终止时间。执行侧另列 `artifact_capture` 耗时；诊断另列宿主分析耗时，均不包含新任务或安装。显式保存仍有复制/写入成本，并会消耗整个执行流程的可用时间，不能承诺开启后总耗时或流程预算结果完全不变。

## 实际验收与边界

本机公开 CLI 故事 `.permsift/success-validation-bNoPHq/verification.json`：共 4 次任务、0 次新安装、0 候选。demo 两任务保存 880 字节，复制分项约 2.34 ms；固定 clsx 一任务保存 1687 字节，约 3.02 ms。对应完整 CLI 诊断墙钟约 93 / 89 ms，包含 Node 启动，不是普遍性能基准。另一个任务是结构化报告夹具。clsx 使用已准备依赖，准备成本不包含在该故事。

clsx 的五条存在断言确实接受空文件；报告同时声明原任务命令已加载产物做 8 项行为检查，没有重新执行这些检查。不能说“五个空文件能通过整套任务”。demo 对空报告、预期项删改及受检值改变有相应拒绝，也不能因此称其整体测试充分。结构化夹具显示非预期项失败被发现、删除非预期项继续接受。清理 demo 项目并移动结果后仍可离线诊断，原项目与原报告未改动。

这证明工具对这些已知事实的说明准确。任务内部测试、输入覆盖、未知业务错误和报告诚实性均未诊断；没有整体质量分数、安全背书或自动改写断言。是否帮助独立使用者改善检查、节省人工时间，仍待实际反馈。完整回归和反例见 [验证记录](validation.md)。
