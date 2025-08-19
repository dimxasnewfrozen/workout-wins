# Workout Wins Slack Bot

Track daily workout “stars” for your team right from Slack.  
This tiny Express app powers a slash command that lets users:

- ⭐ `star me [date]` — add a star for today or a specific date  
- 📊 `my stars` — see your total for the current ISO week  
- 🏆 `weekly stars` — show the team leaderboard  
- 🗓️ `weekly table` — render a code-fenced table of the week (Mon–Sun)

---

## How it works

- **Route:** `POST /slack/workout`  
- **Parsing:** Accepts Slack-style `application/x-www-form-urlencoded` payloads (and JSON for local testing).  
- **Storage:** In-memory objects:  
  - `userDailyStars: { [userId]: { 'YYYY-MM-DD': 1 } }`  
  - `userNames: { [userId]: userName }`  
- **Weeks:** Uses **ISO week** (Mon–Sun) for weekly counts and labels.  
- **Dates:** If you pass a date (e.g., `8/18/2025`) to `star me`, it stores the star under that day; otherwise it uses today. Stored keys are **`YYYY-MM-DD`**.  

---

## Commands (as typed in Slack)

```
/workout-wins star me
/workout-wins star me 8/18/2025
/workout-wins my stars
/workout-wins weekly stars
/workout-wins weekly table
```

### Example responses

- `star me` → `:star: kenny got a star for 2025-08-18`  
- `my stars` → `:star: 3 stars this week.`  
- `weekly stars` →  

  ```
  :trophy: *Weekly Star Leaderboard (2025-W34)*
  1. James – 5 :star:
  2. Kenny – 3 :star:
  ```

- `weekly table` →  

  ```
  *Weekly Workout Table*
  ```
  ```
  | Name       | Mon | Tue | Wed | Thu | Fri | Sat | Sun |
  |------------|-----|-----|-----|-----|-----|-----|-----|
  | kenny      |     | ⭐  |     |     |     |     |     |
  | james      | ⭐  | ⭐  |     |     |     |     |     |
  ```

---

## Quick start

### 1) Install & run

```bash
npm install
PORT=5000 node server.js
# or: npm start (if you add a start script)
```

The app logs:

```
Slackbot running on port 5000
```

### 2) Ensure body parsers are enabled

The code already includes:

```js
const bodyParser = require('body-parser');
app.use(bodyParser.urlencoded({ extended: true }));  // Slack form-encoded
// (Optional) add JSON if testing with Postman raw JSON:
app.use(express.json());
```

---

## Testing without Slack

### cURL (form-encoded, like Slack)

```bash
curl -X POST http://localhost:5000/slack/workout   -H "Content-Type: application/x-www-form-urlencoded"   --data-urlencode 'user_id=U123'   --data-urlencode 'user_name=kenny'   --data-urlencode 'text=star me'
```

```bash
curl -X POST http://localhost:5000/slack/workout   -H "Content-Type: application/x-www-form-urlencoded"   --data-urlencode 'user_id=U123'   --data-urlencode 'user_name=kenny'   --data-urlencode 'text=star me 8/18/2025'
```

### Postman (JSON)

- Method: **POST**  
- URL: `http://localhost:5000/slack/workout`  
- Body → **raw** → **JSON**:

```json
{
  "user_id": "U123",
  "user_name": "kenny",
  "text": "weekly table"
}
```

> Make sure you added `app.use(express.json())` if you use JSON.

---

## Slack setup (slash command)

1. In your Slack app config → **Slash Commands** → **Create New Command**  
   - Command: `/workout-wins`  
   - Request URL: `https://YOUR_HOST/slack/workout`  
   - Method: `POST`  
2. Slack will send **`application/x-www-form-urlencoded`** fields, including:  
   - `user_id`, `user_name`, `text`, `team_id`, etc.  
3. (Recommended) Add **Signing Secret** verification to ensure only Slack can call your endpoint.  

> This sample does **not** include signature verification; see “Security” below.

---

## API details

### Endpoint
`POST /slack/workout`

### Parameters (Slack-style form-encoded)

- `user_id` (string) – Slack user id  
- `user_name` (string) – Slack display name at time of request  
- `text` (string) – command text (e.g., `star me`, `star me 8/18/2025`, `my stars`, etc.)

### Responses

- `response_type: 'ephemeral'` — only the caller sees it  
- `response_type: 'in_channel'` — visible to the channel  

---

## Date handling notes

- Input date accepted as a simple string (`8/18/2025` works via `new Date(dateArg)` in Node).  
- Stored as `YYYY-MM-DD` via `toISOString().split('T')[0]`.  
- **Timezone caution:** `toISOString()` is UTC; if your server TZ differs, very late/early timestamps could roll a date forward/backward. For production use, consider a date library (e.g., `date-fns`, `luxon`) and a team-configured timezone.  

---

## Leaderboard & weekly table logic

- Week key shown as `YYYY-W##` (ISO week).  
- `my stars` and `weekly stars` count only the dates in the **current ISO week** (Mon–Sun).  
- `weekly table` prints a monospace table with a star under each day where the user has a record for that date.  

---

## Persistence & deployment

- **In-memory only** — data clears when the process restarts.  
  - For persistence, back with Redis, a DB table, or a simple JSON file with periodic writes.  
- Suitable for small teams and low traffic; add caching/DB in production.  
- If deploying behind a public URL (required for Slack), use HTTPS and verify Slack signatures.  

---

## Security (recommended additions)

- **Slack signing secret verification:** Validate `X-Slack-Signature` and `X-Slack-Request-Timestamp` on each request.  
- **Rate limiting / abuse protection:** Basic throttling to prevent spam.  
- **Input validation:** Strictly parse/validate dates and allowed commands.  

---

## Troubleshooting

- **“Cannot read properties of undefined (reading 'trim')”**  
  - Cause: `req.body.text` is undefined.  
  - Fix: Ensure content-type matches your parser:  
    - Slack: `application/x-www-form-urlencoded` + `app.use(bodyParser.urlencoded({extended:true}))`  
    - Postman JSON: `Content-Type: application/json` + `app.use(express.json())`  

- **Parameters show up in `req.query` not `req.body`**  
  - You sent `?user_id=...` in the URL. Either read from `req.query` or move them to the body.  

- **Dates off by one**  
  - Likely UTC conversion via `toISOString()`. Consider storing local date strings with a library.  

---

## Extending the bot (ideas)

- Dedupe stars (don’t allow more than one star per user per day).  
- Accept friendly date formats (`2025-08-18`, `Aug 18`, `yesterday`, `mon`).  
- Add `/workout-wins undo 8/18/2025`.  
- Post a scheduled Monday summary using Slack’s Web API (cron/Cloud Scheduler).  
- Switch to persistent storage (Redis/Postgres).  

---

## License

MIT (or your choice).
