# Lineup – Queue Management App

A full-stack queue manager. Managers log in, create named queues, add people (each gets a token), reorder, serve and cancel tokens, and watch a live analytics dashboard.

**Stack:** Node.js + Express (REST API, JWT auth, bcrypt), JSON-file storage, vanilla HTML/CSS/JS frontend, Chart.js for charts.

## Run locally
```bash
npm install
npm start          # http://localhost:3000
```
Demo login: `demo@lineup.test` / `demo1234` (or create your own account).
Optional env vars: `PORT`, `JWT_SECRET`, `DATA_FILE`.

## Features (mapped to the brief)
1. **Manager login** – register/login with JWT; every queue belongs to its manager.
2. **Create queues** – each queue has a unique (per manager) name.
3. **Add tokens** – adding a person creates a token like `B-001` (queue initial + running number).
4. **Waiting list** – live list with position and waiting time (auto-refreshes every 5 s).
5. **Reorder** – ↑ / ↓ buttons swap a token with its neighbour.
6. **Serve next** – one click moves the top token to "Now serving"; "Mark done" completes it.
7. **Cancel** – ✕ removes a waiting token (with confirmation).
8. **Dashboard** – average / longest wait, average service time, totals, queue-length trend, wait time per served token, arrivals per hour.

## API
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | Get a JWT |
| GET / POST | `/api/queues` | List / create queues |
| GET / DELETE | `/api/queues/:id` | Queue detail (waiting, serving, recent) / delete |
| POST | `/api/queues/:id/tokens` | Add person → creates token |
| POST | `/api/queues/:id/serve` | Serve the token at the top |
| POST | `/api/tokens/:id/move` | Body `{direction:"up"\|"down"}` |
| POST | `/api/tokens/:id/cancel` | Cancel a waiting token |
| POST | `/api/tokens/:id/complete` | Finish serving |
| GET | `/api/queues/:id/analytics` | Dashboard data |

## Design notes
- **Ordering:** waiting tokens carry a numeric `order`; moving swaps the `order` values of two neighbours, so it is O(1) and never renumbers the list.
- **Token lifecycle:** `waiting → serving → served`, or `waiting → cancelled`.
- **Analytics:** wait time = `servedAt − createdAt`; service time = `completedAt − servedAt`. A queue-length snapshot is recorded on every add / serve / cancel to draw the trend.
- **Security:** passwords hashed with bcrypt, JWT expires in 7 days, every endpoint checks that the queue/token belongs to the logged-in manager, all rendered text is HTML-escaped.
- **Storage:** a JSON file keeps setup to zero. Swapping it for SQLite/PostgreSQL only touches the small datastore block at the top of `server.js`.

## Push to GitHub
```bash
git init && git add . && git commit -m "Queue management app"
git branch -M main
git remote add origin https://github.com/<your-username>/queue-manager.git
git push -u origin main
```
To deploy on Render/Railway: build `npm install`, start `npm start`, set `JWT_SECRET`.
