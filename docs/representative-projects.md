# 代表项目验证

三个项目均使用真实工具执行任务，不填写 narrower_candidates。它们是仓库内的可运行示例，用于复现实验和评估工具配置成本，不能替代第三方大型项目、生产环境或长期升级验证。

## 准备与运行

在仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run examples:prepare
npm run examples:verify
```

准备步骤在沙箱实验外下载锁定的 esbuild 与 TypeScript 依赖，禁用生命周期脚本。平台对应的 esbuild 可执行包由 npm 的 optionalDependencies 安装。不同平台应重新 npm ci，不要跨平台复制 node_modules；参考 [esbuild 安装说明](https://esbuild.github.io/getting-started/)。沙箱任务仍全程断网，每次从已准备好的输入快照和空缓存开始。

| 项目 | 任务与成功判断 | 预期最终可变写权限 |
| --- | --- | --- |
| [slug-kit](../examples/projects/slug-kit/permsift.yaml) | Node 原生 node:test 执行三个实际用例，生成 JUnit XML，所有预期用例必须通过 | @workspace/reports |
| [bundle-kit](../examples/projects/bundle-kit/permsift.yaml) | esbuild 打包 TypeScript，实际导入产物并验证计算结果，写出构建记录 | @workspace/dist |
| [cached-build](../examples/projects/cached-build/permsift.yaml) | TypeScript 增量编译，写编译缓存，创建并删除临时文件，实际导入产物验证结果 | @cache/typescript、@tmp/compiler、@workspace/dist |

每个配置只填写初始授权、任务和产物断言。依赖锁文件和项目脚本可审阅；没有宿主自定义验证脚本。

examples:verify 保存每个项目的 report.md、report.json、逐次证据和推荐配置，以及汇总 summary.json。脚本要求最终策略经过验证、有限候选搜索结束、符合预期目录，并实际测试了必要授权撤销及恢复；随后重放导出的配置并核对输入哈希。命令会打印证据位置。

cached-build 中，临时文件在退出前删除，文件差异无法观察到它。目录结构提供收缩线索，实际删除 @tmp/compiler 授权必须导致任务失败并恢复成功。只依赖最终文件列表会遗漏这个需要。

## 审阅结果

1. 查看 summary.json 的最终权限、运行次数和耗时。
2. 检查 report.md 的 Candidate discovery，确认候选来源、准备目录和枚举是否截断。
3. 检查 Failure explanations，确认被删权限、拒绝操作、失败断言和恢复结果。
4. 用 run 和 recommended.yaml 再次验证；保持相同 limits。导出配置携带 prepare_directories，记录预建目录这一运行条件。

这些项目没有测量长期依赖升级、所有代码分支或开放网络。结果仅适用于记录的输入、环境、准备方式与成功断言。

## 用 Permsift 自身构建验证

`npm run self:verify` 使用 [self-build.yaml](../examples/self-build.yaml) 冻结当前仓库，真实编译整个 TypeScript 项目，在沙箱内启动编译后的 CLI 并验证版本。预期将整个工作区写权限缩到 @workspace/dist，撤销缓存和临时目录写权限。这是对实际工具仓库的构建验证；未在外层沙箱中运行需要创建网络探针对照端点的工具集成测试。
