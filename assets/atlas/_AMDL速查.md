# AMDL 速查（以 _ 开头，站点会忽略这个文件）

正文写在 `## 说明` 下面，普通 Markdown 照常用，下面这些是可以额外用的。

## 行内

- 强调：`**粗**` `*斜*` `~~删除线~~` `==高亮==` `++下划线++` `^上标^` `~下标~`
- 行内代码：用一对反引号把文字包起来
- 按键：`[[Ctrl+C]]`
- 链接：`[文字](https://example.com "可选的标题")`
- 图片：`![说明](https://example.com/a.png)`
- 短名样式：`{color=#e04b4b|bold}红字{/}`
- 任意样式：`{style="letter-spacing:.1em"}任意 CSS{/}`

样式短名：color bg size weight font align line space border radius pad margin opacity shadow width height gap
布尔旗标：bold italic underline strike mono nowrap center left right justify

## 块级

```markdown
::: note tone=warn title="注意"
提示框，tone 可为 info / tip / warn / danger / success / quote
:::

::: card title="卡片"
卡片内容
:::

::: cols gap=10
::: col
左栏
:::
::: col
右栏
:::
:::

::: gallery cols=3
![图一](https://...)
![图二](https://...)
:::

::: details title="展开查看"
折叠内容
:::

::: tabs
::: tab label="路线 A"
第一条路线
:::
::: tab label="路线 B"
第二条路线
:::
:::

::: linkcard url="https://..." title="标题" desc="说明" icon="https://..."
:::

::: video src="https://...mp4" poster="https://...jpg"
:::

::: figure caption="图注"
![图](https://...)
:::
```

还有 `- 列表`、`1. 有序`、`- [x] 任务`、`> 引用`、`| 表格 |`、`---` 分割线、三个反引号代码块、`![图](url){width=60% align=center}` 独占一行的图。

换行就是换行（正文按行显示）；空行分段。
