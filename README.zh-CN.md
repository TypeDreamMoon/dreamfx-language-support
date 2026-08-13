# DreamFXLang Language Support

[![version](https://img.shields.io/badge/version-0.2.0-blue)](CHANGELOG.md)
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

或者命令面板里的 **`DreamFXLang: Rebuild Module Index`**。本项目实测 **571 个模块、约 8 秒**。
它是**命令**而不是自动行为:每次 `dfx` 调用都要 boot 一次 Unreal 编辑器 —— 几十秒,
而任何由「打字」触发的东西都付不起这个代价。

为什么是文件而不是写死的表:DreamFX 的模块是**运行时从资产注册表发现的**。装了 NiagaraFluids
就多一族,换个项目就换一套。写进扩展里的表**第一天就是错的**。

索引记录了引擎路径与已启用插件列表,因为正是这两样让它失效。目前**没有任何东西去比对它们** ——
那需要一个活着的编辑器来比 —— 所以状态栏只显示索引是什么时候生成的,重建是一次点击。

## 还没做

| | 状态 |
| --- | --- |
| 保存即校验 | 计划中 |
| 与运行中 Unreal 编辑器的双向桥(单资产重编、打开资产、从 VSCode 反编译) | 计划中 |

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
| `DreamFXLang: Verify Current File` | 拿源码核对资产。**只读** |
| `DreamFXLang: Lint Current File` | 风格与一致性警告。**只读** |
| `DreamFXLang: Build Current File` | 生成资产。**写包** —— 见下 |

`verify` 与 `build` 同时以任务形式贡献,所以 `tasks.json` 里可以绑快捷键或设为默认构建任务:

```json
{ "type": "dreamfx", "command": "verify", "scope": "all" }
```

### build 会写包,所以它先问一句

如果 Unreal 编辑器开着这个工程,它和 `dfx` 会存同一批包,**后存的静默胜出**。
这就是为什么 `build` 不会自动跑、不会在保存时跑,并且默认弹一个模态警告。
`verify` 与 `lint` 什么都不写,任何时候都安全。

选「Run anyway」是个正经答案:编辑器开着 ≠ 那个编辑器开的是**这个**工程 ——
这也正是 CLI 自己只警告而不拒绝的原因。等这个区别对你不再重要,用 `dreamfx.confirmBuild` 关掉提示。

另外:每次 `dfx` 调用都要 boot 一次引擎,几十秒级。所以这里**没有任何**按键触发的东西。

## 设置

| 设置 | 默认 | |
| --- | --- | --- |
| `dreamfx.dfxScriptPath` | `""` | `.skill/dfx.ps1` 的路径。留空则先从文件向上找,再搜工作区 |
| `dreamfx.powershellPath` | `"pwsh"` | Windows PowerShell 5.1 请填 `powershell` |
| `dreamfx.syntaxDiagnostics` | `true` | 输入时的实时词法问题 |
| `dreamfx.confirmBuild` | `true` | 写包类命令执行前先确认 |

## 开发

```bash
npm install
npm run compile
npm test
```

`F5` 启动 Extension Development Host。`src/core/` 下的语言核心**不 import 任何 `vscode`** ——
那是将来 language server 或别的 IDE 要复用的接缝,所以保持干净。

测试不需要 VSCode,也不需要引擎。要顺带扫一棵真实源码树:

```bash
DREAMFX_CORPUS_DIR=/path/to/YourProject npm test
```

## 链接

- [DreamFX 插件](https://github.com/TypeDreamMoon/DreamFX) —— 语言、编译器与 CLI
- [语言参考](https://github.com/TypeDreamMoon/DreamFX/tree/main/Docs/language)
- [诊断码](https://github.com/TypeDreamMoon/DreamFX/tree/main/Docs/diagnostics)

MIT © TypeDreamMoon
