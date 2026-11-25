# 来源与适配说明

本地指南于 2026-11-12 整理，2026-11-18 已核对至 [GoogleChrome/modern-web-guidance v1.0.1](https://github.com/GoogleChrome/modern-web-guidance/commit/64a6d708f5a43f2cd3fde5d4d7db3905ba1bdf65)。来源为该项目及其贡献者，不代表上游对本地适配版的审核或背书。

## 选取的上游指南

- [CSS Layouts and Responsive Design](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/css/css-layout.md)：布局选择、尺寸收缩与交互顺序。
- [Responsive design](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/css/responsive-design.md)：容器与视口适配的候选能力。
- [Responsive tables](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/ui-atoms/responsive-table.md)：表格语义、滚动及可访问性。
- [Overflow Clipping Control](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/css/overflow-clipping-control.md)：`overflow: clip` 与滚动容器、sticky 的关系。
- [Dialog](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/ui-components/dialog.md)：模态语义、焦点、关闭请求与原生机制。
- [Prevent the Page Underneath a Modal Dialog from Scrolling](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/ui-behaviors/prevent-page-scroll-under-modal-dialog.md)：模态背景滚动与根元素滚动锁的副作用。
- [IME-safe enter-to-submit](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/forms/ime-safe-enter-submit.md)：输入法确认候选词与 Enter 提交。
- [Accessible Error Announcement](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/accessibility/accessible-error-announcement.md)：可见错误与辅助技术状态同步。
- [Motion](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/ui-behaviors/motion.md)：动效、焦点和减少动态效果偏好。
- [Performance](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/performance/performance.md)：关键资源、长任务、布局与离屏渲染。
- [Identify causes of poor INP](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/performance/identify-inp-causes.md)：交互耗时分段与归因。
- [Break Up Long Tasks](https://github.com/GoogleChrome/modern-web-guidance/blob/main/skills/modern-web-guidance/guides/performance/break-up-long-tasks.md)：时间预算与让出主线程。

上游 [许可说明](https://github.com/GoogleChrome/modern-web-guidance#license) 将指南文档标为 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。本地指南为中文节选、概括与改写，按 CC BY 4.0 标注署名及变更。未复制上游 CLI 或其他程序代码。

## 本地调整

缩小为实际涉及 Web 平台选型、缺陷和优化的任务；沿用项目组件及专用 skill；以项目浏览器目标覆盖 Baseline 默认；将新特性作为候选，去掉无条件的原生组件替换与构建升级建议。层叠与弹层定位、微前端运行环境、框架层性能排查与兼容速查为本地补充，版本数据来自 MDN 兼容数据与上游指南的支持说明。

本地版本不依赖上游 CLI，未保留其每项前端任务必查、全库现代化扫描、实验 API、浏览器内置 AI、扩展开发和固定交付章节流程。也未沿用按耗时阈值直接决定 Worker、全局 containment 或新增缓存的配方。

后续需要新能力时，按当前任务核对 MDN、标准或浏览器官方资料；本文件记录的是来源，不是要求每次访问所有链接。
