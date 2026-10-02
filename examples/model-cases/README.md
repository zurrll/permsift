# 内部模型兼容样本

这是带来源说明的真实记录字段投影，供第一轮适配及后续迁移验证。manifest.json 列出全部案例；每个 JSON 将原报告投影、原始 config/limits、选定执行 sidecar 和 provenance 放在一份可移动文件内。

```sh
npm run model:verify
```

脚本只读样本，生成新的 `.permsift/model-replay-*/` 目录。它不运行历史命令，也不跟随报告里的路径。详见 [案例与投影范围](../../docs/model-cases.md)、[模型含义](../../docs/model.md)。观察使用案例另外复用 `examples/reports/`。

合成反例在 `test/model.test.ts`，不混入真实样本。这些投影不是可直接采用的权限基线；缺少的日志、后端规则和执行细项必须继续视为未保存。
