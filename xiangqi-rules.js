/* ============================================================================
 * 中国象棋规则引擎（纯逻辑，无 DOM）
 * ----------------------------------------------------------------------------
 * 坐标：board 是长度 90 的数组，索引 = y * 9 + x
 *   y = 0 是黑方底线（棋盘上方），y = 9 是红方底线（棋盘下方）
 *   x = 0 是最左一路，x = 8 是最右一路
 * 棋子：红方大写 K 帅 / A 仕 / B 相 / N 马 / R 车 / C 炮 / P 兵
 *       黑方小写 k 将 / a 士 / b 象 / n 马 / r 车 / c 炮 / p 卒
 *       （空位是 ''）
 *
 * 实现的规则：
 *   1. 帅/将：九宫内一步直行；两将不可在同一直线上照面（中间无子）
 *   2. 仕/士：九宫内一步斜行
 *   3. 相/象：田字（两步斜行），塞象眼不能走，不能过河
 *   4. 马：日字，蹩马腿不能走
 *   5. 车：直线任意距离，不能越子
 *   6. 炮：不吃子时同车；吃子必须隔且只隔一个子（炮架）
 *   7. 兵/卒：向前一步；过河后可以横向一步；永远不能后退
 *   8. 任何走法都不能让自己的帅/将被攻击（包括照面），所以「送将」「自刎」都非法
 *   9. 无合法着法即负（绝杀或困毙）
 *
 * 未实现（休闲局约定，页面里也有说明）：
 *   - 长将 / 长捉 判负（只做三次重复判和）
 *   - 六十回合无吃子判和
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Xiangqi = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var COLS = 9;
  var ROWS = 10;
  var SIZE = COLS * ROWS;

  var RED = 'red';
  var BLACK = 'black';

  var START_FEN = 'rheakaehr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RHEAKAEHR w';

  /* ------------------------------- 基础工具 ------------------------------- */

  function xOf(i) { return i % COLS; }
  function yOf(i) { return (i / COLS) | 0; }
  function at(x, y) { return (x < 0 || x >= COLS || y < 0 || y >= ROWS) ? -1 : y * COLS + x; }
  function sideOf(ch) { return ch ? (ch === ch.toUpperCase() ? RED : BLACK) : null; }
  function enemyOf(side) { return side === RED ? BLACK : RED; }
  function kingChar(side) { return side === RED ? 'K' : 'k'; }
  function isPiece(ch, side, type) {
    return !!ch && sideOf(ch) === side && ch.toUpperCase() === type;
  }
  function inPalace(x, y, side) {
    if (x < 3 || x > 5) return false;
    return side === RED ? (y >= 7 && y <= 9) : (y >= 0 && y <= 2);
  }
  function onOwnSide(x, y, side) { return side === RED ? y >= 5 : y <= 4; }

  var NAME = {
    K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵',
    k: '将', a: '士', b: '象', n: '马', r: '车', c: '炮', p: '卒'
  };
  function pieceName(ch) { return NAME[ch] || ''; }
  function sideName(side) { return side === RED ? '红' : '黑'; }

  function emptyBoard() { return new Array(SIZE).fill(''); }

  /* -------------------------------- FEN ---------------------------------- */

  /* 兼容 h/n、e/b 两套字母（CPW 的 FEN 用 h=马, e=象） */
  var FEN_LETTER = { k: 'K', a: 'A', b: 'B', e: 'B', n: 'N', h: 'N', r: 'R', c: 'C', p: 'P' };

  function parseFen(fen) {
    var board = emptyBoard();
    var parts = String(fen || START_FEN).trim().split(/\s+/);
    var rows = parts[0].split('/');
    for (var r = 0; r < ROWS; r++) {
      var line = rows[r] || '9';
      var x = 0;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (ch >= '1' && ch <= '9') { x += ch.charCodeAt(0) - 48; continue; }
        var up = FEN_LETTER[ch.toLowerCase()];
        if (!up) { x++; continue; }
        var piece = ch === ch.toUpperCase() ? up : up.toLowerCase();
        if (x >= 0 && x < COLS) board[r * COLS + x] = piece;
        x++;
      }
    }
    var turn = (parts[1] || 'w').toLowerCase() === 'b' ? BLACK : RED;
    return { board: board, turn: turn };
  }

  function toFen(board, turn) {
    var out = [];
    for (var y = 0; y < ROWS; y++) {
      var line = '';
      var gap = 0;
      for (var x = 0; x < COLS; x++) {
        var ch = board[y * COLS + x];
        if (!ch) { gap++; continue; }
        if (gap) { line += String(gap); gap = 0; }
        line += ch;
      }
      if (gap) line += String(gap);
      out.push(line || '9');
    }
    return out.join('/') + ' ' + (turn === BLACK ? 'b' : 'w');
  }

  /* 网络传输用的紧凑串：90 个字符，'.' 表示空 */
  function boardToString(board) {
    var s = '';
    for (var i = 0; i < SIZE; i++) s += board[i] || '.';
    return s;
  }
  function boardFromString(str) {
    var board = emptyBoard();
    if (typeof str !== 'string') return board;
    for (var i = 0; i < SIZE && i < str.length; i++) {
      var ch = str[i];
      board[i] = (ch && ch !== '.' && ch !== '-') ? ch : '';
    }
    return board;
  }

  function cloneBoard(board) { return board.slice(); }

  function findKing(board, side) {
    var k = kingChar(side);
    for (var i = 0; i < SIZE; i++) if (board[i] === k) return i;
    return -1;
  }

  /* ------------------------------ 着法生成 -------------------------------- */

  var ORTHO = [[0, -1], [0, 1], [-1, 0], [1, 0]];
  var DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  var HORSE = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];

  function pushMove(out, from, to) { out.push({ from: from, to: to }); }

  function pseudoMoves(board, side) {
    var out = [];
    for (var i = 0; i < SIZE; i++) {
      var ch = board[i];
      if (!ch || sideOf(ch) !== side) continue;
      var type = ch.toUpperCase();
      var x = xOf(i);
      var y = yOf(i);
      var d, k, tx, ty, ti;

      if (type === 'K' || type === 'A') {
        var steps = type === 'K' ? ORTHO : DIAG;
        for (d = 0; d < 4; d++) {
          tx = x + steps[d][0]; ty = y + steps[d][1];
          if (!inPalace(tx, ty, side)) continue;
          ti = at(tx, ty);
          if (ti < 0 || (board[ti] && sideOf(board[ti]) === side)) continue;
          pushMove(out, i, ti);
        }
        continue;
      }

      if (type === 'B') {
        for (d = 0; d < 4; d++) {
          tx = x + DIAG[d][0] * 2; ty = y + DIAG[d][1] * 2;
          if (tx < 0 || tx >= COLS || ty < 0 || ty >= ROWS) continue;
          if (!onOwnSide(tx, ty, side)) continue;          /* 象不过河 */
          var eye = at(x + DIAG[d][0], y + DIAG[d][1]);
          if (board[eye]) continue;                        /* 塞象眼 */
          ti = at(tx, ty);
          if (board[ti] && sideOf(board[ti]) === side) continue;
          pushMove(out, i, ti);
        }
        continue;
      }

      if (type === 'N') {
        for (k = 0; k < 8; k++) {
          tx = x + HORSE[k][0]; ty = y + HORSE[k][1];
          ti = at(tx, ty);
          if (ti < 0) continue;
          var lx = Math.abs(HORSE[k][0]) === 2 ? x + HORSE[k][0] / 2 : x;
          var ly = Math.abs(HORSE[k][0]) === 2 ? y : y + HORSE[k][1] / 2;
          if (board[at(lx, ly)]) continue;                 /* 蹩马腿 */
          if (board[ti] && sideOf(board[ti]) === side) continue;
          pushMove(out, i, ti);
        }
        continue;
      }

      if (type === 'R' || type === 'C') {
        for (d = 0; d < 4; d++) {
          tx = x + ORTHO[d][0]; ty = y + ORTHO[d][1];
          var screened = false;
          while (true) {
            ti = at(tx, ty);
            if (ti < 0) break;
            var t = board[ti];
            if (type === 'R') {
              if (!t) { pushMove(out, i, ti); }
              else { if (sideOf(t) !== side) pushMove(out, i, ti); break; }
            } else {
              if (!screened) {
                if (!t) pushMove(out, i, ti);
                else screened = true;                      /* 遇到炮架 */
              } else if (t) {
                if (sideOf(t) !== side) pushMove(out, i, ti);/* 隔一子吃 */
                break;
              }
            }
            tx += ORTHO[d][0]; ty += ORTHO[d][1];
          }
        }
        continue;
      }

      if (type === 'P') {
        var forward = side === RED ? -1 : 1;
        ty = y + forward;
        ti = at(x, ty);
        if (ti >= 0 && (!board[ti] || sideOf(board[ti]) !== side)) pushMove(out, i, ti);
        var crossed = side === RED ? y <= 4 : y >= 5;
        if (crossed) {
          var sideXs = [x - 1, x + 1];
          for (k = 0; k < 2; k++) {
            ti = at(sideXs[k], y);
            if (ti < 0) continue;
            if (board[ti] && sideOf(board[ti]) === side) continue;
            pushMove(out, i, ti);
          }
        }
        continue;
      }
    }
    return out;
  }

  /* ------------------------------ 被攻击判定 ------------------------------ */

  /* target 这一格是否被 bySide 的任何子攻击（含两将照面） */
  function isAttacked(board, target, bySide) {
    if (target < 0) return false;
    var tx = xOf(target);
    var ty = yOf(target);
    var targetPiece = board[target];
    var targetIsKing = !!targetPiece && targetPiece.toUpperCase() === 'K';
    var d, x, y, i, ch, type, dist;

    /* 车 / 炮 / 将 / 兵：四条直线 */
    for (d = 0; d < 4; d++) {
      var dx = ORTHO[d][0];
      var dy = ORTHO[d][1];
      x = tx + dx; y = ty + dy; dist = 1;
      while (at(x, y) >= 0 && !board[at(x, y)]) { x += dx; y += dy; dist++; }
      i = at(x, y);
      var first = i >= 0 ? board[i] : '';
      if (first && sideOf(first) === bySide) {
        type = first.toUpperCase();
        if (type === 'R') return true;
        if (type === 'K') {
          if (dist === 1 && dy === 0) return true;         /* 将帅贴身横吃（理论上不会出现） */
          if (dist === 1 && dx === 0) return true;
          if (targetIsKing && dx === 0) return true;       /* 照面：同一直线且中间无子 */
        }
        if (type === 'P' && dist === 1) {
          if (bySide === RED) {
            if (dy === 1) return true;                    /* 红兵向上吃 */
            if (dy === 0 && y <= 4) return true;          /* 过河后横吃 */
          } else {
            if (dy === -1) return true;                   /* 黑卒向下吃 */
            if (dy === 0 && y >= 5) return true;
          }
        }
      }
      /* 炮：跨一个炮架 */
      if (first) {
        var x2 = x + dx;
        var y2 = y + dy;
        while (at(x2, y2) >= 0 && !board[at(x2, y2)]) { x2 += dx; y2 += dy; }
        var j = at(x2, y2);
        var second = j >= 0 ? board[j] : '';
        if (second && sideOf(second) === bySide && second.toUpperCase() === 'C') return true;
      }
    }

    /* 马 */
    for (var h = 0; h < 8; h++) {
      var hx = tx + HORSE[h][0];
      var hy = ty + HORSE[h][1];
      var hi = at(hx, hy);
      if (hi < 0) continue;
      if (!isPiece(board[hi], bySide, 'N')) continue;
      var ddx = tx - hx;
      var ddy = ty - hy;
      var legX = Math.abs(ddx) === 2 ? hx + ddx / 2 : hx;
      var legY = Math.abs(ddx) === 2 ? hy : hy + ddy / 2;
      var leg = at(legX, legY);
      if (leg >= 0 && !board[leg]) return true;
    }

    /* 仕/士 与 相/象 */
    for (var g = 0; g < 4; g++) {
      var ax = tx + DIAG[g][0];
      var ay = ty + DIAG[g][1];
      var ai = at(ax, ay);
      if (ai >= 0 && isPiece(board[ai], bySide, 'A')) return true;

      var bx = tx + DIAG[g][0] * 2;
      var by = ty + DIAG[g][1] * 2;
      var bi = at(bx, by);
      if (bi >= 0 && isPiece(board[bi], bySide, 'B')) {
        var eye = at(ax, ay);
        if (eye >= 0 && !board[eye]) return true;
      }
    }

    return false;
  }

  function inCheck(board, side) {
    var k = findKing(board, side);
    if (k < 0) return true;
    return isAttacked(board, k, enemyOf(side));
  }

  /* ------------------------------ 合法性过滤 ------------------------------ */

  function legalMoves(board, side, kingIdx) {
    var pseudo = pseudoMoves(board, side);
    var out = [];
    var myKing = typeof kingIdx === 'number' && kingIdx >= 0 ? kingIdx : findKing(board, side);
    var kc = kingChar(side);
    for (var i = 0; i < pseudo.length; i++) {
      var m = pseudo[i];
      var cap = board[m.to];
      var moving = board[m.from];
      board[m.to] = moving;
      board[m.from] = '';
      var kingNow = moving === kc ? m.to : myKing;
      var bad = kingNow < 0 ? true : isAttacked(board, kingNow, enemyOf(side));
      board[m.from] = moving;
      board[m.to] = cap;
      if (!bad) out.push(m);
    }
    return out;
  }

  function legalMovesFrom(board, side, from) {
    var all = legalMoves(board, side);
    var out = [];
    for (var i = 0; i < all.length; i++) if (all[i].from === from) out.push(all[i]);
    return out;
  }

  function isLegal(board, side, from, to) {
    var moves = legalMovesFrom(board, side, from);
    for (var i = 0; i < moves.length; i++) if (moves[i].to === to) return true;
    return false;
  }

  /* -------------------------------- 走子 --------------------------------- */

  function applyMove(board, from, to) {
    var captured = board[to] || '';
    board[to] = board[from];
    board[from] = '';
    return { from: from, to: to, captured: captured };
  }

  function undoMove(board, move) {
    board[move.from] = board[move.to];
    board[move.to] = move.captured || '';
  }

  /* 局面状态：无合法着法即负 */
  function status(board, side) {
    var moves = legalMoves(board, side);
    if (moves.length === 0) {
      return {
        over: true,
        winner: enemyOf(side),
        loser: side,
        reason: inCheck(board, side) ? 'checkmate' : 'stalemate',
        moves: moves
      };
    }
    return { over: false, winner: null, reason: '', moves: moves, check: inCheck(board, side) };
  }

  /* -------------------------------- perft -------------------------------- */

  function perft(board, side, depth) {
    if (depth <= 0) return 1;
    var moves = legalMoves(board, side);
    if (depth === 1) return moves.length;
    var next = enemyOf(side);
    var total = 0;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var cap = board[m.to];
      board[m.to] = board[m.from];
      board[m.from] = '';
      total += perft(board, next, depth - 1);
      board[m.from] = board[m.to];
      board[m.to] = cap;
    }
    return total;
  }

  function perftDivide(board, side, depth) {
    var moves = legalMoves(board, side);
    var out = [];
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      var cap = board[m.to];
      board[m.to] = board[m.from];
      board[m.from] = '';
      out.push({ from: m.from, to: m.to, nodes: perft(board, enemyOf(side), depth - 1) });
      board[m.from] = board[m.to];
      board[m.to] = cap;
    }
    return out;
  }

  return {
    COLS: COLS, ROWS: ROWS, SIZE: SIZE, RED: RED, BLACK: BLACK, START_FEN: START_FEN,
    xOf: xOf, yOf: yOf, at: at, sideOf: sideOf, enemyOf: enemyOf, kingChar: kingChar,
    inPalace: inPalace, onOwnSide: onOwnSide, pieceName: pieceName, sideName: sideName,
    emptyBoard: emptyBoard, cloneBoard: cloneBoard, findKing: findKing,
    parseFen: parseFen, toFen: toFen, boardToString: boardToString, boardFromString: boardFromString,
    pseudoMoves: pseudoMoves, legalMoves: legalMoves, legalMovesFrom: legalMovesFrom,
    isLegal: isLegal, isAttacked: isAttacked, inCheck: inCheck,
    applyMove: applyMove, undoMove: undoMove, status: status,
    perft: perft, perftDivide: perftDivide
  };
});
