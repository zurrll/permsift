# 用已有真实记录练习离线分析

这三份 JSON 是此前 fast-glob 实验的**字段投影**，保留比较和跨任务查看使用的包清单、模块文件、来源状态、观察条件及完整打包来源。删除了原始模块边、执行证据位置等不参与当前视图的字段；不是新执行结果，也不能作为权限回归检查的 report.json。

- `fast-glob-tasks.json`：v0.9 保存的 compile / compile-test 记录，每任务 507 个安装实例；分别有 1 / 97 个包的模块记录。
- `fast-glob-bundle-before.json`、`fast-glob-bundle-after.json`：v0.11 保存的适配打包任务升级前后记录，各有 20 个安装实例。glob-parent 5.1.2 → 6.0.2，JS 贡献 934 → 1560 字节。

上游均固定在 [fast-glob 提交 4868789](https://github.com/mrmlnc/fast-glob/tree/48687898dd26d4e935a0e5ecf6720e7c5aeac15d)。每份 JSON 的 fixture_provenance 标明原报告位置。JSON 中版本、输入摘要与环境仍属于原始采集条件。

compile 使用上游 tsc 配置，增加 skipLibCheck；compile-test 通过已有 verify.cjs 包装调用编译、上游完整 246 项测试和构建 API 检查。bundle 使用额外的 TypeScript CommonJS 转换 / esbuild 脚本及最小依赖清单，不是上游原始构建。两组任务、依赖集合和采集来源不同，不可混合为一次观察。

```sh
npm run build
node dist/cli.js inspect examples/reports/fast-glob-tasks.json --package glob-parent
node dist/cli.js compare examples/reports/fast-glob-bundle-before.json examples/reports/fast-glob-bundle-after.json
npm run offline:verify
```

这些命令读取保存的记录，无需准备 fast-glob 项目、安装它的依赖或启动沙箱。完整范围和退出码见 [离线分析说明](../../docs/offline-usage.md)。
