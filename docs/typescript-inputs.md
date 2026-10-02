# TypeScript 编译输入观察

v0.10 回答一个具体问题：某个包虽然没有 Node 模块加载记录，它的声明文件或源码是否进入了本次编译、为什么进入？使用 TypeScript 的 [explainFiles](https://www.typescriptlang.org/tsconfig/explainFiles.html) 输出，不推断全部读取、实际执行、产物组成或必要权限。

## 配置与执行

在原有场景中明确开启：

```yaml
command: [node, node_modules/typescript/bin/tsc, --skipLibCheck]
observation:
  typescript:
    compiler: '@workspace/node_modules/typescript'
```

compiler 指实际安装的 TypeScript 包目录，须在本次安装清单中识别为 name=typescript。首版仅接受直接 `node <该目录>/bin/tsc`；Node 可为绝对路径，tsc 路径必须相对于项目。npm scripts、shell 包装、Node 额外启动参数、构建/监听模式、response files 和其他输出诊断模式不支持；不自动拆解串联任务。项目引用、增量状态或其他配置导致不产生可识别解释时，报告仍保留任务结果，编译记录不能当作完整。

仅 observe 对这一次命令追加 `--explainFiles --locale en --pretty false`，不更改项目 tsconfig，也不再运行第二次编译；这三个参数覆盖原有同名诊断设置。run/tighten/check 执行原命令。原命令、实际观察命令、编译器包版本和采集器版本都记入证据。既有权限、安装、离线执行、产物新鲜度和边界检查保持；输出取本次进程的 stdout，不导入可能陈旧的解释文件。

可运行的上游示例：

```sh
npm run build
npm run medium:prepare
node dist/cli.js observe \
  --config examples/third-party/fast-glob/observe.yaml \
  --limits examples/third-party/fast-glob/limits.json \
  --output .permsift/fast-glob-inputs
```

示例固定 fast-glob 上游源码与锁文件，在沙箱内冷安装 npm 依赖，随后断网直接编译；只编译，不自动运行其测试。原有 compile-test 场景仍可用于模块观察，但其 verify.cjs 包装中的 tsc 不在本采集器支持范围。冷安装依赖网络；已有固定暖种子可用于下方验证脚本，不必重新做权限搜索。

## 如何读报告

usage.json 的任务新增可选 compilation 字段：来源与版本、编译器安装位置/版本、实际命令、stdout 哈希/字节数、采集上限、files、packages、issues 和 capture_status。文件按最长已识别 npm 安装根归属包实例，保留多个解释；声明文件单独标为 declaration。平台 TypeScript 包中的标准库也按其实际位置归属，不硬归给 JS 包装层。

usage.md 的“Package evidence by source”并列每个包的 Node 模块加载记录数和 TypeScript 输入文件数。同一个包可两列都有记录；无记录和未采集分开。原 not_observed 字段保留向后兼容，始终仅指无模块钩子记录，即使该包存在编译输入证据，也仍可能在这个列表中。摘要与列表旁直接标明这不是未用依赖计数。

例如，fast-glob 本次有 1 个包的 Node 模块加载记录；TypeScript 4.9.5 输出 216 个编译文件、归属 25 个包实例，包含安装的 11 个 @types 包。`@types/micromatch/index.d.ts` 的原因包括从 `@workspace/src/utils/pattern.ts` 导入。这说明类型文件参与编译，不说明该包 JS 已执行或完整进入了产物。

工具包、编译输入、产物依赖不是互斥类别。v0.11 增加可选 [esbuild 打包来源](bundle-inputs.md)，按各自任务并列显示记录，仍不自动判断工具专用、依赖必要性或权限。

## 状态、格式与上限

任务 verdict、Node capture_status、compilation.capture_status 分开。compiled 输入 captured 表示编译成功、收到有解释的文件、安装归属与当前解析范围无已知缺口；不表示全部文件 I/O 已覆盖。没有解释是 unavailable；有效前缀后遇到未知格式、截断、失败、超时或归属缺口是 incomplete。开启的采集器不完整会让顶层 usage 状态为 incomplete，即使产物断言通过。退出码含义沿用 observe。

当前实测 TypeScript 4.9.5 的英文两空格解释和 7.0.2 的英文三空格解释。explainFiles 是诊断文本；未知原因/布局显式报缺口，不把未来格式当作空输入。中文或其他 locale 被观察命令的 en 覆盖。版本号来自已安装包，合作式可信任务仍可能伪造输出；不是抗篡改审计。

TypeScript 7.0.2 在本机 Node 24 上通过 process.execve 替换为原生进程。编译输入可以完整收到；Node preload 的 exit handler 不执行，因此模块日志没有 footer。报告记录 execve 尝试与原生覆盖缺口，模块记录保持 incomplete，顶层退出 2，不为得到“全绿”忽略缺 footer。[Node execve 说明](https://nodejs.org/api/process.html#processexecvefile-args-env)

解析最多 2 MB stdout、4096 个文件、每文件 64 个原因、每行 4096 字符；遇到边界保留有用前缀并标为 partial。任务 stdout/stderr 总量仍受可信 limits.max_output_bytes 限制，先超过它时执行器停止进程并记 unknown；诊断较多时可在可信 limits 中明确调大到 2,000,000。采集不会自行扩张上限。解释路径规范为项目别名，外部路径保留 basename 并报归属缺口；原始 stdout 在任务证据中，分享前仍需审阅。

## 前后对比与验收

用 observe --baseline 上次 usage.json，分别比较模块与编译输入。后者展示新增/不再记录的包和文件、同位置同名包的版本变化、同文件的解释变化；同时提示采集器、编译器、实际命令、输入与环境变化。只有一边采集（包括 v0.9 基线）时显示 unavailable，不把全部输入报告成“新增加依赖”。部分记录的差异只作部分观察，不能据消失项删包或撤权。

```sh
# 小型受控类型专用夹具：普通一次、观察一次、引用改动后再观察一次
npm run compile:verify
# 加入已有固定 fast-glob 暖输入：普通编译一次、观察编译一次
npm run compile:verify -- --medium-baseline .permsift/fast-glob-profile-XXXXXX/summary.json
```

脚本不执行 tighten。夹具中 type-a/type-b 有会抛错的 JS 入口，实际只 import type；替换引用后，编译输入列变化而 JS 加载列不变，同时检出 ambient 声明包版本变化。夹具使用本地安装编译器及平台包的独立副本；不是第三方实际项目。fast-glob 复用固定真实源码、锁文件与暖种子，验证真实来源解释和新产物；逐项成本在 summary.json。单机少量执行不构成性能保证，输入统计也不能替代用户收益验证。

验收强调“解释一种此前漏掉的类型依赖、解释受控改动”；未证明节省了多少人工时间，也未证明观察能降低权限搜索次数。见 [实测记录](validation.md) 和 [收益取舍](value-and-scope.md)。
