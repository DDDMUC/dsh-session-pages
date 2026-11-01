# dsh-session-pages

DeepSeek Harness 的第四个对话视图标签：**窗口**（在「对话 / 轨迹 / 轨迹plus」右边）。

会话按**压缩（compaction）分界**切成若干窗口：第一窗从会话开头起算，之后每次压缩的 checkpoint 开头即新一窗。

## 每一窗画两层

一个窗口**就是**两层，所以视图也分两层画：

**框（frame）—— 这一窗的每一次请求都带在对话前面的东西**

| 行 | 来源 | 备注 |
| --- | --- | --- |
| 系统提示词 | `system/message` / `developer/message` | 只有会话开头那一条；后续窗口标「沿用上一窗」 |
| 工具声明 | `request/header` 的 `tools[]` | 只取名字；个数随插件增减，各窗可能不同 |
| 开窗摘要 | checkpoint 的 `<compacted-summary>` | 折叠显示，点开看全文 |
| 保留尾部 | 平台规则 | 只说事实：上一窗末尾原样保留、排在摘要之后；**确切范围不随日志记录**，所以不编数字 |

**行（rows）—— 这一窗自己的时间线**

注入（`runtime-context` / `skill-catalog` / `time-context`…）、用户、助手、工具调用、工具结果，按 seq 排。

行是**按需拉取**的，并且**按 200 条切块**：`/state` 只发框（一个长会话 14KB）；点「展开明细」拉第 1 块，其余块各自折叠，点块头才请求 `/items?page=N&chunk=K`（每块约 40–60KB）。轮询 10 秒一次，且只在标签打开时。

## 路由

| 路由 | 用途 |
| --- | --- |
| `GET /dsh-session-pages/state?sessionId=…` | 窗口清单 + 框 + 统计（不含行） |
| `GET /dsh-session-pages/items?sessionId=…&page=N&chunk=K[&chunkSize=200]` | 一个窗口的一块行 |

两条都只接受 loopback + 同源 Origin，非 GET 一律 405，没有任何写路径。

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
