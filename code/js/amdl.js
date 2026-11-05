/* ============================================================
   AMDL v1 · Atlas Markdown
   一个「什么内容、什么样式都能写」的 Markdown 超集，给神瞳文案与站点文档共用。

   设计约束（和这个项目的历史教训绑定）：
   1) 单一实现：解析只在这里写一次。构建期用 node 跑它生成 AST，
      浏览器端只负责把 AST 画成 DOM —— 不存在「Python 一套、JS 一套」的对不上。
   2) 零依赖、零 innerHTML：渲染全程 createElement + textContent，
      文案来自上游仓库，绝不能变成 XSS 通道。
   3) 旧文件不改也能读：`# 标题` + `- 键：值` + `## 说明` 的老格式天然是合法子集。
   4) 样式是「受控的自由」：常用键有短名（color/size/bg…），
      想要任意 CSS 就写 style="..."，但仍然过消毒（禁 url()/expression/@import）。

   用法：
     const doc = AMDL.parse(mdText);        // {v,title,meta,blocks,errors}
     AMDL.render(doc, containerEl);         // 画进 DOM
     const plain = AMDL.toText(doc);         // 降级纯文本（老客户端只认 txt）

   语法说明见仓库根目录 AMDL.md。
   ============================================================ */
(function (root) {
  'use strict';

  var VERSION = 1;
  var MAX_NEST = 32;                 // 容器嵌套上限，防手滑写出死循环

  /* ------------------------------------------------------------------ *
   *  基础工具
   * ------------------------------------------------------------------ */

  var META_RE = /^[-*]\s*([^\s：:]{1,8})\s*[：:]\s*(.*)$/;
  var LEGACY_BODY_RE = /^#{2,6}\s*(说明|描述|介绍|正文|Description|Notes?)\s*$/i;
  var LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  var FENCE_RE = /^(`{3,}|~{3,})\s*([\w+.+#-]*)\s*$/;
  var DIRECTIVE_RE = /^:::\s*([A-Za-z][\w-]*)\s*(.*)$/;
  var HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  var HR_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  var IMG_BLOCK_RE = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)\s*(?:\{(.*)\})?\s*$/;

  function repeat(ch, n) { var s = ''; while (n-- > 0) s += ch; return s; }

  function indentOf(line) {
    var n = 0;
    while (n < line.length && (line[n] === ' ' || line[n] === '\t')) n++;
    return n;
  }

  function trimRight(s) { return s.replace(/\s+$/, ''); }

  /* URL 白名单：只放行 http(s)/mailto/tel/锚点/相对路径与安全的内嵌图片 */
  var SAFE_DATA_IMG = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
  function safeUrl(u) {
    var s = String(u == null ? '' : u).trim();
    if (!s) return '';
    if (SAFE_DATA_IMG.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      return /^(https?:|mailto:|tel:)/i.test(s) ? s : '';
    }
    if (s.indexOf('//') === 0) return 'https:' + s;
    return s;
  }

  /* CSS 消毒：禁掉能外联/执行/穿透的构造 */
  var CSS_BAD = /(url\s*\(|expression\s*\(|@import|javascript:|behavior\s*:|-moz-binding|<|>|\\69|\\75)/i;
  function safeCss(css) {
    var s = String(css == null ? '' : css);
    if (!s || CSS_BAD.test(s)) return '';
    return s.replace(/;\s*$/, '');
  }

  /* 单值消毒：值里出现 ; { } 会破坏声明边界，直接丢弃 */
  function safeValue(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s || /[;{}]/.test(s) || CSS_BAD.test(s)) return '';
    return s;
  }

  var STYLE_MAP = {
    color: 'color',
    bg: 'background-color',
    background: 'background',
    size: 'font-size',
    weight: 'font-weight',
    font: 'font-family',
    align: 'text-align',
    line: 'line-height',
    space: 'letter-spacing',
    border: 'border',
    radius: 'border-radius',
    pad: 'padding',
    margin: 'margin',
    opacity: 'opacity',
    shadow: 'box-shadow',
    width: 'width',
    height: 'height',
    display: 'display',
    float: 'float',
    filter: 'filter',
    transform: 'transform',
    gap: 'gap',
    valign: 'vertical-align'
  };

  var STYLE_FLAGS = {
    bold: 'font-weight:700',
    italic: 'font-style:italic',
    underline: 'text-decoration:underline',
    strike: 'text-decoration:line-through',
    mono: 'font-family:var(--font-mono,monospace)',
    nowrap: 'white-space:nowrap',
    center: 'text-align:center',
    left: 'text-align:left',
    right: 'text-align:right',
    justify: 'text-align:justify',
    wrap: 'white-space:normal',
    hidden: 'display:none'
  };

  /* 属性串 → CSS 声明串。短名优先，style= 兜底，未知键忽略（不报错，方便未来扩展） */
  function propsToCss(props) {
    var out = [];
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      var v = props[k];
      if (k === 'style') {
        var raw = safeCss(v);
        if (raw) out.push(raw);
        continue;
      }
      if (STYLE_FLAGS[k] && (v === true || v === '' || v === k || v === '1' || v === 'true')) {
        out.push(STYLE_FLAGS[k]);
        continue;
      }
      var key = STYLE_MAP[k];
      if (!key) continue;
      var val = safeValue(v);
      if (!val) continue;
      out.push(key + ':' + val);
    }
    return out.join(';');
  }

  /* 属性解析：key=value / key="a b" / 裸 flag；分隔符 空格 | , ; */
  function parseProps(src) {
    var out = {};
    var s = String(src == null ? '' : src);
    var i = 0;
    while (i < s.length) {
      while (i < s.length && /[\s|,;]/.test(s[i])) i++;
      var k = '';
      while (i < s.length && /[A-Za-z0-9_-]/.test(s[i])) k += s[i++];
      if (!k) { i++; continue; }
      while (i < s.length && /\s/.test(s[i])) i++;
      var v = true;
      if (s[i] === '=') {
        i++;
        while (i < s.length && /\s/.test(s[i])) i++;
        if (s[i] === '"' || s[i] === "'") {
          var q = s[i++];
          var t = '';
          while (i < s.length && s[i] !== q) t += s[i++];
          i++;
          v = t;
        } else {
          var t2 = '';
          while (i < s.length && !/[\s|]/.test(s[i])) t2 += s[i++];
          v = t2;
        }
      }
      out[k.toLowerCase()] = v;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   *  行内解析
   * ------------------------------------------------------------------ */

  function findCloser(s, from, delim) {
    var idx = s.indexOf(delim, from);
    while (idx > -1) {
      if (idx === from) return -1;                 // 空的 ** 不算
      if (delim === '*' && s[idx + 1] === '*') {   // 避免吃掉紧邻的 **
        idx = s.indexOf(delim, idx + 2);
        continue;
      }
      return idx;
    }
    return -1;
  }

  function readPropsSuffix(s, i) {
    if (s[i] !== '{') return { props: {}, end: i };
    var j = i + 1, q = null;
    while (j < s.length && s[j] !== '}') {
      if (s[j] === '"' || s[j] === "'") { q = s[j++]; while (j < s.length && s[j] !== q) j++; }
      j++;
    }
    if (j >= s.length) return { props: {}, end: i };
    var src = s.slice(i + 1, j);
    if (!/[A-Za-z-]+\s*=/.test(src) && !/[A-Za-z-]/.test(src)) return { props: {}, end: i };
    return { props: parseProps(src), end: j + 1 };
  }

  /* [文字](url "标题"){属性} —— i 指向 '[' */
  function readLink(s, i) {
    var depth = 0, j = i, close = -1;
    for (; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === '[') depth++;
      else if (s[j] === ']') { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close < 0 || s[close + 1] !== '(') return null;
    var k = close + 2, url = '', title = '';
    while (k < s.length && /\s/.test(s[k])) k++;
    if (s[k] === '<') { k++; while (k < s.length && s[k] !== '>') url += s[k++]; k++; }
    else {
      var q = null;
      while (k < s.length && s[k] !== ')') {
        if ((s[k] === '"' || s[k] === "'") && (url === '' || /\s$/.test(url))) {
          q = s[k++];
          while (k < s.length && s[k] !== q) title += s[k++];
          k++;
          continue;
        }
        url += s[k++];
      }
    }
    while (k < s.length && s[k] !== ')') k++;
    if (k >= s.length) return null;
    k++;
    var suf = readPropsSuffix(s, k);
    return {
      text: s.slice(i + 1, close),
      url: url.trim(),
      title: title.trim(),
      props: suf.props,
      end: suf.end
    };
  }

  /* {color=red|size=1.2em}文字{/} —— 支持嵌套，i 指向 '{' */
  function readSpan(s, i) {
    var j = i + 1, q = null;
    while (j < s.length && s[j] !== '}') {
      if (s[j] === '"' || s[j] === "'") { q = s[j++]; while (j < s.length && s[j] !== q) j++; }
      j++;
    }
    if (j >= s.length) return null;
    var head = s.slice(i + 1, j);
    if (!/[A-Za-z-]+\s*=/.test(head) && !/^[A-Za-z-]+(\s*[|,]\s*[A-Za-z-]+)*$/.test(head)) return null;
    var props = parseProps(head);
    if (!Object.keys(props).length) return null;
    var depth = 1, k = j + 1, end = -1;
    while (k < s.length) {
      if (s[k] === '{' && s[k + 1] === '/') {
        depth--;
        if (depth === 0) { end = k; break; }
        k += 2;
        continue;
      }
      if (s[k] === '{' && /^[A-Za-z-]+\s*=/.test(s.slice(k + 1, k + 40))) depth++;
      k++;
    }
    if (end < 0) return null;
    return { props: props, text: s.slice(j + 1, end), end: end + 3 };
  }

  function parseInline(str) {
    var s = String(str == null ? '' : str);
    var out = [];
    var buf = '';
    function flush() { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } }
    var i = 0;

    while (i < s.length) {
      var c = s[i];

      if (c === '\\' && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue; }

      if (c === '`') {
        var n = 0;
        while (s[i + n] === '`') n++;
        var tick = repeat('`', n);
        var endCode = s.indexOf(tick, i + n);
        if (endCode > -1) {
          flush();
          out.push({ t: 'code', v: s.slice(i + n, endCode).replace(/^ | $/g, function (m0) { return m0; }) });
          i = endCode + n;
          continue;
        }
      }

      if (c === '!' && s[i + 1] === '[') {
        var ri = readLink(s, i + 1);
        if (ri) {
          flush();
          out.push({ t: 'img', src: safeUrl(ri.url), alt: ri.text, title: ri.title, p: ri.props });
          i = ri.end;
          continue;
        }
      }

      if (c === '[') {
        if (s[i + 1] === '[') {
          var endK = s.indexOf(']]', i + 2);
          if (endK > -1) {
            flush();
            out.push({ t: 'kbd', c: parseInline(s.slice(i + 2, endK)) });
            i = endK + 2;
            continue;
          }
        }
        var rl = readLink(s, i);
        if (rl) {
          flush();
          out.push({ t: 'a', href: safeUrl(rl.url), title: rl.title, p: rl.props, c: parseInline(rl.text) });
          i = rl.end;
          continue;
        }
      }

      if (s.substr(i, 2) === '**' || s.substr(i, 2) === '__') {
        var d2 = s.substr(i, 2);
        var e2 = findCloser(s, i + 2, d2);
        if (e2 > -1) { flush(); out.push({ t: 'strong', c: parseInline(s.slice(i + 2, e2)) }); i = e2 + 2; continue; }
      }

      if (s.substr(i, 2) === '~~') {
        var e3 = findCloser(s, i + 2, '~~');
        if (e3 > -1) { flush(); out.push({ t: 'del', c: parseInline(s.slice(i + 2, e3)) }); i = e3 + 2; continue; }
      }

      if (s.substr(i, 2) === '==') {
        var e4 = findCloser(s, i + 2, '==');
        if (e4 > -1) { flush(); out.push({ t: 'mark', c: parseInline(s.slice(i + 2, e4)) }); i = e4 + 2; continue; }
      }

      if (s.substr(i, 2) === '++') {
        var e5 = findCloser(s, i + 2, '++');
        if (e5 > -1) { flush(); out.push({ t: 'u', c: parseInline(s.slice(i + 2, e5)) }); i = e5 + 2; continue; }
      }

      if (c === '*' || c === '_') {
        var e6 = findCloser(s, i + 1, c);
        if (e6 > -1) { flush(); out.push({ t: 'em', c: parseInline(s.slice(i + 1, e6)) }); i = e6 + 1; continue; }
      }

      if (c === '^') {
        var e7 = findCloser(s, i + 1, '^');
        if (e7 > -1) { flush(); out.push({ t: 'sup', c: parseInline(s.slice(i + 1, e7)) }); i = e7 + 1; continue; }
      }

      if (c === '~') {
        var e8 = findCloser(s, i + 1, '~');
        if (e8 > -1) { flush(); out.push({ t: 'sub', c: parseInline(s.slice(i + 1, e8)) }); i = e8 + 1; continue; }
      }

      if (c === '{') {
        var sp = readSpan(s, i);
        if (sp) {
          flush();
          out.push({ t: 'span', css: propsToCss(sp.props), c: parseInline(sp.text) });
          i = sp.end;
          continue;
        }
      }

      buf += c;
      i++;
    }
    flush();
    return out;
  }

  /* 段落内的多行：默认逐行显示（中文文案常按行写），行尾 \ 视为「与下一行合并」 */
  function parseParagraph(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var merge = /\\$/.test(l) && !/\\\\$/.test(l);
      if (merge) l = l.slice(0, -1);
      out = out.concat(parseInline(l));
      if (!merge && i < lines.length - 1) out.push({ t: 'br' });
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   *  块级解析
   * ------------------------------------------------------------------ */

  function isTableDelim(line) {
    if (line.indexOf('|') < 0) return false;
    var cells = splitRow(line);
    if (!cells.length) return false;
    for (var i = 0; i < cells.length; i++) {
      if (!/^\s*:?-{2,}:?\s*$/.test(cells[i])) return false;
    }
    return true;
  }

  function splitRow(line) {
    var s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    var cells = [], cur = '';
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
      if (s[i] === '|') { cells.push(cur); cur = ''; continue; }
      cur += s[i];
    }
    cells.push(cur);
    return cells;
  }

  function isBlockStart(line) {
    return FENCE_RE.test(line) || DIRECTIVE_RE.test(line) || line.trim() === ':::' ||
      HEADING_RE.test(line) || HR_RE.test(line) || LIST_RE.test(line) ||
      /^ {0,3}>/.test(line) || IMG_BLOCK_RE.test(line);
  }

  function parseBlocks(lines, start, endFn, depth) {
    var blocks = [];
    var i = start;
    depth = depth || 0;
    if (depth > MAX_NEST) return { blocks: blocks, i: lines.length };

    while (i < lines.length) {
      var raw = lines[i];
      var line = trimRight(raw);
      if (endFn(line, i)) break;
      if (!line.trim()) { i++; continue; }

      /* 代码块 */
      var m = FENCE_RE.exec(line);
      if (m) {
        var fenceChar = m[1][0], fenceLen = m[1].length, lang = m[2] || '';
        var buf = [];
        i++;
        while (i < lines.length) {
          var t = lines[i].trim();
          var isClose = t.length >= fenceLen && t.split('').every(function (ch) { return ch === fenceChar; });
          if (isClose) { i++; break; }
          buf.push(lines[i]);
          i++;
        }
        blocks.push({ t: 'code', lang: lang, v: buf.join('\n') });
        continue;
      }

      /* 容器指令 */
      m = DIRECTIVE_RE.exec(line);
      if (m) {
        var name = m[1].toLowerCase();
        var props = parseProps(m[2]);
        var inner = parseBlocks(lines, i + 1, function (l) { return l.trim() === ':::'; }, depth + 1);
        i = inner.i;
        if (i < lines.length && lines[i].trim() === ':::') i++;
        blocks.push({ t: 'box', n: name, p: props, c: inner.blocks });
        continue;
      }

      if (line.trim() === ':::') { i++; continue; }   /* 多余的闭合符：忽略 */

      /* 标题 */
      m = HEADING_RE.exec(line);
      if (m) {
        blocks.push({ t: 'h', lv: m[1].length, inl: parseInline(m[2]) });
        i++;
        continue;
      }

      /* 分割线 */
      if (HR_RE.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }

      /* 引用 */
      if (/^ {0,3}>/.test(line)) {
        var qbuf = [];
        while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
          qbuf.push(lines[i].replace(/^ {0,3}> ?/, ''));
          i++;
        }
        var qin = parseBlocks(qbuf, 0, function () { return false; }, depth + 1);
        blocks.push({ t: 'quote', c: qin.blocks });
        continue;
      }

      /* 表格 */
      if (line.indexOf('|') > -1 && i + 1 < lines.length && isTableDelim(lines[i + 1])) {
        var head = splitRow(line).map(function (c) { return parseInline(c.trim()); });
        var align = splitRow(lines[i + 1]).map(function (c) {
          var v = c.trim();
          if (/^:.*:$/.test(v)) return 'c';
          if (/:$/.test(v)) return 'r';
          if (/^:/.test(v)) return 'l';
          return '';
        });
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].indexOf('|') > -1 && lines[i].trim() && !isBlockStart(lines[i])) {
          rows.push(splitRow(lines[i]).map(function (c) { return parseInline(c.trim()); }));
          i++;
        }
        blocks.push({ t: 'table', align: align, head: head, rows: rows });
        continue;
      }

      /* 列表 */
      m = LIST_RE.exec(line);
      if (m) {
        var base = m[1].length;
        var ordered = /^\d/.test(m[2]);
        var listStart = ordered ? parseInt(m[2], 10) : 1;
        var items = [];
        while (i < lines.length) {
          var lm = LIST_RE.exec(trimRight(lines[i]));
          if (!lm || lm[1].length !== base) break;
          if (/^\d/.test(lm[2]) !== ordered) break;
          var content = lm[3];
          var task = null;
          var tm = /^\[([ xX])\]\s+/.exec(content);
          if (tm) { task = tm[1].toLowerCase() === 'x'; content = content.slice(tm[0].length); }
          i++;
          var ibuf = [content];
          while (i < lines.length) {
            var l2 = lines[i];
            if (!l2.trim()) {
              var j2 = i;
              while (j2 < lines.length && !lines[j2].trim()) j2++;
              if (j2 < lines.length && indentOf(lines[j2]) > base) { ibuf.push(''); i++; continue; }
              break;
            }
            if (indentOf(l2) > base) {
              ibuf.push(l2.slice(Math.min(indentOf(l2), base + 2)));
              i++;
              continue;
            }
            break;
          }
          var iin = parseBlocks(ibuf, 0, function () { return false; }, depth + 1);
          items.push({ task: task, c: iin.blocks });
        }
        blocks.push({ t: ordered ? 'ol' : 'ul', start: listStart, items: items });
        continue;
      }

      /* 独占一行的图片 */
      m = IMG_BLOCK_RE.exec(line);
      if (m) {
        blocks.push({
          t: 'img',
          src: safeUrl(m[2]),
          alt: m[1],
          title: m[3] || '',
          p: m[4] ? parseProps(m[4]) : {}
        });
        i++;
        continue;
      }

      /* 段落 */
      var plines = [];
      while (i < lines.length) {
        var pl = trimRight(lines[i]);
        if (!pl.trim()) break;
        if (endFn(pl, i)) break;
        if (plines.length && isBlockStart(pl)) break;
        plines.push(pl);
        i++;
      }
      if (plines.length) blocks.push({ t: 'p', inl: parseParagraph(plines) });
      else i++;
    }

    return { blocks: blocks, i: i };
  }

  /* ------------------------------------------------------------------ *
   *  文档解析入口
   * ------------------------------------------------------------------ */

  function parse(text) {
    var src = String(text == null ? '' : text)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\t/g, '  ');
    var lines = src.split('\n');
    var errors = [];
    var meta = {}, metaOrder = [];
    var i = 0;

    while (i < lines.length && !lines[i].trim()) i++;

    var title = '';
    var h1 = /^#\s+(.*)$/.exec(lines[i] || '');
    if (h1) { title = h1[1].trim(); i++; }

    /* 标题与元信息之间允许空行（老文件就是 `# 标题` + 空行 + `- 编号：1`） */
    while (i < lines.length && !lines[i].trim()) i++;

    while (i < lines.length) {
      var mm = META_RE.exec(lines[i]);
      if (!mm) break;
      var key = mm[1].trim();
      var val = mm[2].trim();
      if (!Object.prototype.hasOwnProperty.call(meta, key)) metaOrder.push(key);
      meta[key] = val;
      i++;
    }

    while (i < lines.length && !lines[i].trim()) i++;
    if (LEGACY_BODY_RE.test(lines[i] || '')) i++;
    while (i < lines.length && !lines[i].trim()) i++;

    var res = parseBlocks(lines, i, function () { return false; }, 0);
    /* 正文原文（不含标题/元信息/``## 说明``）：同步工具改写文件时必须回写原文，
       不能拿 toText() 的结果回填，否则手写的富文本语法会被抹平 */
    var bodyRaw = lines.slice(i).join('\n').replace(/\s+$/, '');

    /* 闭合检查：parseBlocks 内部会把未闭合的容器当到文末结束，这里只负责提示 */
    var openCount = 0;
    for (var k = i; k < lines.length; k++) {
      if (DIRECTIVE_RE.test(trimRight(lines[k]))) openCount++;
      else if (trimRight(lines[k]).trim() === ':::' && openCount > 0) openCount--;
    }
    if (openCount > 0) errors.push('有 ' + openCount + ' 个 ::: 容器没有闭合（已按文末结束处理）');

    return {
      v: VERSION,
      title: title,
      meta: meta,
      metaOrder: metaOrder,
      blocks: res.blocks,
      bodyRaw: bodyRaw,
      errors: errors
    };
  }

  /* ------------------------------------------------------------------ *
   *  纯文本导出（老客户端只有 txt 字段；也用于搜索/摘要）
   * ------------------------------------------------------------------ */

  function inlineText(inl) {
    var s = '';
    (inl || []).forEach(function (n) {
      switch (n.t) {
        case 'text': s += n.v; break;
        case 'br': s += '\n'; break;
        case 'code': s += n.v; break;
        case 'img': s += n.alt ? '[' + n.alt + ']' : ''; break;
        case 'kbd': s += '[' + inlineText(n.c) + ']'; break;
        case 'a': s += inlineText(n.c) + (n.href && n.href !== inlineText(n.c) ? '（' + n.href + '）' : ''); break;
        default: s += inlineText(n.c);
      }
    });
    return s;
  }

  function blocksText(blocks, depth) {
    depth = depth || 0;
    var parts = [];
    (blocks || []).forEach(function (b) {
      switch (b.t) {
        case 'p': parts.push(inlineText(b.inl)); break;
        case 'h': parts.push('#' + repeat('#', b.lv - 1) + ' ' + inlineText(b.inl)); break;
        case 'hr': parts.push('---'); break;
        case 'code': parts.push(b.v); break;
        case 'quote': parts.push(blocksText(b.c, depth + 1)); break;
        case 'img': if (b.alt) parts.push('[' + b.alt + ']'); break;
        case 'table': {
          var rows = [b.head].concat(b.rows || []);
          parts.push(rows.map(function (r) {
            return r.map(function (c) { return inlineText(c); }).join(' | ');
          }).join('\n'));
          break;
        }
        case 'ul':
        case 'ol': {
          var pad = repeat('  ', depth);
          var items = b.items.map(function (it, idx) {
            var mark = b.t === 'ol' ? (b.start + idx) + '.' : '-';
            if (it.task === true) mark += ' [x]';
            else if (it.task === false) mark += ' [ ]';
            var body = blocksText(it.c, depth + 1);
            return pad + mark + ' ' + body.replace(/\n/g, '\n' + pad + '  ');
          });
          parts.push(items.join('\n'));
          break;
        }
        case 'box': {
          var head = (b.p && typeof b.p.title === 'string' && b.p.title) ? '【' + b.p.title + '】' : '';
          var body2 = blocksText(b.c, depth);
          parts.push(head && body2 ? head + '\n' + body2 : (head || body2));
          break;
        }
        default: parts.push(blocksText(b.c, depth));
      }
    });
    return parts.filter(function (s) { return s !== '' && s != null; }).join('\n\n');
  }

  function toText(doc) {
    if (!doc) return '';
    if (typeof doc === 'string') return doc;
    return blocksText(doc.blocks || [], 0).trim();
  }

  /* ------------------------------------------------------------------ *
   *  渲染（只在浏览器跑；不碰 innerHTML）
   * ------------------------------------------------------------------ */

  function make(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }

  function applyCss(e, css) {
    if (!css) return;
    var safe = safeCss(css);
    if (safe) e.setAttribute('style', safe);
  }

  function renderInline(inl, parent) {
    (inl || []).forEach(function (n) {
      switch (n.t) {
        case 'text': parent.appendChild(document.createTextNode(n.v)); break;
        case 'br': parent.appendChild(make('br')); break;
        case 'code': parent.appendChild(make('code', 'amdl-code-inline', n.v)); break;
        case 'kbd': {
          var kb = make('kbd', 'amdl-kbd');
          renderInline(n.c, kb);
          parent.appendChild(kb);
          break;
        }
        case 'strong': { var b = make('strong'); renderInline(n.c, b); parent.appendChild(b); break; }
        case 'em': { var em = make('em'); renderInline(n.c, em); parent.appendChild(em); break; }
        case 'del': { var de = make('del'); renderInline(n.c, de); parent.appendChild(de); break; }
        case 'mark': { var mk = make('mark'); renderInline(n.c, mk); parent.appendChild(mk); break; }
        case 'u': { var u = make('u'); renderInline(n.c, u); parent.appendChild(u); break; }
        case 'sup': { var sp = make('sup'); renderInline(n.c, sp); parent.appendChild(sp); break; }
        case 'sub': { var sb = make('sub'); renderInline(n.c, sb); parent.appendChild(sb); break; }
        case 'span': {
          var sn = make('span');
          applyCss(sn, n.css);
          renderInline(n.c, sn);
          parent.appendChild(sn);
          break;
        }
        case 'a': {
          var href = safeUrl(n.href);
          var a = make('a', 'amdl-a');
          if (href) {
            a.href = href;
            if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
          }
          if (n.title) a.title = n.title;
          if (n.p) applyCss(a, propsToCss(n.p));
          renderInline(n.c, a);
          parent.appendChild(a);
          break;
        }
        case 'img': {
          var src = safeUrl(n.src);
          if (!src) { parent.appendChild(document.createTextNode(n.alt || '')); break; }
          var img = make('img', 'amdl-img-inline');
          img.src = src;
          img.alt = n.alt || '';
          img.loading = 'lazy';
          img.referrerPolicy = 'no-referrer';
          if (n.title) img.title = n.title;
          if (n.p) applyCss(img, propsToCss(n.p));
          parent.appendChild(img);
          break;
        }
        default: parent.appendChild(document.createTextNode(inlineText([n])));
      }
    });
  }

  function renderImage(b) {
    var src = safeUrl(b.src);
    var fig = make('figure', 'amdl-figure');
    if (src) {
      var img = make('img', 'amdl-img');
      img.src = src;
      img.alt = b.alt || '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      if (b.title) img.title = b.title;
      if (b.p) applyCss(img, propsToCss(b.p));
      fig.appendChild(img);
    } else {
      fig.appendChild(make('span', 'amdl-img-bad', b.alt || '图片地址不可用'));
    }
    if (b.alt && b.p && b.p.caption !== 'false') fig.appendChild(make('figcaption', 'amdl-cap', b.alt));
    fig.dataset.align = (b.p && typeof b.p.align === 'string') ? b.p.align : '';
    return fig;
  }

  function renderBlocks(blocks, parent) {
    (blocks || []).forEach(function (b) {
      switch (b.t) {
        case 'p': {
          var p = make('p', 'amdl-p');
          renderInline(b.inl, p);
          parent.appendChild(p);
          break;
        }
        case 'h': {
          var lv = Math.min(6, Math.max(2, b.lv || 2));
          var h = make('h' + lv, 'amdl-h amdl-h' + lv);
          renderInline(b.inl, h);
          parent.appendChild(h);
          break;
        }
        case 'hr': parent.appendChild(make('hr', 'amdl-hr')); break;
        case 'code': {
          var pre = make('pre', 'amdl-pre');
          var code = make('code', 'amdl-code-block');
          if (b.lang) code.dataset.lang = b.lang;
          code.textContent = b.v;
          pre.appendChild(code);
          parent.appendChild(pre);
          break;
        }
        case 'quote': {
          var q = make('blockquote', 'amdl-quote');
          renderBlocks(b.c, q);
          parent.appendChild(q);
          break;
        }
        case 'img': parent.appendChild(renderImage(b)); break;
        case 'table': {
          var wrap = make('div', 'amdl-table-wrap');
          var tb = make('table', 'amdl-table');
          var thead = make('thead');
          var htr = make('tr');
          b.head.forEach(function (cell, ci) {
            var th = make('th');
            if (b.align[ci]) th.className = 'is-' + b.align[ci];
            renderInline(cell, th);
            htr.appendChild(th);
          });
          thead.appendChild(htr);
          tb.appendChild(thead);
          var tbody = make('tbody');
          b.rows.forEach(function (row) {
            var tr = make('tr');
            for (var ci = 0; ci < b.head.length; ci++) {
              var td = make('td');
              if (b.align[ci]) td.className = 'is-' + b.align[ci];
              renderInline(row[ci] || [], td);
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          });
          tb.appendChild(tbody);
          wrap.appendChild(tb);
          parent.appendChild(wrap);
          break;
        }
        case 'ul':
        case 'ol': {
          var list = make(b.t, 'amdl-list' + (b.items.some(function (it) { return it.task !== null; }) ? ' is-task' : ''));
          if (b.t === 'ol' && b.start > 1) list.start = b.start;
          b.items.forEach(function (it) {
            var li = make('li', 'amdl-li');
            if (it.task !== null && it.task !== undefined) {
              li.className += it.task ? ' is-done' : '';
              var box = make('span', 'amdl-task' + (it.task ? ' is-on' : ''));
              box.setAttribute('aria-hidden', 'true');
              li.appendChild(box);
            }
            renderBlocks(it.c, li);
            list.appendChild(li);
          });
          parent.appendChild(list);
          break;
        }
        case 'box': renderBox(b, parent); break;
        default: {
          var unk = make('div', 'amdl-box');
          renderBlocks(b.c, unk);
          parent.appendChild(unk);
        }
      }
    });
  }

  var NOTE_TONES = { note: 'info', info: 'info', tip: 'tip', warn: 'warn', warning: 'warn', danger: 'danger', error: 'danger', success: 'success', ok: 'success', quote: 'quote' };

  function renderBox(b, parent) {
    var name = b.n;
    var p = b.p || {};

    if (NOTE_TONES[name]) {
      var tone = typeof p.tone === 'string' ? p.tone : NOTE_TONES[name];
      var box = make('div', 'amdl-note');
      box.dataset.tone = tone;
      if (typeof p.title === 'string' && p.title) box.appendChild(make('div', 'amdl-note-t', p.title));
      var body = make('div', 'amdl-note-b');
      renderBlocks(b.c, body);
      box.appendChild(body);
      parent.appendChild(box);
      return;
    }

    switch (name) {
      case 'card': {
        var card = make('div', 'amdl-card');
        if (typeof p.title === 'string' && p.title) card.appendChild(make('div', 'amdl-card-t', p.title));
        var cb = make('div', 'amdl-card-b');
        renderBlocks(b.c, cb);
        card.appendChild(cb);
        parent.appendChild(card);
        return;
      }
      case 'center':
      case 'right':
      case 'justify': {
        var al = make('div', 'amdl-align');
        al.dataset.align = name;
        renderBlocks(b.c, al);
        parent.appendChild(al);
        return;
      }
      case 'cols': {
        var cols = make('div', 'amdl-cols');
        if (p.gap) cols.style.setProperty('--amdl-gap', safeValue(p.gap) || '12px');
        if (p.ratio) cols.style.setProperty('--amdl-ratio', safeValue(p.ratio) || '1 1');
        renderBlocks(b.c, cols);
        parent.appendChild(cols);
        return;
      }
      case 'col': {
        var col = make('div', 'amdl-col');
        if (p.span && /^\d+(\.\d+)?$/.test(String(p.span))) col.style.setProperty('--amdl-span', String(p.span));
        renderBlocks(b.c, col);
        parent.appendChild(col);
        return;
      }
      case 'grid':
      case 'gallery': {
        var grid = make('div', name === 'gallery' ? 'amdl-gallery' : 'amdl-grid');
        grid.style.setProperty('--amdl-cols', /^\d+$/.test(String(p.cols)) ? String(p.cols) : '2');
        if (p.gap) grid.style.setProperty('--amdl-gap', safeValue(p.gap) || '8px');
        renderBlocks(b.c, grid);
        parent.appendChild(grid);
        return;
      }
      case 'details':
      case 'spoiler': {
        var det = make('details', name === 'spoiler' ? 'amdl-spoiler' : 'amdl-details');
        if (p.open === true || p.open === 'true' || p.open === '1') det.open = true;
        det.appendChild(make('summary', 'amdl-summary', (typeof p.title === 'string' && p.title) || (typeof p.label === 'string' && p.label) || (name === 'spoiler' ? '点击显示（含剧透）' : '展开')));
        var db = make('div', 'amdl-details-b');
        renderBlocks(b.c, db);
        det.appendChild(db);
        parent.appendChild(det);
        return;
      }
      case 'tabs': {
        var tabs = make('div', 'amdl-tabs');
        var bar = make('div', 'amdl-tabs-bar');
        var panels = make('div', 'amdl-tabs-body');
        var labels = b.c.filter(function (x) { return x.t === 'box' && x.n === 'tab'; });
        labels.forEach(function (tab, idx) {
          var label = (tab.p && typeof tab.p.label === 'string' && tab.p.label) || (tab.p && typeof tab.p.title === 'string' && tab.p.title) || ('标签 ' + (idx + 1));
          var btn = make('button', 'amdl-tab-btn' + (idx === 0 ? ' is-on' : ''), label);
          btn.type = 'button';
          btn.dataset.idx = String(idx);
          bar.appendChild(btn);
          var panel = make('div', 'amdl-tab-panel' + (idx === 0 ? ' is-on' : ''));
          renderBlocks(tab.c, panel);
          panels.appendChild(panel);
        });
        bar.addEventListener('click', function (e) {
          var t = e.target.closest ? e.target.closest('.amdl-tab-btn') : null;
          if (!t) return;
          var idx = Number(t.dataset.idx);
          Array.prototype.forEach.call(bar.children, function (c, ci) { c.classList.toggle('is-on', ci === idx); });
          Array.prototype.forEach.call(panels.children, function (c, ci) { c.classList.toggle('is-on', ci === idx); });
        });
        tabs.appendChild(bar);
        tabs.appendChild(panels);
        parent.appendChild(tabs);
        return;
      }
      case 'linkcard': {
        var href = safeUrl(p.url || p.href || '');
        var lc = make(href ? 'a' : 'div', 'amdl-linkcard');
        if (href) { lc.href = href; lc.target = '_blank'; lc.rel = 'noopener noreferrer'; }
        if (typeof p.icon === 'string' && p.icon) {
          var iconSrc = safeUrl(p.icon);
          if (iconSrc) {
            var ic = make('img', 'amdl-linkcard-icon');
            ic.src = iconSrc; ic.alt = ''; ic.loading = 'lazy'; ic.referrerPolicy = 'no-referrer';
            lc.appendChild(ic);
          }
        }
        var txt = make('div', 'amdl-linkcard-txt');
        txt.appendChild(make('div', 'amdl-linkcard-t', (typeof p.title === 'string' && p.title) || href));
        if (typeof p.desc === 'string' && p.desc) txt.appendChild(make('div', 'amdl-linkcard-d', p.desc));
        lc.appendChild(txt);
        if (b.c && b.c.length) { var lb = make('div', 'amdl-linkcard-b'); renderBlocks(b.c, lb); lc.appendChild(lb); }
        parent.appendChild(lc);
        return;
      }
      case 'video': {
        var vsrc = safeUrl(p.src || p.url || '');
        if (!vsrc) return;
        var v = make('video', 'amdl-video');
        v.src = vsrc;
        v.controls = true;
        v.playsInline = true;
        v.preload = 'metadata';
        var poster = safeUrl(p.poster || '');
        if (poster) v.poster = poster;
        parent.appendChild(v);
        return;
      }
      case 'audio': {
        var asrc = safeUrl(p.src || p.url || '');
        if (!asrc) return;
        var au = make('audio', 'amdl-audio');
        au.src = asrc;
        au.controls = true;
        au.preload = 'none';
        parent.appendChild(au);
        return;
      }
      case 'figure': {
        var f = make('figure', 'amdl-figure amdl-figure-box');
        renderBlocks(b.c, f);
        if (typeof p.caption === 'string' && p.caption) f.appendChild(make('figcaption', 'amdl-cap', p.caption));
        parent.appendChild(f);
        return;
      }
      default: {
        var generic = make('div', 'amdl-box');
        generic.dataset.name = name;
        renderBlocks(b.c, generic);
        parent.appendChild(generic);
      }
    }
  }

  function render(doc, el) {
    if (!el) return el;
    var d = Array.isArray(doc) ? { blocks: doc } : (doc || {});
    if (!el.classList.contains('amdl')) el.classList.add('amdl');
    renderBlocks(d.blocks || [], el);
    return el;
  }

  var AMDL = {
    version: VERSION,
    parse: parse,
    render: render,
    renderBlocks: renderBlocks,
    renderInline: renderInline,
    toText: toText,
    parseProps: parseProps,
    propsToCss: propsToCss,
    safeUrl: safeUrl,
    safeCss: safeCss,
    STYLE_MAP: STYLE_MAP,
    STYLE_FLAGS: STYLE_FLAGS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AMDL;
  if (typeof define === 'function' && define.amd) define(function () { return AMDL; });
  root.AMDL = AMDL;
})(typeof globalThis !== 'undefined' ? globalThis : this);
