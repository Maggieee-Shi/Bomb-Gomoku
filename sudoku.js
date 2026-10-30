// Sudoku generator with unique-solution guarantee.
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function canPlace(g, idx, v) {
  const r = Math.floor(idx / 9), c = idx % 9;
  const br = r - (r % 3), bc = c - (c % 3);
  for (let i = 0; i < 9; i++) {
    if (g[r * 9 + i] === v || g[i * 9 + c] === v) return false;
    if (g[(br + Math.floor(i / 3)) * 9 + bc + (i % 3)] === v) return false;
  }
  return true;
}

function fill(g) {
  const idx = g.indexOf(0);
  if (idx === -1) return true;
  for (const v of shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])) {
    if (canPlace(g, idx, v)) {
      g[idx] = v;
      if (fill(g)) return true;
      g[idx] = 0;
    }
  }
  return false;
}

function countSolutions(g, limit = 2) {
  // pick empty cell with fewest candidates
  let best = -1, bestCands = null;
  for (let i = 0; i < 81; i++) {
    if (g[i]) continue;
    const cands = [];
    for (let v = 1; v <= 9; v++) if (canPlace(g, i, v)) cands.push(v);
    if (cands.length === 0) return 0;
    if (!bestCands || cands.length < bestCands.length) { best = i; bestCands = cands; if (cands.length === 1) break; }
  }
  if (best === -1) return 1;
  let count = 0;
  for (const v of bestCands) {
    g[best] = v;
    count += countSolutions(g, limit - count);
    g[best] = 0;
    if (count >= limit) break;
  }
  return count;
}

const CLUES = { easy: 40, medium: 32, hard: 26 };

function generate(difficulty = 'medium') {
  const solution = new Array(81).fill(0);
  fill(solution);
  const puzzle = solution.slice();
  const target = CLUES[difficulty] || CLUES.medium;
  let filled = 81;
  for (const i of shuffle([...Array(81).keys()])) {
    if (filled <= target) break;
    const keep = puzzle[i];
    puzzle[i] = 0;
    if (countSolutions(puzzle.slice()) !== 1) puzzle[i] = keep;
    else filled--;
  }
  return { puzzle, solution };
}

module.exports = { generate };
