# 两条使用路径的模型回放

这些是已保存事实的回放。模型检验没有重装依赖、重跑项目或再次搜索权限；真实后端检验另见环境记录。真实记录投影位于 `examples/model-cases/`，观察事实复用 `examples/reports/`。用 `npm run model:verify` 生成规范化模型和 summary，再用 `npm run offline:verify` 检查公开查询得到的依赖事实。

## 权限：维护现有规则

用户已经有一个构建任务和经过验证的读取规则。新代码增加对 `src/format.json` 的读取后，想知道旧规则是否还能工作，以及失败是否由权限导致。

| 材料 | 原事实 | 模型怎样解释 |
| --- | --- | --- |
| permission-baseline | 初始收缩共 27 次执行，得到 build.cjs 与 src/input.json 的读取列表 | 成功条件、当前方案、候选与恢复分别保存；只有选定 sidecar 的细项可重新判断 |
| permission-old-rule-fails | 新输入下旧规则失败，1 次执行 | 任务进程退出非 0，边界事实独立保留 |
| permission-read-change | 宽对照通过、旧规则确认失败、补充与复验通过；10 次执行、1 个候选 | 阶段仍是汇总；建议新增 src/format.json，verified 不等于已采用 |
| permission-repair-replay | 补充方案重新运行，3 次通过 | 相同任务定义、新输入、新权限；已保存进程与断言支持任务 pass |
| permission-code-error / permission-wide-rule-fails | 普通代码错误下旧规则和宽对照均失败；2 次执行、0 个候选 | 保留 unresolved_failure；宽规则失败不能证明权限是原因，不能靠继续加权限掩盖问题 |

这些来自同一次历史回归验证，生产者 v0.4.0。前后成功条件没有改变，输入和方案改变了。旧报告未声明用户保护目标，也未记录采用动作；因此模型只支持“建议经过当时复验”及“重放规则满足当时成功条件”，不声称保持了一份未保存的用户约定。

初始化：明确任务断言、可信上限，run/tighten 得到验证材料。改动后：check 检验旧规则；失败才做宽对照与受限补充。查询与审阅：读阶段和 sidecar，不再执行。采用：当前用户审阅导出文件；明确采用记录属于第五轮。

## 观察：认知依赖在不同任务中的记录

用户关注 glob-parent 是否在构建或测试中留下记录，以及升级后产物发生了什么变化。用户可以只使用观察路径，不需要先收缩权限。

| 材料 | 可以回答 | 不能据此推出 |
| --- | --- | --- |
| fast-glob-tasks.json | 507 个安装实例；compile 的 Node 钩子没有 glob-parent 模块记录，compile-test 有 1 个模块文件 | 没有记录表示没用、可以删除或可以撤权 |
| fast-glob-bundle-before / after | 已保存适配打包任务中，glob-parent 5.1.2 → 6.0.2；归因 JS 字节 934 → 1560 | 包的所有用途、完整上游构建变化或整包必要性 |
| current-observe | v0.12 上游 glob-parent 试用中 api 任务的模块/安装清单及配套过程、断言、观察器条件 | 被省略的 upstream-tests 细项不存在或没有采集 |

前两组 usage 投影没有任务进程和断言 sidecar，所以模型保存原 composite verdict，独立任务结论为 not_saved。没有编译来源时为 not_collected，而非编译输入 0 个。current-observe 同时保留 api 的过程与断言，能独立判断该任务是否通过；另一任务的细项因本投影未保留而标为 not_saved。

初始化：提供可运行任务、产物断言及明确的来源配置。执行：observe 每任务一次，安装仍可能是主要成本。再次查询：inspect/compare 只读已保存报告，零安装、零任务执行。维护：真实改动后再观察并比较各来源事实；变化不自动成为权限建议或删除建议。

打包样本是已有适配任务，不代表未修改上游构建。历史 native pilot 记录过 Mocha 升级和安装成本，完整说明在 [离线试用](offline-pilot.md)；本轮只复用其材料，不把回放成本计作首次接入成本或用户使用收益。

## 另外三个边界

- `staged-warm`：历史 v0.6.0、55 次执行。安装写规则、离线任务读写及安装复用分别表达；复用 trial 没有安装进程，最终 fresh install 的事实另存。
- `current-demo`：历史 v0.12.0、28 次执行。候选删除必要写权限失败，恢复通过；任务、边界、搜索完成分别保留。
- 合成反例：只放在 `test/model.test.ts`，测试名以 synthetic 标明，包括约定改变、采集缺失、超时恢复、缺宿主对照、缺安装过渡及读取文件变目录。它们不是真实后端运行结果。

## 来源与投影限制

每份新 fixture 包含 report、原始 config/limits 和明确选定的 evidence 字典，以及 fixture_provenance。原报告与 inputs 的文件字节 SHA-256、生产版本、历史路径和选定 sidecar 的摘要均有保存。

投影保留全部 trial 行，但只保留代表 sidecar；日志、原始后端规则、扫描和计时被省略。检查名称和详情中的绝对宿主/临时路径被替换为占位文本。config/limits 内容及顺序、旧摘要、状态、授权、进程状态与退出码、检查状态没有改变。原始 sidecar 摘要与投影自身的规范摘要用途不同。

适配所得 not_saved 常表示投影有意未保留，不是生产者当时没有检查。样本引用的 `.permsift` 路径只用于来源登记；回放不需要这些目录存在。复现本轮案例不需要原项目、网络或沙箱。
