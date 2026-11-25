# 布局与滚动

## 尺寸与溢出

- 单行或单列分配空间时考虑 Flex；二维区域对齐时考虑 Grid。
- 长单号、路径或表格把 Flex 子项撑开时，检查默认最小内容尺寸；在需要收缩的子项设置 `min-width: 0`。纵向 Flex 中滚动区无法收缩时，再检查相应子项的 `min-height: 0` 与父级高度约束。
- 需要在剩余空间内滚动时，沿父子链找出谁限定高度、谁负责 `overflow: auto`。不要用页面级 `overflow: hidden` 掩盖错误尺寸；省略号或有意裁剪仍可使用局部裁剪。
- 卡片按可用宽度排列时，Grid 的 `auto-fit` / `auto-fill` 与 `minmax()` 可减少 JS 测量；最小列宽不能大于实际窄容器。容器查询适用于组件随自身空间变化。
- 旧目标上使用 Flex `gap` 前先查 [兼容速查](compat.md)；不支持时复用现有间距实现。
- 移动端浏览器工具栏引起视口高度变化时，才评估动态视口单位；不在旧设备项目直接将所有 `vh` 替换为 `dvh`。

## 层叠与弹层定位

- 下拉、Tooltip 等弹层被裁掉时，先找带 `overflow` 的祖先，再用 UI 库的挂载容器配置调整（如 antd `getPopupContainer`，Element UI 下拉的 `popper-append-to-body`，Element Plus 的 `teleported`），不靠加大 `z-index`。改挂载位置后核对滚动跟随与定位。
- 已采用 CSS 锚点定位的弹层靠近容器边角时，可用 `position-try-fallbacks: flip-block, flip-inline, flip-block flip-inline`。浏览器依次尝试沿块轴、行内轴、两个轴一起翻转。根据弹层允许的方向选取组合，在目标浏览器实测两个方向同时溢出的情况。
- `z-index` 不生效时，检查祖先是否因 `transform`、`filter`、`opacity < 1`、`isolation: isolate`、`will-change` 等建立了层叠上下文；`z-index` 只在同一层叠上下文内比较。
- `position: fixed` 没有相对视口定位时，检查祖先上的 `transform`、`perspective`、`filter`、`backdrop-filter`、`contain`（`layout` / `paint` / `strict` / `content`）、`content-visibility: auto`、`will-change: transform`，它们会让该祖先成为 fixed 元素的包含块。`container-type` 只在 Chrome 105–128 有此效果。

## 滚动与数据密度

- Sticky 表头或工具栏失效时，检查实际滚动祖先、祖先的 overflow 与定位范围，不只增加 `z-index`。任一轴不是 `visible` / `clip` 的祖先都会成为滚动容器，例如只写 `overflow-x: hidden` 也会让 `overflow-y` 计算为 `auto`。该祖先只为裁剪时，可评估 `overflow: clip` 或 `overflow-x: clip`（Chrome 90+），它裁剪内容但不建立滚动容器；需要在该元素内滚动或程序化滚动时不能使用。
- 业务表格优先保留列标题、行操作和已有横向滚动方式。自定义滚动区需要键盘进入才能操作时，提供可见焦点和名称。
- 视觉顺序应与 DOM 的键盘访问顺序一致；不用 Flex `order` 或倒序排列修补交互布局。
- 长文本截断后仍须能通过现有详情、复制或可键盘使用的提示查看完整内容；不依赖仅鼠标 hover 的路径。

节选及适配来源：上游 `css-layout`、`responsive-design`、`responsive-table`、`overflow-clipping-control`；“层叠与弹层定位”与用 `overflow: clip` 修复 sticky 为本地补充。完整链接见 [来源](sources.md)。
