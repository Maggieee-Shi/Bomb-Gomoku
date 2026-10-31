# 五子棋 Bomb Battle

Two-player Gomoku (five in a row) on a 15×15 board, played live in the browser, with hidden bombs and Nimbo, a storm-cloud mascot.

- On first visit you pick a name. Change it any time with **Change name**.
- **Start a game** creates a room and gives you an invite link. Only one other person can join, and a third visitor sees "This game is full".
- Black moves first. The host plays black in the first game, and colors swap every game after that.
- The first player to line up five or more stones across, down or diagonally wins, and the winning line is marked.
- 12 bombs are hidden on the board in every game. Place a stone on one and Nimbo flies over and drops it: your stone and every stone within range disappear, and your turn ends. Most blasts clear 3×3, and about 1 in 4 is a big 5×5 blast. Bomb positions stay secret until the game ends.
- **I give up** concedes the game and gives your opponent the win.
- After a game ends, either player can click **Play again**. The score carries over.
- There is no timer. Keyboard play works too: arrow keys move, Enter places a stone.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

## Deploy

This repo deploys to Railway on every push to `main`. Railway sets `PORT` and runs `npm start`. No database is needed. Games are kept in memory, so a redeploy clears games in progress. The health check is at `/health`. For local testing, `TEST_BOMBS=128,0` places bombs on fixed cells.
