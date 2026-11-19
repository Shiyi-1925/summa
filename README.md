# 随手记 Lite（summa）

单文件、零依赖的 PWA 记账应用。原生 HTML/CSS/JS，数据全部存在本地 IndexedDB，离线可用，可安装到手机主屏幕。

**在线使用**：https://shiyi-1925.github.io/summa/

## 功能

- 快速记账：大字数字键盘、支出/收入切换、分类、备注、日期
- 流水列表：按日分组、当月汇总、左滑删除、点击编辑
- 统计页：支出/收入切换、分类环形图、6 个月收支趋势
- 分类管理：新增、改名、删除、排序
- CSV 导出、清空数据
- PWA：离线缓存、安装提示、自绘图标

## 技术

- 无构建步骤、无外部依赖，打开 `index.html` 即用
- IndexedDB 本地存储（金额以「分」存整数）
- Service Worker + manifest 实现离线可安装
- 图表为手写 SVG

## 本地开发

```bash
npm run dev        # 默认 http://localhost:7100
npm run dev -- --port 8000
```

## 项目结构

```
index.html            # 整个应用（HTML + CSS + JS 单文件）
manifest.webmanifest  # PWA 清单
sw.js                 # Service Worker（离线缓存）
server.mjs            # 零依赖静态服务器（ESM）
package.json
icons/                # 自绘 PWA 图标
screenshots/          # 应用截图
```
