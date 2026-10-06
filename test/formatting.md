---
title: Formatting test
tags: [test]
---
Setext heading
==============

## ATX heading with closing ##

Text with **bold**, __bold__, *italic*, _italic_, ~~strike~~, `code`, ``double `tick` code``,
a [link](https://example.com "Title"), a [reference link][ref], an autolink <https://example.com>,
a bare address https://example.com/x, a picture ![logo](images/none.png "logo") and escapes \* \_ \#.
Entities: &amp; &lt; &copy; &#169; &#x263A;. Inline <kbd>Ctrl</kbd>+<kbd>C</kbd> and <span title="x">span</span>.
Hard break with two spaces  
	line starting with a tab, and a backslash break\
done. Extra    spaces   here.
Hidden characters: zero​width, no break, soft­hyphen.

[ref]: https://example.com/ref "Reference"

> Quote line one
> continues **here**
>
> > Nested quote

> [!NOTE]
> A callout.

1. First
2. Second

   Loose paragraph in an item

| Left | Center | Right |
|:-----|:------:|------:|
| a    | **b**  | `c`   |
| long cell text | x | y |

***

    indented code line

```python
def f(x):

    return x ** 2   # spaces kept
```

~~~
tilde fence
~~~

Inline math $E = mc^2$ and \(\beta_i\), a footnote[^1].

$$
\int_0^1 x\,dx = \frac{1}{2}
$$

```math
a^2 + b^2 = c^2
```

```mermaid
graph LR; A[Start]-->B[End]
```

<div align="center">
  <p>Centered <b>HTML</b> caption</p>
</div>

<!-- an HTML comment -->

<details>
<summary>Click</summary>

Hidden **markdown** inside.

</details>

[^1]: The footnote text.

Final line without a trailing newline