# dsh-chat-git

把每个对话变成一条 **git 检查点链**的 DeepSeek Harness 插件。

- **对话开始**时检查会话工作目录是否已有 git 仓库，没有则自动 `git init`；
- **每轮对话结束**（agent 交付完成）自动 `git add -A -- .` + `git commit`，提交信息格式为 `Ai-coding：描述`；
- 每轮对话下方多出一个**撤回**按钮：点一下进入待确认，再点一下同时回滚**代码**与**对话**；
- 设置里提供**自动检查点开关**、**检测按钮**（执行 `git --version`）和**下载按钮**（跳转 Git 官方页面）。未安装 git 时开关无法开启。

## 提交信息格式

每个检查点的提交主题由固定的 `Ai-coding：` 前缀（全角冒号）加一段简短描述组成：

```
Ai-coding：给登录接口补上失败重试
```

- **描述**取自驱动该轮的提示词，空白折叠成单个空格；
- 整行（含前缀）**不超过 72 字符**，超出部分截断并以 `…` 结尾；
- 该轮没有记录到提示词时（会话在重启后恢复、或该轮没有用户消息），回退为
  `Ai-coding：第 N 轮对话`。

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
| Client | `lib/client.js`（`exports "./client"`） | 撤回按钮、会话跟踪、设置页 |

`lib/` 下的文件**就是源码**，没有构建步骤 —— 客户端半边直接写在
`window.__ModuleLoader__.load({ id, factory })` 包装格式里（这正是 client-modules
期望被服务的文件形状），因此不需要 TypeScript、tsdown 或任何 npm 依赖。
Host 半边只 import `node:` 内置模块和同目录兄弟模块：profile 安装会把包软链过去，
Node 会从真实项目路径向上解析裸模块名，那里并不存在依赖树，所以保持零依赖是刻意的。

### 三个客户端席位

| Slot | 类型 | 用途 |
| --- | --- | --- |
| `conversation.chat.turnTail` | chain | 撤回按钮。渲染在每轮标准操作行**之前**（兄弟节点，不替换它） |
| `conversation.chat.assistant-actions` | list | 隐形会话跟踪席位，保持检查点索引预热，不渲染任何像素 |
| `settings.section` | list | 设置页（开关 / 检测 / 下载） |

## Host 路由

全部 loopback-only、POST、JSON 信封 `{ ok, value }` / `{ ok, error }`。
路由只接受 `sessionId`，**从不接受路径**，因此无法被指向任意目录。

| 路由 | 作用 |
| --- | --- |
| `POST /chat-git/state` | 开关状态、git 探测结果、该会话的检查点列表 |
| `POST /chat-git/detect` | 执行 `git --version` |
| `POST /chat-git/set-enabled` | 切换开关；git 不可用时**拒绝开启** |
| `POST /chat-git/revert` | `git checkout <sha> -- .` 并清理该检查点之后新增的路径 |
| `POST /chat-git/inherit` | 撤回分叉后，把剩余检查点交给新会话 |

## 状态

写在 `$DSH_HOME/chat-git.json`（默认 `~/.dsh/chat-git.json`），内容为开关偏好与
`sessionId -> { cwd, commits }` 映射。放在磁盘上而非内存里，因此 harness 重启后
历史对话的撤回按钮依然可用。任何读写失败都降级为仅内存，不会把插件拖垮。

## 设计边界与取舍

这些是刻意的工程决定，不是未完成项：

1. **撤回用 fork，不销毁会话。** DSH 没有「截断会话」API，只有
   `sessions.fork({ sessionId, atSeq })`。所以「后面的对话全部删除」实现为：
   在该轮结束序列处分叉，得到只含前 N 轮的新会话并切换过去。原始日志保留，
   用户不会因为一次误点永久丢失记录。
2. **`git checkout` 语义是「还原内容 + 清掉新增」，HEAD 不动。**
   单条 `git checkout <sha> -- .` 不会删除该提交中不存在的路径，后面几轮新建的
   文件会残留、让回溯看起来只做了一半。所以在此之后还会 `git rm` 掉
   `sha..HEAD` 之间**新增**的路径。只动 HEAD 里存在的路径，因此每一步都还能从
   提交历史里找回。HEAD 保持不动，使「轮次 → 检查点」映射继续可读。
3. **未跟踪文件不碰。** 它们不属于任何检查点，删掉就找不回来了。撤回后它们会
   作为未跟踪文件留在原地。
4. **已有仓库会被沿用，不会被重新 init。** 只有当会话工作目录**本身就是**一个
   仓库根时才会沿用；仅仅位于某个上层仓库**内部**时，会在工作目录里 `git init`
   出自己的仓库，避免把提交打到用户没在这个对话里打开过的祖先仓库上。这个隔离由
   两件事共同保证：嵌套仓库本身，以及 `git add -A -- .` 中显式的 pathspec ——
   自 Git 2.0 起，不带 pathspec 的 `git add -A` 会暂存**整个工作树**而与当前目录
   无关，一旦工作区落在更大的仓库内就会把无关改动一起卷进来。
5. **turnTail 的优先级是 `-5`。** 该 chain 没有默认条目，但 `dsh-better-sidebar`
   以 `-1` 注册、并且只在「该轮产出了文件」时命中 —— 那恰好也是产生检查点的轮次。
   本插件的选择器只认领**索引里已有检查点**的轮次，其余一律返回 `null` 交还给兄弟
   条目；代价是在有检查点的轮次上，better-sidebar 的产出文件行会被让位。
   若要恢复其优先权，把 `lib/client.js` 里的 `TURN_TAIL_PRIORITY` 调成 `>= -1` 即可
   （代价是本插件的按钮将只在 better-sidebar 不认领的轮次出现）。
6. **选择器是同步的。** chain 的 `select` 拿不到 `sessionId`、也不能 await，所以它读
   一个由跟踪席位预热的同步索引。索引冷时一律 decline —— 这是安全方向：冷索引只会
   让本插件少出现一个按钮，绝不会抢走别人的席位。
7. **git 走 `ctx.subprocess` 的 argv 数组**，不是 shell 字符串：没有引号规则要处理、
   提交信息与路径没有注入面，并且与工具调用享有同等的子进程生命周期与输出上限。

## 验证

```bash
npm test              # 两套一起跑
npm run test:host     # 52 项：真实 git、假 ctx、真实 loopback HTTP
npm run test:client   # 54 项：包装格式、席位注册、同步选择器、渲染输出
```

`test/harness.mjs` 用**真实 git 子进程**在一个临时工作区里跑完整链路，并通过真实
HTTP 服务器驱动路由处理器，因此 loopback 守卫、JSON 信封都真正被覆盖。

> Windows 沙箱注意：受限模式下 Node 无法用 `stdio: 'pipe'` 捕获子进程输出
> （spawn 直接 EPERM），所以测试桩把子进程输出重定向到**普通文件描述符**再读取。
