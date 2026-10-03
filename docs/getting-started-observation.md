# 观察任务使用的依赖

适合的问题是“这个任务有哪些依赖记录、分别来自什么来源”，以及“代码或依赖变更后出现了哪些变化”。不需要先 run、tighten 或 adopt。

以下命令在仓库根目录运行，要求已安装工具依赖并 build；真实执行需要 macOS 与通过的 `doctor`。输出目录必须是新名字。自己的项目需选择可信 limits，演示上限仅用于这里审核过的项目。

先看配置，再准备示例固定依赖。`examples:prepare` 在宿主安装演示依赖、禁用脚本；这是单独的准备步骤，不是 explain 或 observe 暗中安装。

```sh
node dist/cli.js explain --config examples/projects/bundle-kit/observe.yaml --limits examples/limits.json --for observe
npm run examples:prepare
node dist/cli.js observe --config examples/projects/bundle-kit/observe.yaml --limits examples/limits.json --output .permsift/observation-start
node dist/cli.js inspect .permsift/observation-start
node dist/cli.js inspect .permsift/observation-start/usage.json --package esbuild
```

这次只构建一次，产物 smoke test 与边界检查仍执行。模块列记录构建工具 esbuild，产物输入列由同次构建的 metafile 提供；它们回答不同问题，不能相加为“使用包总数”。TypeScript 输入需另行声明，未开启时显示未采集。

正常修改代码或依赖后再次观察，再离线比较：

```sh
node dist/cli.js observe --config examples/projects/bundle-kit/observe.yaml --limits examples/limits.json --output .permsift/observation-after
node dist/cli.js compare .permsift/observation-start/usage.json .permsift/observation-after/usage.json
```

尚未修改输入时，比较应无相应变化。输入改变后，可以检查新增产物输入、加载包/版本变化、每输出贡献和引入链。inspect / compare 只读保存记录，不重跑旧任务或安装；保留完整结果目录，离开原项目后仍可查询。

**没有模块记录不表示依赖没用。** 类型、资源和原生工具内部有独立缺口；未采集、不完整和没有记录分别理解。观察不能自动证明某包可删除、某权限可撤销或一次升级没有风险。

自己的项目可用已准备依赖，也可显式声明受支持的沙箱 npm 安装阶段。每个 observe 任务各安装一次，目前没有跨任务共享安装；先选能回答问题的少量任务。见 [模块观察](dependency-usage.md)、[编译输入](typescript-inputs.md)、[产物依赖](bundle-inputs.md)。
