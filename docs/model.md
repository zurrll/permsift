# 第一轮内部模型

第一轮建立可运行、可回放的内部适配层。第二轮已将这些角色接入真实执行请求与独立事实文件，详见 [共同执行底座](execution-foundation.md)。旧 CLI 使用方式和历史报告继续支持；第五轮为约定变化提供独立判定及回归 wire v2。第四轮已接入 [固定保护目标](protection-goals.md)；第五轮已实现 [明确采用、保留证据和约定维护](baseline-adoption.md)。

第三轮的只读消费者验证原生 v1 文件并核对工作流引用；旧搜索适配新增操作、前后规则和候选/恢复位置，旧字段缺失时保留 not_saved。回归的原因和修复停止同样进入投影。内部 model_version / identity_version 仍为 1，这些添加不改已有对象身份公式；新版摘要独立保存，见 [结果解释](result-explanations.md)。

源码位于 `src/model/`。这是一份版本化的迁移接口，不是新公开报告协议，也不要求用户填写五个文件。

## 五个对象怎样分工

| 对象 | 保存的内容 | 不承担的结论 |
| --- | --- | --- |
| TaskDefinition | 项目内逻辑任务键、命令及成功条件 | 成功条件足以证明整个程序正确 |
| ProtectionAgreement | 用户保护目标的声明状态、资源类型、操作与阶段 | 把旧内置探针自动变成用户声明的目标 |
| PolicyPlan | 任务读写、固定保护禁止项、离线网络、安装写入和安装域名 | 完整后端权限或全局最小策略 |
| ExecutionEvidence | 一次历史 trial 的事实、任务/边界/保护结论、来源记录、执行条件 | 用一个 verdict 覆盖所有维度，或把多轮流程压成一次任务 |
| BaselineReference | 旧 check 选择的比较记录、引用及采用信息缺口 | 成功报告或验证建议自动成为已采用基线 |

运行条件属于执行证据，包含输入和 limits 摘要、环境、准备目录、超时、安装条件、采集设置与安装复用引用。它们不能混进“任务的成功定义”。安装策略与任务策略分别表达：安装器固定允许的工作区读取不是任务的显式读取列表；任务始终离线。PolicyPlan 的范围明确限于旧生产者的可变授权，系统运行时、固定读取、观察器内部写例外等仍需查原始后端证据。

搜索和回归是工作流。Workflow 保存验证旗标、搜索完成状态、停止原因、阶段汇总和建议引用。旧回归的一个 stage 可以包含三次执行；适配器保留该汇总和 trial 数，不伪造单次进程结果。详细事实来自另行适配的子实验。

## 身份、引用和生命周期

- `key` 表示同一个项目里任务的逻辑延续。调用比较函数的流程须先确定比较的是同一项目；路径相同或任务名字相同不能证明项目相同。
- `id` 标识这次保留内容的版本，格式为 `对象:v1:SHA256`。对象键稳定排序，命令参数保持顺序，授权列表按集合处理；并列成功断言排序，预期测试名按集合处理。改变命令或成功条件会改变任务 ID；输入、权限、超时或采集设置变化不会改变已知任务定义的 ID。
- 文件或目录读取类型属于方案内容，同一个路径的类型变化会改变方案 ID。缺少类型时，不能把相同授权文本称为完全相同方案。
- 未保存命令的观察摘要保留旧场景指纹作为未知定义的来源锚点。补回完整定义时可生成新的内容 ID；`key` 继续提供逻辑连续性，不能把这种补回当作已知任务发生变化。
- 执行引用具体任务、约定和方案 ID。未知方案显式保存缺口。适配结束检查引用存在且属于同一任务，拒绝重复身份和重复逻辑任务键，然后递归冻结结果。
- 初始、候选、恢复、最终、建议是工作流角色，不是不同权限身份。相同保留内容可以共用方案。新内容生成新对象，不能原地改写旧执行引用。
- 旧 check 的 baseline 是比较引用，状态为 `adoption: not_recorded`、`resolution: not_loaded`。其他旧成功实验没有采用对象。第五轮新增 AdoptedBaseline（explicit_adoption / recorded / validated），保存完整的任务、约定、方案和重复执行身份；check 中的 AdoptedBaselineReference 则明确为 adopted_reference / recorded / not_loaded，离线解释不追踪外部存储。旧比较引用及身份公式保持原貌。

新模型的 `model_version` 和 `identity_version` 当前均为 1。改变结构需显式迁移；改变内容归一化或 ID 含义需升级身份版本。不同身份版本禁止直接比较。模型修订不能写成项目、用户约定或权限发生变化。

第四轮为预留的保护角色增加可执行声明、方案禁止项和可选保护事实。原生文件使用 schema_version: 2 明示这一格式扩展；无声明记录继续使用 v1，读取器同时支持两个格式。内部对象的内容身份公式和无声明旧对象不变。保护目标按 key 稳定排序，目标变化改变约定/方案身份，不改变任务成功定义；旧记录没有保护事实时保留缺口，不能补成通过。

## 旧哈希与新身份分开

旧生产者使用 `SHA256(JSON.stringify(value))`。新对象身份使用稳定键排序的规范 JSON。适配器先对保留的原始 config、limits 验证旧摘要，再用当前 schema 校验和补默认值；历史摘要原样保存，不用新摘要替换它。

usage 的 `task_definition_hash` 实际覆盖整个旧 scenario，包括权限、搜索及采集配置。它以 `producer_scenario_hash` 保留，不能直接解释成“成功条件变了”。check 的 `task_definition_changed` 则覆盖命令、断言、超时与安装设置；原布尔值和这个范围一同保留，同样不能缩写成“断言改变”。

`source.artifact_hash` 是本次传入 JSON 对象的规范摘要，帮助识别适配输入；它不是原报告文件字节摘要。样本另存原始文件字节 SHA-256 与投影说明。哈希核对验证保留内容一致，不提供生产者身份认证。

## 缺失信息怎样说

| 状态 | 含义 | 例子 |
| --- | --- | --- |
| recorded | 对应事实确实保留，可为空数组 | 已记录任务网络授权为空 |
| not_declared | 没有声明此项 | 旧报告没有用户保护目标；保留配置没有安装阶段 |
| not_collected | 已知生产流程没有采集该来源 | 普通 run 没有模块钩子；旧 usage 没有编译来源 |
| not_saved | 当前材料没有保留所需细节 | 只有 summary，没有任务进程或读取目标类型 |
| not_run | 明确记录没有执行 | 安装失败跳过任务；复用快照时没有重跑安装 |
| incomplete / unavailable | 来源有明确缺口或不可用 | 模块记录缺 footer 或环境不支持钩子 |
| unknown | 已有事实无法得出该维度的可靠结果 | 超时、未知检查、缺少边界阶段或宿主对照 |

只有部分证据时，保留有依据的事实与缺口。例如观察摘要可保存旧 composite verdict 和模块记录，而独立任务结论为 not_saved。它不表示任务失败，也不补造“任务本身通过”。

## 结论判断表

| 保留事实 | 独立任务结论 | 边界结论 / 其他维度 |
| --- | --- | --- |
| 进程正常完成、退出 0、成功检查全部通过 | pass | 仍需独立看边界 |
| 正常完成、退出非 0 | fail | 记录可同时完整；不推断权限是原因 |
| 退出 0，但检查失败 | fail | 边界通过不替代成功条件 |
| 退出 0，但检查未保存 | not_saved | 原 composite verdict 原样保留 |
| 超时、无退出码、空检查或检查含 unknown | unknown | 不能由其他绿色维度补成 pass |
| 明确跳过任务 | not_run | 安装进程单独保留 |
| 任一边界检查 unknown，或全部通过但缺阶段、核心期待或宿主对照 | 不受影响 | unknown |
| 无 unknown 且有边界期待失败 | 不受影响 | fail |
| 必需阶段、生产者核心期待和宿主对照均保留并通过 | 不受影响 | pass，仅限记录范围 |
| verified，但 search_complete 为 false 或预算停止 | 不受影响 | 两个工作流事实同时保留 |
| 任务 composite pass，模块采集 incomplete | 取决于过程与断言是否保存 | 采集缺口独立存在 |

安装流程要求保留安装后及离线任务前的边界过渡；复用安装状态的 trial 要求保留离线任务前检查。边界 pass 仍不等于任何新用户保护目标已验证，也不证明未保存的其他访问通道。原 composite verdict 不因新的细分判断而改写。

旧证据文件顶层常是执行前的 trial 副本，`verdict` 可能仍为 unknown；完成结果在 `summary`。适配器核对顶层身份与授权，再核对 summary 与报告行一致，避免把初始化值当成最终状态。

## 接口与迁移映射

```js
import { readLegacyJson, adaptLegacy, compareModels } from './dist/src/model/index.js';
const before = await readLegacyJson('examples/model-cases/permission-baseline.json');
const after = await readLegacyJson('examples/model-cases/permission-repair-replay.json');
// 由调用者明确提供 config 和 sidecar 对象；report 内的路径不会触发读取。
const adapt = sample => adaptLegacy(sample.report, { inputs: sample.inputs, evidence: sample.evidence });
const differences = compareModels(adapt(before), adapt(after));
```

| 旧材料 | 适配后的对象和事实 |
| --- | --- |
| inputs.config.scenarios | TaskDefinition；超时、安装和采集配置进入执行条件 |
| report.policies / read_policies / read_modes / install_policies / network_policies | 当前方案引用；trial 自身授权生成各执行的方案 |
| evidence.task.process / assertions | 独立任务判断；安装进程另列 |
| before / after_installation / before_offline_task / after | 分阶段边界事实与判断 |
| dependency_observations / usage.tasks | 同一生产者已校验的清单、模块、编译和产物记录 |
| evidence.observer | 内部写例外、来源、引导文件摘要及实际编译命令等采集条件 |
| searches / verification flags | Workflow；不改变任务定义和方案授权 |
| check.tasks.stages / suggestion / baseline | 阶段汇总、建议方案、未记录采用的比较引用 |

保留 inputs 或 sidecar 时核对原哈希、任务键、trial 身份、授权和最终 verdict。读取单个文件有 32 MB 上限，拒绝链接及非普通文件；适配器不运行项目，不跟随历史 baseline 或 stage 路径。usage 文件和内存适配共用原有严格来源校验。

`compareModels` 分开比较输入、limits、环境、任务定义、保护声明、当前方案和已保存执行条件。不按全部历史候选的数量比较当前方案。已知字段改变可以报告 changed，缺失内容不能被当作相等；环境与其他维度分别保留。比较输出没有“原约定保持”总布尔值。

## 本轮发现怎样影响第二轮

1. 一次受控执行需要分别返回安装与任务过程、成功检查、边界阶段、实际命令和采集条件，不能只返回一个 verdict。
2. 工作流要持有当前方案和建议的角色引用；底座不能用“最后一份成功报告”决定采用。
3. 回归汇总与单次执行需要不同接口，避免再次从完整报告中倒推状态。
4. 新产出的证据应明确保存实际执行命令和完整条件；旧记录的缺口只能说明，不能通过配置反推。
5. 身份冻结与运行目录、计时、随机执行标识的用途需继续分开。原报告保留全部证据，本模型只规范本轮需要解释的事实。

运行 `npm run model:verify` 可检查真实样本映射与前后区别；`test/model.test.ts` 中的合成反例检验未知、约定变化和不一致引用。两个使用案例见 [模型案例](model-cases.md)，本机与跨环境状态见 [环境检验](environment-validation.md)。

第五轮 check 使用 wire v2 保留历史任务定义与逐维度精确变化、当前验证和历史采用结果。旧 wire v1 继续按实际保留字段读取，不补造采用或历史验证。采用文件自身使用 wire v1 / kind: permsift_adopted_baseline；新角色沿用现有对象内容身份公式，采用记录与其 baseline 选择内容各自校验。
