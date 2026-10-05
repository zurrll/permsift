# 按任务观察依赖使用

v0.9 增加 `observe`，v0.10 可选采集直接 tsc 的编译输入，v0.11 可选采集本次任务新生成的 esbuild metafile。每个配置任务在独立副本中执行一次，复用安装、断网任务、产物断言、边界探针和清理；不运行权限搜索。模块观察回答“本次 Node 模块加载涉及哪些已安装包、解析来自哪里”；编译输入和打包记录为另两种独立来源，后者记录输入、全部报告输出、字节贡献、引入链及 external。各来源不回答必要权限或哪些依赖可以删除。

## 使用

```sh
npm run build
# 配置和 limits 与 run 相同；示例需要先 examples:prepare
node dist/cli.js observe \
  --config examples/projects/bundle-kit/permsift.yaml \
  --limits examples/limits.json \
  --output .permsift/bundle-observation

# 修改代码/依赖后，再观察一次并对比；不会重新执行旧任务
node dist/cli.js observe \
  --config examples/projects/bundle-kit/permsift.yaml \
  --limits examples/limits.json \
  --baseline .permsift/bundle-observation/usage.json \
  --output .permsift/bundle-observation-next
```

`--json` 输出使用报告；`--keep-workspaces` 保留副本。观察仍需明确可信 limits。执行能力与现有 macOS 后端相同；模块观察需要 `module.registerHooks`，Node 22.15+ 或 23.5+，当前验证 Node 24.21.0。旧 Node 能运行任务时，缺少钩子记为不完整观察，不自动升级或切换运行方式。

limits.repetitions 对 run/tighten/check 保持原义；observe 固定每个任务一次，计入原总时间和任务超时预算。每个任务有独立安装/工作区；不自动拆开一个串联编译、测试的命令。若想分别比较，请分别配置任务并给出各自断言。安装配置继续遵循已有 npm/冷暖缓存限制，安装阶段不被观察。

## 文件与状态

- `usage.json`：包清单、加载文件、解析关系、进程/线程记录、子进程启动尝试、覆盖缺口、可选 compilation / bundling 与对比。
- `usage.md`：可阅读报告，展示包版本、安装位置、各来源记录、根项目依赖声明，以及无模块钩子记录的包；摘要旁明确标注盲区。
- `report.json` / `report.md` / `evidence/*.json`：原执行器的任务结果、安装、前后探针、生效沙箱配置、变化清单和耗时。内部 mode 为 observe，不能作为 check 的历史策略基线。
- 不生成 recommended.yaml，也不修改项目的配置或依赖。

顶层 observed 表示所有任务通过，且已安装清单、Node 记录与开启的编译/打包记录在各自范围内完整读回；它不表示所有进程/读取都已覆盖。failed 表示任务/断言失败；incomplete 表示执行未知、没进入观察、没有 Node 记录，或有截断/损坏/未结束/编译或打包采集缺口。退出码分别为 0、1、2；中断为 130。

每个任务分别保留 verdict 和 capture_status。比如 shell 构建可以 pass，但 capture_status 为 unavailable；正常退出的失败任务也可以有完整加载记录。超时留下的已写事件仍保存，但缺结束标记不会当成完整观察。使用 JSON 中的 coverage_gaps 和 limitations 判断实际覆盖。

## 什么算一个包

主计数是安装目录实例：`@workspace/node_modules/a` 与 `@workspace/node_modules/b/node_modules/a` 分别计数，哪怕同名同版本。另列包名去重数和包名/版本去重数。加载文件归属最长匹配的已识别安装根，避免把嵌套依赖归给外层包。

支持 npm 常规提升、作用域目录及嵌套 node_modules；包识别不额外遍历包内部全部文件。`.bin` 与 `.package-lock.json` 不作为包；普通 `.cache` 目录作为辅助目录忽略并记录 ignored_entries，符号链接或其他未知条目仍是缺口。包集合来自任务启动前实际 package.json；根 declarations 说明根项目声明了这个名字，不说明每个嵌套实例都是直接依赖。

新记录保存各安装实例的声明关系、入口及文件结构摘要。它复用已有任务前文件清单，不增加完整依赖树扫描；与实际解析/加载边分别展示。结构描述已准备输入，不描述任务之后写出的文件。按包查询、上限和历史兼容见 [离线查看](offline-usage.md)。

v2/v3 锁文件记录数单独列出。可选/平台条目未实际安装是正常情况，locked_not_installed 不自动表示安装错误。目录链接、pnpm 链接布局、损坏元数据或清单上限标记 partial；不把忽略的结构算成完整。

## 观察语义与覆盖

预加载使用 Node 内置同步 resolve/load 钩子。记录成功解析和成功返回的加载调用；缓存命中可能只有解析事件。加载不说明全部代码已执行，解析也不证明一定加载。关系是本次执行的动态图，和 package.json 的声明依赖图分开。

Node 子进程默认继承内部 NODE_OPTIONS，workers 默认可继承预加载；任务清空环境、调整 worker execArgv 或使用不同加载路径时可能漏掉。报告列出收到 header 的进程/线程及 footer，不能据此声称发现了所有进程。child_process 接口记录启动尝试与预加载环境是否保留，不记录参数或环境内容；启动尝试不是启动成功证明。原生进程、shell 内部、编译器直接读取的声明/资源、原生扩展、bundler 内部等不由模块钩子覆盖。

bundle-kit 是明确的边界案例：能看到 esbuild 的 JS 包装层和原生二进制启动尝试，不能从模块钩子解释它读过的 TS 输入或 bundle 内容。原生 esbuild 包可能显示“未观察到模块加载”，尽管它实际提供了构建二进制。TypeScript 也可能读取 @types 文件而不将其作为 JS 加载。

v0.10 明确开启后采集直接 tsc 的 explainFiles；详见 [编译输入](typescript-inputs.md)。它补充类型等输入，仍不等于所有文件读取；v0.11 的 esbuild 元数据详见 [产物依赖](bundle-inputs.md)，由任务保存完整 JSON。`not_observed` 为兼容保留，仅指无模块钩子记录，不表示 unused、可删除、必需性或可撤销读取。不能将模块、编译与打包包数相加，也不强制归为工具/应用等互斥用途。

## 内部权限与资源上限

观察仅在离线任务执行时设置内部 NODE_OPTIONS，既有读写/网络规则保持。未开启编译采集时命令参数保持；开启后仅对这一次 tsc 追加 explainFiles、英文 locale 与无颜色诊断设置，实际命令写入证据。工具在 `@tmp/.permsift-observer/` 创建只含内置模块的 preload，将文件设为只读并加入后端 denyWrite；只额外允许写 logs/ 目录。预加载不授予新的项目读取或网络能力。安装和探针不注入预加载，也不加这项写例外。生效规则和例外写入 evidence。

这是额外的工具内部写能力，不是“完全没有增加权限”。脚本获得日志目录的写能力，报告仅适用于可信、受审阅任务；不能抵抗任务伪造或绕过记录，不能作为安全审计监控器。任务前后 tmp 文件变化包含内部观察文件。

每进程/线程最多 10,000 个去重事件、2 MB 日志；读回最多 64 个日志、32 MB 总字节；安装清单最多 2048 个包。超过上限、损坏记录、缺结束标记或不支持的 Node 都显式保留问题。URL 查询/片段与非文件 URL 内容被去除，child_process 不记录完整命令参数；包路径、模块请求、package.json 名称仍可能包含项目内部信息，分享报告前应审阅。

node-module-load-v3 记录 event_limit、byte_limit、text_limit、io_error；读回另识别 count_mismatch 和 missing_footer。trace_diagnostics 保存每份进程/线程日志的计数、字节、footer 状态和上限。旧 footer 只说 truncated 而没有具体原因时显示 truncation_reason_not_saved，不猜测触发哪个上限。原始模块采集 module_capture_status 与安装清单/归属问题分开；capture_status 仍保留综合缺口，整体退出码没有放宽。任务通过与采集不完整可以同时成立，见 [本轮实测](real-task-results.md)。

记录开销随模块数和进程数变化。上限限制单个生产者和报告读回，不给恶意派生进程提供宿主磁盘配额；普通子进程仍由执行器的时间/进程组清理约束。预加载及 child_process 包装可能影响行为和时序，需与相同输入的普通 run 对照。

## 前后对比

v0.12 可用 `permsift compare BEFORE_USAGE_JSON AFTER_USAGE_JSON` 离线比较已有记录，不再安装或执行任务；`permsift inspect USAGE_JSON --package NAME` 将同名包的全部安装实例按任务集中展示。来源状态和 0 字节记录保持区别，详见 [离线分析](offline-usage.md)。

observe 的 --baseline 只读入 usage.json；check 的 --baseline 仍是 verified report.json，两者不能混用。对比按任务 ID 与安装位置匹配，列新增/不再观察到的包以及同位置同名包的版本变化；新增/移除任务单独列出。

对比标出输入、配置、limits、Node/npm/系统/后端和 observer 版本变化。任务定义变化、未知执行和部分记录给出提示。编译输入有单独的包/文件/解释变化、编译器和采集器条件；打包有独立输入/输出、版本/贡献/链/external 变化与范围条件；旧版本未采集某来源时不推断整组新增。允许比较部分报告，但“没出现”不被升级为确定未使用。相同夹具应稳定；真实任务列表变化可以是有效信息，不强行要求全部场景相同，也不自动归因于依赖升级。

## 验证与收益

```sh
# 默认验证已准备好的 bundle-kit：普通一次、观察两次
npm run observe:verify

# 同时验证已有 medium:verify 产生的固定暖输入与种子
npm run observe:verify -- --medium-baseline .permsift/fast-glob-profile-XXXXXX/summary.json
```

脚本不运行 tighten；固定输入下比较任务断言、两次加载包/解析边与普通/观察耗时。fast-glob 分开配置 compile 和 compile-test，用原命令验证 TypeScript 与 Mocha 的任务差异；只使用已有暖输入，缺基线时不自动做中等项目搜索。成本比较是单机顺序样本，不能外推为普遍开销保证。

收益验收是“解释一个间接包的本次加载来源”“区分不同任务”“发现一次受控改动中的新增加载/版本变化”“明确原生工具盲区”。没有自动删依赖、观察驱动的权限候选、扩大 32 条规则上限、产物敏感内容扫描或必要权限证明。实测记录见 [validation.md](validation.md)，取舍见 [value-and-scope.md](value-and-scope.md)。
