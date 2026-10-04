# 一步步手工试用

这轮由你实际操作，记录第一次接入时看到什么、哪里卡住，以及报告是否帮你作出判断。自动验收已由开发流程覆盖；这里先不运行完整测试套件、权限搜索或外部项目冷安装。

分四段进行，一段结束再继续。每段保留原始输出、完整结果目录、大致等待时间和难懂的地方。遇到错误就停在该步骤，反馈命令和完整错误；不要先反复重跑或放宽权限。

当前默认终端使用中文摘要；下文 verified / compatible / observed 是对应的 JSON 状态。需要更多依据时使用 `inspect 结果目录 --details`，不用重新执行项目。默认摘要、详细模式及进度说明见 [终端展示](terminal-output.md)。

## 1. 全新克隆、安装、检查环境

需要 macOS、Node 22.15+ 或 23.5+ 与配套 npm。任务后端需系统 sandbox-exec；本项目在 macOS 15.8 / Node 24.21.0 实测，其他环境要由实际 doctor 结果确认。

打开终端，进入你选的父目录；确保还没有 permsift-try 文件夹，然后逐条执行：

```sh
git clone https://github.com/zurrll/permsift.git permsift-try
cd permsift-try
node --version
npm --version
npm ci --ignore-scripts
npm run build
node dist/cli.js doctor
```

成功时 doctor 应为 verified。先反馈 Node/npm 版本、doctor 原始输出，以及安装或构建是否需要猜测、额外步骤或修复。这段有一次工具安装和一次环境检查，没有项目权限搜索。

## 2. 建立规则，体验一次变更后的复验

本段的问题是：“这些任务能否在当前规则下完成？我改了项目实现后，已经采用的规则是否还能使用？”在新克隆的仓库根目录执行：

```sh
node dist/cli.js explain --config examples/demo/permsift.yaml --limits examples/limits.json --for run
node dist/cli.js run --config examples/demo/permsift.yaml --limits examples/limits.json --output .permsift/manual-permission
node dist/cli.js inspect .permsift/manual-permission
```

先试着从报告回答：任务与成功条件是什么、用了哪些权限、什么已经验证、什么尚未验证、怎样找到依据。读不懂的地方记录下来，不必替工具解释。示例两项任务各重复三次，共六次执行，没有额外依赖安装。run 验证的是初始规则，并没有收缩权限。

理解结果并决定采用后执行：

```sh
node dist/cli.js adopt .permsift/manual-permission --config examples/demo/permsift.yaml --limits examples/limits.json --output .permsift/manual-baselines --reason '手工审阅后采用演示任务的初始规则'
```

在编辑器中打开 examples/demo/src/invoice.js，把 subtotal 中的 reduce 那一行改成等价的循环，保留前面的输入检查与其他代码：

```js
let sum = 0;
for (const item of items) sum += item.cents * item.quantity;
return sum;
```

然后只复验旧规则：

```sh
node dist/cli.js check --config examples/demo/permsift.yaml --limits examples/limits.json --baseline .permsift/manual-baselines --output .permsift/manual-check
node dist/cli.js inspect .permsift/manual-check
```

预期 compatible，另六次任务，零搜索。记录报告是否能说明输入变了、任务约定与权限有没有变化，以及结论的范围。本段两次执行共十二次任务、零额外安装；不把一次等价改写通过当作长期维护收益。

## 3. 独立观察，解释一次输入变化

本段的问题是：“这次构建记录了什么？增加一个源码输入后，比较能不能指出它？”不需要先建立或采用权限基线。

```sh
node dist/cli.js explain --config examples/projects/bundle-kit/observe.yaml --limits examples/limits.json --for observe
npm run examples:prepare
node dist/cli.js observe --config examples/projects/bundle-kit/observe.yaml --limits examples/limits.json --output .permsift/manual-observe-before
node dist/cli.js inspect .permsift/manual-observe-before
node dist/cli.js inspect .permsift/manual-observe-before/usage.json --package esbuild
```

examples:prepare 显式在宿主安装两个示例的固定依赖，禁用脚本；观察只构建一次。尝试说明模块加载与产物输入各在回答什么，报告有没有使你误以为“未观察就是没用”。

新增 examples/projects/bundle-kit/src/identity.ts：

```ts
export const identity = (value: number): number => value;
```

把同目录的 index.ts 改为：

```ts
import { identity } from './identity';
export interface Item { price: number; quantity: number }
export const total = (items: Item[]): number => identity(items.reduce((sum, item) => sum + item.price * item.quantity, 0));
```

再次观察并比较保存记录：

```sh
node dist/cli.js observe --config examples/projects/bundle-kit/observe.yaml --limits examples/limits.json --output .permsift/manual-observe-after
node dist/cli.js compare .permsift/manual-observe-before/usage.json .permsift/manual-observe-after/usage.json
```

预期构建通过，产物输入变化能找到 @workspace/src/identity.ts。没有包版本变化是正常的；这里只增加源码输入。记录你是否能找到变化、依据和未采集范围。本段两次构建、两次显式示例安装，第二次观察不再安装，查询和比较不执行项目。

## 4. 带一个自己的真实问题接入

前面只检验基本使用。最后选一个你平时会跑的测试或构建，先写下你想据此作出的决定，例如保护源码不被测试改写，或确认一次升级改变了哪些依赖记录。

把项目的技术栈、原命令、已有依赖/安装方式、可检查的成功条件，以及要回答的问题反馈回来，再围绕一个任务制定配置和可信 limits。先不默认运行全部任务或完整权限搜索；接入记录与实际收益分别评价。

每段可以使用 [反馈模板](trial-feedback.md) 记下阻碍、成本、决定和后续验证。你的手工试用能提供理解与操作反馈；若仍在同一机器上，它不替代另一环境或第三方用户的验证。
