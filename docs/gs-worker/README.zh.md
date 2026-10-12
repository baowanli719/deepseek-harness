# gs-worker 项目记录

[English](README.md) | 中文

## 概要

本目录按打包版本整理 GS 桌面项目的需求、交付修改、安全复核及验证证据，并区分产品版本、测试构建版本与内置 Harness 运行时版本。各包 README 仍是当前配置和 API 行为的维护来源。

## 目录

- [版本记录](#version-records)
- [版本来源](#version-source)

-----

<a id="version-records"></a>
## 版本记录

每份记录注明打包证据及验证范围。记录不会将既有安装包认定为已经包含后续源码修改。

| 打包版本 | 产品版本 | 记录 |
| --- | --- | --- |
| `2.2.0` | `2.2.0` | [需求、修改及验证记录](releases/2.2.0/requirements-and-changes.zh.md) |
| `2.1.1-test.20261002.3` | `2.1.1` | [需求、修改及验证记录](releases/2.1.1-test.20261002.3/requirements-and-changes.zh.md) |

<a id="version-source"></a>
## 版本来源

[GS 产品清单](../../apps/desktop/brand/gs/product.json)声明产品版本。[桌面发布解析器](../../apps/desktop/scripts/desktop-release-environment.mjs)为 `gs-desktop` 选择该版本，[构建版本解析器](../../apps/desktop/scripts/desktop-build-version.mjs)据此生成发布的测试版本。[桌面包清单](../../apps/desktop/package.json)标识内置 Harness 运行时版本。本机打包运行元数据和最终阶段结果确认实际成功的构建；凭据和安装包二进制不放入这些记录。
