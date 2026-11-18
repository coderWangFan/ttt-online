/* 双人迷宫竞速 · 纯逻辑内核（浏览器 + node 通用，零依赖）
 *
 * 设计要点
 *  - 一张迷宫左右镜像：右半 = 左半的水平镜像。两人的迷宫难度完全等价。
 *  - 中间一道实墙隔开：各跑各的道，不需要碰撞/阻挡判定（网络抖动不会影响公平）。
 *  - 起点镜像（左下 / 右下），终点镜像（左上 / 右上，靠中线一侧）。
 *    镜像对称 => 两人最短路径长度严格相等。
 *  - 只用 seed 决定迷宫：两边各自用同一 seed 生成，结果必须逐字节一致。
 *
 * 坐标：x 向右 0..w-1，y 向下 0..h-1，索引 idx = y*w + x
 * 墙位：N=1, E=2, S=4, W=8（格子自己记录四面墙，1 表示有墙）
 */
(function (root) {
  'use strict';

  var N = 1, E = 2, S = 4, W = 8;
  // dir 顺序固定：0=上 1=右 2=下 3=左
  var DIRS = [
    { bit: N, dx: 0, dy: -1, opp: S },
    { bit: E, dx: 1, dy: 0, opp: W },
    { bit: S, dx: 0, dy: 1, opp: N },
    { bit: W, dx: -1, dy: 0, opp: E }
  ];

  var DEF_HALF_W = 6;   // 单侧宽度（格）
  var DEF_H = 15;       // 高度（格）  => 总宽 12

  /* ---------- 确定性随机 ---------- */
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rngFrom(seed) {
    return mulberry32(hashStr(seed));
  }

  /* ---------- 生成 ---------- */
  function swapEW(v) {
    var e = v & E, w = v & W;
    return (v & ~(E | W)) | (e ? W : 0) | (w ? E : 0);
  }

  // 递归回溯（迭代栈）在 hw x h 的半场上开路
  function carveHalf(rng, hw, h) {
    var cells = [], seen = [], i;
    for (i = 0; i < hw * h; i++) { cells.push(N | E | S | W); seen.push(false); }

    var stack = [0];        // 从 (0,0) 起手，连通性和起点无关
    seen[0] = true;

    while (stack.length) {
      var cur = stack[stack.length - 1];
      var cx = cur % hw, cy = (cur - cx) / hw;

      var opts = [];
      for (var d = 0; d < 4; d++) {
        var nx = cx + DIRS[d].dx, ny = cy + DIRS[d].dy;
        if (nx < 0 || ny < 0 || nx >= hw || ny >= h) continue;
        var ni = ny * hw + nx;
        if (seen[ni]) continue;
        opts.push({ d: d, i: ni });
      }
      if (!opts.length) { stack.pop(); continue; }

      var pick = opts[Math.floor(rng() * opts.length)];
      cells[cur] &= ~DIRS[pick.d].bit;
      cells[pick.i] &= ~DIRS[pick.d].opp;
      seen[pick.i] = true;
      stack.push(pick.i);
    }
    return cells;
  }

  /**
   * 生成一张迷宫
   * @param {string} seed 房间码 / 局号 / 任意串都可以，两端必须一样
   * @returns {{seed:string,w:number,h:number,halfW:number,cells:number[]}}
   */
  function build(seed, opt) {
    opt = opt || {};
    var hw = opt.halfW || DEF_HALF_W;
    var h = opt.h || DEF_H;
    var rng = rngFrom(seed);

    var half = carveHalf(rng, hw, h);
    var w = hw * 2;
    var cells = [];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var v;
        if (x < hw) {
          v = half[y * hw + x];
        } else {
          v = swapEW(half[y * hw + (w - 1 - x)]);   // 镜像列
        }
        cells.push(v);
      }
    }
    return { seed: String(seed), w: w, h: h, halfW: hw, cells: cells };
  }

  /* ---------- 规则 ---------- */
  // 两边的起点 / 终点（索引 = 0 左 / 1 右）
  function sides(m) {
    return [
      { start: { x: 0, y: m.h - 1 }, goal: { x: m.halfW - 1, y: 0 } },
      { start: { x: m.w - 1, y: m.h - 1 }, goal: { x: m.halfW, y: 0 } }
    ];
  }

  function inBounds(m, x, y) {
    return x >= 0 && y >= 0 && x < m.w && y < m.h;
  }

  // 能不能从 (x,y) 往 dir 走一步
  function canMove(m, x, y, dir) {
    if (!inBounds(m, x, y)) return false;
    var d = DIRS[dir];
    if (m.cells[y * m.w + x] & d.bit) return false;
    return inBounds(m, x + d.dx, y + d.dy);
  }

  // 以 (sx,sy) 为源做 BFS，返回每格最短步数（-1 = 不可达）
  function distances(m, sx, sy) {
    var n = m.w * m.h, dist = [], i;
    for (i = 0; i < n; i++) dist.push(-1);
    if (!inBounds(m, sx, sy)) return dist;

    var q = [sy * m.w + sx];
    dist[q[0]] = 0;
    for (var head = 0; head < q.length; head++) {
      var cur = q[head];
      var cx = cur % m.w, cy = (cur - cx) / m.w;
      for (var d = 0; d < 4; d++) {
        if (!canMove(m, cx, cy, d)) continue;
        var nx = cx + DIRS[d].dx, ny = cy + DIRS[d].dy;
        var ni = ny * m.w + nx;
        if (dist[ni] !== -1) continue;
        dist[ni] = dist[cur] + 1;
        q.push(ni);
      }
    }
    return dist;
  }

  // 某一边起点到终点的最短步数（-1 表示不连通）
  function routeLength(m, side) {
    var s = sides(m)[side ? 1 : 0];
    var dist = distances(m, s.start.x, s.start.y);
    return dist[s.goal.y * m.w + s.goal.x];
  }

  // 两边路径是否等长（公平性自检）
  function isFair(m) {
    var a = routeLength(m, 0), b = routeLength(m, 1);
    return a > 0 && a === b;
  }

  /* ---------- 对局判定 ---------- */

  // 每局迷宫的种子：房间码 + 局号。局号单调递增，所以每局都是新迷宫
  function seedFor(code, round) {
    return String(code || '') + '#' + (round | 0);
  }

  /**
   * 谁赢：把两边的用时（毫秒）做规范化比较，两端算出来的结论必然一样
   * @returns {{winner:'host'|'guest'|'draw', diff:number}|null}
   */
  function verdict(hostMs, guestMs, tol) {
    if (typeof hostMs !== 'number' || typeof guestMs !== 'number') return null;
    if (!isFinite(hostMs) || !isFinite(guestMs) || hostMs < 0 || guestMs < 0) return null;
    var d = Math.abs(hostMs - guestMs);
    if (d < (tol || 80)) return { winner: 'draw', diff: d };
    return { winner: hostMs < guestMs ? 'host' : 'guest', diff: d };
  }

  // 起点到终点的方向序列（BFS 最短路），给测试和「提示」用
  function pathTo(m, side) {
    var s = sides(m)[side ? 1 : 0];
    var prev = [], seen = [], i;
    for (i = 0; i < m.w * m.h; i++) { prev.push(-1); seen.push(false); }
    var start = s.start.y * m.w + s.start.x;
    var goal = s.goal.y * m.w + s.goal.x;
    var q = [start];
    seen[start] = true;
    for (var head = 0; head < q.length; head++) {
      var cur = q[head];
      if (cur === goal) break;
      var cx = cur % m.w, cy = (cur - cx) / m.w;
      for (var d = 0; d < 4; d++) {
        if (!canMove(m, cx, cy, d)) continue;
        var nx = cx + DIRS[d].dx, ny = cy + DIRS[d].dy;
        var ni = ny * m.w + nx;
        if (seen[ni]) continue;
        seen[ni] = true;
        prev[ni] = cur * 4 + d;
        q.push(ni);
      }
    }
    if (prev[goal] === -1) return null;
    var dirs = [];
    var node = goal;
    while (node !== start) {
      var p = prev[node];
      if (p === -1) return null;
      dirs.push(p % 4);
      node = (p - (p % 4)) / 4;
    }
    dirs.reverse();
    return dirs;
  }

  /* ---------- 序列化 ---------- */
  function encode(m) {
    var hex = '';
    for (var i = 0; i < m.cells.length; i++) hex += m.cells[i].toString(16);
    return 'v1:' + m.w + 'x' + m.h + ':' + hex;
  }

  function decode(str) {
    var parts = String(str).split(':');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    var wh = parts[1].split('x');
    var w = +wh[0], h = +wh[1];
    if (!(w > 0 && h > 0)) return null;
    var hex = parts[2];
    if (hex.length !== w * h) return null;
    var cells = [];
    for (var i = 0; i < hex.length; i++) cells.push(parseInt(hex.charAt(i), 16));
    return { seed: '', w: w, h: h, halfW: w / 2, cells: cells };
  }

  var api = {
    N: N, E: E, S: S, W: W, DIRS: DIRS,
    DEF_HALF_W: DEF_HALF_W, DEF_H: DEF_H,
    hashStr: hashStr, mulberry32: mulberry32, rngFrom: rngFrom,
    build: build, sides: sides, canMove: canMove, inBounds: inBounds,
    distances: distances, routeLength: routeLength, isFair: isFair,
    seedFor: seedFor, verdict: verdict, pathTo: pathTo,
    encode: encode, decode: decode
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MazeCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
