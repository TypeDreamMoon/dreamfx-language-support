# DreamFXLang Language Support

[![version](https://img.shields.io/badge/version-0.4.0-blue)](CHANGELOG.md)
[![vscode](https://img.shields.io/badge/VS%20Code-%5E1.85-007ACC)](https://code.visualstudio.com/)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[DreamFX](https://github.com/TypeDreamMoon/DreamFX) 的编辑器支持 —— 用 `.dfs` / `.dfe` / `.dfm`
文本生成 Unreal Niagara 系统的那门语言。

[English](README.md) | 简体中文

---

## 现在能做什么

| | |
| --- | --- |
| **高亮** | `.dfs` / `.dfe` / `.dfm` 完整 TextMate 语法;`hlsl { }` 与模块的 `Body = { }` 交给 HLSL 语法着色 |
| **大纲** | 文档 → emitter → 栈 / 段落 / 渲染器 → 模块调用与声明,在 Outline、面包屑与 `Ctrl+Shift+O` 中可用 |
| **折叠** | 花括号,外加 `#Region` / `#EndRegion` |
| **实时语法错误** | 未闭合的字符串、块注释、反引号名、原始块,非法字符,未闭合的块 —— 用**编译器自己的 DFX1xxx 码**报出,并链到它的文档 |
| **补全** | 先按**当前所在的栈**过滤出模块名,再补该模块的**真实输入名**,再补枚举值 —— 全部来自项目**实际可用**的模块集,不是写死的表 |
| **Hover** | 模块的说明、可用栈与完整签名;输入的类型、枚举值、是否接受表达式 |
| **代码片段** | 26 个骨架:各类文档、栈、`OnEvent`、`Stage`、渲染器、`curve { }`、`hlsl { }`、`Bind`、`disabled`、`as`、`@version`、`#Region` |
| **新建文件** | `DreamFXLang: New Source File` —— 选类型、填资产名,得到一个**能直接 build 过**的文件 |
| **任务与 Problems** | `verify` / `lint` / `build`,命令或任务两种入口,每个 `DFXnnnn` 带行列落进 Problems 面板,可点击跳转 |
| **保存即校验** | 需开启(`dreamfx.verifyOnSave`):保存时校验,结果直接进 Problems,**同时只跑一个引擎** |
| **编辑器桥** | Unreal 编辑器开着时,`verify` / `build` **交给它做**,不再另起一个引擎 —— **半秒,而不是十三秒**。另可打开本文件生成的资产、重新导出、Adopt。见[下文](#编辑器桥) |

## 有意不做什么

**它从不判断你的源码是否合法。** 那是编译器的事 —— C++ 里的 143 个诊断码,每个都带行列。
在 TypeScript 里再实现一遍,等于给同一个问题造出**第二个真相源**,而两个真相源必然漂移。
漂移的表现是*「编辑器说没事、构建报错」* —— 比完全没有编辑器反馈还糟。

所以扩展只报**从字符本身就能确定**的东西 —— 编译器自己的 `DFX1xxx` 词法族,从它自己的 lexer 移植过来 ——
其余一律由 `dfx` 经 problem matcher 送达,带着它在终端里会显示的同一批码。

这是量出来的,不是声称的:编译器的 40 个反例语料(每一个都构建失败)在这个扩展里报出**零**个问题,
因为那 40 个全部是**语义**失败;而 73 个真实源码(含第三方内容的反编译镜像)同样报出零个,
并且每一个的结构都被正确识别。

## 模块索引

补全与 hover 读的是插件导出的 `DFX/.dfx-index.json`:

```bash
pwsh -File .skill/dfx.ps1 index
```

或者命令面板里的 **`DreamFXLang: Rebuild Module Index`**。本项目实测 **571 个模块**,
引擎 boot 约 13 秒之后再干约 8 秒的活。它是**命令**而不是自动行为:
任何由「打字」触发的东西都付不起这个代价。

为什么是文件而不是写死的表:DreamFX 的模块是**运行时从资产注册表发现的**。装了 NiagaraFluids
就多一族,换个项目就换一套。写进扩展里的表**第一天就是错的**。

索引记录了引擎路径与已启用插件列表,因为正是这两样让它失效。目前**没有任何东西去比对它们** ——
那需要一个活着的编辑器来比 —— 所以状态栏只显示索引是什么时候生成的,重建是一次点击。

## 保存即校验

打开 `dreamfx.verifyOnSave`,保存源码就会对它跑一次 `dfx verify`,结果**直接进 Problems** ——
不开终端、不开任务面板。只读,不写任何包。同一个文件连续保存只排一次队;
校验进行中到来的保存会**并入同一个队列**,而不是再起一个引擎。

**默认关闭,因为代价取决于编辑器开不开。** 走 CLI 单文件约 **13 秒**,几乎全是引擎 boot;
走运行中的编辑器**不到半秒**。所以:如果你习惯开着编辑器,就把它打开。

`DreamFXLang: Verify Current File (quietly, into Problems)` 是同一件事的手动入口。

## 编辑器桥

Unreal 编辑器开着这个工程时,`verify` 与 `build` **交给它做**,而不是再 boot 一个引擎。对活编辑器实测:

| | 桥 | CLI |
| --- | --- | --- |
| ping | 113 ms | — |
| verify(干净文件) | **324 ms** | 13,000 ms |
| verify(2 个错) | **539 ms** | 13,000 ms |
| build(单系统) | **1,255 ms** | 13,000 ms + 构建 |

**走哪条路不是偏好问题。** `dfx build` 写包,运行中的编辑器也写包;两者存同一批包时,
**后存的静默胜出**,先做的工作没了,而且哪儿都不报错。编辑器开着时,桥不是「更快的那条路」,
而是**唯一正确的那条** —— 这也是为什么写包警告只出现在 CLI 路线上。

它通过 `<Project>/Saved/DreamFX/Bridge/` 下的文件通信:无端口、无防火墙弹窗。
需要插件侧的 `FBridgeService`;没有它则一切照旧 —— 没有 `status.json` 就是没有编辑器,
所有命令走原来的 CLI 路线。

状态栏显示下一条命令会走哪条路。**Editor Bridge Status** 可以 ping 一下。

### 明说的限制

- **桥上不探测输入签名。** 探测要走模块图,而有一份引擎内容会递归到栈溢出进程死掉 ——
  这对有人看着的 CLI 进程可以接受,对你的编辑器不行。编辑器开着时 `Rebuild Module Index`
  给你模块清单;要输入签名请跑 `dfx index`,补全那边会**明说**而不是给个空列表。
- **一个工程一个编辑器。** 两个会抢同一批请求。两个编辑器开同一工程本来就是不支持的状态,故只声明不设防。
- **没人在听的时候写下的请求会被丢弃,不会排队。** 等到有编辑器启动时,发它的人早已超时走了别的路;
  而在启动时执行一条过期的 `build` 会写下没人要的包。

## 还没做

| | 状态 |
| --- | --- |
| 发布到 VSCode Marketplace | 押后 —— release 里发 `.vsix` |

## 安装

从 release:下载 `.vsix` 后运行

```bash
./install-vscode-extension.ps1
```

从源码:

```bash
npm install && npm run package
```

## 使用

工作区可以由插件生成 —— Unreal 编辑器里 **Tools → DreamFX → Open Workspace** 会写出
`DFX/DreamFX.code-workspace`,把工程与各插件的源码根都列为文件夹,文件关联也已经指向本扩展。

命令(`Ctrl+Shift+P`):

| 命令 | |
| --- | --- |
| `DreamFXLang: New Source File` | 从模板创建 `.dfs` / `.dfe` / `.dfm` |
| `DreamFXLang: Rebuild Module Index` | 重新导出补全所读的模块索引。**只读** |
| `DreamFXLang: Verify Current File` | 拿源码核对资产,开终端看过程。**只读** |
| `DreamFXLang: Verify Current File (quietly…)` | 同上,但不开终端,结果直接进 Problems。**只读** |
| `DreamFXLang: Lint Current File` | 风格与一致性警告。**只读** |
| `DreamFXLang: Build Current File` | 生成资产。**写包** —— 见下 |
| `DreamFXLang: Open the Asset This File Builds` | 在编辑器里打开它。需要桥 |
| `DreamFXLang: Re-export This Asset to Source` | 重新反编译成源码。需要桥 |
| `DreamFXLang: Adopt This Asset` | 让文本成为唯一真相源。需要桥 |
| `DreamFXLang: Editor Bridge Status` | 当前走哪条路,以及 ping 一下 |

`verify` 与 `build` 同时以任务形式贡献,所以 `tasks.json` 里可以绑快捷键或设为默认构建任务:

```json
{ "type": "dreamfx", "command": "verify", "scope": "all" }
```

### build 会写包,所以 CLI 那条路先问一句

如果 Unreal 编辑器开着这个工程,它和 `dfx` 会存同一批包,**后存的静默胜出**。
这就是为什么 CLI 的 `build` 不会自动跑、不会在保存时跑,并且默认弹一个模态警告。
`verify` 与 `lint` 什么都不写,任何时候都安全。

**走桥则不问** —— 因为没有第二个写包者可问:存包的就是编辑器自己。

在 CLI 那条路上选「Run anyway」是个正经答案:编辑器开着 ≠ 那个编辑器开的是**这个**工程 ——
这也正是 CLI 自己只警告而不拒绝的原因。等这个区别对你不再重要,用 `dreamfx.confirmBuild` 关掉提示。

另外:一次 CLI 调用要 boot 一次引擎,约 13 秒。所以这里**没有任何**按键触发的东西。

## 设置

| 设置 | 默认 | |
| --- | --- | --- |
| `dreamfx.dfxScriptPath` | `""` | `.skill/dfx.ps1` 的路径。留空则先从文件向上找,再搜工作区 |
| `dreamfx.powershellPath` | `"pwsh"` | Windows PowerShell 5.1 请填 `powershell` |
| `dreamfx.syntaxDiagnostics` | `true` | 输入时的实时词法问题 |
| `dreamfx.confirmBuild` | `true` | 写包类命令执行前先确认 |
| `dreamfx.verifyOnSave` | `false` | 保存时校验。只读;每次约 13 秒 |

## 开发

```bash
npm install
npm run build
npm test
```

扩展是两个进程。`src/server/` 是一个标准 LSP server —— 补全、悬停、大纲、词法诊断,以及它们读的
`.dfx-index.json`。`src/extension.ts` 是客户端:构建、校验、资产操作和编辑器桥,这些协议都管不着。
`src/core/` 下的语言核心既不 import `vscode`、也不 import 协议,正因如此 server 才能原封不动地从
provider 里抬出来。

`npm run build` 先跑 `tsc`(类型和测试),再跑 esbuild 打出编辑器真正加载的两个 bundle
(`out/client.js`、`out/server.js`)。`F5` 启动 Extension Development Host;要在 server 里下断点,
用 **Extension + Server** 复合配置,它会额外挂一个调试器到 6019 端口。

测试不需要 VSCode,也不需要引擎 —— 包括 `serverProtocol.test.ts`,它会拉起构建好的 server 走 stdio
跟它进行一次真实的 LSP 对话。要顺带扫一棵真实源码树 —— 指向一个项目或插件本身,它会双向校对:
编译器接受的源一条都不许报,编译器拒绝的源这边除 DFX1xxx 外不许有任何判断:

```bash
DREAMFX_CORPUS_DIR=/path/to/Plugins/DreamFX npm test
```

## 链接

- [DreamFX 插件](https://github.com/TypeDreamMoon/DreamFX) —— 语言、编译器与 CLI
- [语言参考](https://github.com/TypeDreamMoon/DreamFX/tree/main/Docs/language)
- [诊断码](https://github.com/TypeDreamMoon/DreamFX/tree/main/Docs/diagnostics)

MIT © TypeDreamMoon
