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
  }

  function setDetail(html) { detailEl.innerHTML = html; }

  function setNotice(text, kind) {
    if (text) {
      noticeEl.textContent = text;
      noticeEl.dataset.kind = kind || 'warn';
      noticeEl.hidden = false;
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
    scoreEls.me.textContent = S.score.me;
    scoreEls.draw.textContent = S.score.draw;
    scoreEls.opp.textContent = S.score.opp;
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
    S.sentRematch = false;
    S.gotRematch = false;
    rematchBtn.hidden = false;
    rematchBtn.textContent = '再来一局';
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
    assignMarks();
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

  function connectBroker() {
    if (typeof mqtt === 'undefined') {
      setConn('', '连接库加载失败');
      setNotice('无法加载联机库（可能被网络或代理拦截）。');
      return;
    }
    const url = BROKERS[S.brokerIndex];
    S.brokerTries++;
    setConn('wait', '连接中…');

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
      setConn('wait', '等待对手…');
      client.subscribe(TOPIC_ROOT + S.code, { qos: 0 });
      publish({ t: 'hello', role: S.role, round: S.round });
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
      setConn('on', '对方在线');
      if (!S.over) {
        if (S.turn === S.myMark) { setStatus('轮到你了', 'idle'); setDetail('你执' + markName(S.myMark) + '，请落子。'); }
        else { setStatus('等对方落子', 'idle'); setDetail('你执' + markName(S.myMark) + '。'); }
      }
    }

    switch (msg.t) {
      case 'hello':
        publish({ t: 'here', role: S.role, round: S.round });
        if (S.board.some(Boolean)) publish({ t: 'state', round: S.round, board: S.board, last: S.lastMove });
        break;

      case 'here':
        break;

      case 'state':
        if (msg.round >= S.round && !S.board.some(Boolean) && Array.isArray(msg.board)) {
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
    rematchBtn.textContent = '等待对方同意…';
    setDetail('已发送「再来一局」请求。');
    if (S.gotRematch) nextRound();
  }

  function nextRound() {
    S.round++;
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
    lobbyEl.hidden = true;
    gameEl.hidden = false;
    codeEl.textContent = code;
    assignMarks();
    resetRound();
    setStatus('连接中…', 'wait');
    connectBroker();
    requestAnimationFrame(layout);
  }

  function createRoom() {
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
    gameEl.hidden = true;
    lobbyEl.hidden = false;
    setConn('', '未连接');
    try { history.replaceState(null, '', location.pathname); } catch (err) {}
  }

  /* ============================ 事件 ============================ */

  function bind() {
    $('create-btn').addEventListener('click', createRoom);
    $('join-btn').addEventListener('click', () => joinRoom($('code-input').value));
    $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom($('code-input').value); });
    $('leave-btn').addEventListener('click', leaveRoom);
    rematchBtn.addEventListener('click', requestRematch);

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
    tryPlay, requestRematch, assignMarks, layout, hitTest, geomOf: () => geom, TOTAL, N
  };

  boot();
})();
