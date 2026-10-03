# 基线采用与日常维护

一次实验得到的是验证结果。`adopt` 记录用户明确选择的结果，并保存以后能读取的验证证据；后续 `check` 用它检查当前项目。采用不会运行任务，也不会把历史结果变成当前项目或未来版本的保证。

## 最短使用流程

在仓库根目录完成构建后，用保护目标示例体验：

```sh
npm run build
node dist/cli.js run --config examples/protection/permsift.yaml \
  --limits examples/protection/limits.json --output .permsift/my-baseline
node dist/cli.js adopt .permsift/my-baseline \
  --config examples/protection/permsift.yaml --limits examples/protection/limits.json \
  --reason '采用已验证的构建与保护目标'
node dist/cli.js check --config examples/protection/permsift.yaml \
  --limits examples/protection/limits.json --output .permsift/my-check
node dist/cli.js inspect examples/protection/.permsift-baselines
```

也可以采用 `tighten` 的成功结果。旧的 `check --baseline report.json` 入口保留，显式参数优先；不传 `--baseline` 时读取配置文件所在目录的 `.permsift-baselines/current.json`。没有当前选择时明确报错，不寻找“最近成功”的实验。

`adopt --output DIR` 将 DIR 作为基线存储目录，之后用 `check --baseline DIR` 选择它。默认存储和实验 `.permsift/` 分开。默认配置排除 `.permsift-baselines`；显式 exclude 的配置如需把基线放进任务项目，应自己添加这个顶层排除项，或把存储放在项目外。采用拒绝向未排除的任务输入目录写入，防止维护记录改变下一次任务输入。

每个配置目录有一个默认当前选择。多个独立配置需要不同存储时，使用显式 `--output` 和 `--baseline`。

## 什么可以采用

- `run` 或 `tighten` 已完成、baseline/final 标记通过，最终选定规则的全部配置重复验证通过。
- 每次重复都有可读取且一致的任务进程、成功检查、完整固定边界检查；声明保护目标时还必须有通过的独立保护检查。
- 显式分阶段安装必须有最终规则下的全新安装证据，不能只采用安装快照上的任务通过结果。
- `check` 的全部当前任务都有通过的旧规则复验、新任务验证，或重复验证通过的修复方案。报告仍可标记 `regressed` 或 `review_required`：明确采用是在审阅之后记录选择，不会回写此前的检查结论。

只有整体当前方案完整时才能采用；失败、未知、预算未完成的任务阻止整份采用。新增任务不能靠其他任务的成功补齐。

采用时还要求证据中的任务定义、保护目标、读取模式和执行要求与 `--config` 对应。只改正向初始权限或候选设置不改变这些任务约定。所选规则和准备目录必须落在本次显式提供的可信 limits 内。采用不复制 limits 为未来的授权；每次真实执行仍以独立传入的 limits 校验。声明的准备目录与底座自动推导的完整执行准备分别保留；前者改变要求审阅，后者仍核对实际验证证据及可信上限。

## 如何保存

```text
.permsift-baselines/
  current.json                       当前选择，原子替换
  records/<采用内容摘要>/
    baseline.json                    采用时间、理由、前一份选择、五对象引用、文件摘要
    source/report.json               原始工作流报告
    source/inputs.json               原始规范化配置和验证条件
    source/evidence/...              选定最终重复验证的原始证据
    source/executions/...            存在时保留原始原生事实及索引
    source/tasks/...                 check 选定任务阶段的对应报告和证据
```

复制仅涉及有界 JSON 文件；不复制源码、缓存或 node_modules，也不重新安装、执行、收缩权限。工作流元数据保留原貌，但未选定搜索阶段的证据副本不全部复制。因此基线包用于追溯最终验证；完整候选搜索过程仍需保留原实验目录。

每份采用记录创建后由工具保持不变。再次采用创建新记录并关联前一份；当前指针通过独占锁与原子替换发布。已有指针或其证据损坏时拒绝覆盖，保留错误原因。进程强制结束留下 `.adopt.lock` 时，确认没有采用进程后可手动删除该锁；这是本地并发写保护。

`inspect`/`check` 使用采用记录时重新校验文件摘要、任务/约定/权限/执行引用及实际检查结果。移动整份存储或清理原实验目录仍能读取。证据缺失、内容变化、链接和越界引用会被拒绝。前一份记录位置可显示为缺失，当前证据独立存在时仍能读取；查看前一份记录需单独 inspect，不自动遍历全部历史。

源文件路径用于说明来源，读取不依赖它。SHA-256 检查内容一致性，不认证生产者；宿主进程能修改存储。验证和采用记录不具备授予执行权限的权力。

基线包包含原始诊断记录中的日志及路径。需要与代码一起长期保存时，明确选择是否把这些证据提交项目仓库；本工具不自动提交项目的基线文件。

## 约定变化怎样解释

新检查报告使用 schema_version 2；读取器仍支持旧 schema_version 1。

每个任务分别记录历史定义、当前定义的精确变化、本次选定方案的验证结果。任务命令与成功条件、执行要求（含声明的准备目录）、固定边界检查、每一个具名保护目标有各自的变化关系。断言、期望测试名、保护目标的顺序变化不会被当作内容变化。

| 情况 | 本次结果 | 如何理解 |
| --- | --- | --- |
| 代码/依赖变了，约定相同，旧规则通过 | compatible | 本次按原约定完成验证；没有重做权限收缩 |
| 删除成功检查或改变命令后通过 | review_required | 当前条件下通过，原约定延续未被证实 |
| 增加、修改、删除保护目标后通过 | review_required | 本次检查当前目标；逐目标保留原目标的历史证据 |
| 新增任务 | 单项 new_task_verified 或失败/未知 | 新任务运行当前配置规则，不能宣称原基线包含它 |
| 删除任务 | 单项 removed_task / not_run | 历史结果保留；本次没有执行该任务 |
| 旧规则失败，宽对照通过并复验稳定 | regressed | 可提出经过真实验证的权限补充，采用仍需显式动作 |
| 两种规则都失败 | regressed / unresolved_failure | 不把普通代码或断言问题认定为权限不足 |
| 一个任务的读取/安装模式不能沿用，或证据未知 | inconclusive | 保留原因，并继续其他能验证的任务 |

整体存在失败或未知时保留这些结论，同时逐任务显示约定变化；全部当前任务通过但约定变化时，顶层为 `review_required`，CLI 返回 1，不能让自动化把它当作原约定保持。`compatible` 返回 0；`regressed` 返回 1；`inconclusive` 返回 2。

删除源码写保护时，旧源码保护的历史通过记录继续存在，当前声明和检查中明确为已删除；其他目标的新检查也独立显示。历史通过从未自动变成本次通过。精确展示断言变化，不推断任意断言之间的强弱关系。

宽对照和修复始终保持本次声明的保护目标；目标变化本身在检查摘要中要求审阅。更换读取或安装模式暂不自动迁移；受影响任务给出原因，其他任务继续检查。

## 验证与成本

```sh
npm run maintenance:verify
# 有现成大型基线与原项目时，复用它进行完整安装/任务复验：
npm run maintenance:verify -- --large-baseline /absolute/path/report.json \
  --large-limits /absolute/path/trusted-limits.json
```

默认公共 CLI 故事覆盖：建立→采用→清理源报告→代码变化复验→精确读取修复→采用→改变成功和保护条件→审阅采用→移动存储→无项目离线解释。离线命令用空 PATH 检验，运行次数、安装次数、阶段耗时写入 verification.json。

大型入口只复用保存的基线，不重复搜索。它记录采用复制的文件/字节数、当前复验次数与安装次数，并单独列出历史搜索成本。历史搜索与当前复验不构成同条件性能实验，不据此报告普遍节省比例。

工程检查、跨进程多次采用和真实沙箱流程可以当次验证；几个月持续维护的收益、独立使用者是否理解实际保护范围，仍需分别记录为未验证。采用摘要明确标出历史输入、环境、执行要求、保护范围及“本次未执行”。
