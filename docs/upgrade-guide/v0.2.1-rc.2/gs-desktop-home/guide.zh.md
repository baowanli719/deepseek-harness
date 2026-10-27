---
kind: upgrade-guide
description: "GS Desktop 的默认用户数据目录从 ~/.dsh 改为 ~/.gs-worker，并自动导入旧版 GS 数据。"
---

# GS Desktop 使用独立的数据目录

[English](guide.md) | 中文

## 变更

GS Desktop（`gs-worker`，profile 为 `gs-desktop`）默认使用 `~/.gs-worker`，不再与上游 Harness 共用 `~/.dsh`。若 `~/.dsh/profiles/gs-desktop` 存在，它会在 Host 启动前自动复制旧对话、附件、工作区状态、GS profile 和登录状态以及托管凭据。Session 文件的字节和标识保持不变。源数据保持原样，目标目录已有文件优先。旧历史没有产品标记，因此会包含之前可见的全部对话，包括此前与上游共享的对话。完成后不会重复导入。CLI 的默认主目录不变。

## 迁移

1. 保持 `DSH_HOME` 未设置，正常升级 GS Desktop。首次启动自动导入旧数据，无需手动复制。已有的有效登录状态会保留，仍遵循服务端正常的令牌过期规则。
2. 确认旧对话可见，且新数据写入 `~/.gs-worker`。上游 Harness 继续使用 `~/.dsh`，导入后在其中产生的变更彼此独立。
3. 如导入无法完成，等待其他客户端完成保存后重启。失败或中断的导入可以重试，不替换目标目录已有文件，也不删除原件。链接的数据目录需先改为普通目录，插件链接会保留。
4. 显式设置非空白的 `DSH_HOME` 会禁用自动导入。CLI 操作新主目录时，需要显式将 `DSH_HOME` 指向 `~/.gs-worker`；有意选择旧主目录则保留原来的共享数据。
