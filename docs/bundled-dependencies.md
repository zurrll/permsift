# 内嵌依赖安装兼容性

有些 npm 包发布时已把依赖装入自己的 tarball。安装父包会同时解包这些依赖，因此锁文件的 `inBundle: true` 条目可能没有独立 `resolved` 和 `integrity`。原预检逐条要求下载地址和完整性字段，曾在 glob-parent 5.1.2 / nyc 13.3.0 的真实接入中拒绝 137 个这样的条目。

现在支持能够从 v2/v3 锁文件确认归属的内嵌依赖。现有配置不需要增加开关；安装仍使用 `npm ci --ignore-scripts`，独立可信 limits 仍约束网络、读写和执行预算。

## 如何确认来源

1. 独立下载的包继续要求受支持的 registry tarball URL 和 SRI；npm ci 验证实际 tarball 完整性。
2. 父包通过 `bundleDependencies` 或 `bundledDependencies` 声明直接内嵌包。支持包名数组和布尔声明；相互矛盾或重复声明被拒绝。
3. 从直接包沿 `dependencies` / `optionalDependencies` 查找传递依赖，按 npm 嵌套目录逐层解析，支持作用域包、内部提升和环。查找停在父包目录，不用外部包为内嵌条目建立归属。
4. 每个 `inBundle` 条目必须能关联到具有下载地址和完整性依据的父包。孤立标记、路径异常、符号链接依赖、错误归属和缺少父包完整性均不能放行。内嵌条目若同时提供下载信息，仍完整检查这些字段并记录域名。

子包的完整性依据是包含它的父 tarball；没有为子包虚构独立 SRI。这不证明包代码安全，也不提供报告生产者认证。

## npm 成功后还检查什么

真实反例表明：锁声称某个内嵌包存在，但父 tarball 缺少它时，npm ci 可以退出 0。因此安装结束后、项目命令及安装快照捕获前，工具还读取实际包元数据：

- 父包和内嵌包必须存在，名称与版本匹配锁文件；父包实际内嵌声明与记录一致。
- 元数据只读取工作区内的普通文件，每文件最多 1 MiB，不跟随目录或文件链接。
- 明确缺失、名称/版本或声明不同为失败；读取不可确认、超限、取消或时间耗尽为未知。
- 未通过时跳过项目命令，不发布可复用安装快照，不导出已验证方案。安装结果独立参与 trial 判断，即使其他产物断言通过也不能覆盖它。

检查成本计入既有 `install` 分项；仅读取这些包的 package.json，不增加安装次数、任务次数或权限候选。现有前后边界、输入哈希及锁/清单不变检查继续保留。

## 保存与再次使用

`report.json` 与 `inputs.json` 的 `inputs.installations.<task>.bundled` 保存父包、内嵌实例及归属。每次实际安装的 sidecar 中，`installation.bundled_checks` 保存逐项结果。Markdown 安装说明显示实例及父 tarball 数量。

普通报告读回、原始基线导入和 adopt 核对完整通过记录，拒绝缺失、重复、错误名称或失败检查被标成安装通过。adopt 保存最终 sidecar；清理原报告后仍可检查这些材料。旧输入没有内嵌声明时，继续按旧格式读取，不倒填新检查。原生五对象中的安装结果沿用已有 `reported_verdict`，详细核对记录留在对应 sidecar；没有改写旧身份公式。

依赖观察继续枚举实际安装目录，内嵌包按独立位置和版本参与统计与模块归属；不把父包一次下载误算成只有一个安装实例。

## 复现

在受支持的 macOS 环境、仓库根目录运行：

```sh
npm run bundled:verify
```

默认使用本地 HTTP 注册表和自包含 tarball，不访问公开 npm 注册表。通过公共 CLI 验证 run → adopt → check → observe → 清理项目后 inspect。三次独立安装只请求三个父 tarball；每次包含作用域子包及提升到同一父包目录的传递包。父包和子包的 postinstall 均保持禁用；任务断网。

真实 glob-parent 试用需要固定上游提交和锁文件：

```sh
npm run bundled:verify -- \
  --upstream-source /absolute/path/to/glob-parent-checkout \
  --upstream-lock /absolute/path/to/frozen-package-lock.json
```

脚本从本地 Git 对象导出固定提交 `eb2c439de448c779b450472e591a2bc9e37e9668` 到新目录，不改变已有 checkout；复制指定锁，保持源码、测试和 package.json 原样。只观察原 `npm run azure-pipelines` 一次，无额外 reporter 参数、包装脚本或权限搜索。证据、日志和配置写入新的 `.permsift/bundled-validation-*`。

新使用者可以克隆 [glob-parent](https://github.com/gulpjs/glob-parent)、在这个提交的独立 checkout 中用 `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` 准备锁，再传给脚本。这一步生成锁元数据，真实安装在沙箱里；新解析的普通传递依赖可能与本机固定锁不同，不能声称重现了同一输入。仓库提供 [任务配置](../examples/third-party/glob-parent/permsift.yaml) 和独立 [limits](../examples/third-party/glob-parent/limits.json)。

## 支持边界

归属图不支持仅靠 peerDependencies、锁文件缺失信息、workspaces 或链接布局来推导内嵌来源。声明的内嵌包必须实际存在；平台或可选安装省略不被假定为通过。需要 preinstall/install/postinstall 才可用的依赖仍可能无法执行后续任务，这需要另行设计脚本阶段。

依据：[npm 锁文件字段及内嵌安装](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/)、[bundleDependencies 声明](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bundledependencies)。本机实测及成本见 [验证记录](validation.md)。
