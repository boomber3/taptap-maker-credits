/**
 * 极简 SVG 折线图，无第三方依赖（扩展页面的 CSP 也不允许远程脚本）。
 *
 * 遵循的图表规范：
 *   - 折线 2px、圆角端点；端点圆点 r=4 且带 2px 表面色描边，压在线上也看得清
 *   - 网格线 1px 实线、弱化；坐标轴文字用 muted 文本色，不染曲线色
 *   - 两条以上曲线必带图例（线形色键），单条曲线不加图例框（标题已说明画的是什么）
 *   - 十字准星吸附到最近的 X，tooltip 一次列出该 X 上的全部曲线，数值在前、名称在后
 *   - 只用一个 Y 轴，永不双轴
 */

import { formatExact, makeAxisFormatter } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const PAD = { top: 14, right: 20, bottom: 26, left: 60 };
const X_LABEL_MIN_GAP = 62;

function el(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const key in attrs) {
    if (attrs[key] != null) node.setAttribute(key, attrs[key]);
  }
  return node;
}

/** Y 轴刻度落在 1/2/2.5/5 的整数倍上，避免出现 3271 这种刻度 */
function niceScale(max, targetTicks = 4) {
  if (!(max > 0)) return { top: 10, ticks: [0, 5, 10] };
  const rough = max / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const top = Math.ceil(max / step) * step;
  const count = Math.round(top / step);
  const ticks = Array.from({ length: count + 1 }, (_, i) => i * step);
  return { top, ticks };
}

function surfaceColor(host) {
  const v = getComputedStyle(host).getPropertyValue('--surface-1').trim();
  return v || '#fcfcfb';
}

export function renderLineChart(host, spec) {
  // 重复渲染同一个宿主时，旧观察器必须摘掉，否则每次重绘都会多留一个
  if (host.__chartObserver) host.__chartObserver.disconnect();

  host.textContent = '';
  host.classList.add('chart-host');

  const legendEl = document.createElement('div');
  legendEl.className = 'chart-legend';
  const plotEl = document.createElement('div');
  plotEl.className = 'chart-plot';
  host.append(legendEl, plotEl);

  // 不替调用方筛掉全 0 的曲线：用户手动勾上的项目，哪怕这段区间没消耗，
  // 那条贴着 0 的线本身也是信息（「确实是没用过」）。只有一条数据都没有才走空态。
  const visible = spec.series || [];
  const hasData = visible.some((s) => s.values.some((v) => v > 0));

  if (visible.length === 0 || !hasData) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = spec.emptyText || '这段时间没有消耗记录';
    plotEl.append(empty);
    return;
  }

  // 图例：线形色键，文字用文本色（浅色系的曲线色当文字看不清）
  if (visible.length >= 2) {
    for (const s of visible) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const key = document.createElement('span');
      key.className = 'legend-key';
      key.style.setProperty('--c', s.color);
      const label = document.createElement('span');
      label.textContent = s.name; // 项目名来自接口，一律走 textContent
      item.append(key, label);
      legendEl.append(item);
    }
  } else {
    legendEl.remove();
  }

  let lastWidth = 0;
  let lastHeight = 0;
  let raf = 0;
  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      // 高度也要盯着：放大浮层是靠 flex 撑高的，宽度没变但高度变了同样要重画
      if (Math.abs(w - lastWidth) < 1 && Math.abs(h - lastHeight) < 1) return;
      lastWidth = w;
      lastHeight = h;
      draw();
    });
  };

  const ro = new ResizeObserver(schedule);
  ro.observe(host);
  host.__chartObserver = ro;

  let hoverIndex = -1;

  function draw() {
    plotEl.textContent = '';

    // clientWidth/Height 是**含内边距**的，而图例和 svg 画在内容盒里 ——
    // 不把内边距扣掉，图就会比可视区高出一圈：最下面那行日期刻度正好落在
    // 多出来的部分，被外层容器裁掉（弹窗里就是这样）。
    const hostStyle = getComputedStyle(host);
    const padX = parseFloat(hostStyle.paddingLeft) + parseFloat(hostStyle.paddingRight);
    const padY = parseFloat(hostStyle.paddingTop) + parseFloat(hostStyle.paddingBottom);

    const width = Math.round(host.clientWidth - padX);
    if (width < 120) return;

    const legendHeight = legendEl.isConnected ? legendEl.offsetHeight + 12 : 0;
    const height = spec.height || Math.max(180, Math.round(host.clientHeight - padY - legendHeight));

    const n = spec.xLabels.length;
    const plotW = Math.max(10, width - PAD.left - PAD.right);
    const plotH = Math.max(10, height - PAD.top - PAD.bottom);
    const surface = surfaceColor(host);

    let max = 0;
    for (const s of visible) {
      for (const v of s.values) if (v > max) max = v;
    }
    const scale = niceScale(max);
    const fmtAxis = makeAxisFormatter(scale.top);

    const stepX = n > 1 ? plotW / (n - 1) : 0;
    const xAt = (i) => (n > 1 ? PAD.left + i * stepX : PAD.left + plotW / 2);
    const yAt = (v) => PAD.top + plotH - (v / scale.top) * plotH;

    const svg = el('svg', {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': spec.ariaLabel || '折线图',
    });

    // 网格线 + Y 轴刻度
    for (const tick of scale.ticks) {
      const y = yAt(tick);
      svg.append(el('line', {
        x1: PAD.left, x2: width - PAD.right, y1: y, y2: y,
        stroke: 'var(--gridline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      }));
      const label = el('text', {
        x: PAD.left - 10, y: y + 4, 'text-anchor': 'end',
        fill: 'var(--text-muted)', 'font-size': 11, class: 'axis-text',
      });
      label.textContent = fmtAxis(tick);
      svg.append(label);
    }

    // 基线
    svg.append(el('line', {
      x1: PAD.left, x2: width - PAD.right, y1: yAt(0), y2: yAt(0),
      stroke: 'var(--baseline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
    }));

    // X 轴标签：按可用宽度抽稀，首尾对齐避免被裁
    const maxLabels = Math.max(2, Math.floor(plotW / X_LABEL_MIN_GAP));
    const stride = Math.max(1, Math.ceil(n / maxLabels));
    for (let i = 0; i < n; i += stride) {
      const isLast = i + stride >= n;
      if (isLast && n - 1 - i < stride * 0.5) break;
      const anchor = n === 1 ? 'middle' : i === 0 ? 'start' : 'middle';
      const label = el('text', {
        x: xAt(i), y: height - 8, 'text-anchor': anchor,
        fill: 'var(--text-muted)', 'font-size': 11, class: 'axis-text',
      });
      label.textContent = spec.xLabels[i];
      svg.append(label);
    }

    // 单条曲线时铺一层 10% 淡色面积，多条时铺会让线条糊在一起
    if (visible.length === 1) {
      const s = visible[0];
      const area = [`M ${xAt(0)} ${yAt(0)}`]
        .concat(s.values.map((v, i) => `L ${xAt(i)} ${yAt(v)}`))
        .concat([`L ${xAt(n - 1)} ${yAt(0)}`, 'Z'])
        .join(' ');
      svg.append(el('path', { d: area, fill: s.color, 'fill-opacity': 0.1, stroke: 'none' }));
    }

    // 折线
    for (const s of visible) {
      const d = s.values.map((v, i) => `${i ? 'L' : 'M'} ${xAt(i)} ${yAt(v)}`).join(' ');
      svg.append(el('path', {
        d, fill: 'none', stroke: s.color, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }));
    }

    // 末端圆点：2px 表面色描边，和别的线交叉时也分得开
    for (const s of visible) {
      const lastIndex = n - 1;
      svg.append(el('circle', {
        cx: xAt(lastIndex), cy: yAt(s.values[lastIndex]), r: 4,
        fill: s.color, stroke: surface, 'stroke-width': 2,
      }));
    }

    // 交互层
    const crosshair = el('line', {
      y1: PAD.top, y2: PAD.top + plotH, stroke: 'var(--baseline)',
      'stroke-width': 1, opacity: 0, 'shape-rendering': 'crispEdges',
    });
    svg.append(crosshair);

    const dotGroup = el('g', { opacity: 0 });
    const dots = visible.map((s) => {
      const dot = el('circle', { r: 4, fill: s.color, stroke: surface, 'stroke-width': 2 });
      dotGroup.append(dot);
      return dot;
    });
    svg.append(dotGroup);

    const overlay = el('rect', {
      x: PAD.left - stepX / 2, y: PAD.top,
      width: plotW + stepX, height: plotH,
      fill: 'transparent', style: 'cursor:crosshair',
    });
    svg.append(overlay);
    plotEl.append(svg);

    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    plotEl.append(tip);

    function showAt(index) {
      const i = Math.max(0, Math.min(n - 1, index));
      hoverIndex = i;
      const x = xAt(i);

      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      crosshair.setAttribute('opacity', 1);
      dotGroup.setAttribute('opacity', 1);

      visible.forEach((s, k) => {
        dots[k].setAttribute('cx', x);
        dots[k].setAttribute('cy', yAt(s.values[i]));
      });

      const rows = visible
        .map((s) => ({ name: s.name, color: s.color, value: s.values[i] }))
        .sort((a, b) => b.value - a.value);

      tip.textContent = '';
      const head = document.createElement('div');
      head.className = 'tip-head';
      head.textContent = spec.xFull[i];
      tip.append(head);

      for (const row of rows) {
        const line = document.createElement('div');
        line.className = 'tip-row';

        const key = document.createElement('span');
        key.className = 'tip-key';
        key.style.setProperty('--c', row.color);

        const name = document.createElement('span');
        name.className = 'tip-name';
        name.textContent = row.name;

        const value = document.createElement('span');
        value.className = 'tip-value';
        value.textContent = formatExact(row.value);

        line.append(key, name, value);
        tip.append(line);
      }

      tip.hidden = false;
      const tw = tip.offsetWidth;
      let left = x + 14;
      if (left + tw > width - 4) left = x - tw - 14;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = `${PAD.top + 4}px`;
    }

    function hide() {
      hoverIndex = -1;
      crosshair.setAttribute('opacity', 0);
      dotGroup.setAttribute('opacity', 0);
      tip.hidden = true;
    }

    function indexAt(ev) {
      const rect = svg.getBoundingClientRect();
      const scaleX = width / rect.width;
      const px = (ev.clientX - rect.left) * scaleX;
      return n > 1 ? Math.max(0, Math.min(n - 1, Math.round((px - PAD.left) / stepX))) : 0;
    }

    // 滚轮缩放时间轴。以光标下的那个点为锚 —— 不然一放大，画面就跑到别处去了。
    if (typeof spec.onZoom === 'function') {
      let acc = 0;
      overlay.addEventListener(
        'wheel',
        (ev) => {
          ev.preventDefault(); // 图表里滚轮只用来缩放，不再带动页面滚动
          // 鼠标滚轮一格约 ±100；触控板是一串小值，累积到阈值才算一步
          const step = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
          acc += step;
          if (Math.abs(acc) < 40) return;
          const direction = acc < 0 ? 1 : -1; // 向上滚 = 放大
          acc = 0;
          spec.onZoom(direction, indexAt(ev));
        },
        { passive: false },
      );
    }

    overlay.addEventListener('pointermove', (ev) => showAt(indexAt(ev)));
    overlay.addEventListener('pointerleave', hide);

    host.tabIndex = 0;
    host.onkeydown = (ev) => {
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
        ev.preventDefault();
        const base = hoverIndex < 0 ? (ev.key === 'ArrowRight' ? -1 : n) : hoverIndex;
        showAt(base + (ev.key === 'ArrowRight' ? 1 : -1));
      } else if (ev.key === 'Escape') {
        hide();
      }
    };
    host.onblur = hide;
  }

  draw();
}
