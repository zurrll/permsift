# 沙箱内安装依赖与网络域名

v0.5 把安装作为场景的前置阶段。一个 trial 包括：独立工作区和缓存 → 边界探针 → 沙箱 npm ci → 检查锁文件/清单不变 → 再查安装边界 → 关闭网络授权并检查探针 → 当前测试或构建命令 → 新鲜产物断言和后置探针。安装未通过时不会执行后面的命令。

## 运行示例

```sh
npm run build
node dist/cli.js tighten \
  --config examples/install/permsift.yaml \
  --limits examples/install/limits.json

# 完整冷暖缓存、导出重放及旧规则回归
npm run install:verify
```

随仓库示例使用 npm 锁定的 clsx 2.1.1，验证字符串、条件对象、嵌套数组和空输入四项行为，并生成 classes.json。安装脚本默认禁用。命令最后得到的构建产物及测试报告由内置断言检查。原项目不会出现 node_modules、dist 或 reports。

完整脚本使用公开 HTTPS 注册表，速度和可用性取决于网络；报告实际记录 search_complete，无法判断或预算结束不宣称搜索完成。真实集成测试另外使用本地注册表和完整性校验的 tarball，可以稳定验证允许下载、未授权目标拒绝、恢复和停机状态。

## 配置

```yaml
schema_version: 1
project: ./project
exclude: [.git, .permsift, dist, reports, node_modules]
scenarios:
  - id: install-build
    install:
      manager: npm
      cache: cold
      registry: https://registry.npmjs.org/
    initial_network_grants: [registry.npmjs.org, example.org]
    initial_write_grants: ['@workspace', '@cache', '@tmp']
    auto_discover: false
    command: [node, verify.cjs]
    assertions:
      - type: json_equals
        path: '@workspace/dist/classes.json'
        pointer: /classes
        value: button active
```

可信 limits 必须单独提供：

```json
{
  "schema_version": 1,
  "allowed_write_roots": ["@workspace", "@cache", "@tmp"],
  "allowed_network_domains": ["registry.npmjs.org", "example.org"],
  "max_candidates": 40,
  "repetitions": 3,
  "budget_seconds": 600
}
```

域名只接受规范的小写精确主机名，拒绝通配符、URL、端口和保留探针域名。匹配该主机的所有端口，不隐含子域名授权。没有上限声明时拒绝安装设置；锁文件中的主机只作为输入信息记录，不能自动放宽。HTTP registry 仅允许 localhost / 127.0.0.1，供本地夹具使用；实际 registry 使用 HTTPS origin。

网络授权只影响 install，command 和它的探针域名列表始终为空。适配器清除 NO_PROXY 绕过列表，npm 经后端认证代理访问；直接连接、本地监听及任意 Unix socket 放行继续关闭。

未声明 install.initial_write_grants 的旧配置共用该场景的文件写规则，网络按阶段切换。v0.6 的显式分阶段配置支持独立安装写规则、任务读写与安装快照复用，详见 [分阶段说明](staged-permissions.md)。旧模式导出的是整条安装、验证流程的写范围；尚未分别搜索各阶段的写策略，也不在不同场景之间传递安装产物。

## 冷缓存与固定暖缓存

- cold：每个候选、恢复、基线及最终 trial 的 npm 缓存都从空目录开始。顶层 node_modules 必须排除，不能靠源项目已安装依赖通过。
- warm：cache_seed 必须指向输入项目中的现有目录，如 @workspace/seed。工具冻结并哈希它，每轮独立克隆到 @cache/npm；固定添加 npm --offline，缺少内容就失败，不自行联网补全。种子内不接受符号链接。

暖缓存写法：

```yaml
install:
  manager: npm
  cache: warm
  cache_seed: '@workspace/seed'
initial_network_grants: []
```

种子包含 npm 缓存目录的内容，而不是包含 npm 这一层的父目录。不要把 seed 列入 exclude；它是结果成立的输入条件。完整示例从已验证冷安装的隔离缓存创建暖种子，保留在 `.permsift/install-workflow-*/warm-project/seed`，导出文件可独立重放；删除种子后不得继续宣称无网络规则可用。

每次冷安装重新下载会花时间，这是验证下载权限需要控制的条件。写时复制减少工作区及暖种子的重复数据写入，不能免除冷下载、文件枚举、哈希或任务成本。想验证已有依赖的测试/构建权限，可继续使用普通离线场景。

## 搜索、失败与回归

安装场景先成组或逐项撤销域名，再搜索写目录。写范围改变后复查域名，域名不变时省略重复写搜索。候选通过才接受；失败或 unknown 后恢复上一策略。最终仍从相同缓存条件独立重复 repetitions 次。

DNS、连接重置、网络超时、TLS 和注册表 5xx 记 unknown。网络候选安装失败但没有捕获到独立的代理域名拒绝，同样不能建立必要性结论；成功恢复也不把这种 unknown 改成 rejected。恢复失败停止搜索为 unstable。锁文件不匹配、依赖行为错误或缺失产物可以是明确失败，但不能自动当成网络权限原因。

check 可导入最终安装域名。锁文件升级引发新主机拒绝时，只在当前对照域名和可信上限内生成补充，并实际安装、断网运行和重复验证。缓存模式、安装开关变化要求新基线。成功建议增加 added_network 字段，CI 仍返回回归退出码 1。

## 证据与范围

report.json 的 network_policies / network_searches 保存最终候选域名、每次变更和恢复；inputs.installations 记录清单及锁文件哈希、锁定下载主机、缓存条件和暖种子哈希。environment.npm 记录安装工具版本。

每个 evidence 保存 workspace_fork、install_cache、installation 的命令/有限日志/生效策略/拒绝事件、输入不变检查、after_installation、before_offline_task 和真正的 task。被跳过的命令使用 task_skipped 表明，不伪造任务成功。

后端每次调用使用独立 worker。真实命令结果发送后，若代理的 CONNECT 半关闭连接卡住清理，父进程最多等待 1 秒，再结束该 worker 并确认退出；execution.backend_cleanup.forced 记录此事。没有真实命令结果、执行超时、取消或清理报错仍为 unknown。每次 worker 启动会增加一点执行开销；它把后端状态及代理连接限制在该次调用内。

首版要求 Node 旁边可用的 npm、package-lock v2/v3、完整性校验的 registry tarball。拒绝项目 .npmrc、npm-shrinkwrap、workspaces、Git/file/link 依赖或私有凭据配置。安装器保留工作区读取。旧模式不做动态依赖读取搜索；v0.6 分阶段模式可对安装后的任务搜索项目和包读取。需要 postinstall 构建的包通常无法通过后续行为验证；未来应把生命周期脚本设计成独立权限阶段。

域名授权不约束 URL 路径或返回内容，也不是供应链信任证明。固定锁和完整性校验只覆盖声明的安装输入。macOS、SRT 和文件系统边界仍有 [安全说明](security.md) 中的范围限制。

依据：[npm ci 官方行为](https://docs.npmjs.com/cli/v11/commands/npm-ci/)、[Sandbox Runtime 官方说明](https://github.com/anthropics/sandbox-runtime#network-isolation)。实现针对仓库锁定的 SRT 0.0.77，并以本地真实测试核对行为。
