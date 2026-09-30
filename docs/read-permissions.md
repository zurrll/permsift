# 项目读取权限收缩

v0.3 在 macOS 上搜索项目内的文件内容读取授权。系统运行时、缓存、临时目录和工作区根目录访问保持固定。旧场景文件仍能运行，不会自动改变原有读取策略。

## 开启方式

场景中声明初始读取范围：

```yaml
initial_read_grants: ['@workspace']
auto_read_discover: true
```

同时在可信 limits 中声明上限：

```json
{
  "schema_version": 1,
  "allowed_write_roots": ["@workspace", "@cache", "@tmp"],
  "allowed_read_roots": ["@workspace"],
  "max_candidates": 150,
  "repetitions": 3
}
```

用 `npm run demo:read` 运行完整示例。自己的任务仍需定义 command、initial_write_grants 和新产物断言。max_candidates 是所有任务读写搜索的共同预算；恢复、基线和最终验证不计入候选次数。

initial_read_grants 缺省表示 legacy：工作区整体可读，不参与读取搜索。空数组表示 explicit：没有可变的项目文件内容读取授权；例如只使用 Node 内置模块的内联命令可以这样运行。允许数组中的文件或目录授权重叠，但不允许重复。

## 文件和目录的含义

- 目录授权包含其子树，例如 @workspace/src。
- 普通文件授权只允许该路径本身，例如 @workspace/src/input.json。
- 只能声明 @workspace 及其子路径；不支持任意外部输入路径。
- 目标必须在任务启动前存在，且目标与祖先不能是符号链接。读输入不会被自动创建。
- 写候选及 prepare_directories 可以提前创建输出目录；之后允许读取该输出目录，任务便能加载本轮产物。
- 文件断言由宿主执行，不需要向任务授权读取断言文件。若任务自己读取它，则仍需读取授权。

SRT 将普通路径编译为递归 subpath。Permsift 对文件使用内部生成的锚定 glob，例如 `/run/workspace/src/[i]nput.json`，使其仅匹配一个路径；用户配置依然禁止 glob。每轮启动时冻结文件/目录类型，任务把文件改成目录也不会让后置探针变成递归授权。strict 模式下，实际路径包含 `*`、`?` 或方括号会被拒绝，避免后端误解路径造成扩权。

Node 的 process.cwd() 需要工作区目录访问。执行器固定授予工作区根目录本身的读取与列举能力，使用同样的精确模式；这不会授予任意子文件内容读取。SRT 还保留固定的元数据访问等基础规则，所以这轮结果不能用来宣称文件名和存在性被隐藏。读取搜索不缩小这些基础能力。

真实集成测试确认：允许写整个工作区不会自动允许读取其中未授权的文件。读写范围必须分别配置。

## 候选和联合搜索

输入结构在基线任务启动前枚举，区分普通文件和目录，不跟随符号链接。max_read_discovery_entries 默认 128，max_read_discovery_depth 默认 3。只有完整列出的直接子项才生成父目录替换规则，每个候选不超过 32 项。无法安全列举的目录保留较粗授权，报告标注 truncated。

读取搜索先尝试成组或逐项删除授权，再展开仍需保留的目录。这样可以直接删除无关测试树或依赖包，避免逐个尝试其文档文件。自动结构只提供候选，不说明哪些输入“已经被证明必需”。每项修改都执行真实任务、产物断言和边界检查。

手工补充规则可写为：

```yaml
auto_read_discover: false
narrower_read_candidates:
  - from: '@workspace'
    to: ['@workspace/package.json', '@workspace/scripts/build.mjs', '@workspace/src', '@workspace/dist']
```

失败或 unknown 后恢复之前的读取规则，在新的干净副本中复测。恢复失败会停止搜索并记为不稳定。v0.3.1 将同级授权成组撤销、失败拆分，已尝试操作延后到下一轮复查；同一轮的相同已恢复失败可作为拆分线索，关联原证据，下一轮清空。详见 [搜索效率](search-efficiency.md)。

每个场景先搜索写权限，再搜索读权限。读取发生变化后重新搜索写权限，直到读写候选都不再接受、预算耗尽或恢复不稳定。因为程序可能在读取失败后走另一条分支，不能假设读写需求互不影响。最终组合独立重复验证，再导出 recommended.yaml。

## 项目内假文件探针

explicit 模式在每轮副本根目录，以及冻结输入中存在的 src、bin、test 目录，建立 `.permsift-read-checks/fake-secret`。位置由输入决定，和候选授权无关；它们只含随机假数据，不修改原项目。此命名空间不能写入用户授权，也不会成为自动候选。

假文件所在目录只加入 denyWrite，**不加入 denyRead**。探针按当前读取规则判断：整棵父目录被授权时必须能读到正确内容；仅授权其他文件或撤销父目录时必须得到 EPERM/EACCES。前后都检查，宿主也确认内容未变。缺失、篡改或 ENOENT 为 unknown，不能冒充拒绝成功。

因此探针检查的是实际读取策略，而非额外写死的拒绝例外。有限探针仍不等于验证了所有路径，也不构成无逃逸证明。

## 阅读报告

report.json 的 policies/searches 保持记录写权限，read_policies/read_searches 记录读取权限，read_modes 区分 explicit 与 legacy。每个 trial 保存两种授权和组合哈希。搜索记录增加 rounds、step 的 round 与 removed_grants，以及单独的 reuses；复用线索不算新执行。read_discovery 保存输入结构规则、观察证据 ID、枚举截断和限制说明。

report.md 并列展示读写范围，失败解释注明规则类型、被拒绝路径、断言和恢复结果。recommended.yaml 保留 initial_read_grants 和统一的目录准备状态；使用 run 重放即可重新验证当前输入。

search_complete 表示有限候选都已尝试完成，不表示穷举所有输入组合。依赖升级、新任务、新断言或环境变化后应重新验证。
