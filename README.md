# dsh-chat-git

把每个对话变成一条 **git 检查点链**的 DeepSeek Harness 插件。

- **对话开始**时检查会话工作目录是否已有 git 仓库，没有则自动 `git init`；
- **每轮对话结束**（agent 交付完成）自动 `git add -A -- .` + `git commit`，提交信息格式为 `Ai-coding：描述`；
- 描述默认由**模型总结**：读一遍该轮的提示词与改动文件，写出一句简短标题，取代冗长且被截断的原始提示词；
- 每轮对话的图标行里多出一个**回退**图标按钮（就在复制按钮旁边）：点一下进入待确认，再点一下同时回滚**代码**与**对话**；
- 设置里提供**自动检查点开关**、**总结模型**（关闭 / 使用当前模型 / 指定模型）、**检测按钮**（执行 `git --version`）和**下载按钮**（跳转 Git 官方页面）。未安装 git 时自动检查点开关无法开启。

## 提交信息格式

每个检查点的提交主题由固定的 `Ai-coding：` 前缀（全角冒号）加一段简短描述组成：

```
Ai-coding：修复设置页开关无法启用
```

- **描述优先由模型生成**：把该轮的提示词与 `git diff --cached` 摘要交给
  `ctx.llm`，要求输出一句不超过 20 字、与提示词同语言的标题。返回结果会被清洗
  （去掉引号、`标题：` 之类的标签、被回显的 `Ai-coding：` 前缀、结尾句号），并
  截到 40 字。
- 整行（含前缀）**不超过 72 字符**，超出部分截断并以 `…` 结尾；
- 模型不可用、超时、报错或返回内容不可用时，**自动回退为提示词本身**（空白折叠
  成单个空格），绝不会因此丢掉检查点；
- 该轮没有记录到提示词时（会话在重启后恢复、或该轮没有用户消息），再回退为
  `Ai-coding：第 N 轮对话`。
- 设置里的 **总结模型** 有三态：**关闭**（描述直接取提示词，零模型调用）、
  **使用当前模型**（该对话自身的模型，读不到时退回默认模型）、**指定模型**
  （显式选一个 provider + model）。
- 指定模型的选择器由 host 从 **实时模型注册表**（`llm.listProviders()` +
  `llm.listModels()`）填充，因此不会列出本部署无法调用的路由；没有已注册模型的
  服务商不会出现在列表里，而已存储但注册表不再列出的路由仍保持可选 —— 否则打开
  一次设置页就会让用户的配置变得不可达。

## 安装

插件是一个 dsh profile bundle，用 profile 的 pnpm 装成本地包即可：

```bash
dsh plugin --profile web add link:E:/Porject/My_project/DsChatGit
```

`dsh plugin --profile <name> ...` 是一条 pnpm 转发器：它在 profile 目录里执行
`pnpm`，然后**按已安装状态重建 `dsh.profile.bundles` 层列表** —— 任何能解析到
「声明了 `dsh.bundle` 的包」的依赖都会自动加入层栈，本包正是这种情况，所以不必手改
profile 的 `package.json`。装完需要重启 `dsh web` 才会加载。卸载：

```bash
dsh plugin --profile web remove dsh-chat-git
```

## 组成

| 半边 | 入口 | 职责 |
| --- | --- | --- |
| Host | `lib/index.js`（`exports "."`） | 会话事件钩子、git 命令、`/chat-git` 路由、设置持久化 |
| Client | `lib/client.js`（`exports "./client"`） | 回退按钮、设置页 |

`lib/` 下的文件**就是源码**，没有构建步骤 —— 客户端半边直接写在
`window.__ModuleLoader__.load({ id, factory })` 包装格式里（这正是 client-modules
期望被服务的文件形状），因此不需要 TypeScript、tsdown 或任何 npm 依赖。
Host 半边只 import `node:` 内置模块和同目录兄弟模块：profile 安装会把包软链过去，
Node 会从真实项目路径向上解析裸模块名，那里并不存在依赖树，所以保持零依赖是刻意的。

### 两个客户端席位

| Slot | 类型 | 用途 |
| --- | --- | --- |
| `conversation.chat.assistant-actions` | list | 回退按钮。shell 把它渲染成该回合图标行的 `extraActions`，即**紧跟在复制按钮之后** |
| `settings.section` | list | 设置页（自动检查点开关 / 总结模型三态 / 检测 / 下载） |

两个席位都是**纯增量**的 list：不与他人争抢任何 cell，因此本插件不会遮蔽、也不会顶掉
任何既有 UI。

## Host 路由

全部 loopback-only、POST、JSON 信封 `{ ok, value }` / `{ ok, error }`。
路由只接受 `sessionId`，**从不接受路径**，因此无法被指向任意目录。

| 路由 | 作用 |
| --- | --- |
| `POST /chat-git/state` | 两个开关的状态、git 探测结果、该会话的检查点列表 |
| `POST /chat-git/detect` | 执行 `git --version` |
| `POST /chat-git/set-enabled` | 切换自动检查点；git 不可用时**拒绝开启** |
| `POST /chat-git/set-summary` | 局部更新总结偏好（`mode` / `provider` / `model`）；无路由的 `custom` **被拒绝** |
| `POST /chat-git/models` | 实时模型目录，供设置页的选择器使用（带 60 秒缓存与每服务商 4 秒上限） |
| `POST /chat-git/revert` | `git checkout <sha> -- .` 并清理该检查点之后新增的路径 |
| `POST /chat-git/inherit` | 回退分叉后，把剩余检查点交给新会话 |

## 状态

写在 `$DSH_HOME/chat-git.json`（默认 `~/.dsh/chat-git.json`），内容为偏好与
`sessionId -> { cwd, commits }` 映射：

```json
{
  "version": 1,
  "enabled": true,
  "summary": { "mode": "current", "provider": "", "model": "" },
  "sessions": { "<sessionId>": { "cwd": "...", "commits": [] } }
}
```

放在磁盘上而非内存里，因此 harness 重启后历史对话的回退按钮依然可用。任何读写失败
都降级为仅内存，不会把插件拖垮。0.2 的布尔 `summarize` 字段会被读取并迁移为对应的
`summary.mode`（`false` → `off`，`true` → `current`），不会因为升级而悄悄把用户关掉
的功能重新打开。

## 设计边界与取舍

这些是刻意的工程决定，不是未完成项：

1. **回退用 fork，不销毁会话。** DSH 没有「截断会话」API，只有
   `sessions.fork({ sessionId, atSeq })`。所以「后面的对话全部删除」实现为：
   在该轮结束序列处分叉，得到只含前 N 轮的新会话并切换过去。原始日志保留，
   用户不会因为一次误点永久丢失记录。
2. **`git checkout` 语义是「还原内容 + 清掉新增」，HEAD 不动。**
   单条 `git checkout <sha> -- .` 不会删除该提交中不存在的路径，后面几轮新建的
   文件会残留、让回溯看起来只做了一半。所以在此之后还会 `git rm` 掉
   `sha..HEAD` 之间**新增**的路径。只动 HEAD 里存在的路径，因此每一步都还能从
   提交历史里找回。HEAD 保持不动，使「轮次 → 检查点」映射继续可读。
3. **未跟踪文件不碰。** 它们不属于任何检查点，删掉就找不回来了。回退后它们会
   作为未跟踪文件留在原地。
4. **已有仓库会被沿用，不会被重新 init。** 只有当会话工作目录**本身就是**一个
   仓库根时才会沿用；仅仅位于某个上层仓库**内部**时，会在工作目录里 `git init`
   出自己的仓库，避免把提交打到用户没在这个对话里打开过的祖先仓库上。这个隔离由
   两件事共同保证：嵌套仓库本身，以及 `git add -A -- .` 中显式的 pathspec ——
   自 Git 2.0 起，不带 pathspec 的 `git add -A` 会暂存**整个工作树**而与当前目录
   无关，一旦工作区落在更大的仓库内就会把无关改动一起卷进来。
5. **按钮落在回合图标行，而不是用户消息那一行。** 用户消息的复制按钮由 shell 的
   `UserMessageNodeView` 内联渲染，内部**不渲染任何 slot**；`conversation.chat.node`
   下只声明了 `tool.call.toolview` / `assistant-actions` / `turnTail` / `commandview`
   四个子席，没有任何用户消息操作位。且 `UserStyleBubble` / `MessageIconActions` 是
   `dsh-client-ui-chat` 的模块私有符号，`exports` 只暴露 4 个值；所有公开 client 模块
   （ui-chat 4 个、ui-conversation 13 个、ui-session 3 个）都不提供可复用的气泡组件，
   `dsh-client-ui-primitives` 在本机安装树里甚至不存在。因此「复制旁边」只能落在
   回合图标行 —— 那里恰好是 `MessageIconActions` 的 `extraActions`，渲染顺序为
   `[时间, 复制按钮, extraActions, 分支按钮, …]`，即**紧邻复制按钮**。
6. **按钮靠 `messageId` 反查轮次。** `assistant-actions` 只派发 `messageId`，而检查点
   按轮次编号存放，回退还需要分叉边界。轮次号与回合结束序列都从 Chat snapshot 的
   `turn-tail` 节点上读回（其已声明的载荷同时携带三者），选择器返回 `"turn:seq"`
   字符串而非对象，以保证取值按值比较稳定、不引发多余渲染。
7. **`/chat-git/state` 的空 `sessionId` 是合法的全局读。** 设置页没有会话，只读开关、
   git 探测与状态文件路径。曾经把它当作缺参拒绝，结果设置页永远拿不到 state、开关
   一直禁用并显示 `sessionId is required` —— 现由 host 与 client 两侧的测试共同看住。
8. **git 走 `ctx.subprocess` 的 argv 数组**，不是 shell 字符串：没有引号规则要处理、
   提交信息与路径没有注入面，并且与工具调用享有同等的子进程生命周期与输出上限。
9. **AI 总结在读不到模型时必须是「少一个功能」而不是「丢一个检查点」。** 所以
   `ctx.get('llm')` 与 `agentDefaultModel.currentSelection()` 都是可选读，整条路径
   返回空字符串即回退到提示词；`llm` 调用另有 8 秒上限，且 `GenerateOptions` 里
   不声明 `purpose` —— 本插件的调用不是 harness 的 `session-title` 功能，冒用它会让
   遥测把用量记到别处。标题消息以 `source: { kind: 'plugin', plugin: 'chat-git' }`
   标注作者。
10. **标题调用发生在暂存之后、提交之前。** 先把 `git add -A -- .` 做掉，标题调用才能
    看到这一轮真正改了哪些文件 —— 这是「总结这一轮做了什么」而非「复述请求」的关键。
    代价是每轮结束会等一次模型调用（上限 8 秒）；换来的是提交必定早于客户端渲染该轮
    的回退按钮，两者不会赛跑。
11. **偏好校验放在 store，不放在路由。** `setSummary` 自己拒绝未知的 `mode`，以及
    缺少 provider 或 model 的 `custom` —— 这样每个写入方都被覆盖，而路由只是转发。
    另一面是**部分补丁会合并**：只发 `{ mode: 'custom' }` 会保留已存好的路由，因此
    「切模式」和「选路由」可以分两步走，不会互相清空。
12. **选择器只提供可用的东西，但保留已成事实的配置。** 没有已注册模型的服务商不出现在
    列表里（选它必然被 host 拒绝，等于设陷阱）；而**已存储**、注册表却不再列出的
    provider / model 仍然可选 —— 否则打开一次设置页就会让用户的配置变得不可达。
    模型目录读取带 60 秒缓存，且每个服务商各自 4 秒上限，卡住的服务商只会退化成空
    模型列表，不会拖住整个设置页。

## 验证

```bash
npm test              # 两套一起跑
npm run test:host     # 107 项：真实 git、假 ctx/假模型、真实 loopback HTTP
npm run test:client   # 89 项：包装格式、席位注册、消息→轮次反查、回退流程、三态选择器
```

`test/harness.mjs` 用**真实 git 子进程**在一个临时工作区里跑完整链路，并通过真实
HTTP 服务器驱动路由处理器，因此 loopback 守卫、JSON 信封都真正被覆盖。

> Windows 沙箱注意：受限模式下 Node 无法用 `stdio: 'pipe'` 捕获子进程输出
> （spawn 直接 EPERM），所以测试桩把子进程输出重定向到**普通文件描述符**再读取。
