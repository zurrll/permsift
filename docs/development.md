# 开发与测试

## 安装和构建

```sh
npm ci --ignore-scripts
npm run build
npm run check
```

依赖精确固定在 package.json 和 package-lock.json。TypeScript 输出位于 dist/；源码是 CLI 入口 cli.ts 及 src/ 下的模块。工具尚未发布，直接通过 node dist/cli.js 使用。

## 测试分层

```sh
# 单元和宿主组件测试
npm test

# 真实沙箱测试，仅 macOS
npm run test:integration

# 从头运行演示
npm run demo

# 准备并在沙箱中运行三个代表项目（准备时联网）
npm run examples:prepare
npm run examples:verify

# 读取收缩演示与第三方原始构建（准备时联网）
npm run demo:read
npm run third-party:prepare
npm run third-party:verify

# 构建 Permsift 自身，并启动产物验证 CLI 版本
npm run self:verify
```

| 测试文件 | 关注的问题 |
| --- | --- |
| config.test.ts | 路径穿越、未知配置、最高权限、错误缩小、重复配置 |
| filesystem.test.ts | 快照独立性、依赖目录保留、内部与外部链接、哈希、输出差异 |
| assertions.test.ts | 跳过测试、缺失测试、重复结果、JSON 类型、宿主读取限制、unknown |
| search.test.ts | 实际收紧、必要授权、恢复失败、预算和非单调执行路径 |
| discovery.test.ts | 跨基线观察合并、上限、链接、有界枚举和候选实际验证 |
| diagnostics.test.ts | 拒绝来源与路径、普通错误和超时、归因限制 |
| junit.test.ts | 嵌套报告、缺失/失败/跳过/重复用例、错误 XML、DTD 和深度上限 |
| process.test.ts | 参数引用、输出上限、超时、取消、普通后台子进程清理 |
| probes.test.ts | 不存在的资源、停机端点和夹具篡改 |
| read.test.ts | 独立读上限、候选与恢复、完整枚举、精确后端规则和读探针对照 |
| cli.test.ts | 帮助、版本、明确 limits、未知选项 |
| integration/sandbox.test.ts | 真实读写拒绝、文件收缩、读写联合非单调行为、文件替换目录、自动发现、临时操作、JUnit、准备状态复测与重放、旧产物、超时和中断 |

单元测试可以在 Linux 上运行。集成测试在其他平台显示 skip；这表示未验证该平台，不表示隔离通过。macOS 上出现后端异常时测试应失败，不能临时改成 mock 或无条件跳过。

CI 配置包含 Linux 单元测试与 macOS 完整测试。新增 CI 文件不代表远端已执行，实际远端状态需在推送后查看。

## 添加任务案例

为示例项目增加一个能独立产生确定结果的命令，定义成功断言和初始写范围。先确认 run 多次通过，再设计一项可被缩小的授权，以及一项不能撤销的授权。

优先添加失败案例：旧产物、不完整测试结果、恢复后仍失败、超时、链接和失活的对照资源。它们能检查工具是否错误接受候选。

## 修改后端或搜索算法

- 后端固定配置改变时，检查 effective policy 和全部真实探针。
- 搜索器可以使用模拟评价函数测试决策逻辑，但不能以此替代后端集成测试。
- 不根据单次访问轨迹自动把访问升级为必要授权。
- 保留原始失败与恢复证据，unknown 不得被转换成 pass。
- 若增加并发，先处理 SRT singleton、进程清理、端点和证据隔离。

## 调试失败实验

使用 `--keep-workspaces` 保留副本，报告中的 workspaces 给出绝对路径。查看失败 trial 的 evidence 文件，依次区分对照检查、探针、任务进程和产物断言。

保留的工作区不会自动重用。完成检查后，可自行清理报告所指向的本次临时目录；不要使用宽泛的 /tmp 通配符删除其他实验。
