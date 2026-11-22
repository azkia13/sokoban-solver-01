[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/azkia13/sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/azkia13/sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# sokoban-solver-01

A push-optimal Sokoban solver for make.fun's
[Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121)
bounty. One run answers all 5 instances of a set.

## How it works

A level is a one-square hallway with 1–4 small rooms off it, and a box
pushed out of a room through its door can never come back — so every room
is an independent problem and the level optimum is the sum of the rooms'
optima. Each room is solved with a breadth-first search over **pushes**
(not steps): a state is the boxes' squares plus the player's reachable
region, so the first solved state found uses the fewest pushes. Dead
positions are pruned two ways: squares no box can ever be pulled back from
onto a goal (found by reverse play from the goals), and frozen 2×2 blocks
of walls and boxes holding a box off its goal. The rooms are stitched
together by the player's walk between them.

Everything is deterministic: fixed direction order, FIFO queue, and all
budgets counted in expanded states, never in wall-clock time, so two runs
on the same set write byte-identical answers.

## Run

```sh
node main.ts
```

Reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`). Node 22, standard
library only, no dependencies.

## Results

Practice set: **1,000,000 / 1,000,000** — every instance solved in exactly
P\* pushes (13 / 16 / 29 / 47 / 60), in ~1.3 s. Three freshly drawn sets
from the published generator also score 1,000,000 each. The house
baseline (plain-astar 1.0.0) scores 200,000 on the practice set.
