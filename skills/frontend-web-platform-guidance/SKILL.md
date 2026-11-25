---
name: frontend-web-platform-guidance
description: 实现、修复或评审前端 CSS 布局与溢出、滚动和弹层、键盘焦点与可访问性、DOM 渲染及交互性能时使用，例如页面被撑开或出现横向滚动条、滚动区或 sticky 失效、弹窗或下拉被遮挡裁剪、Tab 焦点错乱、输入法回车误提交、点击或长列表卡顿，以及选用 dialog、Popover、容器查询等新 CSS/DOM 能力前核对目标浏览器支持；结合当前项目组件和浏览器目标选择 Web 平台能力。仅做列表或表单字段配置、接口与权限接线、路由或构建工具调整、JS 语法降级或 polyfill，以及 Canvas/WebGL 场景帧率问题时不触发。
license: CC-BY-4.0
---

# 前端 Web 平台指导

将现代 Web 指南用于当前问题的选型和排查；以项目现有组件、框架和浏览器支持契约确定落地方式。本 skill 只补充平台知识：改动范围、组件复用、验证与交付遵循全局及项目指令，项目专用 skill 继续负责表格、表单、路由等业务契约。

## 按问题取材

- 布局撑开、滚动或 sticky 失效、弹层被遮挡或裁剪、响应式问题：读 [布局与滚动](references/layout.md)。
- 弹窗关闭与焦点、键盘操作（含输入法回车）、表单错误或动效：读 [交互与可访问性](references/interaction-accessibility.md)。
- 首屏慢、点击卡顿、长列表渲染或图片跳动：读 [性能](references/performance.md)。
- 拟在较旧浏览器目标上使用新 CSS 或 DOM 能力：先查 [兼容速查](references/compat.md)。

只读取涉及的主题。

## 浏览器与运行环境

- 从当前项目文档、配置和专用 skill 确定浏览器目标及代码是否经过编译。Baseline 表示现代浏览器之间的支持情况，不等于项目的最低版本保证。Chrome 70 只适用于明确要求它的项目，不能推广为全局目标；pda 项目同时使用 `pda-legacy-browser-compatibility`。
- 兼容速查未覆盖的新 CSS、DOM API 或不确定的兼容行为，查当前 MDN 兼容数据或平台官方文档；已有证据足够时直接使用，不强制每项前端工作联网查询或运行上游 CLI。
- 区分语法转译、运行时 API 与 CSS 行为。Babel/Vite 降级 JS 不能自动补齐容器查询、Popover 或 Flex `gap`；`@supports` 只说明声明可解析，不保证具体布局上下文可用。
- 关键交互必须在目标浏览器可用；非关键增强可以在缺失支持时只保留基础功能。
- 原生 `<dialog>`、Popover、Anchor Positioning 是选型候选，不替换现有 UI 库弹层；不为使用它们抬高项目的浏览器支持基线（构建 target 只影响 JS 语法降级，不提供这些能力）。
- 以 Wujie 子应用运行时，DOM 默认位于 Shadow DOM，脚本在 iframe 沙箱中运行并代理 `document`：`document.activeElement` 指向 shadowRoot 内的焦点元素；document 上的 `keydown` / `keyup` / `keypress` / `wheel` 监听挂到宿主文档，会收到整个宿主页的事件，需按焦点或目标过滤并在卸载时清理；`click`、`mousedown` 等挂到 shadowRoot，宿主区域的点击收不到，“点击外部关闭”在子应用之外不触发。降级模式下 DOM 在 iframe 中，fixed 相对该 iframe 视口定位。以上依据 Wujie 源码，需在项目所用版本及独立运行模式下实测。

## 验证

按涉及的问题检查实际窄容器、长内容、滚动边界、键盘与焦点或性能证据。

内容节选改写自 GoogleChrome/modern-web-guidance，已按用户项目习惯调整触发范围、兼容策略和组件选型；出处与许可见 [来源](references/sources.md)。
