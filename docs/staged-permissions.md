# 安装与任务分阶段权限

v0.6 在一个场景中支持「安装 → 任务」两段实际策略。任务仍是现有 command，可以运行测试、构建或其他离线命令。安装阶段保留完整工作区读取；安装后的任务可独立收缩项目读取和目录写入。每个场景独立验证，场景间不传递产物。

## 配置与兼容

在 install 中显式声明 initial_write_grants 即开启分阶段模式，包括空数组。顶层 initial_write_grants / initial_read_grants 只描述任务阶段；initial_network_grants 仍只用于安装。两段的写规则都受独立可信 limits.allowed_write_roots 约束；任务读取要求 allowed_read_roots，域名要求 allowed_network_domains。

```yaml
schema_version: 1
project: ./project
exclude: [.git, .permsift, node_modules, dist, reports]
scenarios:
  - id: build
    install:
      manager: npm
      cache: cold
      initial_write_grants: ['@workspace', '@cache', '@tmp']
      narrower_candidates:
        - from: '@workspace'
          to: ['@workspace/node_modules']
    initial_network_grants: [registry.npmjs.org]
    initial_write_grants: ['@workspace']
    initial_read_grants: ['@workspace']
    command: [node, build.cjs]
    assertions:
      - type: file_exists
        path: '@workspace/dist/result.json'
```

install.narrower_candidates 是安装写规则的手工候选，install.auto_discover 控制安装写目录自动发现（默认开启）。顶层同名字段用于任务。候选仍必须是原规则的严格子路径，并在可信写上限内。两段自动观察分别记录安装变化和任务变化。

未声明 install.initial_write_grants 的 v0.5 配置继续共用安装与任务写规则，不启用安装快照复用，也不能开启安装后读取搜索。旧离线场景保持原有行为。切换旧基线的阶段模式或读取模式需要建立新基线，不能直接混用两种结果。

可运行示例：[场景](../examples/staged-install/permsift.yaml)、[可信上限](../examples/staged-install/limits.json)。

```sh
npm run stages:verify

# 单独收缩冷缓存的安装与任务规则
node dist/cli.js tighten \
  --config examples/staged-install/permsift.yaml \
  --limits examples/staged-install/limits.json
```

导出仍是一份 recommended.yaml：install.initial_write_grants 保存安装规则，顶层读写保存任务规则。run 会从原始输入重新安装并切换策略，不依赖实验期间的快照。check 保留阶段规则，验证旧规则或给出受限补充。

## 搜索与最终验收

1. 从原始冻结输入独立重复完整基线。
2. 生成两段写候选；统一目录准备变化后重新确认完整基线。
3. 收缩安装域名和安装写规则；每个安装候选及恢复都重新安装并执行任务断言，任务此时保留初始策略。
4. 用已接受安装规则重新安装，冻结安装后状态，再执行任务。只有整个 trial 通过，才发布这份快照。
5. 在快照的独立副本中收缩任务读写；失败后恢复同一冻结输入的任务策略复测。任务读取变化后复查任务写入，写入变化后复查读取。
6. 最终 repetitions 次全部从原始输入、相同冷/暖缓存条件重新安装，切换最终任务策略并检查新鲜产物、断言与边界。

安装候选、基线、冻结来源、最终验收和 run/check 不省略实际安装。仅固定安装策略之后的任务候选及恢复复用快照。注册表故障可以使最终验收 unknown；此前缓存候选通过不能替代最终成功，无法导出 recommended.yaml。

安装策略先搜索，任务策略随后在固定安装状态下搜索。这是有界的阶段顺序，未枚举所有跨阶段组合。search_complete 表示各阶段记录的有限候选已经比较完；不是跨阶段共同最优或全局最小权限证明。候选预算是两段共用的，总时间预算和最终复验预留仍然生效。

## 快照的内容与失效

冻结工作区、npm 安装后的缓存和临时目录，保留后续任务可能使用的状态。捕获发生在任务和项目读取探针执行之前，经过目录准备并清除任务断言的旧输出。每次实际任务再清除输出，防止旧报告假通过。

快照只存在于本次实验的私有工作目录中，默认结束后清理，没有跨实验的持久缓存。键绑定：完整原始输入哈希、package.json / 锁文件及暖种子信息、安装配置、实际安装写规则和域名、目录准备、可信 limits，以及系统/架构、Node、npm、SRT、Permsift 版本。

捕获与克隆分别核对三个根的内容、文件/目录模式和内部符号链接摘要。源状态变化、缺失快照、克隆不一致、外部链接、预算结束或取消保持 unknown。每个候选得到独立 inode 的副本，原地修改、chmod 或删除依赖不会影响其他轮和冻结来源。扩展属性、ACL、mtime 和物理块共享不在摘要证明范围内。

写时复制仍要枚举文件、创建目录项和核对内容哈希；安装快照还需保存一份安装状态。它减少重复安装，不免除这些开销。路径依赖或无法移动的生成产物可能无法在副本中运行；不因此退回原项目执行。

## 任务读取与缓存

读取候选来自安装后实际存在的输入树。node_modules 按包目录生成候选，支持 @scope/package，首版不继续展开包内部文件；其余项目输入沿用有界枚举。未枚举完的子项不构造完整替换规则，目录/条目预算及 32 项授权上限仍可能使整个父目录保留。报告标注 truncated，没有把没检查的包宣称为可删。

静态依赖声明、目录存在或一次访问记录都不能证明授权必需。每个候选仍执行真实任务、检查断言和探针，失败后恢复。文件授权保持精确类型；生成的依赖目标在安装后检查，不在安装前把缺失 node_modules 当成输入丢失。

任务不继承安装写授权。只读依赖的任务可以撤销全部依赖写范围；确实需要 node_modules/.cache 的任务可以保留这一小块。写候选目录在安装后再次准备，避免 npm ci 清理 node_modules 导致准备丢失。两段共用记录的目录准备条件，导出重放会恢复这些条件。

两段各自有真实边界探针；任务及其前后探针始终断网。项目读取探针在安装后建立，按实际任务读授权检查允许/拒绝，且受到写保护。

## 报告与回归

report.json 增加 install_policies / install_searches / install_discovery。原 policies / read_policies 表示任务读写；network_policies 表示安装域名。trial.install_grants 记录安装写范围，installation_reused 区分实际安装与任务快照副本。

installation_stats 分别统计 executed（实际 npm 调用）、reused（成功克隆供任务运行）与 snapshots（通过完整来源试验后发布的快照），并记录键和根哈希。设置失败或取消时，计数之和可能少于 trial 数；计数不伪造执行。

evidence.installed_snapshot 记录快照键、哈希、克隆方式和 source_trial；这一轮没有 installation 命令结果，不把旧安装记录伪装成新执行。冻结来源的 snapshot_created 与实际 installation 可互相追溯。所有阶段仍保留生效后端配置和失败解释，执行失败说明 install/task 来源。

check 导入分阶段基线时，必须找到最终规则下完整重新安装通过的证据，不能用仅复用快照的任务 trial 顶替。历史生成依赖的文件/目录类型在当前重新安装后核对。补充建议分别记录 install_write / added_install_write、任务 read/write 和安装 network；任务读取修复不会顺带扩张安装写权限。

当前仍使用 npm ci --ignore-scripts、v2/v3 注册表锁文件及相同的冷/暖缓存定义。生命周期脚本、安装器自身读取收缩、其他包管理器和任意阶段流水线未加入本版。实际验收记录见 [validation.md](validation.md)。
