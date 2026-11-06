# dsh-session-pages

DeepSeek Harness 的第四个对话视图标签：**窗口**（在「对话 / 轨迹 / 轨迹plus」右边）。

会话按**压缩（compaction）分界**切成若干窗口：第一窗从会话开头起算，之后每次压缩的 checkpoint 开头即新一窗。

## 设置前缀不算一窗

被 `dsh-log-trim` 裁剪过的日志开头是一段纯设置前缀（系统提示词、预设、权限等），没有对话。若按 checkpoint 切分，它会被当成「第 1 窗」，于是「保留 2 窗」显示成 3 窗。

规则：

| 情况 | 结果 |
| --- | --- |
| 首窗有 checkpoint | 是真正的对话窗，保留 |
| 首窗无 checkpoint，但含 user/assistant 消息 | 裁剪没清掉它，保留 |
| 首窗无 checkpoint，且只有设置事件 | **并入**后面第一个带 checkpoint 的窗，不计入窗数 |
| 全程没有 checkpoint | 仍然是 1 窗 |

并入后，那个窗自己持有系统提示词与工具声明（`inherited: false`），不再显示「沿用上一窗」。

## 每一窗画两层

一个窗口**就是**两层，所以视图也分两层画：

每个窗口带一个诞生时刻（`startTime`）：窗口 1 取日志第一条事件的时间，之后每一窗取其 checkpoint 的时间。投影与折叠两条路径结果一致。

**框（frame）—— 这一窗的每一次请求都带在对话前面的东西**

| 行 | 来源 | 备注 |
| --- | --- | --- |
| 系统提示词 | `system/message` / `developer/message` | 只有会话开头那一条；后续窗口标「沿用上一窗」 |
| 工具声明 | `request/header` 的 `tools[]` | 只取名字；个数随插件增减，各窗可能不同 |
| 开窗摘要 | checkpoint 的 `<compacted-summary>` | 折叠显示，点开看全文 |
| 保留尾部 | checkpoint 事件的 `surfaceOp` | 报替换区间与尾部消息条数；实际重发集合未逐条记录，所以只报区间与计数 |

**行（rows）—— 这一窗自己的时间线**

注入（`runtime-context` / `skill-catalog` / `time-context`…）、用户、助手、工具调用、工具结果，按 seq 排。

行是**按需拉取**的，并且**按 200 条切块**：`/state` 只发框（一个长会话 14KB）；点「展开明细」拉第 1 块，其余块各自折叠，点块头才请求 `/items?page=N&chunk=K`（每块约 40–60KB）。轮询 10 秒一次，且只在标签打开时。

## 路由

| 路由 | 用途 |
| --- | --- |
| `GET /dsh-session-pages/state?sessionId=…` | 窗口清单 + 框 + 统计（不含行） |
| `GET /dsh-session-pages/items?sessionId=…&page=N&chunk=K[&chunkSize=200]` | 一个窗口的一块行 |

两条都只接受 loopback + 同源 Origin，非 GET 一律 405，没有任何写路径。


## 可选：接入 dsh-log-trim 的裁剪统计

装了 `dsh-log-trim` 时，本插件会读 `~/.dsh/dsh-log-trim/ledger.json`（只读、best-effort），在视图标题行加一句：

```
2 个窗口 · 累计裁掉 2 窗 / 1,033 条
```

悬停显示最近一次：「最近一次 2026-11-04 12:57 · （裁窗口，3→2 窗） · 已省 921,910 字节」。字节数只在 tooltip 里出现。

没有该包、没有该会话记录、或 JSON 损坏 → 什么都不显示，也不报错。

## 数据从哪来

窗口的计数（轮次、步数、消息数、工具调用、峰值 token、条数）来自**会话投影**，不是每次读日志现算：

```js
ctx.sessionProjections.register({
  key: 'sessionPages', stateVersion: 1, stateSchema, init, apply,
})
```

运行时每提交一个事件就驱动一次折叠，`/state` 直接读当前状态（`stateOf`）。活会话因此是 O(1)，不再重扫日志。

历史（已关闭）会话没有活的投影单元，退回读日志的折叠路径；那次解码按会话缓存 30 秒。

两条路径**逐项对拍过**（`?fold=1` 可强制走折叠做对比）：总量、每窗条数、步数、消息数、峰值、摘要字符数全部相等。

实测（2,370 行、2 个窗口的会话）：

| 路径 | 耗时 |
| --- | --- |
| 投影（活会话） | ~2 ms |
| 折叠（同会话强制） | ~5 ms |
| 已关闭的大会话（缓存命中） | ~0.8 ms |

再次打开一个 5.2 MB 的旧会话，耗时从 8.5 秒降到毫秒级。

## 已知边界

- **保留尾部有区间、没有逐条清单**。checkpoint 事件的 `surfaceOp`（`{op:'replace', startSeq, endSeq}`）记录了被替换的区间，补集即尾部区间，条数可数；但实际重发的集合还受 surface 记账影响，日志没有逐条记录，所以只报区间与条数。
- **系统提示词按“第一条非空”取**。中途的 developer 更新是追加，不是替换，所以不参与“这一窗的框”。
- 只到“每行一段”，不展开完整正文（正文按 220/140/260 字符截断，并标出真实长度）。

## 安装

```yaml
- insert:
    - id: dsh-session-pages
      name: 'dsh-session-pages'
```

装进 profile 后刷新页面，在「+」里选 **窗口** 标签。宿主半侧改代码要重载插件（改一次 profile 的 `cordis.patch.yml` 会触发热重载）。

## 配置

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `clipChars` | 220 | 消息正文截断 |
| `toolArgsChars` | 140 | 工具参数截断 |
| `toolResultChars` | 260 | 工具结果截断 |
| `maxItemsPerPage` | 20000 | 单窗行数上限（安全阀） |

## 测试

```
node --test test/*.test.js   # 12 条：切窗 / 摘要 / 框继承 / 注入分类 / 懒加载 / 注册契约
```
