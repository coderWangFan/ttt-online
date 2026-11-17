(() => {
  'use strict';

  /* ============================ 常量 ============================ */

  const X = window.Xiangqi;
  const TOTAL = X.SIZE;

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];
  const TOPIC_ROOT = 'goose/xq/v1/';
  const ME_ID = 'x' + Math.random().toString(36).slice(2, 10);
  const PING_MS = 5000;
  const OFFLINE_MS = 13000;

  const RED = X.RED;
  const BLACK = X.BLACK;

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
  const piecesEl = $('xq-pieces');
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
    mySide: RED,
    oppSide: BLACK,
    board: X.parseFen(X.START_FEN).board,
    turn: RED,
    over: false,
    last: null,              // { from, to }
    sel: -1,                 // 选中的格子
    targets: [],             // 当前可走到的格子
    movesMade: 0,
    rep: {},                 // 三次重复局面计数
    score: { me: 0, draw: 0, opp: 0 },
    oppOnline: false,
    lastSeen: 0,
    sentRematch: false,
    gotRematch: false,
    total: 4,
    matchOver: false,
    chat: [],
    client: null,
    connected: false,
    pingTimer: null,
    brokerIndex: 0,
    brokerTries: 0
  };

  let pieceSeq = 0;
  const pieceEls = new Map();   // id -> { el, ch, idx }
  let squareId = new Array(TOTAL).fill(0);  // 格子上棋子的 id（用于走子动画）

  /* ============================ 工具 ============================ */

  const other = (s) => (s === RED ? BLACK : RED);
  const sideName = X.sideName;
  const sideTone = (s) => (s === RED ? 'is-red' : 'is-black');

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

  function setNotice(text, kind, ms) {
    if (!noticeEl) return;
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = 0; }
    if (text) {
      noticeEl.textContent = text;
      noticeEl.dataset.kind = kind || 'warn';
      noticeEl.hidden = false;
      noticeTimer = setTimeout(function () { noticeEl.hidden = true; noticeTimer = 0; }, ms || 5200);
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

  function renderRounds() {
    const done = String(S.score.me + S.score.draw + S.score.opp);
    const total = String(S.total || 4);
    if (roundDoneEl && roundDoneEl.textContent !== done) { roundDoneEl.textContent = done; bump(roundDoneEl); }
    if (roundNowEl && roundNowEl.textContent !== total) { roundNowEl.textContent = total; bump(roundNowEl); }
    if (roundDoneEl) roundDoneEl.hidden = false;
    if (roundSlashEl) roundSlashEl.hidden = false;
  }

  const nameOfRole = (role) => (role === 'host' ? '玩家一' : '玩家二');
  const myName = () => nameOfRole(S.role);
  const oppName = () => nameOfRole(S.role === 'host' ? 'guest' : 'host');

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

  function updateChatPeek() {
    if (!chatPeekEl) return;
    const last = S.chat[S.chat.length - 1];
    if (!last) { chatPeekEl.textContent = '还没有消息'; return; }
    chatPeekEl.textContent = (last.own ? '你' : oppName()) + '：' + last.text;
  }

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
    /* 只用剩下的空间：宁可矮一点，也不要压住棋盘最后一排 */
    var h = Math.max(96, Math.min(320, free));
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

  /* ============================ 棋盘渲染 ============================ */

  function layout() {
    if (!boardEl || !boardEl.style) return;
    const w = boardEl.clientWidth || 0;
    const cell = w > 0 ? w / 9 : 40;
    boardEl.style.setProperty('--xq-cell', cell + 'px');
  }

  function placeEl(el, idx) {
    el.style.left = 'calc(var(--xq-cell) * ' + (0.5 + X.xOf(idx)) + ')';
    el.style.top = 'calc(var(--xq-cell) * ' + (0.5 + X.yOf(idx)) + ')';
  }

  function isKingOfSide(ch, side) {
    return !!ch && ch.toUpperCase() === 'K' && X.sideOf(ch) === side;
  }

  function checkedSquare() {
    if (S.over) return -1;
    if (!X.inCheck(S.board, S.turn)) return -1;
    return X.findKing(S.board, S.turn);
  }

  /* 全量重建棋子（换局、同步局面时用） */
  function rebuildPieces() {
    piecesEl.innerHTML = '';
    pieceEls.clear();
    squareId = new Array(TOTAL).fill(0);
    const checkIdx = checkedSquare();
    for (let i = 0; i < TOTAL; i++) {
      const ch = S.board[i];
      if (!ch) continue;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'xq-piece ' + sideTone(X.sideOf(ch));
      el.dataset.idx = String(i);
      el.innerHTML = '<span class="xq-glyph">' + X.pieceName(ch) + '</span>';
      el.setAttribute('aria-label', sideName(X.sideOf(ch)) + '方' + X.pieceName(ch));
      if (i === checkIdx) el.classList.add('is-check');
      placeEl(el, i);
      piecesEl.appendChild(el);
      const id = ++pieceSeq;
      pieceEls.set(id, { el: el, ch: ch, idx: i });
      squareId[i] = id;
    }
  }

  /* 增量同步（走子后调用：同一个 id 换了位置就靠 CSS 过渡滑过去） */
  function syncPieces() {
    const checkIdx = checkedSquare();
    const live = new Set();
    for (let i = 0; i < TOTAL; i++) {
      const ch = S.board[i];
      if (!ch) continue;
      let id = squareId[i];
      let rec = id ? pieceEls.get(id) : null;
      if (!rec || rec.ch !== ch) {
        /* 这一格没登记过（例如刚同步来的局面）→ 就地补一个 */
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'xq-piece ' + sideTone(X.sideOf(ch));
        el.dataset.idx = String(i);
        el.innerHTML = '<span class="xq-glyph">' + X.pieceName(ch) + '</span>';
        el.setAttribute('aria-label', sideName(X.sideOf(ch)) + '方' + X.pieceName(ch));
        placeEl(el, i);
        piecesEl.appendChild(el);
        id = ++pieceSeq;
        rec = { el: el, ch: ch, idx: i };
        pieceEls.set(id, rec);
        squareId[i] = id;
      }
      rec.idx = i;
      rec.el.dataset.idx = String(i);
      rec.el.classList.toggle('is-check', i === checkIdx);
      placeEl(rec.el, i);
      live.add(id);
    }
    /* 被吃掉的子：淡出后移除 */
    pieceEls.forEach((rec, id) => {
      if (live.has(id)) return;
      if (rec.el && rec.el.parentNode) {
        rec.el.classList.add('is-captured');
        const el = rec.el;
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
      }
      pieceEls.delete(id);
    });
  }

  function renderTargets() {
    const old = piecesEl.querySelectorAll ? piecesEl.querySelectorAll('.xq-dot') : [];
    for (let i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    if (!S.targets.length) return;
    S.targets.forEach((idx) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'xq-dot' + (S.board[idx] ? ' is-capture' : '');
      el.dataset.idx = String(idx);
      el.setAttribute('aria-label', '走到第 ' + (X.yOf(idx) + 1) + ' 行第 ' + (X.xOf(idx) + 1) + ' 列');
      placeEl(el, idx);
      piecesEl.appendChild(el);
    });
  }

  function renderMarks() {
    const old = piecesEl.querySelectorAll ? piecesEl.querySelectorAll('.xq-mark') : [];
    for (let i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    if (!S.last) return;
    [['is-from', S.last.from], ['is-to', S.last.to]].forEach(([cls, idx]) => {
      if (typeof idx !== 'number' || idx < 0) return;
      const el = document.createElement('span');
      el.className = 'xq-mark ' + cls;
      el.setAttribute('aria-hidden', 'true');
      placeEl(el, idx);
      piecesEl.appendChild(el);
    });
  }

  function renderSelection() {
    if (!piecesEl.querySelectorAll) return;
    const nodes = piecesEl.querySelectorAll('.xq-piece');
    for (let i = 0; i < nodes.length; i++) {
      const idx = Number(nodes[i].dataset.idx);
      nodes[i].classList.toggle('is-selected', idx === S.sel);
    }
  }

  function draw(rebuild) {
    if (rebuild) rebuildPieces(); else syncPieces();
    renderMarks();
    renderTargets();
    renderSelection();
  }

  /* ============================ 走棋 ============================ */

  function canIPlay() {
    return S.mode === 'online' && S.oppOnline && !S.over && S.turn === S.mySide;
  }

  function clearSelection() {
    S.sel = -1;
    S.targets = [];
  }

  function selectAt(idx) {
    const ch = S.board[idx];
    if (!ch || X.sideOf(ch) !== S.mySide) { clearSelection(); return false; }
    S.sel = idx;
    S.targets = X.legalMovesFrom(S.board, S.mySide, idx).map((m) => m.to);
    return true;
  }

  function repKey() { return X.boardToString(S.board) + '|' + S.turn; }

  function reasonText(reason, loserIsMe) {
    if (reason === 'checkmate') return loserIsMe ? '你被将死了。' : '将死对方，绝杀。';
    if (reason === 'stalemate') return loserIsMe ? '你没有合法走法（困毙）。' : '对方没有合法走法（困毙）。';
    if (reason === 'repetition') return '同一局面出现三次，判和。';
    return '';
  }

  function movePiece(from, to) {
    /* 让「棋子身份」跟着走，CSS 过渡才有动画 */
    squareId[to] = squareId[from];
    squareId[from] = 0;
    X.applyMove(S.board, from, to);
    S.last = { from: from, to: to };
    S.movesMade++;
    clearSelection();
  }

  function play(from, to, side) {
    if (!X.isLegal(S.board, side, from, to)) return false;
    movePiece(from, to);
    S.turn = X.enemyOf(side);

    /* 三次重复局面判和 */
    const key = repKey();
    S.rep[key] = (S.rep[key] || 0) + 1;
    const repeated = S.rep[key] >= 3;

    const st = X.status(S.board, S.turn);
    draw(false);

    if (st.over) {
      finishRound({ winner: side, reason: st.reason });
      return true;
    }
    if (repeated) {
      finishRound({ winner: null, reason: 'repetition' });
      return true;
    }
    return false;
  }

  function tryPlay(from, to) {
    if (S.mode !== 'online') return;
    if (!S.oppOnline) { setStatus('等待对手加入…', 'wait'); return; }
    if (S.over) return;
    if (S.turn !== S.mySide) { setStatus('还没到你的回合', 'wait'); return; }

    if (!X.isLegal(S.board, S.mySide, from, to)) {
      setNotice('这步棋走不了：会送将或者不合规则。');
      return;
    }
    const ended = play(from, to, S.mySide);
    publish({ t: 'move', from: from, to: to, round: S.round });
    if (ended) return;

    setStatus('轮到对方了', 'idle');
    if (X.inCheck(S.board, S.turn)) setDetail('将军！对方的主帅被将军了。');
    else setDetail('你执' + sideName(S.mySide) + '，等对方走棋。');
  }

  function finishRound(result) {
    S.over = true;
    clearSelection();

    if (result.winner === S.mySide) {
      S.score.me++;
      setStatus('你赢了', 'win');
      setDetail('你执' + sideName(S.mySide) + '获胜。' + reasonText(result.reason, false));
    } else if (result.winner === S.oppSide) {
      S.score.opp++;
      setStatus('对方赢了', 'lose');
      setDetail('对方获胜。' + reasonText(result.reason, true));
    } else {
      S.score.draw++;
      setStatus('和棋', 'wait');
      setDetail(reasonText(result.reason, false));
    }

    renderScore();
    renderRounds();
    draw(false);

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
  }

  function resetRound() {
    S.board = X.parseFen(X.START_FEN).board;
    S.turn = RED;
    S.over = false;
    S.last = null;
    S.movesMade = 0;
    S.rep = {};
    S.sentRematch = false;
    S.gotRematch = false;
    clearSelection();
    rematchBtn.hidden = true;
    rematchBtn.classList.remove('btn--primary');
    rematchBtn.classList.add('btn--ghost');
    shareBtn.classList.add('btn--primary');
    shareBtn.classList.remove('btn--ghost');
    assignSides();
    renderRounds();
    layout();
    draw(true);

    if (S.mySide === RED) {
      setStatus('轮到你了', 'idle');
      setDetail('你执红，先行。点自己的子，再点落点。');
    } else {
      setStatus('等对方走棋', 'idle');
      setDetail('你执黑，红方先行。');
    }
  }

  function assignSides() {
    const hostSide = S.round % 2 === 0 ? RED : BLACK;
    S.mySide = S.role === 'host' ? hostSide : other(hostSide);
    S.oppSide = other(S.mySide);
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
      clientId: 'xq_' + ME_ID + '_' + S.code,
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

  function publishState() {
    publish({
      t: 'state', round: S.round, board: X.boardToString(S.board), turn: S.turn,
      last: S.last, moves: S.movesMade, total: S.total, score: S.score
    });
  }

  function applyState(msg) {
    if (typeof msg.board !== 'string' || msg.board.length < TOTAL) return;
    if (S.role === 'guest' && msg.total) setTotal(msg.total);
    S.round = typeof msg.round === 'number' ? msg.round : S.round;
    assignSides();
    S.board = X.boardFromString(msg.board);
    S.turn = msg.turn === BLACK ? BLACK : RED;
    S.last = msg.last && typeof msg.last.from === 'number' ? { from: msg.last.from, to: msg.last.to } : null;
    S.movesMade = typeof msg.moves === 'number' ? msg.moves : 1;
    S.over = false;
    clearSelection();
    draw(true);
    const st = X.status(S.board, S.turn);
    if (st.over) {
      finishRound({ winner: S.turn === S.mySide ? S.oppSide : S.mySide, reason: st.reason });
      return;
    }
    if (S.turn === S.mySide) {
      setStatus('轮到你了', 'idle');
      setDetail('你执' + sideName(S.mySide) + '，棋局已同步。');
    } else {
      setStatus('等对方走棋', 'idle');
      setDetail('你执' + sideName(S.mySide) + '，棋局已同步。');
    }
  }

  function handleMessage(msg) {
    if (!msg || msg.f === ME_ID) return;
    if (msg.r && msg.r !== S.code) return;

    S.lastSeen = Date.now();
    if (!S.oppOnline && msg.t !== 'bye') {
      S.oppOnline = true;
      setConn('on', '在线');
      if (!S.over) {
        if (S.turn === S.mySide) { setStatus('轮到你了', 'idle'); setDetail('你执' + sideName(S.mySide) + '，请走棋。'); }
        else { setStatus('等对方走棋', 'idle'); setDetail('你执' + sideName(S.mySide) + '。'); }
      }
    }

    switch (msg.t) {
      case 'hello':
        publish({ t: 'here', role: S.role, round: S.round, total: S.total });
        if (S.movesMade > 0) publishState();
        break;

      case 'here':
        if (S.role === 'guest' && msg.total) setTotal(msg.total);
        break;

      case 'state':
        if (msg.round >= S.round && S.movesMade === 0) applyState(msg);
        break;

      case 'move':
        if (msg.round !== S.round || S.over) return;
        if (S.turn !== S.oppSide) return;
        if (typeof msg.from !== 'number' || typeof msg.to !== 'number') return;
        if (!X.isLegal(S.board, S.oppSide, msg.from, msg.to)) return;
        {
          const ended = play(msg.from, msg.to, S.oppSide);
          if (ended) return;
          setStatus('轮到你了', 'idle');
          if (X.inCheck(S.board, S.mySide)) setDetail('你执' + sideName(S.mySide) + '，被将军了，先解将。');
          else setDetail('你执' + sideName(S.mySide) + '，请走棋。');
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
    assignSides();
    resetRound();
    setStatus('连接中…', 'wait');
    connectBroker();
    requestAnimationFrame(layout);
  }

  /* ============================ 总局数 ============================ */

  let totalChoice = 4;

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
      if (!(v >= 1)) v = 4;
      return Math.min(99, Math.max(1, v));
    }
    return parseInt(totalChoice, 10) || 4;
  }

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

    /* 棋盘：点子选中，点圆点落子（都是真按钮，键盘也能用） */
    piecesEl.addEventListener('click', function (e) {
      let node = e.target;
      while (node && node !== piecesEl && !(node.classList && (node.classList.contains('xq-piece') || node.classList.contains('xq-dot')))) {
        node = node.parentNode;
      }
      if (!node || node === piecesEl) return;
      const idx = Number(node.dataset.idx);
      if (isNaN(idx)) return;

      if (node.classList.contains('xq-dot')) {
        if (S.sel >= 0) tryPlay(S.sel, idx);
        return;
      }

      if (S.over) return;
      if (S.turn !== S.mySide) {
        /* 对方回合点到对方的子：只提示，不选中 */
        if (S.board[idx] && X.sideOf(S.board[idx]) === S.oppSide) setStatus('还没到你的回合', 'wait');
        return;
      }
      const ch = S.board[idx];
      if (S.sel >= 0 && S.targets.indexOf(idx) >= 0) { tryPlay(S.sel, idx); return; }
      if (!ch) { clearSelection(); draw(false); return; }
      if (X.sideOf(ch) !== S.mySide) { clearSelection(); draw(false); return; }
      selectAt(idx);
      draw(false);
    });

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        layout();
        renderMarks();
        renderTargets();
      });
      ro.observe(boardEl);
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
      setNotice(location.protocol === 'file:'
        ? '双击本地文件打开的页面只能自己玩，链接对方打不开。'
        : '本机地址 localhost 的链接对方打不开，要联机请先用公网地址打开。', 'warn', 7000);
    }
  }

  document.addEventListener('themechange', function () { requestAnimationFrame(layout); });

  window.__xq = {
    S, X, TOTAL, RED, BLACK,
    startOnline, joinRoom, createRoom, handleMessage, publishState, applyState,
    play, tryPlay, selectAt, assignSides, layout, draw, rebuildPieces,
    isLegal: X.isLegal, status: X.status, legalMovesFrom: X.legalMovesFrom,
    boardToString: X.boardToString, boardFromString: X.boardFromString,
    requestRematch, nextRound, finishRound, renderRounds, setTotal, readTotal,
    sendChat, appendChat, clearChat, pieceEls, squareId: () => squareId
  };

  boot();
})();
