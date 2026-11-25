# 兼容速查

只列 Chrome 最低版本，便于对照 Chromium 内核设备与内嵌浏览器；其他浏览器和未列出的能力查 [MDN 兼容数据](https://github.com/mdn/browser-compat-data)。备注列出 `@supports` 误判或容易踩坑的情况。

| 能力 | Chrome | 备注 |
| --- | --- | --- |
| `<dialog>`、`showModal()` | 37 | |
| `position: sticky` | 56 | |
| `overscroll-behavior` | 63 | 对不可滚动容器生效需 144+，且无法用 `@supports` 检测 |
| `ResizeObserver` | 64 | |
| Grid `gap` | 66 | 更早版本用 `grid-gap`（57） |
| `img loading="lazy"` | 77 | |
| Flex `gap` | 84 | Grid `gap` 已支持时 `@supports (gap: 1rem)` 也为真 |
| `content-visibility` | 85 | |
| `:focus-visible` | 86 | |
| `inset` | 87 | |
| `aspect-ratio`、`:is()`、`:where()` | 88 | |
| `overflow: clip` | 90 | |
| `:has()`、容器尺寸查询 | 105 | `container-type: inline-size` 在收缩适应场景（flex 子项、inline-block、绝对定位）下宽度会塌缩，`size` 未设高度时高度为 0；Chrome 105–128 另施加布局包含（成为 fixed/absolute 包含块并建立层叠上下文），129+ 已去掉 |
| `dvh` / `svh` / `lvh` | 108 | |
| Popover | 114 | MDN 口径；上游按 web-features 记为 116 |
| `:user-invalid` | 119 | |
| Anchor Positioning | 125 | `position-try-fallbacks` 从 128 起使用现名，`position-area` 从 129 起使用现名。[Chrome 语法变更说明](https://developer.chrome.com/blog/anchor-syntax-changes) |
| `scheduler.yield()` | 129 | |
| `<dialog closedby>` | 134 | |

版本来自 MDN 兼容数据与上游指南的支持说明；整理日期见 [来源](sources.md)。
