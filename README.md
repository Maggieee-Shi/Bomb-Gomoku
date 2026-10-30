# Sudoku Duel

A two-player Sudoku race. Both players get the same puzzle on their own boards and see each other's progress live. The first to fill the grid correctly wins.

- On first visit you pick a name. Change it any time with **Change name**.
- **Start a game** creates a room and gives you an invite link. Only one other person can join, and a third visitor sees "This game is full".
- **I give up** concedes the round. Your opponent gets the win and the solution is shown.
- After a round ends, either player can pick a difficulty and **Play again**. The score carries over.
- There is no timer.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

## Deploy to Railway

**Option A: from GitHub**
1. Push this folder to a GitHub repo.
2. In Railway, choose **New Project → Deploy from GitHub repo** and pick the repo.
3. Open the service's **Settings → Networking** and click **Generate Domain**.

**Option B: from the CLI**
```bash
npm i -g @railway/cli
railway login
railway init        # create a new project
railway up          # upload and deploy this folder
railway domain      # get a public URL
```

Railway sets `PORT` automatically and runs `npm start`. No database is needed. Games are kept in memory, so a redeploy clears games that are in progress. The health check is at `/health`.
