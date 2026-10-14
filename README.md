# Hydro-testdata-sanitizer

Hydro 插件：批量检查与规范化题目测试数据。

在题库页面（`/p`）右侧栏为 **域 root 用户** 增加一个 `Clean Testdata` 块，点击后进入独立页面，
可以按题目 / 数据状态筛选，查看每一道题的数据状态，并对测试数据执行「测试」与「修改」。

## 功能

* 状态：`Accepted`（正常）、`Wrong`（存在 BOM 头 / CRLF / 单独的 CR）、`Unchecked`、`No testdata`
* 标记出有问题的**具体文件**与问题类型、数量
* 展示出题人、测试数据数量与总大小、题目评测类型（传统题 / SPJ / 交互题 / 通信题 / 提交答案题 / 客观题 / 远端评测题）
* 操作：
  * **测试**：按文件逐个扫描，实时进度条显示「第几个测试点 / 共几个」「第几题 / 共几题」
  * **修改**：把 UTF-8 BOM 去掉、把 CRLF / CR 统一成 LF，同样有逐测试点进度条
* 批量操作（全部测试 / 全部修改）作用于**当前页**的题目，可随时「停止」
* 结果写入操作日志（oplog，`clean-testdata.fix`），并保存检查记录以便下次打开页面直接看到状态

## 有什么用

Hydro 5.0.0 / UI 4.58.0 已优化 judge 对 `\r` 的处理。即使不使用本插件，judge 在评测时也可以自适应部分换行差异。

本插件仍然有实际用途：

* 将题目导出到其他 OJ 前，统一测试数据格式，减少目标 OJ 对换行符和 BOM 的兼容性差异；
* 在题库层面主动检查并清洗测试数据，定位具体文件、编码、BOM、CRLF 或单独的 `\r`；
* 将数据规范化结果保存为检查记录，方便域 root 用户持续维护题库质量。

## 数据安全

* **不删除任何测试数据**，只会在文本文件中检测到 BOM / CRLF / CR 时重写该文件
* 二进制文件（含 `\0` 字节）与 UTF-16 编码文件只标记、不修改
* 修改前先扫描一次（不信任前端状态），修改时再次流式扫描并比对**预期字节数**，
  若文件在两次读取之间被改动，直接中止，不做任何写入
* 修改 `config.yaml` 前会校验规范化结果仍是合法 YAML，否则中止
* 修改前一定先在存储中留一份原文件的副本（`StorageModel.copy`，与原件共享底层文件，不额外占用空间）：
  * 「修改前备份原文件」开启（默认）：备份保留在
    `problem/<domainId>/<docId>/testdata-backup/<时间戳>/<文件名>`，可在操作日志中点击下载还原
  * 关闭：备份仅用于写入失败时回滚，成功后立即释放（7 天后由存储清理任务删除）
* 写入失败时自动用该副本恢复原文件，并在错误信息中告知
* 未规范化前所有写操作都发生在临时文件上（`os.tmpdir()/hydro/clean-testdata`），
  最后通过官方的 `ProblemModel.addTestdata` 写回，因此文件元数据、`config` 缓存、事件通知都与原生流程一致
* 同一进程内按 `域/题目/文件` 加锁，避免并发写入同一个文件
* 文件名会在生成原文件与备份存储路径前再次校验，只允许单层路径名并拒绝路径分隔符、`..` 与控制字符，避免异常题目元数据造成存储路径逃逸

## 权限

* 页面与侧边栏入口都要求 **域 root 权限**（`PERM_ALL`，即域的 `root` 角色 / 域拥有者）
* 路由额外要求 `PERM_EDIT_DOMAIN`；测试额外要求 `PERM_READ_PROBLEM_DATA`，修改额外要求 `PERM_EDIT_PROBLEM`

## 安装

```bash

```

插件目录结构：

```
plugins/clean-testdata/
├── index.ts                  # 插件入口：路由、侧边栏注入、配置、索引、事件清理
├── lib/scan.ts               # 流式扫描 / 规范化（BOM、CRLF、CR、二进制检测）
├── lib/store.ts              # 检查记录（MongoDB collection: testdataCheck）
├── lib/status.ts             # 每题 / 每文件状态计算
├── lib/handler.ts            # CleanTestdataHandler
├── templates/clean_testdata.html
├── frontend/clean-testdata.page.ts
└── locales/{zh,en}.yaml
```

依赖的核心改动（仅新增注入点，无行为变化）：

* `packages/hydrooj/src/interface.ts`：`UIInjectableFields` 增加 `'ProblemSidebar'`
* `packages/ui-default/templates/problem_main.html`：渲染 `ui.getNodes('ProblemSidebar')`

## 配置

系统设置中可以调整（插件配置，`clean-testdata`）：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `scanLimit` | `2000` | 页面最多扫描的题目数量，超出时会提示使用筛选缩小范围 |
| `defaultBackup` | `true` | 「修改前备份原文件」复选框的默认值（关闭时仍会为回滚临时保留一份副本） |

## 接口

页面使用 Hydro 的 `operation` 约定，向当前页面地址 POST：

* `{"operation": "check", "pid": <docId>, "name": "<文件名>"}`
  返回 `{ file: RowFile, row: RowData }`
* `{"operation": "fix", "pid": <docId>, "name": "<文件名>", "backup": true|false}`
  返回 `{ file: FixResult, row: RowData }`

`FixResult` 额外包含 `changed`、`skipped`（`binary` / `utf16`）、`backup`（备份的存储路径）、
`backupUrl`（备份下载链接）、`issuesBefore`（修改前发现的问题）。
