// Sokoban solver: push-optimal, room by room.
//
// Idea: a level is a one-square hallway with 1-4 small rooms off it, and a
// box pushed out of a room through its door can never come back, so every
// room is an independent problem and the level optimum is the sum of the
// rooms' optima. Each room is solved with a breadth-first search over
// pushes (not steps): a state is the boxes' squares plus the player's
// reachable region, so the first solved state found uses the fewest pushes.
// Dead positions are pruned two ways: a square no box can ever be pulled
// back from onto a goal (found by reverse play from the goals), and a frozen
// 2x2 block of walls and boxes holding a box off its goal. The rooms are
// then stitched together by the player's walk between them.
//
// Everything is deterministic: fixed direction order, FIFO queue, and all
// budgets counted in expanded states, never in wall-clock time, so two runs
// on the same set write byte-identical answers.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// State budgets (work, not time). The generator only keeps rooms its own
// push-optimal search solves well inside the room limit.
const ROOM_STATE_LIMIT = 250000;
const WHOLE_STATE_LIMIT = 80000;

// [dx, dy, walk letter, push letter], in a fixed order used everywhere.
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// A parsed level: width, height, wall flags, goal squares, box squares
// (sorted), and the player's square.
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

// Squares a box can ever stand on and still reach a goal: start from the
// goals and walk backwards. A square y is live when some live square x sits
// one step away from it (x = y + d) and the square behind y (y - d, where
// the player would stand to pull) is open floor.
function liveCells(b) {
  const live = new Uint8Array(b.wall.length);
  const queue = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * b.w + dx;
      const y = x - d;
      const behind = y - d;
      if (y < 0 || behind < 0 || y >= live.length || behind >= live.length) continue;
      if (!b.wall[y] && !b.wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Flood fill from `from` around walls and boxes, marking squares in `seen`
// with `stamp` (so the array is reused without clearing). Returns the
// lowest square reached, which names the region: two player positions in
// the same region are the same state.
function reachLow(b, occupied, from, seen, stamp, stack) {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const neighbours = [p - b.w, p + b.w, p - 1, p + 1];
    for (const q of neighbours) {
      if (q < 0 || q >= b.wall.length) continue;
      if (!b.wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// True when the box just pushed onto `t` is stuck in a 2x2 block made of
// walls and boxes that holds a box off its goal: no push can ever free it.
function frozenBlock(b, occupied, isGoal, t) {
  const w = b.w;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const cells = [a, a + 1, a + w, a + w + 1];
    if (cells[0] < 0 || cells[3] >= b.wall.length) continue;
    let filled = true;
    for (const c of cells) {
      if (!b.wall[c] && !occupied[c]) {
        filled = false;
        break;
      }
    }
    if (!filled) continue;
    for (const c of cells) {
      if (occupied[c] && !isGoal[c]) return true;
    }
  }
  return false;
}

function stateKey(boxes, low) {
  return `${low}:${boxes.join(',')}`;
}

// Push-optimal solution of one board: { pushes, moves } (moves in LURD,
// lower case for a walk step, upper case for a push), or null when the
// state budget runs out or the board cannot be solved.
function solvePushOptimal(b, maxStates) {
  const size = b.wall.length;
  const isGoal = new Uint8Array(size);
  for (const g of b.goals) isGoal[g] = 1;
  const live = liveCells(b);
  const solved = (boxes) => boxes.every((x) => isGoal[x]);
  if (solved(b.boxes)) return { pushes: 0, moves: '' };
  for (const x of b.boxes) if (!live[x]) return null;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  // A second stamp array for the region of a state a push would create: the
  // flood fill for that key must not overwrite the current state's region
  // marks in `seen`, which the stand checks below still need.
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // States in discovery order: boxes, player square, parent index, and the
  // push that created the state (box's old square, new square, direction).
  const boxesList = [b.boxes.slice()];
  const playerList = [b.player];
  const parentList = [-1];
  const pushFromList = [-1];
  const pushToList = [-1];
  const pushDirList = [-1];
  const visited = new Map();
  for (const x of b.boxes) occupied[x] = 1;
  const startLow = reachLow(b, occupied, b.player, seen, ++stamp, stack);
  for (const x of b.boxes) occupied[x] = 0;
  visited.set(stateKey(b.boxes, startLow), 0);

  let found = -1;
  for (let head = 0; head < boxesList.length && found < 0; head++) {
    const boxes = boxesList[head];
    const player = playerList[head];
    for (const x of boxes) occupied[x] = 1;
    reachLow(b, occupied, player, seen, ++stamp, stack);
    const regionStamp = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi];
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di];
        const d = dy * b.w + dx;
        const dest = box + d;
        const stand = box - d;
        if (stand < 0 || stand >= size) continue;
        if (seen[stand] !== regionStamp) continue;
        if (b.wall[dest] || occupied[dest] || !live[dest]) continue;
        occupied[box] = 0;
        occupied[dest] = 1;
        const frozen = frozenBlock(b, occupied, isGoal, dest);
        let nextBoxes = null;
        let nextKey = '';
        if (!frozen) {
          nextBoxes = boxes.slice();
          nextBoxes[bi] = dest;
          nextBoxes.sort((x, y) => x - y);
          const low = reachLow(b, occupied, box, mark, ++stamp, stack);
          nextKey = stateKey(nextBoxes, low);
        }
        occupied[dest] = 0;
        occupied[box] = 1;
        if (frozen || visited.has(nextKey)) continue;
        if (boxesList.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        visited.set(nextKey, boxesList.length);
        boxesList.push(nextBoxes);
        playerList.push(box);
        parentList.push(head);
        pushFromList.push(box);
        pushToList.push(dest);
        pushDirList.push(di);
        if (solved(nextBoxes)) {
          found = boxesList.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Walk the parent chain back, then replay it forward: for each push,
  // walk to the square behind the box and push it.
  const steps = [];
  for (let s = found; s > 0; s = parentList[s]) steps.push(s);
  steps.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes.slice();
  for (const s of steps) {
    const from = pushFromList[s];
    const di = pushDirList[s];
    const [dx, dy, , pushLetter] = DIRS[di];
    const d = dy * b.w + dx;
    for (const x of boxes) occupied[x] = 1;
    moves += walkPath(b, occupied, player, from - d);
    for (const x of boxes) occupied[x] = 0;
    moves += pushLetter;
    player = from;
    boxes = boxesList[s].slice();
  }
  return { pushes: steps.length, moves };
}

// Shortest walk from `from` to `to` around walls and boxes, in lower-case
// LURD, ties broken by the fixed direction order. Throws if unreachable
// (the caller only asks for squares the search proved reachable).
function walkPath(b, occupied, from, to) {
  if (from === to) return '';
  const prev = new Int32Array(b.wall.length).fill(-1);
  const how = new Array(b.wall.length).fill('');
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * b.w + dx;
      if (q < 0 || q >= b.wall.length) continue;
      if (b.wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkPath: target unreachable');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

// The player's square after playing `moves` (case aside) from `from`.
function endPos(w, from, moves) {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

// Split a level into rooms: cut the hallway row's dead squares (floor the
// live-cell analysis says no box can ever reach) out of the floor, then
// flood-fill what is left. Each part holding boxes is a room. Returns null
// when the level is not a set of rooms (a box in the hallway, a goal cut
// off, or a room whose boxes and goals do not match).
function splitRooms(b) {
  const live = liveCells(b);
  const hallRow = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.wall.length);
  for (let x = 0; x < b.w; x++) {
    const i = hallRow * b.w + x;
    if (!b.wall[i] && !live[i]) cut[i] = 1;
  }
  if (b.boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(b.wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < b.wall.length; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      for (const [dx, dy] of DIRS) {
        const q = p + dy * b.w + dx;
        if (q < 0 || q >= b.wall.length) continue;
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const x of b.boxes) {
    if (part[x] < 0) return null;
    rooms[part[x]].boxes.push(x);
  }
  for (const g of b.goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// Solve a whole level room by room. While solving one room, the other
// rooms' boxes stand as walls (on their goals once their room is done), so
// the search never disturbs them. Falls back to a whole-level search when
// the level is not a set of rooms or a room's search gives up; returns ''
// (a valid, scoreless answer) rather than failing the run.
function solveLevel(b) {
  const rooms = splitRooms(b);
  if (rooms !== null) {
    let player = b.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = b.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const x of other.done ? other.goals : other.boxes) wall[x] = 1;
      }
      const sub = {
        w: b.w,
        h: b.h,
        wall,
        goals: room.goals.slice().sort((x, y) => x - y),
        boxes: room.boxes.slice().sort((x, y) => x - y),
        player,
      };
      const solved = solvePushOptimal(sub, ROOM_STATE_LIMIT);
      if (solved === null) {
        ok = false;
        break;
      }
      moves += solved.moves;
      player = endPos(b.w, player, solved.moves);
      room.done = true;
    }
    if (ok) return moves;
  }
  const whole = solvePushOptimal(b, WHOLE_STATE_LIMIT);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(parseLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8')));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
