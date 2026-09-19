# 墨读 InkMark

> 电子书实时批注与知识整理工作台 · 纯本地运行，不需要安装，不需要联网

[![CI](https://github.com/liulongxin999-ctrl/inkmark/actions/workflows/ci.yml/badge.svg)](https://github.com/liulongxin999-ctrl/inkmark/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

把「读电子书」和「做笔记」合成一件事：读到哪、批到哪；批注、术语、笔记三者互相连通，
右侧栏原地改、正文即时变，全部数据只存在你自己的电脑里。

![阅读与批注侧栏](docs/screenshots/04-阅读与批注侧栏.png)

---

## 30 秒上手

1. 双击 **`启动.bat`**（会自动打开浏览器；没有 Node 就用 Python，两者都没有也能直接打开 index.html，但部分功能受限）
2. 把 `示例/示例书-认知科学导论.txt` 拖进书库——建议先用它试一遍
3. 打开这本书，**选中任意一句话** → 浮出工具条 → 点「高亮」或「写批注」
4. 选中一个专业名词（比如「组块」）→ 点 **「设为术语」** → 填上定义
5. 之后全书里这个词都会自动高亮：**鼠标悬停看释义，点击在右侧栏编辑**
6. 顶部「笔记」进笔记工作台，卡片可在四列之间拖动；「复习」按遗忘曲线抽卡

> 仓库地址：<https://github.com/liulongxin999-ctrl/inkmark>（私有）

---

## 你要的功能，对应在哪里

| 你的想法 | 墨读里的实现 |
| --- | --- |
| 上传电子书，每本书一个区块 | 书库页：拖拽上传 PDF / EPUB / TXT / Markdown / HTML，每本书一张区块卡片，带进度环、批注数、术语数 |
| 实时批注，多种形式 | 6 种形态：**高亮**（6 色）、**下划线**、**波浪线**、**删除线**、**批注卡**、**书签**；跨段落选择会自动拆成一组并保持关联 |
| 特殊名词特殊化 | 「设为术语」：名称 + 别名 + 分类 + 定义 + 我的理解 + 标签 + 关联 |
| 点击名词 → 侧边栏显示批注 | 点击术语或批注 → 右侧栏定位到对应卡片并聚焦编辑框 |
| 侧边栏实时修改 | 边打字边保存（300ms 防抖），正文样式与批注圆点同时刷新，多标签页打开也同步 |
| 鼠标悬停显示批注 | 悬停 0.25 秒浮出气泡：术语显示释义，批注显示内容摘要 |
| 额外的笔记整理区域 | 笔记工作台：看板四列（收集箱 / 整理中 / 已掌握 / 归档）拖拽流转、列表视图、标签筛选、全文搜索、Markdown 编辑、`[[双向链接]]`、一键跳回原文 |
| 自由发挥的部分 | 命令面板 `Ctrl+K`、全书搜索、间隔复习、阅读热力图、原版 PDF 页面速览、Markdown 打包导出、备份导入导出、深色/护眼主题 |

---

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `Ctrl / ⌘ + K` | 命令面板：跳书、跳章节、搜术语笔记、执行命令 |
| `H` | 高亮选中文字 |
| `U` | 加下划线 |
| `N` | 写批注并自动打开侧栏 |
| `T` | 把选中的词设为术语 |
| `B` | 在当前位置加书签 |
| `J` / `K` | 下一章 / 上一章 |
| `Esc` | 关闭弹窗、工具条、气泡 |

---

## 数据与隐私

- 所有内容存放在浏览器的 **IndexedDB** 里，不联网、不上传。
- 「设置 → 数据」可导出 **JSON 完整备份** 与 **Markdown 打包（zip）**，也可随时导入还原。
- 注意：清理浏览器数据会一并清除这些内容，重要笔记请定期导出备份。
- 原文件（PDF/EPUB）会一并留档，用于「原版页」渲染与批注导出；超大文件可能无法留档，不影响正文批注。

---

## 目录结构

```
墨读/
  index.html                应用骨架
  启动.bat                  一键启动本地服务并打开浏览器
  提交并推送.bat            自检 → 提交 → 推送，一步完成
  server.mjs                零依赖本地静态服务器（带端口自动避让）
  示例/                     示例书，可直接拖进书库
  docs/设计方案.md           完整产品与算法设计说明
  docs/screenshots/         界面截图
  .github/workflows/ci.yml  推送后自动跑自检与端到端测试
  assets/styles/            base 设计系统 · reader 正文与标记 · panels 面板与卡片
  assets/vendor/            pdf.js · JSZip · marked（已本地化，离线可用）
  src/core/                 utils 工具 · db 数据库 · store 状态中枢
  src/import/               parsers 五种格式解析（含 GBK 识别、PDF 版面还原）
  src/reader/               anchors 锚定与分段 · marks 标记渲染 · selection 选区交互 · reader 阅读视图
  src/panels/               sidebar 批注 / 术语 / 大纲 / 统计
  src/views/                library 书库 · notes 笔记工作台 · review 复习
  src/ui/                   shell 主题 / 弹窗 / 命令面板 / 数据导入导出
  tests/                    自检与端到端测试
```

---

## 技术要点

**批注不存 HTML，只存偏移量。** 每条批注只记录 `{块 ID, 起始, 结束, 原文, 前文, 后文}`。
即使改字体、换主题、换设备，批注也不会错位；文字有微小变动时，会用前后文模糊回退重新定位。

**一次边界扫描完成所有标记渲染。** 把「批注区间」与「术语匹配区间」合并成一条边界序列，
切成互不重叠的最小片段，所以重叠批注、术语与批注交叠、跨段落拆分都能正确显示，
且片段文本首尾相接严格等于原文——这保证了字符偏移永远有效。

**写入单点出口。** 所有写库都经过 `store.js`，落盘成功后再广播事件，
配合 `BroadcastChannel` 让多个标签页实时同步。

---

## 开发者命令

```bash
node tests/check-imports.mjs    # 静态检查：导入导出是否匹配
node tests/run-headless.mjs     # 71 项运行时自检（无头浏览器，真实 IndexedDB）
node tests/smoke.mjs            # 22 步端到端：上传 → 划选批注 → 术语 → 笔记 → 刷新持久化
node tests/shots.mjs [输出目录] # 自动截图主要界面，用于视觉验收
node server.mjs 8765 --open     # 启动本地服务
```

代码为原生 ES Modules，**没有构建步骤**，改完刷新浏览器即可生效。
运行应用只需任意版本的 Node.js；跑上面这些自动化测试需要 **Node.js 22+**（用到了内置 WebSocket）。

### 日常改动的推荐流程

**最简单的方式**：改完代码后双击 `提交并推送.bat`——它会先跑快速自检，再让你写一句改动说明，然后自动提交并推送到 GitHub。

**手动方式**：

```bash
node tests/check-imports.mjs        # 可选的快速自检
git add -A
git commit -m "feat: 说明这次改了什么"
git push
```

推送后 GitHub Actions 会自动跑完整测试（配置见 `.github/workflows/ci.yml`），
在仓库页面的 **Actions** 标签里能看到结果；绿色代表这次改动没有破坏已有功能。

---

## 已知限制

- 扫描版 PDF 没有文字层，正文无法提取，只能用「原版页」按原始排版阅读。
- EPUB 中的插图暂以占位符呈现，正文、目录、批注不受影响。
- 复习算法是简化版 SM-2（忘了 / 模糊 / 记住三档），够用但不追求最优排程。
- 单本书建议在 300 万字以内；超大文件首次解析需要等待进度条走完。

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源，你可以自由使用、修改、分发，包括用于商业用途，
只需保留版权声明即可。

第三方依赖（`assets/vendor/`）各有其自身许可证：

- [PDF.js](https://github.com/mozilla/pdf.js) — Apache-2.0
- [JSZip](https://github.com/Stuk/jszip) — MIT / GPLv3 双许可
- [marked](https://github.com/markedjs/marked) — MIT
