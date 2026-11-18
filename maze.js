(() => {
  'use strict';

  /* ============================ 常量 ============================ */

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];
  const TOPIC_ROOT = 'goose/mz/v1/';
  const ME_ID = 'm' + Math.random().toString(36).slice(2, 10);
  const PING_MS = 5000;
  const OFFLINE_MS = 13000;
  const ABORT_OFFLINE_MS = 20000;
  const TOL_MS = 80;
  const POS_MS = 110;
  const READY_RETRY_MS = 1200;
  const COUNT_MS = 700;

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
  const overlayEl = $('mz-overlay');
  const countEl = $('mz-count');

  /* ============================ 状态 ============================ */

  const S = {
    mode: 'lobby', code: '', role: '', round: 0, total: 8,
    score: { me: 0, draw: 0, opp: 0 }, matchOver: false,

    seed: '', maze: null, side: 0,
    pos: { x: 0, y: 0 }, goal: { x: 0, y: 0 }, trail: [], steps: 0,
    oppPos: null, oppSeq: 0, oppHeard: false,

    phase: 'wait',
    startAt: 0, paused: false, pauseAt: 0, pausedMs: 0,
    myMs: null, fin: { host: null, guest: null }, lastResult: null,
    myFinAt: 0,

    dirty: false, seq: 0,
    oppOnline: false, lastSeen: 0, connected: false,
    client: null, pingTimer: null, brokerIndex: 0, brokerTries: 0,
    sentRematch: false, gotRematch: false, chat: []
  };

  let geom = { cell: 24, w: 288, h: 360 };
  let countTimer = 0;
  let readyTimer = 0;
  let posTimer = 0;
  let rafId = 0;
  let nudgeAt = 0;
  let nudgeDir = -1;
  let swipe = null;

  /* ============================ 工具 ============================ */

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

  function bump(el) {
    if (!el) return;
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  function renderScore() {
    [['me', S.score.me], ['draw', S.score.draw], ['opp', S.score.opp]].forEach(([k, v]) => {
      const el = scoreEls[k];
      if (!el) return;
      const next = String(v);
      if (el.textContent !== next) { el.textContent = next; bump(el); }
    });
  }

  function renderRounds() {
    const done = String(S.score.me + S.score.draw + S.score.opp);
    const total = String(S.total || 8);
    if (roundDoneEl && roundDoneEl.textContent !== done) { roundDoneEl.textContent = done; bump(roundDoneEl); }
    if (roundNowEl && roundNowEl.textContent !== total) { roundNowEl.textContent = total; bump(roundNowEl); }
    if (roundDoneEl) roundDoneEl.hidden = false;
    if (roundSlashEl) roundSlashEl.hidden = false;
  }

  const nameOfRole = (role) => (role === 'host' ? '玩家一' : '玩家二');
  const myName = () => nameOfRole(S.role);
  const oppName = () => nameOfRole(S.role === 'host' ? 'guest' : 'host');

  function fmtSec(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '--';
    return (ms / 1000).toFixed(2) + ' 秒';
  }

  function isPublicUrl() {
    if (location.protocol === 'file:') return false;
    const h = location.hostname || '';
    return !(h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]' || h === '::1');
  }

  /* ============================ 房间消息 ============================ */

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

  /* ============================ 局与迷宫 ============================ */

  function seedOf() { return MazeCore.seedFor(S.code, S.round); }

  function showCount(text) {
    if (!overlayEl || !countEl) return;
    overlayEl.hidden = false;
    countEl.textContent = text;
    countEl.classList.remove('is-pop');
    void countEl.offsetWidth;
    countEl.classList.add('is-pop');
  }

  function hideCount() {
    if (overlayEl) overlayEl.hidden = true;
    if (countEl) countEl.classList.remove('is-pop');
  }

  function stopCountTimer() {
    if (countTimer) { clearInterval(countTimer); countTimer = 0; }
  }

  function stopReadyRetry() {
    if (readyTimer) { clearInterval(readyTimer); readyTimer = 0; }
  }

  function startReadyRetry() {
    stopReadyRetry();
    readyTimer = setInterval(function () {
      if (S.phase !== 'counting' && S.phase !== 'racing') { stopReadyRetry(); return; }
      if (S.oppHeard || S.phase === 'done' || S.phase === 'finishing') { stopReadyRetry(); return; }
      if (S.role === 'host') publish({ t: 'ready', round: S.round });
    }, READY_RETRY_MS);
  }

  function stopRaceLoop() {
    if (posTimer) { clearInterval(posTimer); posTimer = 0; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  }

  function startRaceLoop() {
    stopRaceLoop();
    posTimer = setInterval(function () {
      if (S.phase !== 'racing' && S.phase !== 'finishing') return;
      if (S.dirty && S.phase === 'racing') {
        S.dirty = false;
        publish({ t: 'pos', round: S.round, x: S.pos.x, y: S.pos.y, q: ++S.seq });
      }
      // 我到了、对手掉线太久 → 本局作废
      if (S.phase === 'finishing' && !S.oppOnline && S.myFinAt &&
          Date.now() - S.myFinAt > ABORT_OFFLINE_MS && S.fin[S.role === 'host' ? 'guest' : 'host'] == null) {
        abortRound('对方掉线太久，这一局作废');
      }
    }, POS_MS);
    const tick = function () {
      rafId = 0;
      if (S.phase === 'racing' || S.phase === 'counting' || S.phase === 'finishing') {
        draw();
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);
  }

  function elapsedMs() {
    if (!S.startAt) return 0;
    const now = performance.now();
    const extra = (S.paused && S.pauseAt) ? now - S.pauseAt : 0;
    return Math.max(0, now - S.startAt - S.pausedMs - extra);
  }

  function updateElapsedText() {
    if (S.phase !== 'racing') return;
    setDetail('已用 ' + fmtSec(elapsedMs()) + ' · ' + S.steps + ' 步');
  }

  function pauseRace() {
    if (S.paused) return;
    if (S.phase !== 'racing' && S.phase !== 'finishing') return;
    S.paused = true;
    S.pauseAt = performance.now();
    setStatus('已暂停', 'wait');
    setDetail('对方离线，计时暂停。');
  }

  function resumeRace() {
    if (!S.paused) return;
    if (S.pauseAt) S.pausedMs += performance.now() - S.pauseAt;
    S.paused = false;
    S.pauseAt = 0;
    if (S.phase === 'racing') {
      setStatus('跑！', 'idle');
      updateElapsedText();
    } else if (S.phase === 'finishing') {
      setStatus('你到了', 'win');
      setDetail('等对方到终点…');
    }
  }

  function maybeStart() {
    if (S.mode !== 'online' || S.phase !== 'wait' || !S.oppOnline) return;
    if (S.role === 'host') {
      publish({ t: 'ready', round: S.round });
      startCountdown();
      startReadyRetry();
    }
  }

  function startCountdown() {
    stopCountTimer();
    S.phase = 'counting';
    showCount('3');
    setStatus('准备…', 'wait');
    setDetail('3 秒后同时出发');
    let n = 3;
    countTimer = setInterval(() => {
      n--;
      if (n > 0) { showCount(String(n)); return; }
      clearInterval(countTimer); countTimer = 0;
      beginRace();
    }, COUNT_MS);
    startRaceLoop();
  }

  function beginRace() {
    showCount('开始');
    setTimeout(hideCount, 420);
    S.phase = 'racing';
    S.startAt = performance.now();
    S.paused = false; S.pauseAt = 0; S.pausedMs = 0;
    setStatus('跑！', 'idle');
    updateElapsedText();
    if (!rafId && !posTimer) startRaceLoop();
    try { canvas.focus({ preventScroll: true }); } catch (err) { try { canvas.focus(); } catch (e2) {} }
  }

  function resetRound() {
    stopCountTimer();
    stopReadyRetry();
    stopRaceLoop();
    S.phase = 'wait';
    S.seed = seedOf();
    S.maze = MazeCore.build(S.seed);
    S.side = S.role === 'host' ? 0 : 1;
    const st = MazeCore.sides(S.maze)[S.side];
    S.pos = { x: st.start.x, y: st.start.y };
    S.goal = { x: st.goal.x, y: st.goal.y };
    S.trail = [{ x: S.pos.x, y: S.pos.y }];
    S.steps = 0;
    S.oppPos = null; S.oppSeq = 0; S.oppHeard = false;
    S.myMs = null; S.fin = { host: null, guest: null };
    S.paused = false; S.pausedMs = 0; S.pauseAt = 0; S.startAt = 0; S.myFinAt = 0;
    S.dirty = false; S.seq = 0;
    S.sentRematch = false; S.gotRematch = false;
    S.lastResult = null;
    rematchBtn.hidden = true;
    rematchBtn.classList.remove('btn--primary');
    rematchBtn.classList.add('btn--ghost');
    shareBtn.classList.add('btn--primary');
    shareBtn.classList.remove('btn--ghost');
    canvas.classList.remove('is-over');
    hideCount();
    renderRounds();
    layout();
    setStatus(S.oppOnline ? '等待开始…' : '等待对手…', 'wait');
    setDetail('双方在线后自动倒计时出发');
    maybeStart();
  }

  function abortRound(reason) {
    stopCountTimer();
    stopReadyRetry();
    stopRematchRetry();
    stopRaceLoop();
    hideCount();
    setNotice(reason || '这一局作废', 'warn');
    // 同一局号重开（不递增），重新生成同一张图、回到 wait
    S.phase = 'wait';
    S.seed = seedOf();
    S.maze = MazeCore.build(S.seed);
    S.side = S.role === 'host' ? 0 : 1;
    const st = MazeCore.sides(S.maze)[S.side];
    S.pos = { x: st.start.x, y: st.start.y };
    S.goal = { x: st.goal.x, y: st.goal.y };
    S.trail = [{ x: S.pos.x, y: S.pos.y }];
    S.steps = 0;
    S.oppPos = null; S.oppSeq = 0; S.oppHeard = false;
    S.myMs = null; S.fin = { host: null, guest: null };
    S.paused = false; S.pausedMs = 0; S.pauseAt = 0; S.startAt = 0; S.myFinAt = 0;
    S.dirty = false; S.seq = 0;
    S.lastResult = null;
    rematchBtn.hidden = true;
    canvas.classList.remove('is-over');
    renderRounds();
    draw();
    setStatus(S.oppOnline ? '等待开始…' : '等待对手…', 'wait');
    setDetail('本局作废，重新出发');
    maybeStart();
  }

  /* ============================ 移动 / 判定 ============================ */

  function nudge(dir) {
    nudgeAt = performance.now();
    nudgeDir = dir;
    try { if (navigator.vibrate) navigator.vibrate(8); } catch (err) {}
    draw();
  }

  function tryMove(dir) {
    if (S.mode !== 'online') return false;
    if (!S.oppOnline || !S.connected) { setNotice('还没连上对方'); return false; }
    if (S.phase !== 'racing' || S.paused) return false;
    if (!S.maze) return false;
    if (!MazeCore.canMove(S.maze, S.pos.x, S.pos.y, dir)) { nudge(dir); return false; }
    const d = MazeCore.DIRS[dir];
    S.pos = { x: S.pos.x + d.dx, y: S.pos.y + d.dy };
    S.steps++;
    S.trail.push({ x: S.pos.x, y: S.pos.y });
    S.dirty = true;
    if (S.pos.x === S.goal.x && S.pos.y === S.goal.y) finishMine();
    else updateElapsedText();
    draw();
    return true;
  }

  function finishMine() {
    const ms = Math.round(elapsedMs());
    S.myMs = ms; S.myFinAt = Date.now();
    S.fin[S.role] = ms;
    publish({ t: 'fin', round: S.round, ms: ms, moves: S.steps, role: S.role });
    // 立刻再发一次当前位置，方便对手看到终点光点
    publish({ t: 'pos', round: S.round, x: S.pos.x, y: S.pos.y, q: ++S.seq });
    S.dirty = false;
    S.phase = 'finishing';
    setStatus('你到了', 'win');
    setDetail('你用了 ' + fmtSec(ms) + '，等对方…');
    checkVerdict();
  }

  function checkVerdict() {
    const v = MazeCore.verdict(S.fin.host, S.fin.guest, TOL_MS);
    if (!v || S.phase === 'done') return;
    finishRound(v);
  }

  function scoreForWire() {
    return S.role === 'host'
      ? { host: S.score.me, guest: S.score.opp, draw: S.score.draw }
      : { host: S.score.opp, guest: S.score.me, draw: S.score.draw };
  }

  function scoreFromWire(w) {
    if (!w || typeof w.host !== 'number' || typeof w.guest !== 'number') return;
    var host = w.host || 0;
    var guest = w.guest || 0;
    var draw = w.draw || 0;
    S.score = S.role === 'host'
      ? { me: host, draw: draw, opp: guest }
      : { me: guest, draw: draw, opp: host };
    renderScore();
  }

  function resultDetail(v) {
    const my = S.fin[S.role];
    const opp = S.fin[S.role === 'host' ? 'guest' : 'host'];
    const diffSec = (v.diff / 1000).toFixed(2);
    if (v.winner === 'draw') {
      return '你 ' + fmtSec(my) + ' · 对方 ' + fmtSec(opp) + '，相差 ' + diffSec + ' 秒算平手';
    }
    if (v.winner === S.role) {
      return '你 ' + fmtSec(my) + ' · 对方 ' + fmtSec(opp) + '，快 ' + diffSec + ' 秒';
    }
    return '你 ' + fmtSec(my) + ' · 对方 ' + fmtSec(opp) + '，慢 ' + diffSec + ' 秒';
  }

  function finishRound(v, noScore) {
    S.phase = 'done';
    stopRaceLoop();
    stopReadyRetry();
    stopCountTimer();
    hideCount();
    S.lastResult = { winner: v.winner, host: S.fin.host, guest: S.fin.guest, diff: v.diff };
    if (!noScore) {
      if (v.winner === 'draw') S.score.draw++;
      else if (v.winner === S.role) S.score.me++;
      else S.score.opp++;
    }
    renderScore();
    renderRounds();

    if (v.winner === 'draw') {
      setStatus('平手', 'wait');
    } else if (v.winner === S.role) {
      setStatus('你赢了', 'win');
    } else {
      setStatus('对方赢了', 'lose');
    }
    setDetail(resultDetail(v));

    if (S.score.me + S.score.draw + S.score.opp >= S.total) S.matchOver = true;
    S.sentRematch = false;
    S.gotRematch = false;
    rematchBtn.hidden = false;
    rematchBtn.textContent = '下一局';
    rematchBtn.classList.add('btn--primary');
    rematchBtn.classList.remove('btn--ghost');
    shareBtn.classList.remove('btn--primary');
    shareBtn.classList.add('btn--ghost');
    canvas.classList.add('is-over');

    if (S.mode === 'online' && S.matchOver) {
      rematchBtn.hidden = true;
      showMatchDialog();
      const verdict = S.score.me > S.score.opp ? '你赢下本轮'
        : S.score.me < S.score.opp ? '对方赢下本轮' : '本轮打平';
      setStatus('本轮对局结束', S.score.me > S.score.opp ? 'win' : S.score.me < S.score.opp ? 'lose' : 'wait');
      setDetail('你 ' + S.score.me + ' · 平 ' + S.score.draw + ' · 对方 ' + S.score.opp + '，' + verdict +
        '（共 ' + S.total + ' 局）点「再来一轮」清空比分重新开始。');
    }
    draw();
  }

  /* ============================ 画布 ============================ */

  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
    return {
      board: v('--board-bg', '#ffffff'),
      line: v('--board-line', 'rgba(60,60,67,.22)'),
      label3: v('--label-3', 'rgba(60,60,67,.45)'),
      blue: v('--blue', '#007aff'),
      orange: v('--orange', '#ff9500'),
      green: v('--green', '#34c759')
    };
  }

  function layout() {
    if (!S.maze) {
      const dpr0 = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = 360 * dpr0;
      canvas.height = 450 * dpr0;
      canvas.style.width = '360px';
      canvas.style.height = '450px';
      ctx.setTransform(dpr0, 0, 0, dpr0, 0, 0);
      geom = { cell: 30, w: 360, h: 450 };
      return;
    }
    const m = S.maze;
    // 只吃 board-slot 这一格的真实宽高（grid 中间行），别按整窗估，否则会盖住状态文案和底部按钮
    const slot = boardSlotEl ? boardSlotEl.getBoundingClientRect() : { width: 360, height: 400 };
    const availW = Math.max(160, Math.round((slot.width || 360) - 16));
    const availH = Math.max(160, Math.round((slot.height || 400) - 16));
    const cell = Math.max(10, Math.floor(Math.min(availW / m.w, availH / m.h)));
    const w = cell * m.w;
    const h = cell * m.h;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    geom = { cell: cell, w: w, h: h };
    draw();
  }

  function cellCenter(x, y) {
    return { x: (x + 0.5) * geom.cell, y: (y + 0.5) * geom.cell };
  }

  function draw() {
    if (!S.maze) return;
    const m = S.maze;
    const cell = geom.cell;
    const C = themeColors();
    const Nbit = MazeCore.N, Ebit = MazeCore.E, Sbit = MazeCore.S, Wbit = MazeCore.W;

    ctx.clearRect(0, 0, geom.w, geom.h);
    ctx.fillStyle = C.board;
    ctx.fillRect(0, 0, geom.w, geom.h);

    // 起点 / 终点底色
    const sides = MazeCore.sides(m);
    ctx.fillStyle = 'rgba(60,60,67,.06)';
    sides.forEach(function (s) {
      ctx.fillRect(s.start.x * cell, s.start.y * cell, cell, cell);
    });
    ctx.fillStyle = 'rgba(52,199,89,.12)';
    sides.forEach(function (s) {
      ctx.fillRect(s.goal.x * cell, s.goal.y * cell, cell, cell);
    });

    // 轨迹先画在墙下面：粗轨迹盖住墙线时，会误看成「这边能拐进去」
    if (S.trail.length > 1) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < S.trail.length; i++) {
        const p = cellCenter(S.trail[i].x, S.trail[i].y);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = 'rgba(0,122,255,.12)';
      ctx.lineWidth = cell * 0.28;
      ctx.stroke();
      ctx.beginPath();
      for (let i = 0; i < S.trail.length; i++) {
        const p = cellCenter(S.trail[i].x, S.trail[i].y);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = 'rgba(0,122,255,.34)';
      ctx.lineWidth = cell * 0.10;
      ctx.stroke();
    }

    // 墙：每格只画 N / W，末行补 S、末列补 E（画在轨迹之上，开口/堵口一眼能分清）
    ctx.strokeStyle = C.line;
    ctx.lineWidth = Math.max(1.5, cell * 0.10);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const v = m.cells[y * m.w + x];
        const x0 = x * cell, y0 = y * cell;
        if (v & Nbit) { ctx.moveTo(x0, y0); ctx.lineTo(x0 + cell, y0); }
        if (v & Wbit) { ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 + cell); }
        if (y === m.h - 1 && (v & Sbit)) { ctx.moveTo(x0, y0 + cell); ctx.lineTo(x0 + cell, y0 + cell); }
        if (x === m.w - 1 && (v & Ebit)) { ctx.moveTo(x0 + cell, y0); ctx.lineTo(x0 + cell, y0 + cell); }
      }
    }
    ctx.stroke();

    // 中线
    ctx.strokeStyle = C.label3;
    ctx.lineWidth = cell * 0.14;
    ctx.beginPath();
    ctx.moveTo(m.halfW * cell, 0);
    ctx.lineTo(m.halfW * cell, geom.h);
    ctx.stroke();

    // 终点标记（自己这边）
    const g = cellCenter(S.goal.x, S.goal.y);
    ctx.strokeStyle = C.green;
    ctx.fillStyle = C.green;
    ctx.lineWidth = Math.max(1.5, cell * 0.06);
    ctx.beginPath();
    ctx.arc(g.x, g.y, cell * 0.22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(g.x, g.y, cell * 0.07, 0, Math.PI * 2);
    ctx.fill();

    // 自己的点（含撞墙 nudge）
    let me = cellCenter(S.pos.x, S.pos.y);
    if (nudgeDir >= 0 && nudgeAt) {
      const age = performance.now() - nudgeAt;
      if (age < 140) {
        const t = 1 - age / 140;
        const amp = 3 * t;
        const d = MazeCore.DIRS[nudgeDir];
        me = { x: me.x + d.dx * amp, y: me.y + d.dy * amp };
      } else {
        nudgeDir = -1;
      }
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.18)';
    ctx.shadowBlur = cell * 0.25;
    ctx.shadowOffsetY = cell * 0.06;
    ctx.fillStyle = C.blue;
    ctx.beginPath();
    ctx.arc(me.x, me.y, cell * 0.30, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(me.x, me.y, cell * 0.30, 0, Math.PI * 2);
    ctx.stroke();

    // 对手光点
    if (S.oppPos) {
      const op = cellCenter(S.oppPos.x, S.oppPos.y);
      const breath = 0.12 + 0.08 * (Math.sin(performance.now() / 280) + 1); // 0.12~0.28
      ctx.save();
      ctx.globalAlpha = breath;
      ctx.fillStyle = C.orange;
      ctx.beginPath();
      ctx.arc(op.x, op.y, cell * 0.40, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = C.orange;
      ctx.beginPath();
      ctx.arc(op.x, op.y, cell * 0.26, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function cellAt(clientX, clientY) {
    if (!S.maze) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = (clientX - rect.left) * (geom.w / rect.width);
    const y = (clientY - rect.top) * (geom.h / rect.height);
    const cx = Math.floor(x / geom.cell);
    const cy = Math.floor(y / geom.cell);
    if (!MazeCore.inBounds(S.maze, cx, cy)) return null;
    return { x: cx, y: cy };
  }

  /* ============================ 联机 ============================ */

  function publish(msg) {
    if (!S.client || !S.connected) return;
    msg.f = ME_ID;
    msg.r = S.code;
    try {
      S.client.publish(TOPIC_ROOT + S.code, JSON.stringify(msg), { qos: 1 });
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
      clientId: 'mz_' + ME_ID + '_' + S.code,
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
      if (S.phase === 'wait' && !S.oppOnline) {
        setStatus('等待对手…', 'wait');
        setDetail('复制邀请链接发给对方，进来后自动开跑');
      }
      client.subscribe(TOPIC_ROOT + S.code, { qos: 1 });
      publish({ t: 'hello', role: S.role, round: S.round, total: S.total, phase: S.phase });
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
        pauseRace();
        if (S.phase === 'wait' || S.phase === 'counting') setStatus('对方离线了', 'wait');
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

    // 角色撞车：只在 wait 处理，避免跑一半换边
    if (msg.role && msg.f && msg.role === S.role && S.phase === 'wait') {
      const wantHost = ME_ID < msg.f;
      if (wantHost !== (S.role === 'host')) {
        S.role = wantHost ? 'host' : 'guest';
        rememberRole(S.code, S.role);
        resetRound();
        publish({ t: 'hello', role: S.role, round: S.round, total: S.total, phase: S.phase });
        setNotice(wantHost ? '两边角色撞车了，已自动调成你跑左边。' : '两边角色撞车了，已自动调成你跑右边。', 'info');
      }
    }

    if (!S.oppOnline && msg.t !== 'bye') {
      S.oppOnline = true;
      setConn('on', '在线');
      resumeRace();
      // 开局握手交给 hello/here（带 phase），避免刷新恢复时抢先倒计时
    } else if (S.paused && msg.t !== 'bye') {
      resumeRace();
    }

    switch (msg.t) {
      case 'hello':
        publish({ t: 'here', role: S.role, round: S.round, total: S.total, phase: S.phase });
        // 有人中途刷新：竞速中作废重开
        if (S.phase === 'racing' || S.phase === 'finishing' || S.phase === 'counting') {
          abortRound('对方重新连上了，这一局重开。');
        } else if (S.phase === 'done' || S.lastResult) {
          publish({
            t: 'state',
            round: S.round,
            total: S.total,
            score: scoreForWire(),
            done: S.phase === 'done',
            result: S.lastResult
          });
        } else if (S.phase === 'wait' && (!msg.phase || msg.phase === 'wait')) {
          maybeStart();
        }
        break;

      case 'here':
        if (S.role === 'guest' && msg.total) setTotal(msg.total);
        // 对方若已在 done，等 state 恢复，别抢先开倒计时
        if (S.phase === 'wait' && (!msg.phase || msg.phase === 'wait')) maybeStart();
        break;

      case 'ready':
        if (msg.round !== S.round) return;
        if (S.phase !== 'wait') return; // counting/racing/done 一律忽略
        startCountdown();
        break;

      case 'pos':
        if (msg.round !== S.round) return;
        if (typeof msg.q !== 'number' || msg.q <= S.oppSeq) return;
        if (typeof msg.x !== 'number' || typeof msg.y !== 'number') return;
        S.oppSeq = msg.q;
        S.oppPos = { x: msg.x, y: msg.y };
        S.oppHeard = true;
        stopReadyRetry();
        break;

      case 'fin':
        if (msg.round !== S.round) return;
        S.oppHeard = true;
        stopReadyRetry();
        if (typeof msg.ms === 'number' && (msg.role === 'host' || msg.role === 'guest')) {
          S.fin[msg.role] = msg.ms;
        }
        if (S.phase === 'racing') {
          setDetail('对方到了，继续跑！');
        }
        checkVerdict();
        break;

      case 'state':
        if (typeof msg.round !== 'number' || msg.round < S.round) return;
        if (msg.total) setTotal(msg.total);
        S.round = msg.round;
        scoreFromWire(msg.score);
        if (msg.done && msg.result) {
          S.seed = seedOf();
          S.maze = MazeCore.build(S.seed);
          S.side = S.role === 'host' ? 0 : 1;
          const st = MazeCore.sides(S.maze)[S.side];
          S.pos = { x: st.goal.x, y: st.goal.y };
          S.goal = { x: st.goal.x, y: st.goal.y };
          S.trail = [{ x: st.start.x, y: st.start.y }, { x: st.goal.x, y: st.goal.y }];
          S.fin = { host: msg.result.host, guest: msg.result.guest };
          S.myMs = S.fin[S.role];
          finishRound({ winner: msg.result.winner, diff: msg.result.diff || 0 }, true);
        } else if (S.phase === 'wait' || S.phase === 'lobby' || !S.maze) {
          resetRound();
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
        pauseRace();
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

  let rematchTimer = 0;
  function stopRematchRetry() {
    if (rematchTimer) { clearInterval(rematchTimer); rematchTimer = 0; }
  }

  function requestRematch() {
    if (S.phase !== 'done') return;
    S.sentRematch = true;
    publish({ t: 'rematch', round: S.round });
    stopRematchRetry();
    rematchTimer = setInterval(function () {
      if (S.phase !== 'done' || !S.sentRematch) { stopRematchRetry(); return; }
      publish({ t: 'rematch', round: S.round });
    }, 1000);
    if (matchDialogEl && !matchDialogEl.hidden && mdAgainEl) {
      mdAgainEl.textContent = '等待对方同意…';
      mdAgainEl.disabled = true;
    }
    rematchBtn.textContent = '等待对方同意…';
    setDetail('已发送「再来一局」请求。');
    if (S.gotRematch) nextRound();
  }

  function nextRound() {
    stopRematchRetry();
    hideMatchDialog();
    // 局号单调递增，永不归零（再来一轮也不归零，避免重放第一张迷宫）
    if (S.matchOver) {
      S.matchOver = false;
      S.score = { me: 0, draw: 0, opp: 0 };
      renderScore();
    }
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

  const ROLE_KEY = 'mz-role-';

  function rememberRole(code, role) {
    try { sessionStorage.setItem(ROLE_KEY + code, role); } catch (err) {}
  }

  function recallRole(code) {
    try { return sessionStorage.getItem(ROLE_KEY + code) || ''; } catch (err) { return ''; }
  }

  function forgetRole(code) {
    try { sessionStorage.removeItem(ROLE_KEY + code); } catch (err) {}
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
    resetRound();
    setStatus('连接中…', 'wait');
    connectBroker();
    requestAnimationFrame(layout);
  }

  /* ============================ 总局数 ============================ */

  let totalChoice = 8;

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

  function setTotal(v) {
    const n = parseInt(v, 10);
    if (!(n >= 1)) return;
    S.total = Math.min(99, n);
    renderRounds();
  }

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
    rememberRole(S.code, 'host');
    // 本机也写进 URL，刷新才能靠 ?r= + sessionStorage 回到同一身份
    try { history.replaceState(null, '', '?r=' + S.code); } catch (err) {}
  }

  function joinRoom(raw, asRole) {
    const code = String(raw || '').trim().toUpperCase();
    if (code.length !== 5) { setNotice('房间码是 5 位字母/数字。'); return; }
    startOnline(code, asRole === 'host' ? 'host' : 'guest');
    rememberRole(code, asRole === 'host' ? 'host' : 'guest');
    try { history.replaceState(null, '', '?r=' + code); } catch (err) {}
  }

  function leaveRoom() {
    publish({ t: 'bye' });
    stopPing();
    stopCountTimer();
    stopReadyRetry();
    stopRematchRetry();
    stopRaceLoop();
    if (S.client) { try { S.client.end(true); } catch (err) {} }
    S.client = null;
    S.connected = false;
    S.oppOnline = false;
    S.mode = 'lobby';
    forgetRole(S.code);
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

    // 滑动步进
    canvas.addEventListener('pointerdown', (e) => {
      if (S.phase !== 'racing') return;
      swipe = { x: e.clientX, y: e.clientY };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      try { canvas.focus({ preventScroll: true }); } catch (err) { try { canvas.focus(); } catch (e2) {} }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!swipe || S.phase !== 'racing') return;
      const dx = e.clientX - swipe.x;
      const dy = e.clientY - swipe.y;
      const thr = Math.max(16, (geom.cell || 20) * 0.72);
      if (Math.abs(dx) < thr && Math.abs(dy) < thr) return;
      let dir;
      if (Math.abs(dx) > Math.abs(dy)) dir = dx > 0 ? 1 : 3;
      else dir = dy > 0 ? 2 : 0;
      const moved = tryMove(dir);
      if (moved) {
        if (dir === 1) swipe.x += thr;
        else if (dir === 3) swipe.x -= thr;
        else if (dir === 2) swipe.y += thr;
        else swipe.y -= thr;
      } else {
        swipe.x = e.clientX;
        swipe.y = e.clientY;
      }
    });
    const clearSwipe = () => { swipe = null; };
    canvas.addEventListener('pointerup', clearSwipe);
    canvas.addEventListener('pointercancel', clearSwipe);

    // 点击相邻格
    canvas.addEventListener('click', (e) => {
      if (S.phase !== 'racing' || S.paused) return;
      const c = cellAt(e.clientX, e.clientY);
      if (!c) return;
      const dx = c.x - S.pos.x;
      const dy = c.y - S.pos.y;
      if (Math.abs(dx) + Math.abs(dy) !== 1) return;
      let dir = -1;
      if (dx === 1) dir = 1;
      else if (dx === -1) dir = 3;
      else if (dy === 1) dir = 2;
      else if (dy === -1) dir = 0;
      if (dir >= 0) tryMove(dir);
    });

    // 桌面：方向键 / WASD 全局可走（输入框打字时不抢）
    const onKeyMove = (e) => {
      if (S.mode !== 'online' || S.phase !== 'racing') return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const map = {
        ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3,
        w: 0, W: 0, d: 1, D: 1, s: 2, S: 2, a: 3, A: 3
      };
      if (!(e.key in map)) return;
      e.preventDefault();
      tryMove(map[e.key]);
    };
    window.addEventListener('keydown', onKeyMove);
    canvas.addEventListener('keydown', onKeyMove);

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => layout());
      if (boardSlotEl) ro.observe(boardSlotEl);
      else ro.observe(canvas);
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
      joinRoom(room, recallRole(room));
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

  document.addEventListener('themechange', function () { requestAnimationFrame(function () { layout(); }); });

  window.__mz = {
    S, MazeCore, tryMove, layout, geomOf: () => geom, joinRoom, createRoom,
    startOnline, handleMessage, resetRound, nextRound, requestRematch,
    seedOf, encodeMaze: () => (S.maze ? MazeCore.encode(S.maze) : ''),
    pathOf: () => (S.maze ? MazeCore.pathTo(S.maze, S.side) : null),
    verdict: MazeCore.verdict, abortRound, finishRound
  };

  boot();
})();
