# 离线比较与跨任务查看

v0.12 增加两个只读取 usage.json 的入口。它们不安装依赖、不运行项目任务、不启动沙箱，不需要项目目录、config 或 limits；没有新的权限搜索或采集来源。执行任务仍需要 macOS，离线分析只需要 Node 和已构建的 CLI。

第三轮扩展 `inspect REPORT_JSON_OR_DIRECTORY`：无需 --package 即可解释整轮权限实验、回归、观察或已保存比较；旧包视图继续使用 --package。compare 文字输出与保存的 comparison.md 前面新增同源概览，--output 还保存 summary.json/md，原比较 JSON 和退出码不变。材料读取、概览退出码和边界见 [结果解释](result-explanations.md)。

## 比较两份已保存的报告

```sh
npm run build
node dist/cli.js compare before/usage.json after/usage.json
node dist/cli.js compare before/usage.json after/usage.json --json
# 可选保存工件；目录必须尚不存在
node dist/cli.js compare before/usage.json after/usage.json --output .permsift/comparison
```

默认 stdout 是中文终端摘要；--details 展开来源、变化与依据，--json 的 stdout 仍是完整比较 JSON，两者不能同用。指定 --output 后保存 comparison.json / comparison.md，不覆盖输入或已有目录；不指定输出时不会生成一个虚构的结果文件路径。compare 不接受 --config、--limits、--baseline、--package 或 --keep-workspaces。

compare 与 observe --baseline 共用 usage-comparison.ts 的比较逻辑及 Markdown 段落。按任务 ID 和安装位置比较模块包、编译输入及打包记录，保留任务结果、输入/config/limits/环境/采集器变化提示。输出变化包括输入/输出、版本、编译原因、贡献、引用链及 external；不从相同字节数推断内容相同。

历史报告未采集某来源时，相应比较为 unavailable，不把新能力产生的数据报告成整组新增。部分记录保留已有差异和各侧健康度，缺记录不升级为确定移除。新增/移除任务也单独记录，不能当成同一任务的包增减。

离线分析状态 compared 表示读取并完成当前支持范围的比较，不表示升级无风险、任务重新通过或权限兼容。partial 表示原任务失败/未知、采集不完整、未运行任务或一侧缺少需要比较的来源。单纯版本、环境、配置变化不会被当作分析失败，但仍展示条件变化。

## 按包查看所有任务

```sh
node dist/cli.js inspect usage.json --package glob-parent
node dist/cli.js inspect usage.json --package @scope/name --json
```

按完整包名精确匹配，不接受 glob、版本范围或互斥用途分类。输出每个任务下的所有安装实例，保留版本和安装位置；嵌套目录即使同名同版本，也分别列出。任务采用独立工作区，行之间不是共享进程或共享安装状态。

每行展示模块文件数量、编译输入数量、打包输入数量和逐输出字节贡献。各来源旁保留 capture_status；任务结果与安装清单健康度也单独展示。表格是聚焦投影，完整文件、编译原因和引用链仍在原报告，不再复制整份长报告。

| 显示 | 含义 |
| --- | --- |
| 1 files [captured] | 该来源完整读回范围内记录了一个文件 |
| no record [captured] | 本次该来源没有记录；不等于未参与 |
| no record [incomplete] / [unavailable] | 记录有缺口，不能推出不存在 |
| not collected | 本次没有开启该来源 |
| output.js: 0 [captured] | 存在明确的 0 字节贡献记录 |
| no reported contribution [captured] | 没有报告该包的输出贡献，不能改写为 0 |
| package recorded; file list not saved | 旧/精简报告有包记录，未保存文件列表；数量未知 |

安装清单完整且没有匹配实例时，提示“该任务记录的安装清单没有此实例”；清单未保存、不完整或任务未运行时，只提示没有匹配的保留记录。不能由这些情况提出删包或撤权建议。

inspect 不接受执行选项或 --output；需要保存时可重定向 stdout。没有同名实例也会列出各任务的状态，避免空输出掩盖采集缺口。

### 谁引入这个版本，它包含什么？

新观察记录还保存任务执行前的安装关系和包结构，按实例在同一查询中展示：

```sh
node dist/cli.js inspect RESULT/usage.json --package type-fest --details
node dist/cli.js inspect RESULT/usage.json --package eslint-visitor-keys --json
```

安装关系来自 package.json 声明及受支持的 npm 目录布局：显示直接父依赖、声明种类/版本范围和最多三条根项目引入路径。按祖先目录查找实际安装实例，不把所有同名版本连在一起；不验证 semver 满足关系，也不执行 Node 条件 exports 选择。根项目的开发依赖纳入关系，安装包自身的开发依赖不纳入；缺少可选/peer 实例保留 unresolved。这不是本次实际加载链。

结构摘要复用已有执行前文件清单：保留 types/typings、main/module/bin/exports 声明及对应文件证据，分别统计声明文件、JS（含 mjs/cjs）、非声明 TS、原生模块、Wasm、其他文件和符号链接。无扩展名入口归入其他内容；目录、通配符或条件入口不能凭字符串判定已经解析。链接内容不跟随，缺清单或达到上限显示 partial；其他包自己的入口截断不让当前实例变成缺资料。已识别的安装辅助目录/文件和合成读探针不计为包内容。结构中的文件存在不表示本次读取了它。

本次成功解析边单独显示来源文件、请求和目标，与静态安装关系分开。模块、编译和构建来源仍各自显示健康度；普通 npm 脚本没有明确开启直接 tsc 采集时，编译来源为 not collected。未见加载记录与只有声明文件的结构相容，但不能据此断言“纯类型”“没用”或可删除。

材料含版本、prepared_task_inputs 阶段和文件清单摘要，离线读取校验实例引用、数量与完整性一致性。旧材料没有这些事实时显示 not_saved，不读取现在的项目补历史。默认每类最多展示六项，--details 最多 64 项；--json 保留全部已保存的有界事实。保存上限为 20,000 条声明关系、每实例 64 项入口、100,000 项已有清单；引入路径查询限制 512 步、24 层、三条路径，截断会提示。这些边界不是全依赖路径枚举。

真实 execa 七个 type-fest 和三个 eslint-visitor-keys 的核对见 [本轮实测](real-task-results.md)。查询不执行项目命令或 npm ls，也不需要原项目仍在磁盘上。

## 退出码和 CI

| 入口 | 0 | 1 | 2 |
| --- | --- | --- | --- |
| compare | 比较完成，允许有差异 | 不使用 | 输入无效或比较为 partial |
| inspect | 分析完整且找到实例 | 分析完整但没有匹配实例 | 输入无效或分析为 partial |

partial 优先于“没有匹配实例”的退出码。未知报告不会输出成功 JSON。CI 可把已保存的主干/当前 usage.json 交给独立比较步骤，比较步骤无需重跑构建；生成当前 usage.json 的观察步骤仍要执行任务。此处没有自动的依赖风险阈值或回归判定。

## 导入范围

接受 schema_version=1 的 dependency_usage 报告，包括 v0.9 未采集编译/打包来源的记录。report.json、比较结果、未知 schema 均不能冒充 usage.json。

每份输入实际读取最多 32 MB，拒绝目录、最终路径符号链接和 FIFO，读回过程中增长也受同一上限约束。校验任务/实例唯一性、跨来源包身份、模块所属安装根，以及已有编译归属和打包图/贡献/链一致性；保留的文本和数组有界。它验证格式和内部一致性，不认证记录生产者。

新材料的 trace_diagnostics 还保留紧凑编码、字符串定义数和 worker 父侧结束线索。worker_lifecycle 的创建身份、父线程引用和 worker_end 的解释必须一致；缺 footer 的事实不能被父侧正常退出覆盖。旧材料缺少这些可选字段时保持原有缺口，不补读项目推测原因。详细事实见 usage.md / usage.json，离线包查询仍按各来源健康度解释包记录。

## 可运行样例与验收

```sh
node dist/cli.js inspect examples/reports/fast-glob-tasks.json --package glob-parent
node dist/cli.js compare examples/reports/fast-glob-bundle-before.json examples/reports/fast-glob-bundle-after.json
npm run offline:verify
```

[样例来源](../examples/reports/README.md)和[使用检验](offline-pilot.md)注明原任务适配。offline:verify 通过公开 CLI 读取真实保存记录，检查跨任务与升级事实、输入摘要未改变，并在 PATH 没有外部工具的条件下执行。它的项目任务执行数和安装数均为 0；不会悄悄补跑 observe。单次 Node 启动/分析耗时不代表人工阅读时间或采用收益。
