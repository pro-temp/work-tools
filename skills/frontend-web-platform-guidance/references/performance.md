# 性能

围绕实际慢点选择措施，不按组件名或数据量猜测瓶颈。本文针对 DOM/SVG 渲染（含 X6 等 SVG 图形）；Canvas/WebGL 场景帧率不在范围。

- 首屏问题检查关键资源与请求链；点击或输入卡顿检查事件处理、长任务与布局；滚动卡顿检查重复测量、DOM 数量和绘制。区分接口等待与主线程阻塞。
- 取证用 DevTools Performance 录制，优化前后用同一操作和数据对比，低端设备目标开启 CPU 节流。交互慢时把耗时拆为输入延迟（交互发生时已在运行的任务）、事件处理、渲染呈现三段，先判断问题在哪段再改；Chrome 123+ 可用 Long Animation Frames 看脚本与样式、布局归因。
- 先排查框架层：React 用 Profiler 找重复渲染和过大的更新范围；Vue 2 大数组或大对象先排除深度响应式开销，如对只读数据使用 `Object.freeze`。
- 批量处理 DOM 时将尺寸读取与样式写入分组，避免在循环中交错写样式和读 `offsetHeight` / `getBoundingClientRect()` 造成反复同步布局。
- 已定位的长任务先减少重复计算与渲染。React 18 中非紧急更新优先用 `startTransition` / `useDeferredValue`，它们只让 React 渲染可中断，拆不开事件处理器或 `useMemo` 里的单次同步计算。确需手动拆分时按约 50ms 预算处理，到期后让出主线程：支持时用 `scheduler.yield()`，否则 `await new Promise((resolve) => setTimeout(resolve))`；让出后核对数据和业务顺序是否仍然有效。`Promise.resolve()` 只排入微任务，不能让浏览器获得处理输入或绘制的机会。
- `scheduler.yield()` 拆分已开始的任务。需要为多个待执行任务分配优先级时，单独核对目标浏览器的 `scheduler.postTask()` 支持情况。已排入队列的后台任务也可在运行中调用 `yield()`，后续工作会继承该任务的优先级。
- 普通分页表格不再叠加虚拟化。`content-visibility: auto` 仅在离屏渲染确为成本、组件尺寸及焦点语义允许时评估，并用 `contain-intrinsic-size: auto <长度>` 提供占位尺寸，验证测量和滚动是否改变。
- 首屏关键图片不懒加载；离屏图片可按目标浏览器能力延后加载。预留图片尺寸以减少跳动，资源优先级只用于真正关键的资源。
- `will-change` 和 CSS containment（含 `content-visibility`）可能增加资源占用，并改变层叠上下文与 fixed 包含块（见 [布局与滚动](layout.md)），不能全局铺设。

节选及适配来源：上游 `performance`、`identify-inp-causes`、`break-up-long-tasks`，结合业务列表约束改写；框架层排查、CPU 节流与 React 调度为本地补充。完整链接见 [来源](sources.md)。
