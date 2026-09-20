/**
 * 在 maker.taptap.cn/credits 页面里挂一个常驻胶囊，点开滑出统计面板。
 *
 * 为什么是 Shadow DOM + iframe，而不是直接往站点内容区插一块：
 *   - 站点是 SPA，内容区那个 div 由框架托管，插进去的节点可能被它重渲染冲掉
 *   - 直接插入会双向污染样式：站点的样式影响我，我的样式漏到站点
 *   - iframe 里是扩展自己的页面，chrome.* 可用，现有仪表盘一行都不用改
 * 外层 Shadow DOM 隔开站点样式，位置全用 fixed 定位 —— 不依赖站点的任何 DOM
 * 结构，站点改版也弄不坏它。
 *
 * 这个脚本注入在 maker.taptap.cn 全站，但只在 /credits 才挂载；
 * 站点是 SPA，切换路由不会重新执行内容脚本，所以要自己盯着 pathname。
 */
(() => {
  const HOST_ID = 'ttm-credits-root';
  const OPEN_KEY = 'panelOpen';
  const MASCOT_KEY = 'mascotMode'; // 嗒啦啦开关。没存过时算开 —— 默认就是 1

  // ── 表情合图 assets/faces.png ────────────────────────────────────────
  // 3x3，一格 175x184。这几个数字必须和 tools/make-faces.mjs 的输出对上 ——
  // 换了源图就重跑那个脚本，它会把这行该填的值打印出来。
  const FACE_COLS = 3;
  const FACE_ROWS = 3;

  /** 九个表情，顺序 = 合图从左到右、从上到下。 */
  const FACE_IDS = ['wave', 'eager', 'thumb', 'confused', 'meh', 'cheer', 'angry', 'sleepy', 'shock'];
  const FACE_INDEX = new Map(FACE_IDS.map((id, i) => [id, i]));

  /** 状态 → 表情。cheer 和 angry 留给「点她随机」那一池，不占状态位。 */
  const FACE_BY_STATE = {
    sync: 'eager', // 正在同步 → 期待
    error: 'meh', // 出错了 → 无奈
    zero: 'sleepy', // 今天还没花 → 困倦
    light: 'wave', // 比平时少 → 挥手
    normal: 'thumb', // 和平时差不多 → 点赞
    heavy: 'confused', // 比平时多 → 疑惑
    over: 'shock', // 明显爆表 → 震惊
  };

  /** 点她本人时随机抽，表情和台词一起换。 */
  const PLAY_FACES = ['cheer', 'angry', 'confused', 'thumb', 'wave', 'shock', 'sleepy'];
  const PLAY_LINES = ['嘿嘿', '被我发现了', '看我看我', '今天也要加油呀', '要不要看看明细？', '别戳啦', '我可爱吗'];

  /** 每个状态备几句台词，轮着说不重复。 */
  const QUIPS = {
    sync: ['正在对账…', '让我看看账本', '稍等，在数积分'],
    error: ['诶？取数失败了', '网络好像不太对', '同步出错，待会儿再试'],
    zero: ['今天还没花积分哦', '账户纹丝不动', '零消耗，真省钱'],
    light: ['今天花得不多', '还行，挺克制的', '这点消耗不算什么'],
    normal: ['今天花得正常', '和平时差不多', '平稳的一天'],
    heavy: ['今天有点费积分', '花得比平时多哦', '消耗开始上来了'],
    over: ['今天花得有点凶！', '积分在飞速消失', '这消耗有点吓人'],
  };

  /** 「点她」之后多少毫秒回到状态对应的表情。不回去的话，状态映射就废了。 */
  const PLAY_HOLD_MS = 8000;

  const isCreditsPage = () => /^\/credits\/?$/.test(location.pathname);

  let host = null;
  let shadow = null;
  let capsule = null;
  let dotEl = null;
  let valueEl = null;
  let panel = null;
  let frame = null;
  let mascot = null; // 外层容器，负责入场动画
  let mascotImg = null; // 图片本身，负责呼吸浮动
  let modeInput = null; // 嗒啦啦开关（真的 input，负责可访问性）
  let pet = null; // 面板收起时的整体容器（她 + 气泡）
  let petFace = null; // 她的表情
  let petBubble = null;
  let petNum = null; // 气泡第一行：今日多少积分
  let petQuip = null; // 气泡第二行：状态台词
  let petState = 'normal'; // 当前状态，点她之后要靠它回位
  let petQuipIdx = -1; // 上次说了哪句，避免连着重复
  let playTimer = 0;
  let overlay = null;
  let overlayFrame = null;
  let overlayKey = ''; // 浮层当前加载的是哪张图 / 哪个区间
  let isOpen = false;
  let mascotMode = true; // 默认嗒啦啦模式
  let frameLoaded = false;
  let checkQueued = false;

  // ------------------------------------------------------------------ 样式

  const STYLE = `
    :host {
      all: initial;
      --surface: #fcfcfb;
      --ink: #0b0b0b;
      --muted: #898781;
      --line: rgba(11, 11, 11, 0.12);
      /* 强调色 = 站点品牌的那支青绿（#14c9a3 / #22d3a6）。白底上要压深一档，
         否则白色滑块坐上去糊成一片；深色那边用亮的那支。 */
      --accent: #0e9c7d;
      --good: #0ca30c;
      --bad: #d03b3b;
      --frame: #f9f9f7;

      /* 嗒啦啦尺寸。--mascot-w 按素材宽高比 564 / 717 算得，
         面板要靠它整体左移，给「她扛着面板」腾出位置。 */
      --mascot-h: 210px;
      --mascot-w: 165px;

      /* 锚点：嗒啦啦「外缘」距视口右侧 / 底部的距离 —— 整套构图的基准点，
         改这里 = 面板和她一起平移（面板由它再往左让出一个她的宽度）。
         --mascot-dx / --mascot-dy 则是她相对面板右下角的偏移，单位像素：
         dx 正数把她往右推，dy 正数把她往下推；两个都为 0 时，
         她的左下角正好压在面板的右下角上。
         这四个值在 tools/panel-preview.html 里边拖边调，调好填回来。 */
      --anchor-r: -30px;
      --anchor-b: 70px;
      --mascot-dx: -30px;
      --mascot-dy: 69px;

      /* 普通模式：她不在，面板自己贴回右下角。默认值就是最初没有她时的落点。 */
      --plain-r: 20px;
      --plain-b: 68px;

      /* 开关滑块处于「关」时的轨道色。--line 太淡，撑不起一个控件 */
      --track: rgba(11, 11, 11, 0.24);

    }
    /* 站点主题优先；站点没管这件事时才跟系统走 */
    @media (prefers-color-scheme: dark) {
      :host(:not([data-theme="light"])) {
        --surface: #1a1a19;
        --ink: #ffffff;
        --muted: #898781;
        --line: rgba(255, 255, 255, 0.14);
        --accent: #17c8a2;
        --bad: #e66767;
        --frame: #0d0d0d;
        --track: rgba(255, 255, 255, 0.28);
      }
    }
    :host([data-theme="dark"]) {
      --surface: #1a1a19;
      --ink: #ffffff;
      --muted: #898781;
      --line: rgba(255, 255, 255, 0.14);
      --accent: #17c8a2;
      --bad: #e66767;
      --frame: #0d0d0d;
      --track: rgba(255, 255, 255, 0.28);
    }

    .capsule, .panel, .panel * { box-sizing: border-box; }
    .capsule, .panel {
      font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    }

    .capsule {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 4; /* 在面板(2)和嗒啦啦(3)之上 */
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      padding: 9px 13px;
      pointer-events: auto;
      appearance: none;
      cursor: pointer;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface);
      color: var(--ink);
      font-size: 13px;
      line-height: 1.2;
      box-shadow: 0 2px 6px rgba(0,0,0,.08), 0 10px 26px rgba(0,0,0,.14);
      transition: transform 120ms ease, box-shadow 120ms ease;
    }
    .capsule:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 10px rgba(0,0,0,.10), 0 14px 32px rgba(0,0,0,.18);
    }
    /* 必写：.capsule 自己声明了 display:flex，[hidden] 的默认 display:none 压不住它 */
    .capsule[hidden] { display: none; }
    .capsule:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .dot {
      flex: none;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--muted);
    }
    .dot.is-ok { background: var(--good); }
    .dot.is-syncing { background: var(--accent); animation: ttm-pulse 1.4s ease-in-out infinite; }
    .dot.is-error { background: var(--bad); }
    @keyframes ttm-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .3 } }

    .label { color: var(--muted); }
    .value {
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.01em;
    }
    .unit { font-size: 12px; color: var(--muted); }

    .chev {
      flex: none;
      width: 0;
      height: 0;
      margin-left: 2px;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-bottom: 5px solid var(--muted);
      transition: transform 160ms ease;
    }
    .capsule[aria-expanded="true"] .chev { transform: rotate(180deg); }

    .panel {
      position: fixed;
      /* 左移一个嗒啦啦的宽度：她的左下角要正好落在面板的右下角上 */
      right: calc(var(--anchor-r) + var(--mascot-w));
      bottom: var(--anchor-b);
      z-index: 2;
      display: flex;
      flex-direction: column;
      /* 初始尺寸；拖动改过之后由内联样式接管 */
      width: min(420px, calc(100vw - 40px - var(--mascot-w)));
      height: min(744px, calc(100vh - 108px));
      overflow: hidden;
      pointer-events: auto;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--frame);
      color: var(--ink);
      box-shadow: 0 6px 18px rgba(0,0,0,.10), 0 24px 60px rgba(0,0,0,.24);
      animation: ttm-rise 180ms cubic-bezier(.2, .8, .3, 1);
    }
    .panel[hidden] { display: none; }

    /* 普通模式：没有她，面板就不用再往左让位置。
       注意这是唯一一处「她不在时面板该去哪」的答案 —— 窄窗口那条媒体查询
       也复用它，免得同一个落点写两遍。 */
    :host([data-mode="plain"]) .panel {
      right: var(--plain-r);
      bottom: var(--plain-b);
      width: min(420px, calc(100vw - 40px));
    }
    @keyframes ttm-rise {
      from { opacity: 0; transform: translateY(10px) scale(.985); }
      to { opacity: 1; transform: none; }
    }

    /* 嗒啦啦：她「扛着」面板。
       构图靠一个对角对齐 —— **她的左下角 = 面板的右下角**。
       素材里她伸出的手臂正好在左边缘被裁断，接上竖着的面板边就成了
       「手伸到面板后面托着」。她静止不动：扛着重物不会上下浮。
       z-index 比面板高：她在前，面板在后。 */
    .mascot {
      position: fixed;
      /* 从锚点出发，再叠加她自己的偏移 */
      right: calc(var(--anchor-r) - var(--mascot-dx));
      bottom: calc(var(--anchor-b) - var(--mascot-dy));
      z-index: 3;
      line-height: 0;
      pointer-events: none;
      user-select: none;
      animation: ttm-mascot-in 260ms cubic-bezier(0.2, 0.8, 0.3, 1);
    }
    .mascot[hidden] {
      display: none;
    }
    .mascot img {
      display: block;
      height: var(--mascot-h);
      width: auto;
      /* 素材是透明底，加一层柔和投影让她坐实，不飘 */
      filter: drop-shadow(0 6px 18px rgba(0, 0, 0, 0.32));
    }

    @keyframes ttm-mascot-in {
      from { opacity: 0; transform: translateY(14px); }
      to { opacity: 1; transform: none; }
    }

    /* 普通模式下她整个不参与布局，不只是藏起来 */
    :host([data-mode="plain"]) .mascot {
      display: none;
    }

    /* ── 嗒啦啦模式下、面板收起时的形态：她本人 + 一句气泡 ──────────────
       取代原来的胶囊。胶囊是「一个控件」，这个更像「她在跟你说话」。
       两个热区分开：点气泡 = 展开面板（和原胶囊一样），
       点她本人 = 换个表情（同一个点不能既开面板又换表情）。 */
    .pet {
      /* 只留 --pet-scale 一个旋钮，其余尺寸全由它推 —— 分散写死的话，
         改一次大小要同时动十几个数字，漏一个就不成比例了。
         175 / 184 是合图格子的宽高比，要和 tools/make-faces.mjs 的输出一致。

         这几个必须定义在 .pet 上而不是 :host：派生值是在**声明它的那个元素**上
         算完再往下继承的。写在 :host 上，窄窗口在 .pet 覆盖 --pet-scale 就没用了 ——
         --pet-h 早就在宿主那里算成了定值，于是出现「气泡缩小了、她没缩」的错位。 */
      --pet-scale: 1;
      --pet-h: calc(108px * var(--pet-scale));
      --pet-w: calc(var(--pet-h) * 175 / 184);
      --pet-gap: calc(10px * var(--pet-scale));

      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 4; /* 和胶囊同层：都是面板收起时的入口 */
      display: flex;
      align-items: flex-end;
      gap: var(--pet-gap);
      pointer-events: auto;
      animation: ttm-pet-in 260ms cubic-bezier(.2, .8, .3, 1);
    }
    .pet[hidden] { display: none; }

    .pet-face {
      flex: none;
      width: var(--pet-w);
      height: var(--pet-h);
      padding: 0;
      border: 0;
      appearance: none;
      cursor: pointer;
      background-color: transparent;
      background-repeat: no-repeat;
      /* 3x3 合图放大到 300%，再用 0 / 50 / 100% 的 background-position
         定位到某一格 —— 不用在 JS 里算像素偏移 */
      background-size: 300% 300%;
      filter: drop-shadow(0 6px 16px rgba(0, 0, 0, 0.32));
      transition: transform 140ms ease;
    }
    .pet-face:hover { transform: translateY(-2px); }
    .pet-face:active { transform: translateY(0) scale(.97); }
    .pet-face:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .pet-bubble {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: calc(2px * var(--pet-scale));
      /* 上限取「按倍率算出来的宽」和「窗口里实际剩下的宽」里小的那个 ——
         她放大两倍之后整个组件有 630px 宽，窄一点的窗口会顶出去。 */
      max-width: min(
        calc(208px * var(--pet-scale)),
        calc(100vw - 40px - var(--pet-w) - var(--pet-gap))
      );
      margin-bottom: calc(16px * var(--pet-scale)); /* 抬起来一点，尾巴才落在她的头肩高度 */
      padding: calc(9px * var(--pet-scale)) calc(12px * var(--pet-scale));
      pointer-events: auto;
      cursor: pointer;
      text-align: left;
      appearance: none;
      border: 1px solid var(--line);
      border-radius: calc(12px * var(--pet-scale));
      background: var(--surface);
      color: var(--ink);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08), 0 10px 26px rgba(0, 0, 0, 0.16);
    }
    .pet-bubble:hover { border-color: var(--accent); }
    .pet-bubble:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    /* 尾巴：一个只留右边和下边的方块转 -45°，尖角就朝右指向她 */
    .pet-bubble::after {
      content: '';
      position: absolute;
      right: calc(-6px * var(--pet-scale));
      bottom: calc(14px * var(--pet-scale));
      width: calc(10px * var(--pet-scale));
      height: calc(10px * var(--pet-scale));
      background: var(--surface);
      border-right: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      transform: rotate(-45deg);
    }
    .pet-bubble:hover::after { border-color: var(--accent); }

    .pet-num {
      font-size: calc(13px * var(--pet-scale));
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .pet-quip {
      font-size: calc(12px * var(--pet-scale));
      line-height: 1.4;
      color: var(--muted);
    }

    @keyframes ttm-pet-in {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: none; }
    }

    /* 窗口太窄时她加上面板会挤成一团，不如不显示。
       既然她不在了，面板也得跟着回到普通模式的落点 —— 否则右边会空出
       一个她宽度的缺口。 */
    @media (max-width: 620px) {
      .mascot { display: none; }
      .panel {
        right: var(--plain-r);
        bottom: var(--plain-b);
      }
      /* 她不能跟着一起藏 —— 面板收起时她是唯一的入口，藏了就点不开面板了。
         改成缩小一档，其余尺寸都跟着 --pet-scale 一起收。 */
      .pet { --pet-scale: 0.8; }
    }

    @media (prefers-reduced-motion: reduce) {
      .mascot {
        animation: none;
      }
    }

    /* 左上角的拖拽把手。面板锚在右下角，所以从对角拖最自然 ——
       往左上拖是变大，右下角那条边不动。 */
    .panel-resize {
      position: absolute;
      left: 0;
      top: 0;
      width: 18px;
      height: 18px;
      cursor: nwse-resize;
      touch-action: none;
    }
    .panel-resize::after {
      content: '';
      position: absolute;
      left: 4px;
      top: 4px;
      width: 7px;
      height: 7px;
      border-left: 2px solid var(--muted);
      border-top: 2px solid var(--muted);
      border-radius: 3px 0 0;
      opacity: 0.55;
    }
    .panel-resize:hover::after {
      opacity: 1;
    }

    .bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex: none;
      padding: 9px 10px 9px 22px; /* 左边留出把手的宽度 */
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }
    .bar-title { font-size: 13px; font-weight: 600; }

    /* 嗒啦啦的开关：滑块在前，名字在后。名字是固定的，不随开关变 ——
       它答的是「这个开关管的是谁」，开没开看滑块本身。 */
    .mode {
      position: relative;
      display: flex;
      align-items: center;
      gap: 7px;
      margin-left: auto;
      margin-right: 6px;
      cursor: pointer;
      user-select: none;
    }
    .mode-text {
      font-size: 12px;
      color: var(--muted);
      transition: color 120ms ease;
    }
    .mode:hover .mode-text { color: var(--ink); }

    /* 真正可聚焦的是这个 input，视觉上由后面的 track 代替。
       它留在文档流里（只是缩到 1px），键盘和读屏才够得着。 */
    .mode-input {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: 0;
      opacity: 0;
      pointer-events: none;
    }
    .mode-track {
      position: relative;
      flex: none;
      width: 34px;
      height: 18px;
      border-radius: 999px;
      background: var(--track);
      transition: background 160ms ease;
    }
    .mode-track::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
      transition: transform 160ms ease;
    }
    .mode-input:checked + .mode-track { background: var(--accent); }
    .mode-input:checked + .mode-track::after { transform: translateX(16px); }
    /* 焦点画在滑块上，别画在那个看不见的 input 上 */
    .mode-input:focus-visible + .mode-track {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      appearance: none;
      cursor: pointer;
      border: 1px solid transparent;
      border-radius: 7px;
      background: transparent;
      color: var(--muted);
      font-size: 17px;
      line-height: 1;
    }
    .close:hover { border-color: var(--line); color: var(--ink); }
    .close:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

    .frame {
      flex: 1;
      width: 100%;
      min-height: 0;
      border: 0;
      display: block;
      background: transparent;
    }

    /* 放大查看是「另起一层」，绝不动原来的面板 ——
       早先是把面板本身放大成弹窗，结果原来那张卡片被挪走又放回来，
       观感上就是「消失了又出现」。弹窗就该浮在上面，底下的东西原地不动。 */
    .overlay {
      position: fixed;
      inset: 0;
      z-index: 5; /* 最上层 */
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px 28px;
      /* 宿主是 pointer-events:none，子元素必须逐个打开才收得到点击。
         漏了这条，浮层上的关闭按钮和遮罩就全被穿透掉，永远关不掉。 */
      pointer-events: auto;
    }
    .overlay[hidden] {
      display: none;
    }

    .overlay-scrim {
      position: absolute;
      inset: 0;
      z-index: 0;
      background: rgba(0, 0, 0, 0.5);
      animation: ttm-fade 170ms ease;
    }

    .overlay-card {
      position: relative;
      z-index: 1;
      display: flex;
      width: 100%;
      height: min(700px, 100%);
      max-width: 1120px;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--frame);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
      animation: ttm-pop 200ms cubic-bezier(0.2, 0.8, 0.3, 1);
    }

    .overlay-card .frame {
      flex: 1;
      min-height: 0;
    }

    @keyframes ttm-fade {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes ttm-pop {
      from { opacity: 0; transform: translateY(12px) scale(0.985); }
      to { opacity: 1; transform: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      .overlay-scrim,
      .overlay-card {
        animation: none;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .capsule, .chev { transition: none; }
      .panel { animation: none; }
      .dot.is-syncing { animation: none; }
      .mode-track, .mode-track::after, .mode-text { transition: none; }
      .pet { animation: none; }
      .pet-face { transition: none; }
    }
  `;

  // -------------------------------------------------------------- 挂载/卸载

  function build() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000';

    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;

    capsule = document.createElement('button');
    capsule.type = 'button';
    capsule.className = 'capsule';
    capsule.setAttribute('aria-expanded', 'false');
    capsule.setAttribute('aria-label', '展开积分消耗面板');

    dotEl = document.createElement('span');
    dotEl.className = 'dot';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = '今日';

    valueEl = document.createElement('span');
    valueEl.className = 'value';
    valueEl.textContent = '—';

    const unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = '积分';

    const chev = document.createElement('span');
    chev.className = 'chev';

    capsule.append(dotEl, label, valueEl, unit, chev);
    capsule.addEventListener('click', () => setOpen(!isOpen));

    panel = document.createElement('div');
    panel.className = 'panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '积分消耗统计');

    const bar = document.createElement('div');
    bar.className = 'bar';

    const title = document.createElement('span');
    title.className = 'bar-title';
    title.textContent = '积分消耗';

    // 嗒啦啦的开关。文案是固定的一个名字，不随状态切换 ——
    // 这是个「开/关她」的开关，不是两个模式二选一，写「普通」只会让人
    // 以为还有第二个东西可选。滑块自己在左边，名字在旁边，够了。
    const mode = document.createElement('label');
    mode.className = 'mode';
    mode.title = '显示 / 隐藏嗒啦啦';

    modeInput = document.createElement('input');
    modeInput.type = 'checkbox';
    modeInput.className = 'mode-input';
    // role=switch 比 checkbox 更贴合「开/关某一件事」的语义
    modeInput.setAttribute('role', 'switch');
    modeInput.setAttribute('aria-label', '显示嗒啦啦');
    modeInput.addEventListener('change', () => setMascotMode(modeInput.checked));

    const modeTrack = document.createElement('span');
    modeTrack.className = 'mode-track';

    const modeText = document.createElement('span');
    modeText.className = 'mode-text';
    modeText.textContent = '嗒啦啦';

    mode.append(modeInput, modeTrack, modeText);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.textContent = '×';
    close.setAttribute('aria-label', '收起面板');
    close.addEventListener('click', () => setOpen(false));

    bar.append(title, mode, close);

    // 面板收起时的形态：她本人 + 一句气泡。两个热区是分开的 ——
    // 点气泡展开面板，点她本人换个表情（同一个点没法既开面板又换表情）。
    pet = document.createElement('div');
    pet.className = 'pet';
    pet.hidden = true;

    petFace = document.createElement('button');
    petFace.type = 'button';
    petFace.className = 'pet-face';
    petFace.setAttribute('aria-label', '点一下换个表情');
    petFace.addEventListener('click', playOnce);

    petBubble = document.createElement('button');
    petBubble.type = 'button';
    petBubble.className = 'pet-bubble';
    petBubble.setAttribute('aria-label', '展开积分消耗面板');
    petBubble.addEventListener('click', () => setOpen(true));

    petNum = document.createElement('span');
    petNum.className = 'pet-num';
    petNum.textContent = '今日 — 积分';

    petQuip = document.createElement('span');
    petQuip.className = 'pet-quip';

    petBubble.append(petNum, petQuip);
    pet.append(petBubble, petFace); // 气泡在左、她在右（气泡朝右指向她）

    frame = document.createElement('iframe');
    frame.className = 'frame';
    frame.setAttribute('title', '积分消耗统计');
    frame.setAttribute('loading', 'lazy');

    // 放大浮层与面板平级，独立一层
    overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.hidden = true;

    const overlayScrim = document.createElement('div');
    overlayScrim.className = 'overlay-scrim';
    overlayScrim.addEventListener('click', collapseOverlay);

    const overlayCard = document.createElement('div');
    overlayCard.className = 'overlay-card';

    overlayFrame = document.createElement('iframe');
    overlayFrame.className = 'frame';
    overlayFrame.setAttribute('title', '积分消耗统计（放大）');

    overlayCard.append(overlayFrame);
    overlay.append(overlayScrim, overlayCard);

    const resizeGrip = document.createElement('div');
    resizeGrip.className = 'panel-resize';
    resizeGrip.title = '拖动调整面板大小';
    attachPanelResize(resizeGrip);

    // 嗒啦啦：和面板平级、锚点相同，所以在面板之上盖住它的右下角。
    // 外面套一层容器 —— 入场动画和呼吸动画都得动 transform，
    // 压在同一个元素上会互相覆盖，分层就互不干扰。
    mascot = document.createElement('div');
    mascot.className = 'mascot';
    mascot.hidden = true;

    mascotImg = document.createElement('img');
    mascotImg.alt = '';
    mascotImg.setAttribute('aria-hidden', 'true');
    mascot.append(mascotImg);

    panel.append(resizeGrip, bar, frame);
    shadow.append(style, capsule, pet, panel, mascot, overlay);
  }

  function mount() {
    if (host && host.isConnected) return;
    if (!host) build();
    document.body.append(host);
    restorePanelSize();
    pushTheme(true);
    // 站点的路由切换可能把 body 下的东西清掉，重新挂回来后要把面板状态接上
    applyMode({ persist: false }); // 得先于 applyOpen：她要靠 data-mode 才显示得出来
    applyOpen(isOpen, { persist: false });
    refreshSummary();
  }

  function unmount() {
    if (host && host.isConnected) host.remove();
  }

  // ---------------------------------------------------------------- 主题

  /**
   * 站点用 <html class="dark"> 自己管主题（不是媒体查询）。
   * 面板要跟着它走，但 iframe 跨源，仪表盘那边读不到父页面的 class ——
   * 所以由这里读出来，通过 ?theme= 和 postMessage 传进去。
   */
  function siteTheme() {
    const el = document.documentElement;
    if (el.classList.contains('dark')) return 'dark';
    if (el.classList.contains('light')) return 'light';

    // 站点没给明确标记时，退回到它自己声明的 color-scheme，再不行才看系统
    const scheme = getComputedStyle(el).colorScheme || '';
    if (scheme.includes('dark')) return 'dark';
    if (scheme.includes('light')) return 'light';
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  let currentTheme = null;

  function pushTheme(force) {
    const theme = siteTheme();
    if (!force && theme === currentTheme) return;
    currentTheme = theme;

    if (host) host.setAttribute('data-theme', theme);

    if (frame && frameLoaded) {
      try {
        frame.contentWindow.postMessage({ type: 'ttm-theme', theme }, '*');
      } catch {
        // 读不到 contentWindow 就算了，下次重开面板会带上正确的 ?theme=
      }
    }
  }

  // ---------------------------------------------------------------- 状态

  function applyOpen(next, { persist = true } = {}) {
    isOpen = next;
    if (!panel) return;

    panel.hidden = !isOpen;
    if (!isOpen) setExpanded(false); // 收起面板时把放大状态一起复位
    setMascotVisible(isOpen && mascotMode);
    applyChrome();
    // 收起状态下换模式是不夹尺寸的（那时量不到），所以开的时候补一次
    if (isOpen) clampPanelSize();
    capsule.setAttribute('aria-expanded', String(isOpen));
    capsule.setAttribute('aria-label', isOpen ? '收起积分消耗面板' : '展开积分消耗面板');

    if (isOpen && !frameLoaded) {
      // 懒加载：不展开就不去加载仪表盘，省得每次开页面都跑一遍。
      // 把主题一并带上，让它在第一帧就是对的颜色，不闪一下再切。
      frame.src = `${chrome.runtime.getURL('src/dashboard.html')}?embed=1&theme=${siteTheme()}`;
      frameLoaded = true;
    }
    if (persist) {
      chrome.storage.local.set({ [OPEN_KEY]: isOpen }).catch(() => {});
    }
  }

  function setOpen(next) {
    applyOpen(next);
  }

  /** 仪表盘里开了放大浮层时把面板铺满窗口；关掉后收回原尺寸 */
  // ── 面板收起时的小嗒啦啦（表情 + 气泡）──────────────────────────────

  /** 合图懒加载：没进过这个形态就不去取那 350KB。 */
  function setPetVisible(on) {
    if (!pet) return;
    if (on && petFace && !petFace.style.backgroundImage) {
      petFace.style.backgroundImage = `url("${chrome.runtime.getURL('assets/faces.png')}")`;
    }
    pet.hidden = !on;
  }

  /**
   * 右下角什么时候摆什么。
   *   嗒啦啦模式 收起 → 她 + 气泡（取代胶囊）
   *   嗒啦啦模式 展开 → 只有扛着面板的她，胶囊不出现
   *   普通模式   两种 → 都是原来的胶囊
   * 换句话说：嗒啦啦模式下胶囊一律不出现；普通模式下她一律不出现。
   * 收起面板本来靠的就是面板自己的 × ，不依赖胶囊，所以展开时不摆它也没问题。
   */
  function applyChrome() {
    setPetVisible(mascotMode && !isOpen);
    if (capsule) capsule.hidden = mascotMode;
  }

  /** 把合图里某一格挪到脸上。3x3 用 0 / 50 / 100% 定位，不用算像素。 */
  function setFace(id) {
    const i = FACE_INDEX.get(id);
    if (i == null || !petFace) return;
    const col = i % FACE_COLS;
    const row = Math.floor(i / FACE_COLS);
    petFace.style.backgroundPosition = `${col * 50}% ${row * 50}%`;
    petFace.dataset.face = id;
  }

  /** 同一状态连着说同一句很出戏，所以记一下上次是哪句。 */
  function quipFor(state) {
    const list = QUIPS[state] || QUIPS.normal;
    let i = (Math.random() * list.length) | 0;
    if (list.length > 1 && i === petQuipIdx) i = (i + 1) % list.length;
    petQuipIdx = i;
    return list[i];
  }

  function showStateFace() {
    setFace(FACE_BY_STATE[petState] || FACE_BY_STATE.normal);
    if (petQuip) petQuip.textContent = quipFor(petState);
  }

  /** 点她：表情和台词各随机抽一个，过一会儿自己回到状态对应的那个。 */
  function playOnce() {
    if (!pet || pet.hidden) return;
    let pick = PLAY_FACES[(Math.random() * PLAY_FACES.length) | 0];
    // 连着抽到同一个就没意思了
    if (pick === petFace.dataset.face) pick = PLAY_FACES[(PLAY_FACES.indexOf(pick) + 1) % PLAY_FACES.length];
    setFace(pick);
    if (petQuip) petQuip.textContent = PLAY_LINES[(Math.random() * PLAY_LINES.length) | 0];
    clearTimeout(playTimer);
    // 回调里必须把 playTimer 清掉：留着那个过期的 id 会让 applyPet 以为
    // 「还在演」，之后状态再变也不换表情了。
    playTimer = setTimeout(() => {
      playTimer = 0;
      showStateFace();
    }, PLAY_HOLD_MS);
  }

  /**
   * 今天算「多」还是「少」—— 拿你自己的历史当尺子，而不是拍几个固定数。
   * 有人一天花几千、有人花几万，固定阈值对谁都有一半是错的。
   */
  function consumptionState(total, daily, day) {
    if (!total) return 'zero';
    const past = Object.entries(daily || {})
      .filter(([d, v]) => d !== day && v && typeof v === 'object')
      .map(([, v]) => Object.values(v).reduce((a, b) => a + (Number(b) || 0), 0))
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    // 历史太少就别硬分档，一律当「正常」，免得头几天乱跳
    if (past.length < 5) return 'normal';

    const q = (p) => past[Math.min(past.length - 1, Math.floor(past.length * p))];
    if (total < q(0.25)) return 'light';
    if (total < q(0.75)) return 'normal';
    if (total < q(0.9)) return 'heavy';
    return 'over';
  }

  /** 状态变了才动表情；正在「点她」的展示期内先不动，让那一下演完。 */
  function applyPet(raw, total, status) {
    petState = status === 'syncing' ? 'sync'
      : status === 'error' || status === 'noauth' ? 'error'
        : consumptionState(total, raw.daily, localDayKey());

    if (petNum) {
      petNum.textContent = `今日 ${Math.round(total || 0).toLocaleString('zh-CN')} 积分`;
    }
    if (!playTimer) showStateFace();
  }

  /** 嗒啦啦只在面板展开时露面。图片懒加载 —— 没开过面板就不去取这个 400KB */
  function setMascotVisible(on) {
    if (!mascot) return;
    if (on && mascotImg && !mascotImg.src) {
      mascotImg.src = chrome.runtime.getURL('assets/mascot.png');
    }
    mascot.hidden = !on;
  }

  const PANEL_MIN = { w: 300, h: 240 };

  /**
   * 右边留给嗒啦啦的宽度 —— 面板要往左让出这么多；她不在时是 0。
   *
   * 「她在不在」不在这里另算一遍，而是直接问她现在的 computed display。
   * 普通模式、窄于 620px 的窗口、开关没拨…… 这些条件全都体现在那一个值上，
   * 从 CSS 变量里读宽度也免了在 JS 里再抄一份尺寸。抄两遍迟早对不上：
   * 之前只看模式不看窗口宽度，窄窗口下就会白白预留出 165px。
   */
  function mascotSpace() {
    if (!host || !mascot) return 0;
    if (getComputedStyle(mascot).display === 'none') return 0;
    const v = getComputedStyle(host).getPropertyValue('--mascot-w');
    return parseFloat(v) || 0;
  }

  /**
   * 开关状态的唯一出口：把 mascotMode 这个布尔值同步到界面上。
   * 「她出不出场」由两件事共同决定 —— 面板展开着，且开关是开的 ——
   * 这两条以前散在不同地方，很容易只改一处；现在都收在这里。
   */
  function applyMode({ persist = true } = {}) {
    if (modeInput) modeInput.checked = mascotMode;
    // CSS 靠宿主的 data-mode 决定面板落点、以及她是否参与布局
    if (host) host.setAttribute('data-mode', mascotMode ? 'mascot' : 'plain');
    setMascotVisible(isOpen && mascotMode);
    applyChrome();

    if (persist) {
      chrome.storage.local.set({ [MASCOT_KEY]: mascotMode }).catch(() => {});
    }
  }

  function setMascotMode(on) {
    if (on === mascotMode) return;
    mascotMode = on;
    applyMode();
    clampPanelSize();
  }

  /**
   * 换模式后宽度上限会变（普通模式没有她，能更宽），所以要把当前尺寸重新夹一遍。
   * 只在真超限时才动它 —— 否则每切一次模式就会把 min() 那套响应式宽度
   * 固化成内联值，之后窗口再变宽面板也不跟着长了。
   */
  function clampPanelSize() {
    if (!panel || panel.hidden) return;
    const maxW = Math.max(PANEL_MIN.w, window.innerWidth - 24 - mascotSpace());
    const maxH = Math.max(PANEL_MIN.h, window.innerHeight - 96);
    // 用 offsetWidth 而不是 getBoundingClientRect：面板刚显示时入场动画的
    // transform 还没跑完，rect 量到的是被 scale(.985) 缩过的值。
    if (panel.offsetWidth > maxW || panel.offsetHeight > maxH) {
      setPanelSize(panel.offsetWidth, panel.offsetHeight);
    }
  }

  /** 面板尺寸。它锚在右下角（right/bottom），所以从左上角拖时右下角固定不动。 */
  function setPanelSize(w, h) {
    if (!panel) return;
    const maxW = Math.max(PANEL_MIN.w, window.innerWidth - 24 - mascotSpace());
    const maxH = Math.max(PANEL_MIN.h, window.innerHeight - 96);
    panel.style.width = `${Math.max(PANEL_MIN.w, Math.min(Math.round(w), maxW))}px`;
    panel.style.height = `${Math.max(PANEL_MIN.h, Math.min(Math.round(h), maxH))}px`;
  }

  /**
   * 当前尺寸。用 offsetWidth/Height 而不是 getBoundingClientRect —— 后者会
   * 被入场动画的 transform 影响，刚展开就抓把手会量到缩过的值、拖起来跳一下。
   * 而且这两个值本来就是「要写进内联样式的边框盒尺寸」，offset 系列正好是它。
   */
  function currentPanelSize() {
    return { w: panel.offsetWidth, h: panel.offsetHeight };
  }

  /** 左上角的拖拽把手。往左上拖是变大 —— 那正是远离锚点的方向。 */
  function attachPanelResize(grip) {
    grip.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      const startX = ev.clientX;
      const startY = ev.clientY;
      const base = currentPanelSize();
      try {
        grip.setPointerCapture(ev.pointerId);
      } catch {
        // 拿不到捕获也能拖，只是拖出把手范围会断
      }

      const onMove = (e) => {
        setPanelSize(base.w - (e.clientX - startX), base.h - (e.clientY - startY));
      };
      const onUp = () => {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        chrome.storage.local.set({ panelSize: currentPanelSize() }).catch(() => {});
      };

      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
    });
  }

  /** 恢复上次拖出来的尺寸 */
  function restorePanelSize() {
    chrome.storage.local
      .get('panelSize')
      .then((raw) => {
        const s = raw && raw.panelSize;
        if (s && Number.isFinite(s.w) && Number.isFinite(s.h) && s.w > 0 && s.h > 0) setPanelSize(s.w, s.h);
      })
      .catch(() => {
        // 读不到就用默认尺寸
      });
  }

  /**
   * 收起浮层。
   * 这里直接隐藏，不依赖浮层里的仪表盘回应 —— 否则它一旦没响应（比如弹窗早被
   * 拆掉了），用户就被困在一个盖满屏幕、关不掉的浮层里。
   * 同时通知它收好自己的弹窗，下次打开才是干净的。
   */
  function collapseOverlay() {
    if (!overlay) return;
    overlay.hidden = true;
    try {
      overlayFrame.contentWindow.postMessage({ type: 'ttm-collapse' }, '*');
    } catch {
      // 拿不到就算了，反正浮层已经藏起来了
    }
  }

  /**
   * 开关放大浮层。面板本身一动不动 —— 动了就会出现「卡片消失又回来」。
   * opts 里的 chart / range 是仪表盘正在看的那张图和区间，传过去让浮层
   * 落在同一处，而不是回到默认视图。
   */
  function setExpanded(on, opts = {}) {
    if (!overlay) return;

    if (!on) {
      collapseOverlay();
      return;
    }

    const key = `${opts.chart || ''}|${opts.range || ''}`;
    if (key !== overlayKey) {
      const params = new URLSearchParams({ embed: '1', overlay: '1' });
      if (opts.chart) params.set('chart', opts.chart);
      if (opts.range) params.set('range', opts.range);
      overlayFrame.src = `${chrome.runtime.getURL('src/dashboard.html')}?${params}`;
      overlayKey = key;
    } else {
      // 同一张图，iframe 不重新加载 —— 但上次关闭时它把自己的弹窗拆掉了，
      // 所以得让它重新打开，不然第二次进来看到的是一份没有弹窗的仪表盘。
      try {
        overlayFrame.contentWindow.postMessage({ type: 'ttm-open', chart: opts.chart }, '*');
      } catch {
        // 忽略
      }
    }

    overlay.hidden = false;
  }

  // ---------------------------------------------------------------- 数据

  /**
   * 直接读存储拿今日数字 —— 后台在每次写聚合时已经算好放在 `today` 里。
   * 不走消息是有意的：走消息就得先叫醒后台服务进程，它休眠或正忙时可能不应答，
   * 胶囊就只剩一根横线，还看不出原因。
   */
  async function refreshSummary() {
    let raw;
    try {
      raw = await chrome.storage.local.get(['today', 'daily', 'sync', 'auth']);
    } catch {
      // 扩展重载后，页面上这个旧的内容脚本已经和扩展失联，只能靠刷新页面
      showUnavailable('扩展已更新，刷新本页后恢复');
      return;
    }
    applySummary(raw);
  }

  /**
   * 本地日期键，格式必须和后台 dayKey 一致（YYYY-MM-DD）。
   * sv-SE 这个 locale 的输出恰好就是 YYYY-MM-DD，比手拼少一处会写错的地方；
   * 万一环境给的不是这个格式，再退回手拼。
   */
  function localDayKey() {
    const formatted = new Date().toLocaleDateString('sv-SE');
    if (/^\d{4}-\d{2}-\d{2}$/.test(formatted)) return formatted;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function showUnavailable(reason) {
    dotEl.className = 'dot is-error'; // 亮红灯：一眼能看出不对劲，悬停才知道怎么办
    valueEl.textContent = '—';
    capsule.title = reason;
  }

  /**
   * 数字以 daily 为准自己算一遍，后台预算的 today 只在对得上日期时才用。
   * 这样胶囊和仪表盘永远看同一份数据 —— 早先只信 today，它一旦没写上或写旧了，
   * 胶囊就会显示 0，而展开面板里数字却是对的。
   */
  function todayTotal(raw) {
    const key = localDayKey();

    if (raw.today && raw.today.day === key && typeof raw.today.total === 'number') {
      return raw.today.total;
    }
    const bucket = (raw.daily || {})[key];
    if (bucket) return Object.values(bucket).reduce((a, b) => a + b, 0);
    return null; // 连当天的桶都没有，说明还没同步过
  }

  function applySummary(raw) {
    const total = todayTotal(raw);

    const auth = raw.auth;
    const sync = raw.sync || {};
    // 残骸超时。内容脚本不能 import，只能在这里抄一份 —— 值必须和
    // src/util.js 的 SYNC_STALE_MS 保持一致，改一处就得改另一处。
    const SYNC_STALE_MS = 3 * 60_000;
    const syncing = Boolean(sync.running) && Date.now() - (sync.runningSince || 0) < SYNC_STALE_MS;
    const key = localDayKey();

    let status = 'ok';
    if (!auth || !auth.accessToken) status = 'noauth';
    else if (syncing) status = 'syncing';
    else if (sync.lastError) status = 'error';

    valueEl.textContent = total == null ? '0' : Math.round(total).toLocaleString('zh-CN');
    dotEl.className = `dot is-${status}`;

    capsule.title = status === 'noauth'
      ? '还没拿到登录态 —— 打开 maker.taptap.cn 登录一次'
      : status === 'error'
        ? `同步出错了：${sync.lastError.message}`
        : status === 'syncing'
          ? '正在同步…'
          : total == null
            ? '还没有同步过数据，点开面板开始同步'
            : `${key} 消耗 ${Math.round(total).toLocaleString('zh-CN')} 积分`;

    applyPet(raw, total, status);
  }

  // ------------------------------------------------------------ 路由与生命周期

  function evaluate() {
    if (!isCreditsPage()) {
      unmount();
      return;
    }
    // 站点重渲染可能把 host 冲掉，每轮都确认一下还在
    if (!host || !host.isConnected) mount();
  }

  function scheduleCheck() {
    if (checkQueued) return;
    checkQueued = true;
    requestAnimationFrame(() => {
      checkQueued = false;
      evaluate();
    });
  }

  // SPA 切路由不会重新执行内容脚本。pushState 在隔离世界里改不动（内容和页面
  // 各自的 window 是不同的包装对象），所以用 MutationObserver + popstate 兜。
  new MutationObserver(scheduleCheck).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.addEventListener('popstate', scheduleCheck);
  window.addEventListener('hashchange', scheduleCheck);

  // 仪表盘里开关放大浮层时会通知这里（浮层是另起的一层，面板本身不动）。
  // 只认自己那两个 iframe 发来的消息，别的页面说什么都不管。
  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data || data.type !== 'ttm-expand') return;
    // 面板里的仪表盘和浮层里的仪表盘都会发这个，两个 iframe 都得认
    const fromPanel = frame && ev.source === frame.contentWindow;
    const fromOverlay = overlayFrame && ev.source === overlayFrame.contentWindow;
    if (!fromPanel && !fromOverlay) return;
    setExpanded(data.on === true, { chart: data.chart, range: data.range });
  });

  // 站点切深浅色只改 <html> 上的 class，不触发 childList，得单独盯属性
  new MutationObserver(() => pushTheme(false)).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });

  // 上面两个都有漏网的可能，再加一道低频兜底
  setInterval(scheduleCheck, 2000);

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.today || changes.sync || changes.auth) refreshSummary();
    });
    chrome.storage.local.get([OPEN_KEY, MASCOT_KEY]).then((raw) => {
      isOpen = !!raw && raw[OPEN_KEY] === true;
      // 没存过 = 从没切过 = 用默认的嗒啦啦模式
      mascotMode = !raw || raw[MASCOT_KEY] !== false;
      applyMode({ persist: false });
      applyOpen(isOpen, { persist: false });
    }).catch(() => {});
  } catch {
    // 拿不到扩展 API 也不至于把页面搞坏
  }

  applyOpen(false, { persist: false });
  evaluate();
  setInterval(refreshSummary, 60_000);
})();
