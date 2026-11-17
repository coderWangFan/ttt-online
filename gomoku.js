(() => {
  'use strict';

  /* ============================ 常量 ============================ */

  const N = 15;
  const TOTAL = N * N;

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];
  const TOPIC_ROOT = 'goose/gmk/v1/';
  const ME_ID = 'g' + Math.random().toString(36).slice(2, 10);
  const PING_MS = 5000;
  const OFFLINE_MS = 13000;

  const BLACK = 'B';
  const WHITE = 'W';
  const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  /* ============================ DOM ============================ */

  const $ = (id) => document.getElementById(id);
  const lobbyEl = $('lobby');
  const gameEl = $('game');
  const stageEl = (function () {
    try { return document.querySelector ? document.querySelector('.stage') : null; } catch (err) { return null; }
  })();
  const boardSlotEl = (function () {
    try { return document.querySelector ? document.querySelector('.board-slot') : null; } catch (err) { return null; }
  })();
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const statusEl = $('status');
  const detailEl = $('detail');
  const codeEl = $('show-code');
  const dotEl = $('dot');
  const connTextEl = $('conn-text');
  const noticeEl = $('notice');
  const rematchBtn = $('rematch-btn');
  const shareBtn = $('share-btn');
  const scoreEls = { me: $('score-me'), draw: $('score-draw'), opp: $('score-opp') };
  const roundNowEl = $('round-now');
  const roundDoneEl = $('round-done');
  const roundSlashEl = $('round-slash');
  const chatEl = $('chat');
  const chatListEl = $('chat-list');
  const chatEmptyEl = $('chat-empty');
  const chatFormEl = $('chat-form');
  const chatInputEl = $('chat-input');
  const chatSendEl = $('chat-send');
  const chatToggleEl = $('chat-toggle');
  const chatPeekEl = $('chat-peek');
  const chipEl = $('code-chip');
  const matchDialogEl = $('match-dialog');
  const mdTextEl = $('md-text');
  const mdAgainEl = $('md-again');
  const mdCloseEl = $('md-close');
  const mdScrimEl = $('md-scrim');
  const totalPickEl = $('total-pick');
  const totalInputEl = $('total-input');
  const totalCustomRowEl = $('total-custom-row');


  /* ============================ 状态 ============================ */

  const S = {
    mode: 'lobby',
    code: '',
    role: '',
    round: 0,
    myMark: BLACK,
    oppMark: WHITE,
    board: Array(TOTAL).fill(null),
    turn: BLACK,
    over: false,
    lastMove: -1,
    winLine: null,
    score: { me: 0, draw: 0, opp: 0 },
    oppOnline: false,
    lastSeen: 0,
    sentRematch: false,
    gotRematch: false,
    total: 8,
    matchOver: false,
    chat: [],
    client: null,
    connected: false,
    pingTimer: null,
    brokerIndex: 0,
    brokerTries: 0
  };

  let geom = { size: 460, gap: 460 / N, pad: 460 / N / 2 };
  let hoverIdx = -1;
  let cursorIdx = 7 * N + 7;
  let keyboardMode = false;

  /* ============================ 工具 ============================ */

  const other = (m) => (m === BLACK ? WHITE : BLACK);
  const markName = (m) => (m === BLACK ? '黑' : '白');

  function makeCode() {
    let s = '';
    for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }

  function setStatus(text, tone) {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone || 'idle';
    statusEl.classList.remove('is-updating');
    void statusEl.offsetWidth;
    statusEl.classList.add('is-updating');
  }

  function setDetail(html) { detailEl.innerHTML = html; }

  let noticeTimer = 0;

  // 提示只做「提示」，不占版面：浮在底部，几秒后自己消失
  function setNotice(text, kind) {
    if (!noticeEl) return;
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = 0; }
    if (text) {
      noticeEl.textContent = text;
      noticeEl.dataset.kind = kind || 'warn';
      noticeEl.hidden = false;
      noticeTimer = setTimeout(function () { noticeEl.hidden = true; noticeTimer = 0; }, 5200);
    } else {
      noticeEl.hidden = true;
      noticeEl.textContent = '';
    }
  }

  function setConn(state, text) {
    dotEl.className = 'dot' + (state === 'on' ? ' on' : state === 'wait' ? ' wait' : '');
    connTextEl.textContent = text;
  }

  function renderScore() {
    // 数字变化时给一点反馈，不要硬切
    [['me', S.score.me], ['draw', S.score.draw], ['opp', S.score.opp]].forEach(([k, v]) => {
      const el = scoreEls[k];
      if (!el) return;
      const next = String(v);
      if (el.textContent !== next) { el.textContent = next; bump(el); }
    });
  }

  /* ============================ 局数 / 房间消息 ============================ */

  function bump(el) {
    if (!el) return;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  // 局数显示「已完成 / 总局数」
  function renderRounds() {
    const done = String(S.score.me + S.score.draw + S.score.opp);
    const total = String(S.total || 8);
    if (roundDoneEl && roundDoneEl.textContent !== done) { roundDoneEl.textContent = done; bump(roundDoneEl); }
    if (roundNowEl && roundNowEl.textContent !== total) { roundNowEl.textContent = total; bump(roundNowEl); }
    if (roundDoneEl) roundDoneEl.hidden = false;
    if (roundSlashEl) roundSlashEl.hidden = false;
  }

  // 房间内固定身份：房主 = 玩家一，访客 = 玩家二
  const nameOfRole = (role) => (role === 'host' ? '玩家一' : '玩家二');
  const myName = () => nameOfRole(S.role);
  const oppName = () => nameOfRole(S.role === 'host' ? 'guest' : 'host');

  // 列表滚上去时给顶部加一层渐隐，避免气泡被硬切
  function syncChatScroll() {
    if (!chatListEl) return;
    chatListEl.classList.toggle('is-scrolled', chatListEl.scrollTop > 2);
  }

  function scrollChatToEnd() {
    try { chatListEl.scrollTop = chatListEl.scrollHeight; } catch (err) {}
    syncChatScroll();
  }

  function appendChat(text, own) {
    if (!chatListEl) return;
    if (chatEmptyEl) chatEmptyEl.hidden = true;
    chatListEl.classList.remove('is-empty');
    const row = document.createElement('div');
    row.className = 'msg ' + (own ? 'from-me' : 'from-other');
    const prev = S.chat[S.chat.length - 1];
    if (prev && prev.own === !!own) {
      row.classList.add('is-group');
      const last = chatListEl.lastElementChild;
      if (last && last.classList.contains('msg')) last.classList.add('is-mid');
    }
    const name = document.createElement('span');
    name.className = 'msg-name';
    name.textContent = own ? myName() : oppName();
    const bubble = document.createElement('p');
    bubble.className = 'bubble';
    bubble.textContent = text;
    row.appendChild(name);
    row.appendChild(bubble);
    chatListEl.appendChild(row);
    S.chat.push({ own: !!own, text: text });
    scrollChatToEnd();
    updateChatPeek();
    if (!chatExpanded && chatEl) chatEl.classList.add('has-new');
  }

  let chatExpanded = false;

  function makeSpacer() {
    const el = document.createElement('div');
    el.className = 'chat-spacer';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  // 收起时也要能看到「谁说了最后一句」，不用点开才知道有新消息
  function updateChatPeek() {
    if (!chatPeekEl) return;
    const last = S.chat[S.chat.length - 1];
    if (!last) { chatPeekEl.textContent = '还没有消息'; return; }
    chatPeekEl.textContent = (last.own ? '你' : oppName()) + '：' + last.text;
  }

  /* 面板多高：正好到棋盘下沿，永远不压棋盘（尺寸、位置都不变） */
  function fitChatSheet() {
    if (!stageEl || !boardSlotEl || !stageEl.style) return;
    var narrow = true;
    try { narrow = window.matchMedia ? window.matchMedia('(max-width: 899px)').matches : true; } catch (err) {}
    if (!narrow || !chatExpanded) {
      stageEl.style.removeProperty('--chat-sheet');
      return;
    }
    var sr = stageEl.getBoundingClientRect();
    var br = boardSlotEl.getBoundingClientRect();
    var free = Math.round(sr.bottom - br.bottom - 6);
    var h = Math.max(150, Math.min(320, free));
    stageEl.style.setProperty('--chat-sheet', h + 'px');
  }
  try { window.addEventListener('resize', fitChatSheet); } catch (err) {}

  function setChatExpanded(on, scrollIntoView) {
    chatExpanded = !!on;
    if (chatEl) {
      chatEl.classList.toggle('is-collapsed', !chatExpanded);
      if (chatExpanded) chatEl.classList.remove('has-new');
    }
    if (chatToggleEl) chatToggleEl.setAttribute('aria-expanded', chatExpanded ? 'true' : 'false');
    fitChatSheet();
    if (chatExpanded) {
      scrollChatToEnd();
      // 展开后等高度动画走完，把输入框带进视野（只是位置变化，棋盘大小不动）
      if (scrollIntoView) {
        const reveal = function () {
          const form = document.getElementById('chat-form');
          const target = form || chatEl;
          if (target && target.scrollIntoView) {
            try { target.scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch (err) {}
          }
        };
        setTimeout(reveal, 330);
      }
    }
  }

  /* 对局中给外壳上锁：窄屏整页固定一屏，消息区怎么收放都不会撑出页面滚动条 */
  (function watchShell() {
    var wrapEl = null;
    try {
      if (document.querySelector) wrapEl = document.querySelector('.wrap--game');
    } catch (err) {}
    if (!wrapEl || !gameEl) return;
    var sync = function () { wrapEl.classList.toggle('is-playing', !gameEl.hidden); };
    sync();
    if (window.MutationObserver) {
      try {
        new MutationObserver(sync).observe(gameEl, { attributes: true, attributeFilter: ['hidden'] });
      } catch (err) {}
    }
  })();

  function clearChat() {
    S.chat = [];
    if (!chatListEl) return;
    chatListEl.innerHTML = '';
    chatListEl.appendChild(makeSpacer());
    chatListEl.classList.remove('is-scrolled', 'has-new');
    chatListEl.classList.add('is-empty');
    updateChatPeek();
    if (chatEmptyEl) { chatEmptyEl.hidden = false; chatListEl.appendChild(chatEmptyEl); }
  }

  function updateChatSend() {
    if (!chatSendEl || !chatInputEl) return;
    chatSendEl.disabled = chatInputEl.value.trim().length === 0;
  }

  function sendChat(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text) return;
    if (!S.client || !S.connected) { setNotice('还没连上对方，稍等一下再发。'); return; }
    appendChat(text, true);
    publish({ t: 'msg', x: text, round: S.round });
  }

  function isPublicUrl() {
    if (location.protocol === 'file:') return false;
    const h = location.hostname || '';
    return !(h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]' || h === '::1');
  }

  /* ============================ 规则 ============================ */

  function winLineAt(board, idx, mark) {
    const r0 = Math.floor(idx / N);
    const c0 = idx % N;

    for (let d = 0; d < DIRS.length; d++) {
      const dr = DIRS[d][0];
      const dc = DIRS[d][1];
      const line = [idx];

      for (let s = 1; s < 5; s++) {
        const r = r0 + dr * s;
        const c = c0 + dc * s;
        if (r < 0 || r >= N || c < 0 || c >= N) break;
        if (board[r * N + c] !== mark) break;
        line.push(r * N + c);
      }
      for (let s = 1; s < 5; s++) {
        const r = r0 - dr * s;
        const c = c0 - dc * s;
        if (r < 0 || r >= N || c < 0 || c >= N) break;
        if (board[r * N + c] !== mark) break;
        line.unshift(r * N + c);
      }
      if (line.length >= 5) return line;
    }
    return null;
  }

  function getResult(board, lastIdx) {
    if (lastIdx != null) {
      const line = winLineAt(board, lastIdx, board[lastIdx]);
      if (line) return { winner: board[lastIdx], line: line, reason: 'win' };
    }
    for (let i = 0; i < TOTAL; i++) if (!board[i]) return null;
    return { winner: null, line: null, reason: 'full' };
  }

  /* ============================ 画布 ============================ */

  function layout() {
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(240, Math.round(rect.width || 440));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const gap = size / N;
    geom = { size: size, gap: gap, pad: gap / 2 };
    draw();
  }

  function posOf(index) {
    return {
      x: geom.pad + (index % N) * geom.gap,
      y: geom.pad + Math.floor(index / N) * geom.gap
    };
  }

  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
    return {
      board: v('--board-bg', '#ffffff'),
      line: v('--board-line', 'rgba(60,60,67,.22)'),
      star: v('--board-star', 'rgba(60,60,67,.38)'),
      black: v('--stone-black', '#1d1d1f'),
      blackEdge: v('--stone-black-edge', 'rgba(0,0,0,.55)'),
      white: v('--stone-white', '#ffffff'),
      whiteEdge: v('--stone-white-edge', 'rgba(0,0,0,.16)'),
      accent: v('--blue', '#007aff')
    };
  }

  function draw() {
    const { size, gap, pad } = geom;
    const C = themeColors();

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = C.board;
    ctx.fillRect(0, 0, size, size);

    // 网格
    ctx.strokeStyle = C.line;
    ctx.lineWidth = Math.max(0.8, gap * 0.032);
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const p = pad + i * gap;
      ctx.moveTo(pad, p);
      ctx.lineTo(size - pad, p);
      ctx.moveTo(p, pad);
      ctx.lineTo(p, size - pad);
    }
    ctx.stroke();

    // 星位
    const stars = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]];
    ctx.fillStyle = C.star;
    stars.forEach(([r, c]) => {
      ctx.beginPath();
      ctx.arc(pad + c * gap, pad + r * gap, Math.max(1.8, gap * 0.085), 0, Math.PI * 2);
      ctx.fill();
    });

    // 棋子
    const radius = gap * 0.44;
    for (let i = 0; i < TOTAL; i++) {
      const mark = S.board[i];
      if (!mark) continue;
      const p = posOf(i);
      drawStone(p.x, p.y, radius, mark, C);
    }

    // 最后一手
    if (S.lastMove >= 0 && S.board[S.lastMove]) {
      const p = posOf(S.lastMove);
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = Math.max(1.6, gap * 0.07);
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 0.32, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 五连高亮
    if (S.winLine) {
      const a = posOf(S.winLine[0]);
      const b = posOf(S.winLine[S.winLine.length - 1]);
      ctx.save();
      ctx.globalAlpha = .85;
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = Math.max(2.5, gap * 0.14);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }

    // 悬停 / 键盘光标预览
    const preview = keyboardMode ? cursorIdx : hoverIdx;
    if (preview >= 0 && !S.board[preview] && !S.over && canIPlay()) {
      const p = posOf(preview);
      ctx.save();
      ctx.globalAlpha = .3;
      drawStone(p.x, p.y, radius, S.myMark, C);
      ctx.restore();
      if (keyboardMode) {
        ctx.strokeStyle = C.accent;
        ctx.lineWidth = 2;
        ctx.strokeRect(p.x - gap / 2 + 1.5, p.y - gap / 2 + 1.5, gap - 3, gap - 3);
      }
    }
  }

  function drawStone(x, y, r, mark, C) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.20)';
    ctx.shadowBlur = r * 0.55;
    ctx.shadowOffsetY = r * 0.18;

    const g = ctx.createRadialGradient(x - r * 0.32, y - r * 0.36, r * 0.12, x, y, r * 1.06);
    if (mark === BLACK) {
      g.addColorStop(0, 'rgba(255,255,255,.26)');
      g.addColorStop(0.38, C.black);
      g.addColorStop(1, C.black);
    } else {
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.72, C.white);
      g.addColorStop(1, C.white);
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(x, y, r - 0.2, 0, Math.PI * 2);
    ctx.strokeStyle = mark === BLACK ? C.blackEdge : C.whiteEdge;
    ctx.lineWidth = Math.max(0.7, r * 0.09);
    ctx.stroke();
  }

  function hitTest(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const scale = geom.size / rect.width;
    const x = (clientX - rect.left) * scale;
    const y = (clientY - rect.top) * scale;
    const col = Math.round((x - geom.pad) / geom.gap);
    const row = Math.round((y - geom.pad) / geom.gap);
    if (row < 0 || row >= N || col < 0 || col >= N) return -1;
    const p = posOf(row * N + col);
    const dist = Math.hypot(p.x - x, p.y - y);
    if (dist > geom.gap * 0.62) return -1;
    return row * N + col;
  }

  /* ============================ 落子 ============================ */

  function canIPlay() {
    return S.mode === 'online' && S.oppOnline && !S.over && S.turn === S.myMark;
  }

  function placeMark(index, mark) {
    S.board[index] = mark;
    S.lastMove = index;

    const result = getResult(S.board, index);
    if (result) { finishRound(result); draw(); return true; }

    S.turn = other(mark);
    draw();
    return false;
  }

  function tryPlay(index) {
    if (S.mode !== 'online') return;
    if (!S.oppOnline) { setStatus('等待对手加入…', 'wait'); return; }
    if (S.over) return;
    if (S.turn !== S.myMark) return;
    if (index < 0 || S.board[index]) return;

    const ended = placeMark(index, S.myMark);
    publish({ t: 'move', i: index, round: S.round });
    if (ended) return;

    setStatus('轮到对方了', 'idle');
    setDetail('你执' + markName(S.myMark) + '，等对方落子。');
  }

  function finishRound(result) {
    S.over = true;
    S.winLine = result.line || null;
    canvas.classList.add('is-over');

    if (result.winner === S.myMark) {
      S.score.me++;
      setStatus('你赢了', 'win');
      setDetail('五子连珠，赢下这局。');
    } else if (result.winner === S.oppMark) {
      S.score.opp++;
      setStatus('对方赢了', 'lose');
      setDetail('对方连成五子。');
    } else {
      S.score.draw++;
      setStatus('平局', 'wait');
      setDetail('棋盘下满，未分胜负。');
    }

    renderScore();
    renderRounds();

    // 打满总局数：本轮对局结束，按钮改成「再来一轮」
    if (S.score.me + S.score.draw + S.score.opp >= S.total) S.matchOver = true;
    S.sentRematch = false;
    S.gotRematch = false;
    rematchBtn.hidden = false;
    rematchBtn.textContent = '再来一局';
    rematchBtn.classList.add('btn--primary');
    rematchBtn.classList.remove('btn--ghost');
    shareBtn.classList.remove('btn--primary');
    shareBtn.classList.add('btn--ghost');

    if (S.mode === 'online' && S.matchOver) {
      rematchBtn.hidden = true;
      showMatchDialog();
      const verdict = S.score.me > S.score.opp ? '你赢下本轮'
        : S.score.me < S.score.opp ? '对方赢下本轮' : '本轮打平';
      setStatus('本轮对局结束', S.score.me > S.score.opp ? 'win' : S.score.me < S.score.opp ? 'lose' : 'wait');
      setDetail('你 ' + S.score.me + ' · 平 ' + S.score.draw + ' · 对方 ' + S.score.opp + '，' + verdict +
        '（共 ' + S.total + ' 局）点「再来一轮」清空比分重新开始。');
    }
    // 局末：主按钮让位给「再来一局」
    draw();
  }

  function resetRound() {
    S.board = Array(TOTAL).fill(null);
    S.turn = BLACK;
    S.over = false;
    S.lastMove = -1;
    S.winLine = null;
    S.sentRematch = false;
    S.gotRematch = false;
    rematchBtn.hidden = true;
    canvas.classList.remove('is-over');
    rematchBtn.classList.remove('btn--primary');
    rematchBtn.classList.add('btn--ghost');
    shareBtn.classList.add('btn--primary');
    shareBtn.classList.remove('btn--ghost');
    assignMarks();
    renderRounds();
    draw();

    if (S.myMark === BLACK) {
      setStatus('轮到你了', 'idle');
      setDetail('你执黑，先手。');
    } else {
      setStatus('等对方落子', 'idle');
      setDetail('你执白，对方先手。');
    }
  }

  function assignMarks() {
    const hostMark = S.round % 2 === 0 ? BLACK : WHITE;
    S.myMark = S.role === 'host' ? hostMark : other(hostMark);
    S.oppMark = other(S.myMark);
  }

  /* ============================ 联机 ============================ */

  function publish(msg) {
    if (!S.client || !S.connected) return;
    msg.f = ME_ID;
    msg.r = S.code;
    try {
      S.client.publish(TOPIC_ROOT + S.code, JSON.stringify(msg), { qos: 0 });
    } catch (err) {}
  }

  function connectBroker(attempt) {
    // mqtt 库以 async 方式加载，先等它一下再判定失败
    if (typeof mqtt === 'undefined') {
      if ((attempt || 0) < 25) {
        setTimeout(function () { connectBroker((attempt || 0) + 1); }, 200);
        return;
      }
      setConn('', '连不上');
      setNotice('无法加载联机库（可能被网络或公司代理拦截）。请检查网络后刷新页面重试。');
      return;
    }
    const url = BROKERS[S.brokerIndex];
    S.brokerTries++;
    setConn('wait', '连接中');

    let settled = false;
    const client = mqtt.connect(url, {
      clientId: 'gmk_' + ME_ID + '_' + S.code,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 3000,
      connectTimeout: 8000
    });
    S.client = client;

    const fallback = setTimeout(() => {
      if (settled) return;
      try { client.end(true); } catch (err) {}
      nextBroker();
    }, 8000);

    client.on('connect', () => {
      settled = true;
      clearTimeout(fallback);
      S.connected = true;
      setConn('wait', '等待中');
      client.subscribe(TOPIC_ROOT + S.code, { qos: 0 });
      publish({ t: 'hello', role: S.role, round: S.round, total: S.total });
      startPing();
      setNotice('');
    });

    client.on('message', (topic, payload) => {
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch (err) { return; }
      handleMessage(msg);
    });

    client.on('error', () => {});
    client.on('close', () => {
      if (S.connected) { S.connected = false; setConn('wait', '重连中…'); }
    });
    client.on('reconnect', () => setConn('wait', '重连中…'));
  }

  function nextBroker() {
    S.brokerIndex = (S.brokerIndex + 1) % BROKERS.length;
    if (S.brokerTries >= BROKERS.length) {
      setConn('', '连不上服务器');
      setNotice('两个公共服务器都连不上，可能是网络限制。稍后刷新页面重试。');
      return;
    }
    connectBroker();
  }

  function startPing() {
    stopPing();
    S.pingTimer = setInterval(() => {
      publish({ t: 'ping' });
      if (S.oppOnline && Date.now() - S.lastSeen > OFFLINE_MS) {
        S.oppOnline = false;
        setConn('wait', '对方离线');
        if (!S.over) setStatus('对方离线了', 'wait');
      }
    }, PING_MS);
  }

  function stopPing() {
    if (S.pingTimer) { clearInterval(S.pingTimer); S.pingTimer = null; }
  }

  function handleMessage(msg) {
    if (!msg || msg.f === ME_ID) return;
    if (msg.r && msg.r !== S.code) return;

    S.lastSeen = Date.now();
    if (!S.oppOnline && msg.t !== 'bye') {
      S.oppOnline = true;
      setConn('on', '在线');
      if (!S.over) {
        if (S.turn === S.myMark) { setStatus('轮到你了', 'idle'); setDetail('你执' + markName(S.myMark) + '，请落子。'); }
        else { setStatus('等对方落子', 'idle'); setDetail('你执' + markName(S.myMark) + '。'); }
      }
    }

    switch (msg.t) {
      case 'hello':
        publish({ t: 'here', role: S.role, round: S.round, total: S.total });
        if (S.board.some(Boolean)) publish({ t: 'state', round: S.round, board: S.board, last: S.lastMove, total: S.total, score: S.score });
        break;

      case 'here':
        if (S.role === 'guest' && msg.total) setTotal(msg.total);
        break;

      case 'state':
        if (msg.round >= S.round && !S.board.some(Boolean) && Array.isArray(msg.board)) {
          if (S.role === 'guest' && msg.total) setTotal(msg.total);
          S.round = msg.round;
          assignMarks();
          S.board = msg.board.slice(0, TOTAL);
          while (S.board.length < TOTAL) S.board.push(null);
          S.lastMove = typeof msg.last === 'number' ? msg.last : -1;
          S.turn = countTurn(S.board);
          const r = getResult(S.board, S.lastMove);
          if (r) { S.over = false; finishRound(r); }
          else {
            draw();
            if (S.turn === S.myMark) { setStatus('轮到你了', 'idle'); setDetail('你执' + markName(S.myMark) + '，棋局已同步。'); }
            else { setStatus('等对方落子', 'idle'); setDetail('你执' + markName(S.myMark) + '，棋局已同步。'); }
          }
        }
        break;

      case 'move':
        if (msg.round !== S.round || S.over) return;
        if (S.turn !== S.oppMark) return;
        if (typeof msg.i !== 'number' || msg.i < 0 || msg.i >= TOTAL || S.board[msg.i]) return;
        {
          const ended = placeMark(msg.i, S.oppMark);
          if (ended) return;
          setStatus('轮到你了', 'idle');
          setDetail('你执' + markName(S.myMark) + '，请落子。');
        }
        break;

      case 'rematch':
        if (msg.round !== S.round) return;
        S.gotRematch = true;
        if (matchDialogEl && !matchDialogEl.hidden && mdAgainEl) {
          mdAgainEl.textContent = '对方想再来一轮 → 同意';
          mdAgainEl.disabled = false;
        }
        if (S.sentRematch) nextRound();
        else {
          rematchBtn.hidden = false;
          rematchBtn.textContent = '对方想再来一局 · 同意';
          setDetail('对方请求再来一局。');
        }
        break;

      case 'bye':
        S.oppOnline = false;
        setConn('wait', '对方已离开');
        break;

      case 'msg':
        if (typeof msg.x !== 'string') return;
        {
          const text = msg.x.replace(/\s+/g, ' ').trim().slice(0, 80);
          if (text) appendChat(text, false);
        }
        break;

      default:
        break;
    }
  }

  function countTurn(board) {
    let b = 0;
    let w = 0;
    for (let i = 0; i < TOTAL; i++) {
      if (board[i] === BLACK) b++;
      else if (board[i] === WHITE) w++;
    }
    return b > w ? WHITE : BLACK;
  }

  function requestRematch() {
    if (!S.over) return;
    S.sentRematch = true;
    publish({ t: 'rematch', round: S.round });
    if (matchDialogEl && !matchDialogEl.hidden && mdAgainEl) {
      mdAgainEl.textContent = '等待对方同意…';
      mdAgainEl.disabled = true;
    }
    rematchBtn.textContent = '等待对方同意…';
    setDetail('已发送「再来一局」请求。');
    if (S.gotRematch) nextRound();
  }

  function nextRound() {
    hideMatchDialog();
    if (S.matchOver) {
      S.matchOver = false;
      S.round = 0;
      S.score = { me: 0, draw: 0, opp: 0 };
      renderScore();
    } else {
      S.round++;
    }
    resetRound();
  }

  /* ============================ 房间 ============================ */

  function roomUrl(code) {
    if (!isPublicUrl()) return '';
    return location.origin + location.pathname + '?r=' + code;
  }

  function copyText(text) {
    if (!text) return Promise.reject(new Error('empty'));
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('copy failed'));
      } catch (err) { reject(err); }
    });
  }

  function showLink(text, fallbackLabel) {
    setNotice('');
    copyText(text).then(
      () => setNotice('已复制：' + text, 'info'),
      () => setNotice(fallbackLabel + '：' + text, 'info')
    );
  }

  function startOnline(code, role) {
    S.mode = 'online';
    S.code = code;
    S.role = role;
    S.round = 0;
    S.score = { me: 0, draw: 0, opp: 0 };
    S.matchOver = false;
    renderScore();
    clearChat();
    updateChatSend();
    var narrow = false;
    try { narrow = window.matchMedia('(max-width: 899px)').matches; } catch (err) {}
    setChatExpanded(!narrow, false);
    updateChatPeek();
    lobbyEl.hidden = true;
    gameEl.hidden = false;
    gameEl.classList.remove('view-in');
    void gameEl.offsetWidth;
    gameEl.classList.add('view-in');
    if (chipEl) chipEl.hidden = false;
    codeEl.textContent = code;
    assignMarks();
    resetRound();
    setStatus('连接中…', 'wait');
    connectBroker();
    requestAnimationFrame(layout);
  }

  /* ============================ 总局数 ============================ */

  let totalChoice = 8;   // 8 | 16 | 32 | custom

  function syncTotalPicker() {
    if (!totalPickEl) return;
    const btns = totalPickEl.querySelectorAll ? totalPickEl.querySelectorAll('.seg-btn') : [];
    Array.prototype.forEach.call(btns, function (b) {
      const on = String(b.dataset.total) === String(totalChoice);
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (totalCustomRowEl) totalCustomRowEl.hidden = totalChoice !== 'custom';
  }

  function readTotal() {
    if (totalChoice === 'custom') {
      let v = parseInt(totalInputEl ? totalInputEl.value : '', 10);
      if (!(v >= 1)) v = 8;
      return Math.min(99, Math.max(1, v));
    }
    return parseInt(totalChoice, 10) || 8;
  }

  // 对手（房主）说了算：房主的总局数会同步过来
  function setTotal(v) {
    const n = parseInt(v, 10);
    if (!(n >= 1)) return;
    S.total = Math.min(99, n);
    renderRounds();
  }

  /* ============================ 结果弹窗 ============================ */

  function matchVerdict() {
    if (S.score.me > S.score.opp) return '你赢下本轮';
    if (S.score.me < S.score.opp) return '对方赢下本轮';
    return '本轮打平';
  }

  function showMatchDialog() {
    if (!matchDialogEl) return;
    if (mdTextEl) {
      mdTextEl.textContent = '你 ' + S.score.me + ' · 平 ' + S.score.draw + ' · 对方 ' + S.score.opp +
        '，' + matchVerdict() + '（共 ' + S.total + ' 局）';
    }
    if (mdAgainEl) { mdAgainEl.textContent = '再来一轮（清空比分）'; mdAgainEl.disabled = false; }
    matchDialogEl.hidden = false;
  }

  function hideMatchDialog() {
    if (matchDialogEl) matchDialogEl.hidden = true;
  }

  function createRoom() {
    S.total = readTotal();
    startOnline(makeCode(), 'host');
    if (isPublicUrl()) {
      try { history.replaceState(null, '', '?r=' + S.code); } catch (err) {}
    }
  }

  function joinRoom(raw) {
    const code = String(raw || '').trim().toUpperCase();
    if (code.length !== 5) { setNotice('房间码是 5 位字母/数字。'); return; }
    startOnline(code, 'guest');
    if (isPublicUrl()) {
      try { history.replaceState(null, '', '?r=' + code); } catch (err) {}
    }
  }

  function leaveRoom() {
    publish({ t: 'bye' });
    stopPing();
    if (S.client) { try { S.client.end(true); } catch (err) {} }
    S.client = null;
    S.connected = false;
    S.oppOnline = false;
    S.mode = 'lobby';
    S.code = '';
    clearChat();
    updateChatSend();
    gameEl.hidden = true;
    lobbyEl.hidden = false;
    if (chipEl) { chipEl.hidden = true; chipEl.classList.remove('is-copied'); }
    setConn('', '离线');
    try { history.replaceState(null, '', location.pathname); } catch (err) {}
  }

  /* ============================ 事件 ============================ */

  function bind() {
    $('create-btn').addEventListener('click', createRoom);
    $('join-btn').addEventListener('click', () => joinRoom($('code-input').value));
    $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom($('code-input').value); });
    $('leave-btn').addEventListener('click', leaveRoom);
    rematchBtn.addEventListener('click', requestRematch);
    if (mdAgainEl) mdAgainEl.addEventListener('click', requestRematch);
    if (mdCloseEl) mdCloseEl.addEventListener('click', function () {
      hideMatchDialog();
      // 关掉弹窗后留一个安静的小按钮，方便再叫一次
      if (S.matchOver && rematchBtn) {
        rematchBtn.hidden = false;
        rematchBtn.textContent = '再来一轮';
        rematchBtn.classList.remove('btn--primary');
        rematchBtn.classList.add('btn--quiet');
      }
    });
    if (mdScrimEl) mdScrimEl.addEventListener('click', function () { if (mdCloseEl) mdCloseEl.click(); });
    if (totalPickEl) {
      totalPickEl.addEventListener('click', function (e) {
        let btn = e.target;
        while (btn && btn !== totalPickEl && !(btn.classList && btn.classList.contains('seg-btn'))) btn = btn.parentNode;
        if (!btn || btn === totalPickEl) return;
        const raw = btn.dataset.total;
        totalChoice = raw === 'custom' ? 'custom' : parseInt(raw, 10);
        syncTotalPicker();
        if (totalChoice === 'custom' && totalInputEl) { try { totalInputEl.focus(); } catch (err) {} }
      });
    }
    syncTotalPicker();

    if (chipEl) {
      chipEl.addEventListener('click', () => {
        shareBtn.click();
        chipEl.classList.add('is-copied');
        setTimeout(() => chipEl.classList.remove('is-copied'), 1400);
      });
    }
    if (chatInputEl) chatInputEl.addEventListener('input', updateChatSend);
    if (chatListEl) chatListEl.addEventListener('scroll', syncChatScroll, { passive: true });
    if (chatToggleEl) chatToggleEl.addEventListener('click', function () { setChatExpanded(!chatExpanded, true); });
    if (chatFormEl) {
      chatFormEl.addEventListener('submit', (e) => {
        e.preventDefault();
        sendChat(chatInputEl.value);
        chatInputEl.value = '';
        updateChatSend();
        chatInputEl.focus();
      });
    }
    updateChatSend();

    shareBtn.addEventListener('click', () => {
      const url = roomUrl(S.code);
      if (url) {
        showLink(url, '把这个链接发给对方');
      } else {
        copyText(S.code).then(
          () => setNotice('已复制房间码 ' + S.code + '。但你现在用的是本机地址，对方打不开 —— 请用公网地址打开本页。', 'warn'),
          () => setNotice('房间码是 ' + S.code + '，但本机地址对方打不开。', 'warn')
        );
      }
    });

    canvas.addEventListener('click', (e) => {
      const idx = hitTest(e.clientX, e.clientY);
      if (idx >= 0) tryPlay(idx);
    });

    canvas.addEventListener('mousemove', (e) => {
      if (keyboardMode) { keyboardMode = false; }
      const idx = hitTest(e.clientX, e.clientY);
      if (idx !== hoverIdx) { hoverIdx = idx; draw(); }
    });

    canvas.addEventListener('mouseleave', () => {
      if (hoverIdx !== -1) { hoverIdx = -1; draw(); }
    });

    canvas.addEventListener('keydown', (e) => {
      const key = e.key;
      const row = Math.floor(cursorIdx / N);
      const col = cursorIdx % N;
      let nr = row;
      let nc = col;

      if (key === 'ArrowUp') nr = Math.max(0, row - 1);
      else if (key === 'ArrowDown') nr = Math.min(N - 1, row + 1);
      else if (key === 'ArrowLeft') nc = Math.max(0, col - 1);
      else if (key === 'ArrowRight') nc = Math.min(N - 1, col + 1);
      else if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        keyboardMode = true;
        tryPlay(cursorIdx);
        draw();
        return;
      } else return;

      e.preventDefault();
      keyboardMode = true;
      cursorIdx = nr * N + nc;
      canvas.setAttribute('aria-label',
        '五子棋棋盘，当前选中第 ' + (nr + 1) + ' 行第 ' + (nc + 1) + ' 列，' +
        (S.board[cursorIdx] ? markName(S.board[cursorIdx]) + '棋' : '空') + '。回车落子。');
      draw();
    });

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => layout());
      ro.observe(canvas);
    } else {
      window.addEventListener('resize', layout);
    }
  }

  /* ============================ 启动 ============================ */

  function boot() {
    bind();
    layout();

    const params = new URLSearchParams(location.search);
    const room = (params.get('r') || '').toUpperCase();

    if (room && room.length === 5) {
      joinRoom(room);
      return;
    }
    lobbyEl.hidden = false;
    gameEl.hidden = true;

    if (!isPublicUrl()) {
      const warn = $('local-warn');
      warn.hidden = false;
      warn.dataset.kind = 'warn';
      warn.textContent = location.protocol === 'file:'
        ? '你现在是双击本地文件打开的 —— 链接发出去对方打不开。要联机，请用公网地址打开本页。'
        : '你现在用的是本机地址 localhost —— 复制的链接对方打不开。要联机，请用公网地址打开本页。';
    }
  }

  document.addEventListener('themechange', function () { requestAnimationFrame(function () { layout(); }); });

  window.__gmk = {
    S, startOnline, joinRoom, createRoom, handleMessage, getResult, winLineAt,
    tryPlay, requestRematch, assignMarks, layout, hitTest, geomOf: () => geom, TOTAL, N,
    sendChat, appendChat, clearChat, renderRounds
  };

  boot();
})();
