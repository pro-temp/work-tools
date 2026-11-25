# 交互与可访问性

## 弹层与焦点

- 先明确交互是否阻止用户操作页面。模态弹窗需要焦点进入、合理的初始焦点、关闭后的返回位置和背景交互限制；菜单、提示和非模态面板不能直接套用模态行为。破坏性确认的初始焦点落在安全操作。
- 使用现有组件时，先查其已实现的焦点、Esc 与滚动锁行为。
- 自行采用原生 `dialog.showModal()` 时，复用浏览器的模态语义与焦点机制，不重复设置 `role="dialog"`、`aria-modal` 或手写焦点圈定。给弹窗提供可访问名称，并验证实际关闭与焦点恢复。
- 原生模态按 Esc 时先触发 `cancel` 再关闭。未保存修改在 `cancel` 中拦截并显示可见原因，用 `aria-describedby` 关联到获得焦点的控件；弹窗打开后没有新的用户激活时，再次 Esc 的 `preventDefault()` 可能无效，因此 `close` 处理不能直接丢弃未保存数据。`closedby` 只是渐进增强：缺失支持时 `none` 挡不住 Esc，`any` 也没有点击外部关闭。在 `close` 事件中读取 `returnValue` 后将其重置为 `''`：Esc 关闭不写入新值，旧值可能残留。
- `showModal()` 只让背景不可交互，不阻止背景滚动。不要为此给 `html` / `body` 加 `overflow: hidden` 或 `position: fixed`，这会去掉滚动条引起横移并可能破坏 sticky；渐进增强用 `dialog:modal { overscroll-behavior: contain }` 加 `dialog::backdrop { overflow: hidden; overscroll-behavior: contain }`，缺少后者时在遮罩上滚轮仍会滚动页面。

## 键盘、校验与动效

- 自定义动作优先使用现有按钮组件或原生 button；给图标按钮可访问名称，保留清晰焦点。裁剪或遮罩不能把焦点指示一起裁掉。
- 自定义 Enter 提交或确认（搜索框、行内重命名、弹窗字段）在输入法确认候选词时也会收到 Enter 的 keydown，执行前须跳过组合输入：原生事件判断 `e.isComposing || e.keyCode === 229`；React 合成事件没有 `isComposing`，用 `e.nativeEvent.isComposing || e.keyCode === 229`。antd 5 的 `onPressEnter` 不过滤组合输入，回调内同样要判断。`<form>` 内的输入框自行处理 Enter 时先 `preventDefault()`，避免再触发隐式提交造成重复提交。把旧的 `keyCode === 13` 改为 `key === 'Enter'` 时尤其要补，前者对输入法确认天然不触发；没有自定义 Enter 处理的原生表单隐式提交不受影响。
- 校验错误的可访问状态与当前表单真正显示的错误同步：用已有错误状态驱动 `aria-invalid`，在显示错误时关联描述；不要把未交互的空必填项立即播报为错误。
- 提交失败时，按表单现有能力将用户带到错误字段或错误摘要。数据表格、菜单等复合组件的键盘行为沿用其既有契约，不统一改成每个内部节点都可 Tab。
- 动效尽量使用 `transform`、`opacity`，并根据 `prefers-reduced-motion` 保留可读、可操作的静态结果；不能关闭动画后把内容留在 `opacity: 0`，也不能让业务完成依赖必然发生的动画结束事件。
- 自动持续滚动或播放超过五秒且与其他内容并列展示时，提供键盘可用的暂停、停止或隐藏控制；减少动态效果偏好不能代替这个控制。

节选及适配来源：上游 `dialog`、`prevent-page-scroll-under-modal-dialog`、`ime-safe-enter-submit`、`accessible-error-announcement`、`motion`；完整链接见 [来源](sources.md)。
