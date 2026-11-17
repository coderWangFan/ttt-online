(() => {
  'use strict';

  /* ============================ 常量 ============================ */

  const WIN_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉易混的 I O 0 1
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];
  const TOPIC_ROOT = 'goose/ttt/v1/';
  const ME_ID = 'p' + Math.random().toString(36).slice(2, 10);
  const PING_MS = 5000;
  const OFFLINE_MS = 13000;

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
  const boardEl = $('board');
  const statusEl = $('status');
  const detailEl = $('detail');
  const codeEl = $('show-code');
  const dotEl = $('dot');
  const connTextEl = $('conn-text');
  const noticeEl = $('notice');
  const rematchBtn = $('rematch-btn');
  const shareBtn = $('share-btn');
  const modeLabelEl = $('mode-label');
  const hintEl = $('hint');
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
    mode: 'lobby',        // 'lobby' | 'online' | 'relay'
    code: '',
    role: '',             // 'host' | 'guest'
    round: 0,
    myMark: 'X',
    oppMark: 'O',
    board: Array(9).fill(null),
    turn: 'X',
    over: false,
    overReason: '',
    score: { me: 0, draw: 0, opp: 0 },
    oppOnline: false,
    lastSeen: 0,
    sentRematch: false,
    gotRematch: false,
    total: 8,
    matchOver: false,
    cells: [],
    chat: [],
    client: null,
    pingTimer: null,
    brokerIndex: 0,
    brokerTries: 0,
    connected: false
  };

  /* ============================ 工具 ============================ */

  const other = (m) => (m === 'X' ? 'O' : 'X');

  function makeCode() {
    let s = '';
    for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return s;
  }

  function markSVG(mark) {
    return mark === 'X'
      ? '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
          '<path d="M26 26 L74 74"/><path d="M74 26 L26 74"/></svg>'
      : '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
          '<circle cx="50" cy="50" r="26"/></svg>';
  }

  function cellLabel(i, mark) {
    return '第 ' + (Math.floor(i / 3) + 1) + ' 行第 ' + (i % 3 + 1) + ' 列，' + (mark || '空');
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
    void el.offsetWidth;          // 强制重排，动画可重播
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
    if (S.mode === 'relay') { setNotice('接力模式下不能发消息，回到联机房间再聊。'); return; }
    if (!S.client || !S.connected) { setNotice('还没连上对方，稍等一下再发。'); return; }
    appendChat(text, true);
    publish({ t: 'msg', x: text, round: S.round });
  }

  /* ============================ 规则 ============================ */

  function getResult(board) {
    for (let i = 0; i < WIN_LINES.length; i++) {
      const l = WIN_LINES[i];
      const a = board[l[0]];
      if (a && a === board[l[1]] && a === board[l[2]]) {
        return { winner: a, line: l, reason: 'win' };
      }
    }
    let full = true;
    for (let i = 0; i < board.length; i++) if (!board[i]) { full = false; break; }
    if (full) return { winner: null, line: null, reason: 'full' };
    if (isDead(board)) return { winner: null, line: null, reason: 'dead' };
    return null;
  }

  function isDead(board) {
    for (let i = 0; i < WIN_LINES.length; i++) {
      const l = WIN_LINES[i];
      let hasX = false;
      let hasO = false;
      for (let k = 0; k < 3; k++) {
        const v = board[l[k]];
        if (v === 'X') hasX = true;
        else if (v === 'O') hasO = true;
      }
      if (!(hasX && hasO)) return false;
    }
    return true;
  }

  function turnFromBoard(board) {
    let x = 0;
    let o = 0;
    for (let i = 0; i < board.length; i++) {
      if (board[i] === 'X') x++;
      else if (board[i] === 'O') o++;
    }
    return x > o ? 'O' : 'X';
  }

  /* ============================ 棋盘渲染 ============================ */

  function buildBoard() {
    boardEl.textContent = '';
    S.cells = [];
    for (let i = 0; i < 9; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cell';
      btn.dataset.index = String(i);
      btn.setAttribute('aria-label', cellLabel(i, null));
      btn.addEventListener('click', () => onCellClick(i));
      btn.addEventListener('keydown', onCellKeydown);
      boardEl.appendChild(btn);
      S.cells.push(btn);
    }
  }

  function onCellKeydown(event) {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'];
    if (keys.indexOf(event.key) === -1) return;
    event.preventDefault();
    const i = Number(event.currentTarget.dataset.index);
    let row = Math.floor(i / 3);
    let col = i % 3;
    if (event.key === 'ArrowRight') col = (col + 1) % 3;
    if (event.key === 'ArrowLeft') col = (col + 2) % 3;
    if (event.key === 'ArrowDown') row = (row + 1) % 3;
    if (event.key === 'ArrowUp') row = (row + 2) % 3;
    S.cells[row * 3 + col].focus();
  }

  function paintCell(i, mark) {
    const cell = S.cells[i];
    cell.classList.add('filled', mark === 'X' ? 'x' : 'o');
    cell.innerHTML = markSVG(mark);
    cell.setAttribute('aria-disabled', 'true');
    cell.setAttribute('aria-label', cellLabel(i, mark));
  }

  function clearBoard() {
    boardEl.classList.remove('is-over');
    S.cells.forEach((cell, i) => {
      cell.className = 'cell';
      cell.style.animationDelay = '';
      cell.innerHTML = '';
      cell.removeAttribute('aria-disabled');
      cell.setAttribute('aria-label', cellLabel(i, null));
    });
  }

  function renderFullBoard(board) {
    clearBoard();
    for (let i = 0; i < 9; i++) if (board[i]) paintCell(i, board[i]);
    S.board = board.slice();
    S.turn = turnFromBoard(S.board);
  }

  /* ============================ 走子 ============================ */

  // 返回 true 表示本步结束了对局
  function placeMark(index, mark) {
    S.board[index] = mark;
    paintCell(index, mark);

    const result = getResult(S.board);
    if (result) { finishRound(result); return true; }
    S.turn = other(mark);
    return false;
  }

  function onCellClick(index) {
    if (S.mode === 'relay') { relayMove(index); return; }
    if (S.mode !== 'online') return;
    if (!S.oppOnline) { setStatus('等待对手加入…', 'wait'); return; }
    if (S.over) return;
    if (S.turn !== S.myMark) return;
    if (S.board[index]) return;

    const ended = placeMark(index, S.myMark);
    publish({ t: 'move', i: index, round: S.round });
    if (ended) return;

    setStatus('轮到对方了', 'idle');
    setDetail('你执 ' + S.myMark + '，等对方落子。');
  }

  function finishRound(result) {
    S.over = true;
    S.overReason = result.reason;
    boardEl.classList.add('is-over');

    if (result.winner === S.myMark) {
      S.score.me++;
      setStatus('你赢了', 'win');
      setDetail('三连成功。');
    } else if (result.winner === S.oppMark) {
      S.score.opp++;
      setStatus('对方赢了', 'lose');
      setDetail('这局被对方拿下。');
    } else if (result.reason === 'dead') {
      S.score.draw++;
      setStatus('死局', 'wait');
      setDetail('已无任何可能的三连线，判定平局。');
    } else {
      S.score.draw++;
      setStatus('平局', 'wait');
      setDetail('棋盘已满，平局。');
    }

    if (result.line) {
      result.line.forEach((idx, order) => {
        const cell = S.cells[idx];
        cell.classList.add('win');
        cell.style.animationDelay = (order * 70) + 'ms';
      });
    }

    renderScore();
    renderRounds();

    // 打满总局数：本轮对局结束，按钮改成「再来一轮」
    if (S.score.me + S.score.draw + S.score.opp >= S.total) S.matchOver = true;

    if (S.mode === 'online') {
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
    } else {
      updateRelayUi();
    }
  }

  function resetRound() {
    S.board = Array(9).fill(null);
    S.turn = 'X';
    S.over = false;
    S.overReason = '';
    S.sentRematch = false;
    S.gotRematch = false;
    rematchBtn.hidden = true;
    clearBoard();
    rematchBtn.classList.remove('btn--primary');
    rematchBtn.classList.add('btn--ghost');
    shareBtn.classList.add('btn--primary');
    shareBtn.classList.remove('btn--ghost');
    assignMarks();
    renderRounds();

    if (S.mode === 'online') {
      if (S.myMark === 'X') {
        setStatus('轮到你了', 'idle');
        setDetail('你执 X，请落子。');
      } else {
        setStatus('等对方落子', 'idle');
        setDetail('你执 O，对方先手。');
      }
    } else {
      updateRelayUi();
    }
  }

  // 局数决定先手：偶数局房主执 X，奇数局交换
  function assignMarks() {
    if (S.mode === 'relay') {
      S.myMark = S.turn;
      S.oppMark = other(S.turn);
      return;
    }
    const hostMark = S.round % 2 === 0 ? 'X' : 'O';
    S.myMark = S.role === 'host' ? hostMark : other(hostMark);
    S.oppMark = other(S.myMark);
  }

  /* ============================ 联机：MQTT ============================ */

  function publish(msg) {
    if (!S.client || !S.connected) return;
    msg.f = ME_ID;
    msg.r = S.code;
    try {
      S.client.publish(TOPIC_ROOT + S.code, JSON.stringify(msg), { qos: 0 });
    } catch (err) { /* 忽略瞬时失败 */ }
  }

  function connectBroker(attempt) {
    // mqtt 库以 async 方式加载，先等它一下再判定失败
    if (typeof mqtt === 'undefined') {
      if ((attempt || 0) < 25) {
        setTimeout(function () { connectBroker((attempt || 0) + 1); }, 200);
        return;
      }
      setConn('', '连不上');
      setNotice('无法加载联机库（可能网络或公司代理拦截）。可以改用「链接接力」模式：下完一手把链接发对方。');
      return;
    }

    const url = BROKERS[S.brokerIndex];
    S.brokerTries++;
    setConn('wait', '连接中');

    let settled = false;
    const client = mqtt.connect(url, {
      clientId: 'ttt_' + ME_ID + '_' + S.code,
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

    client.on('error', () => { /* mqtt.js 会自动重连 */ });

    client.on('close', () => {
      if (S.connected) {
        S.connected = false;
        setConn('wait', '重连中…');
      }
    });

    client.on('reconnect', () => setConn('wait', '重连中…'));
  }

  function nextBroker() {
    S.brokerIndex = (S.brokerIndex + 1) % BROKERS.length;
    if (S.brokerTries >= BROKERS.length) {
      setConn('', '连不上服务器');
      setNotice('两个公共服务器都连不上，可能是网络限制。可改用「链接接力」：每走一手把当前链接发给对方。');
      enableRelayFallback();
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
        if (!S.over && S.mode === 'online') setStatus('对方离线了', 'wait');
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
        if (S.mode === 'relay') return;
        if (S.turn === S.myMark) { setStatus('轮到你了', 'idle'); setDetail('你执 ' + S.myMark + '，请落子。'); }
        else { setStatus('等对方落子', 'idle'); setDetail('你执 ' + S.myMark + '。'); }
      }
    }

    switch (msg.t) {
      case 'hello':
        publish({ t: 'here', role: S.role, round: S.round, total: S.total });
        if (S.board.some(Boolean)) publish({ t: 'state', round: S.round, board: S.board, total: S.total, score: S.score });
        break;

      case 'here':
        if (S.role === 'guest' && msg.total) setTotal(msg.total);
        break;

      case 'state':
        if (msg.round >= S.round && !S.board.some(Boolean) && Array.isArray(msg.board)) {
          if (S.role === 'guest' && msg.total) setTotal(msg.total);
          S.round = msg.round;
          assignMarks();
          renderFullBoard(msg.board);
          const r = getResult(S.board);
          if (r) finishRound(r);
          else if (S.turn === S.myMark) { setStatus('轮到你了', 'idle'); setDetail('你执 ' + S.myMark + '，棋局已同步。'); }
          else { setStatus('等对方落子', 'idle'); setDetail('你执 ' + S.myMark + '，棋局已同步。'); }
        }
        break;

      case 'move':
        if (msg.round !== S.round || S.over) return;
        if (S.turn !== S.oppMark) return;          // 不该对方走
        if (S.board[msg.i] || typeof msg.i !== 'number') return;
        {
          const ended = placeMark(msg.i, S.oppMark);
          if (ended) return;
          setStatus('轮到你了', 'idle');
          setDetail('你执 ' + S.myMark + '，请落子。');
        }
        break;

      case 'rematch':
        if (msg.round !== S.round) return;
        S.gotRematch = true;
        if (matchDialogEl && !matchDialogEl.hidden && mdAgainEl) {
          mdAgainEl.textContent = '对方想再来一轮 → 同意';
          mdAgainEl.disabled = false;
        }
        if (S.sentRematch) { nextRound(); }
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

  function requestRematch() {
    if (!S.over || S.mode !== 'online') return;
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

  /* ============================ 链接接力模式 ============================ */

  function encodeBoard(board) {
    let s = '';
    for (let i = 0; i < 9; i++) s += board[i] || '-';
    return s;
  }

  function decodeBoard(str) {
    if (typeof str !== 'string' || str.length !== 9) return null;
    const out = Array(9).fill(null);
    for (let i = 0; i < 9; i++) {
      const c = str[i];
      if (c === '-') continue;
      if (c !== 'X' && c !== 'O') return null;
      out[i] = c;
    }
    return out;
  }

  function startRelay(board) {
    S.mode = 'relay';
    modeLabelEl.textContent = '接力';
    lobbyEl.hidden = true;
    gameEl.hidden = false;
    document.getElementById('scoreboard').hidden = true;
    rematchBtn.hidden = true;
    if (chatEl) chatEl.hidden = true;
    shareBtn.textContent = '复制链接给对方';
    if (hintEl) hintEl.textContent = '接力模式：你走一手 → 复制链接发给对方 → 他打开走一手 → 再发回来。';

    renderFullBoard(board);
    const r = getResult(S.board);
    if (r) finishRound(r);
    else {
      S.myMark = S.turn;
      S.oppMark = other(S.turn);
      setStatus('轮到你（' + S.myMark + '）', 'idle');
      updateRelayUi();
    }
    setConn('', '接力');
  }

  function relayMove(index) {
    if (S.over) return;
    if (S.board[index]) return;
    const ended = placeMark(index, S.myMark);
    if (!ended) {
      S.myMark = S.turn;
      S.oppMark = other(S.turn);
    }
    updateRelayUi();
    if (ended) return;
  }

  function updateRelayUi() {
    const code = encodeBoard(S.board);
    const isFile = location.protocol === 'file:';
    const link = isFile ? '' : location.origin + location.pathname + '?m=' + code;
    try { history.replaceState(null, '', '?m=' + code); } catch (err) {}

    if (S.over) {
      setDetail('本局结束。点「新的一局」重新开始。');
      shareBtn.textContent = '新的一局';
      shareBtn.dataset.action = 'restart';
    } else {
      setDetail('当前局面 <span class="room-code">' + code + '</span> · 你执 ' + S.myMark +
        (isFile ? '（本地打开时请把文件和局面码一起发给对方）' : '，走完把链接发给对方。'));
      shareBtn.textContent = isFile ? '复制局面码' : '复制链接给对方';
      shareBtn.dataset.action = 'share';
    }
    shareBtn.dataset.link = link || code;
  }

  /* ============================ 房间 / 分享 ============================ */

  function roomUrl(code) {
    if (!isPublicUrl()) return '';
    return location.origin + location.pathname + '?r=' + code;
  }

  // 只有真正的公网地址才能发给别人；localhost / file:// 只能自己看
  function isPublicUrl() {
    if (location.protocol === 'file:') return false;
    const h = location.hostname || '';
    return !(h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]' || h === '::1');
  }

  function copyText(text) {
    if (!text) return Promise.reject(new Error('empty'));
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
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

  function enterGame() {
    lobbyEl.hidden = true;
    gameEl.hidden = false;
    gameEl.classList.remove('view-in');
    void gameEl.offsetWidth;
    gameEl.classList.add('view-in');
    if (chipEl) chipEl.hidden = false;
    if (chatEl) chatEl.hidden = false;
    codeEl.textContent = S.code;
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
    assignMarks();
    enterGame();
    resetRound();
    setStatus('连接中…', 'wait');
    connectBroker();
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
    if (location.protocol !== 'file:') {
      try { history.replaceState(null, '', '?r=' + S.code); } catch (err) {}
    }
  }

  function joinRoom(raw) {
    const code = String(raw || '').trim().toUpperCase();
    if (code.length !== 5) { setNotice('房间码是 5 位字母/数字。'); return; }
    startOnline(code, 'guest');
    if (location.protocol !== 'file:') {
      try { history.replaceState(null, '', '?r=' + code); } catch (err) {}
    }
  }

  function enableRelayFallback() {
    shareBtn.textContent = '改用接力模式';
    shareBtn.dataset.action = 'relay';
    shareBtn.dataset.link = '';
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
    modeLabelEl.textContent = '联机';
    setConn('', '离线');
    setStatus('等待对手…', 'idle');
    try { history.replaceState(null, '', location.pathname); } catch (err) {}
  }

  /* ============================ 事件绑定 ============================ */

  function bind() {
    $('create-btn').addEventListener('click', createRoom);
    $('join-btn').addEventListener('click', () => joinRoom($('code-input').value));
    $('code-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinRoom($('code-input').value);
    });
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
      const action = shareBtn.dataset.action || 'share';
      if (action === 'relay') {
        startRelay(S.board);
        return;
      }
      if (action === 'restart') {
        S.round++;
        resetRound();
        shareBtn.dataset.action = 'share';
        S.mode = 'relay';
        updateRelayUi();
        return;
      }
      if (S.mode === 'relay') { showLink(shareBtn.dataset.link, '手动复制这个链接'); return; }

      const url = roomUrl(S.code);
      if (url) {
        showLink(url, '把这个链接发给对方');
      } else {
        copyText(S.code).then(
          () => setNotice('已复制房间码 ' + S.code + '。但你现在用的是本机地址（localhost / 文件），对方打不开这个页面 —— 请先用公网地址（部署到 Pages 或隧道）打开本页，再创建房间。', 'warn'),
          () => setNotice('房间码是 ' + S.code + '，但本机地址对方打不开。请先部署到公网再用。', 'warn')
        );
      }
    });
  }

  /* ============================ 启动 ============================ */

  function boot() {
    buildBoard();
    bind();

    const params = new URLSearchParams(location.search);
    const relay = params.get('m');
    const room = (params.get('r') || '').toUpperCase();

    if (relay) {
      const board = decodeBoard(relay);
      if (board) { startRelay(board); return; }
    }
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
        ? '你现在是双击本地文件打开的 —— 只能自己玩，链接发出去对方打不开。要联机，请用公网地址打开本页。'
        : '你现在用的是本机地址 localhost —— 复制的链接对方打不开。要联机，请用公网地址（部署到 Pages 或开隧道）打开本页。';
    }
  }

  // 供无头测试使用（浏览器里无副作用）
  window.__ttt = { S, startOnline, joinRoom, createRoom, handleMessage, getResult, encodeBoard, decodeBoard, assignMarks, onCellClick, requestRematch, placeMark, sendChat, appendChat, clearChat, renderRounds };

  boot();
})();
