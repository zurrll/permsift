# esbuild 产物依赖观察

v0.11 使用同一次任务生成的 [esbuild metafile](https://esbuild.github.io/api/#metafile)，解释打包输入、每个输出中的字节贡献、入口引入链和输出中的外部引用。它与 Node 模块加载、TypeScript 编译输入分别记录，来源可以重叠，计数不能相加成“实际用了几个包”。

## 开启与运行

项目的构建脚本需要保存完整 JSON，例如：

```js
const result = await build({ /* 原构建选项 */, metafile: true });
await writeFile('dist/meta.json', JSON.stringify(result.metafile));
```

在任务配置中声明已有工具和产物位置：

```yaml
command: [node, scripts/build.mjs]
initial_write_grants: ['@workspace/dist']
observation:
  esbuild:
    bundler: '@workspace/node_modules/esbuild'
    metafile: '@workspace/dist/meta.json'
    output_root: '@workspace/dist'
```

bundler 须在任务启动前的 npm 安装清单中识别为 esbuild；版本来自该清单。metafile 必须在 output_root 内；observe 要求整个 output_root 已有任务写授权，且不能包含 node_modules 或配置的构建工具。run/check/tighten 不因未启用的采集拒绝已有更窄规则或其导出配置；observe 若范围未获授权，在执行前拒绝，不扩大规则。三个位置都在项目内。记录中的相对路径按任务工作区解析；首版要求 esbuild 的 absWorkingDir 与任务工作区一致，改变工作目录的包装脚本应先适配。支持一个明确 metafile，不自动合并多次构建、发现配置或改写任意 npm 脚本。

**observe 在隔离副本中清空声明的 output_root，再恢复显式准备目录和断言的父目录。** 全部报告产物，包括延迟分块，都来自该次任务的输出目录；已有 metafile 和旧分块不能作为成功采集的替代。请将它配置为专用产物目录：该目录中任务所需的输入也会在副本中被清除。原项目不被清理。run/check/tighten 不执行这项采集准备，原有断言新鲜度逻辑保持。

任务命令、项目读写和网络授权不因 esbuild 采集而扩张。工具不替任务保存 metafile，不再构建一次；模块观察原有私有日志写例外仍存在。任务失败、边界结果和各来源采集状态分别保留。

```sh
npm run examples:prepare
npm run build
node dist/cli.js observe \
  --config examples/projects/bundle-kit/observe.yaml \
  --limits examples/limits.json \
  --output .permsift/bundle-first

# 修改自己的代码/依赖后，比较一次当前任务；不会重跑历史基线
node dist/cli.js observe \
  --config examples/projects/bundle-kit/observe.yaml \
  --limits examples/limits.json \
  --baseline .permsift/bundle-first/usage.json \
  --output .permsift/bundle-next
```

bundle-kit 只演示配置和原生工具盲区，没有业务依赖。下面的受控样例及真实源码任务负责验证归因收益。

## 阅读报告

usage.json 每个任务的可选 bundling 字段保存来源/版本、工具安装位置/版本、实际命令、metafile 路径及原始文本摘要/字节数、声明输出范围、上限、inputs、outputs、packages、issues 和 capture_status。原始 metafile 不额外复制进报告；`--keep-workspaces` 可保留任务副本进行检查。摘要用于标识读回文本，不认证生产者。

usage.md 并列显示每个包的模块加载记录、编译输入文件、esbuild 输入文件和各产物中的贡献。随后列出完整的报告输出集合、输入对应输出和一条入口到输入的路径。

- **打包输入**：metafile 记录的文件，不等于每个文件的代码都进入了产物，也不覆盖全部配置、资源及文件读取。包按实际安装根最长匹配，支持嵌套实例。
- **字节贡献**：esbuild 报告的 bytesInOutput，按包、按输出分别聚合；0、没有报告贡献、没有采集是不同情况。代码包装开销不一定归属于输入；字节数不衡量重要性或必需性，也不是源码大小或风险评分。
- **分块和资源**：列出所有记录的输出、入口和输出引用，不只看主文件。sourcemap 也保留；metafile 的字节归因不能用于判断 map 中是否包含敏感源码。
- **外部引用**：原样展示保留到输出中的导入请求及方式，包括 Node 内置模块。不会把请求猜成已安装包实例，也不据此证明构建需要读取它或某条运行时路径一定执行。
- **入口链**：从记录的入口和输入导入边生成一条有界路径；动态引用方式保留在图中。它是一条可检查的引入路径，不保证展示全部路径，没有链不证明不可达。

缺失/损坏/不受支持/过大的记录为 unavailable；有可用输入和输出但执行、归属、引用、文件检查或上限存在缺口为 incomplete。captured 表示范围内记录可读、工具识别成功、任务成功且无已知缺口；不等于整个输出目录被 metafile 穷尽，更不等于产物已发布。开启的来源不完整会使顶层使用报告 incomplete，即使任务通过。

最多读取 4 MB JSON、4096 输入、256 输出、16384 条导入/贡献记录、64 个路径节点；文本最多 4096 字符，单条原始字节计数限制在安全聚合范围。只读取普通 metafile 文件，不跟随目录/文件链接或读取 FIFO；输出路径必须在声明范围内，并检查实际普通文件与报告大小一致。完整文件内容没有额外认证。插件虚拟输入、工作区外输入和未知安装归属明确报缺口；插件返回真实文件路径的情况可保留观察，但输入字节可能表示插件转换后的内容。

这是合作式可信任务记录。任务仍能复制旧内容到新文件、伪造 JSON 或绕过记录，工具不会将新文件与摘要升级为抗篡改安全证据或依赖删除建议。

## 前后比较

--baseline 上次 usage.json 单独比较打包来源：输入包及版本、输入/输出文件、输出大小与引用、每个包在各输出中的贡献、入口链、外部引用。报告保留输入/配置/环境，以及工具、采集器、实际命令和声明输出范围变化。文件名包含内容摘要的分块可能表现为一旧一新；首版不猜测两者身份。相同字节数也不说明代码内容相同，本版不是内容差异工具。

一边未采集（包括 v0.9/v0.10 基线）显示 unavailable，不将整组数据推断成新增依赖；部分采集中的消失项只是记录差异。

## 验证真实变化

```sh
# 受控应用包、间接共享、纯类型、被移除代码、external 和动态分块
npm run bundle:verify

# 固定真实上游源码；安装在每次沙箱任务内进行
npm run bundle:prepare
npm run bundle:verify -- --real

# 也可独立观察已经准备的真实任务
node dist/cli.js observe \
  --config examples/third-party/fast-glob-bundle/observe.yaml \
  --limits examples/third-party/fast-glob-bundle/limits.json
```

prepare 固定 fast-glob 3.3.3 上游提交与原样 src/fixtures/LICENSE，添加明确构建任务和最小锁定运行/工具依赖；重复准备核对这些资产，发现修改时拒绝替换。项目本身保留在 .permsift/third-party/fast-glob-bundle。验证脚本在自己的独立源码副本中修改依赖，不改准备好的项目。

真实任务先用 TypeScript 4.9.5 transpileModule 保留旧 CommonJS 导入和 ES2017 字段初始化语义，再由 esbuild 0.28.2 打包；不做类型检查，不是上游 npm run build，也不采集 explainFiles。执行打包后的同步、异步、流式 API，各核对固定 9 个 Markdown 文件。升级 glob-parent 5.1.2 → 6.0.2 后重新冷安装、打包和检查，比较版本及产物贡献。不是对原先 507 个开发依赖任务的性能比较，也没有重新运行上游 246 项单元测试。

每个项目普通一次、观察一次、改动后观察一次，不进行权限搜索。实测能解释间接依赖引入链及升级影响；尚未证明用户节省多少人工时间。esbuild 自带 [analyze](https://esbuild.github.io/api/#analyze) 已能显示体积和引入路径，Permsift 这轮验证的是把这些事实与任务条件、独立来源和前后变化连接起来。方法与结果见 [validation.md](validation.md)，收益边界见 [value-and-scope.md](value-and-scope.md)。
