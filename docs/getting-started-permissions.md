# 用任务验证并维护权限

适合的问题是“这组任务能否在指定权限下完成”，以及“改代码或依赖后，已经审阅的规则是否仍有效”。先选真实任务与可信的成功条件；收缩针对有价值的范围，例如工作区写入、私人配置读取或安装网络。

以下命令在 Permsift 仓库根目录运行，要求已安装工具依赖并 build；真实任务需要 macOS 与通过的 `doctor`。示例 limits 仅用于审核过的示例，自己的项目要明确批准上限。再次执行时请换新输出目录名。

```sh
node dist/cli.js explain --config examples/demo/permsift.yaml --limits examples/limits.json --for run
node dist/cli.js run --config examples/demo/permsift.yaml --limits examples/limits.json --output .permsift/permission-start
node dist/cli.js inspect .permsift/permission-start
```

订单测试与构建默认各重复三次。原项目不受产物删除/写入影响；任务、产物断言、边界和声明的保护目标一起决定验证。run 通过只证明初始方案完成本次验收。

初始写权限过宽、确实希望收缩时，再执行：

```sh
node dist/cli.js explain --config examples/demo/permsift.yaml --limits examples/limits.json --for tighten
node dist/cli.js tighten --config examples/demo/permsift.yaml --limits examples/limits.json --output .permsift/permission-trim
node dist/cli.js inspect .permsift/permission-trim
```

典型结果是测试写入缩到 `@workspace/reports`，构建缩到 `@workspace/dist`，撤销缓存写权限。查看最终验证与搜索缺口；候选失败后恢复通过提供本次比较依据。基线与最终验证各重复三次，候选、准备确认和恢复另计；搜索完成不等于全局最小。

审阅后明确采用，之后改代码/依赖直接复验：

```sh
node dist/cli.js adopt .permsift/permission-trim --config examples/demo/permsift.yaml --limits examples/limits.json --output .permsift/permission-baselines --reason '审阅任务结果后采用产物目录写权限'
# 正常修改自己的项目后执行
node dist/cli.js check --config examples/demo/permsift.yaml --limits examples/limits.json --baseline .permsift/permission-baselines --output .permsift/permission-check
node dist/cli.js inspect .permsift/permission-check
```

无需收缩时，已验证的 run 也可作为 adopt 来源。check 通过表示当前任务在旧规则下完成本次验证；改命令、成功条件或保护目标时，即使任务通过也可能需要审阅新约定。失败不一定是缺权限，先看宽对照和具体原因；建议不会自动被采用。

自己的配置见 [配置参考](configuration.md)。敏感范围见 [保护目标](protection-goals.md)，安装见 [分阶段权限](staged-permissions.md)，检查产物断言能力见 [成功条件诊断](success-diagnostics.md)。不要为普通公开依赖的逐包读取默认开展大量实验。
