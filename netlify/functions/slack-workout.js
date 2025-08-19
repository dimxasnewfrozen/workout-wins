// netlify/functions/slack-workout.js
// Pure Netlify Function for Slack slash commands (no Express).
'use strict';

// Load .env when running outside Netlify CLI
try {
  if (!process.env.NETLIFY && !process.env.NETLIFY_DEV) {
    require('dotenv').config();
  }
} catch (_) {}

// ─────────────────────────────────────────────────────────────────────────────
// Upstash Redis (lazy init)
// ─────────────────────────────────────────────────────────────────────────────
let _redis;
async function getRedis() {
  if (_redis) return _redis;
  const { Redis } = await import('@upstash/redis');
  _redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
  });
  return _redis;
}

const ENV = process.env.ENV || 'dev';
const USERS_KEY = `users:${ENV}`;
const USERNAMES_KEY = `usernames:${ENV}`;
const starsKey = (userId) => `stars:${ENV}:${userId}`; // hash: dateStr -> count

// ─────────────────────────────────────────────────────────────────────────────
// Timezone-safe date helpers
// ─────────────────────────────────────────────────────────────────────────────
const TZ = process.env.WORKOUT_TZ || 'America/New_York';
const fmtDateKey = (d) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
// Mon–Sun keys (YYYY-MM-DD) for the "today" week in TZ
function getWeekDateKeys(today) {
  const tzNow = new Date(new Date(today).toLocaleString('en-US', { timeZone: TZ }));
  const monday = new Date(tzNow);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return fmtDateKey(d);
  });
}

// ISO week label for leaderboard header
function getISOWeekYearAndWeek(date) {
  const tmp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return [tmp.getUTCFullYear(), weekNo];
}
function getWeekKey(date) {
  const [year, week] = getISOWeekYearAndWeek(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data access helpers (Redis)
// ─────────────────────────────────────────────────────────────────────────────
async function ensureUser(userId, userName) {
  if (!userId) return;
  const r = await getRedis();
  await r.sadd(USERS_KEY, userId);
  if (userName) {
    await r.hset(USERNAMES_KEY, { [userId]: userName });
  }
}
async function getUsernamesMap() {
  const r = await getRedis();
  return (await r.hgetall(USERNAMES_KEY)) || {};
}
const userLabel = (userId, usernames) => usernames[userId] || userId;

async function recordStar(userId, userName, dateStr) {
  const r = await getRedis();
  await r.sadd(USERS_KEY, userId);
  if (userName) await r.hset(USERNAMES_KEY, { [userId]: userName });
  // increment per-user, per-day count
  const newCount = await r.hincrby(starsKey(userId), dateStr, 1);
  return newCount; // 1 for first star, 2 for second, etc.
}

async function getUserWeekTotal(userId, today) {
  const r = await getRedis();
  const map = (await r.hgetall(starsKey(userId))) || {}; // { 'YYYY-MM-DD': 'N' }
  const keys = getWeekDateKeys(today);
  return keys.reduce((sum, k) => sum + (Number(map[k] || 0)), 0);
}

async function getAllUserDataForWeek(today) {
  const r = await getRedis();
  const [userIds, usernames] = await Promise.all([
    r.smembers(USERS_KEY),          // [uid...]
    r.hgetall(USERNAMES_KEY).then(x => x || {})
  ]);
  const keys = getWeekDateKeys(today);
  const users = [];
  for (const uid of userIds) {
    const map = (await r.hgetall(starsKey(uid))) || {};
    const counts = keys.map(k => Number(map[k] || 0));
    users.push({
      uid,
      name: usernames[uid] || uid,
      counts,
      total: counts.reduce((a, b) => a + b, 0)
    });
  }
  return { keys, users };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slack helpers
// ─────────────────────────────────────────────────────────────────────────────
function parseSlackBody(event) {
  const headers = event.headers || {};
  const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(event.body || '');
    return Object.fromEntries(params.entries());
  }
  if (ct.includes('application/json')) {
    try { return JSON.parse(event.body || '{}'); } catch { return {}; }
  }
  const params = new URLSearchParams(event.body || '');
  return Object.fromEntries(params.entries());
}
function json(obj) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(obj) };
}
async function postToResponseUrl(response_url, payload) {
  await fetch(response_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}
function pickDateFromText(rawText) {
  const parts = rawText.split(/\s+/);
  return parts[2] === 'for' ? parts[3] : parts[2]; // support "star me for 8/10/2025"
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation helpers
// ─────────────────────────────────────────────────────────────────────────────
function generateWeeklyTableTextFromData(data) {
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  if (!data.users || data.users.length === 0) return 'No stars recorded yet this week.';
  const cell = (n) => (n > 1 ? `⭐ x${n}` : (n === 1 ? '⭐' : ' '));
  let table = '*Weekly Workout Table*\n```\n';
  table += '| Name       | ' + days.join(' | ') + ' |\n';
  table += '|------------|-----|-----|-----|-----|-----|-----|-----|\n';
  for (const u of data.users) {
    const name = (u.name || u.uid).slice(0, 20);
    const row  = (u.counts || []).map(c => cell(c));
    table += `| ${name.padEnd(10)} | ${row.join(' | ')} |\n`;
  }
  table += '```';
  return table;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactivity handler (buttons)
// ─────────────────────────────────────────────────────────────────────────────
async function handleInteraction(body) {
  const payload = JSON.parse(body.payload);
  if (payload.type !== 'block_actions') return { statusCode: 200, body: '' };

  const action = payload.actions?.[0];
  const actionId = action?.action_id;
  const dateStr = action?.value;
  const userId = payload.user?.id;
  const userName = payload.user?.username || payload.user?.name || payload.user?.profile?.display_name;

  await ensureUser(userId, userName);

  if (actionId === 'extra_star_confirm' && userId && dateStr) {
    const newCount = await recordStar(userId, userName, dateStr);

    await postToResponseUrl(payload.response_url, {
      response_type: 'in_channel',
      text: `:star: ${(userName || userId)} logged an *additional* workout for ${dateStr} (total today: ${newCount})`
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        response_action: 'update',
        text: `Added another workout for ${dateStr}. Total today: *${newCount}*.`
      })
    };
  }

  if (actionId === 'extra_star_cancel') {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response_action: 'clear' }) };
  }

  return { statusCode: 200, body: '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash command handlers (Redis-backed)
// ─────────────────────────────────────────────────────────────────────────────
async function handleStarMe(body, userId, userName, rawText) {
  await ensureUser(userId, userName);

  let target = new Date();
  const dateArg = pickDateFromText(rawText);
  if (dateArg) { const p = new Date(dateArg); if (!isNaN(p)) target = p; }
  const dateStr = fmtDateKey(target);

  const newCount = await recordStar(userId, userName, dateStr);

  if (newCount === 1) {
    // First star → announce publicly
    await postToResponseUrl(body.response_url, {
      response_type: 'in_channel',
      text: `:star: ${(userName || userId)} got a star for ${dateStr}`
    });
    return { statusCode: 200, body: '' };
  }

  // Additional star → confirm with ephemeral buttons
  await postToResponseUrl(body.response_url, {
    response_type: 'ephemeral',
    replace_original: false,
    text: `You already recorded a workout for *${dateStr}* (total: *${newCount}*). Add another?`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `You already recorded a workout for *${dateStr}* (total: *${newCount}*). Add another?` } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Yes, add another' }, style: 'primary', action_id: 'extra_star_confirm', value: dateStr },
          { type: 'button', text: { type: 'plain_text', text: 'Cancel' }, action_id: 'extra_star_cancel', value: dateStr }
        ]
      }
    ]
  });

  return { statusCode: 200, body: '' };
}

async function handleMyStars(userId, today) {
  if (!userId) return json({ response_type: 'ephemeral', text: 'Missing user_id.' });
  const total = await getUserWeekTotal(userId, today);
  return json({ response_type: 'ephemeral', text: `:star: ${total} stars this week.` });
}

async function handleWeeklyStars(today, weekKey) {
  const data = await getAllUserDataForWeek(today);
  const ranked = data.users
    .filter(u => u.total > 0)
    .sort((a, b) => b.total - a.total);

  if (ranked.length === 0) {
    return json({ response_type: 'in_channel', text: 'No stars this week yet!' });
  }

  const lines = ranked.map((u, i) => `${i + 1}. ${u.name} – ${u.total} :star:`);
  return json({
    response_type: 'in_channel',
    text: `:trophy: *Weekly Star Leaderboard (${weekKey})*\n${lines.join('\n')}`
  });
}

async function handleWeeklyTable(rawText, today) {
  const isPublic = /\bpublic\b/.test(rawText);
  const data = await getAllUserDataForWeek(today);
  return json({ response_type: isPublic ? 'in_channel' : 'ephemeral', text: generateWeeklyTableTextFromData(data) });
}

async function handleAnalyze(rawText, today) {
  const isPublic = /\bpublic\b/.test(rawText);
  const data = await getAllUserDataForWeek(today);

  if (!data.users || data.users.length === 0) {
    return json({ response_type: 'ephemeral', text: 'No stars recorded yet this week to analyze.' });
  }

  const table = generateWeeklyTableTextFromData(data);
  const prompt = [
    `Analyze this table and provide a funny sentence or two on the results. Include some trash talking and make it competitive`,
    ``,
    `Weekly Table (Slack monospace):`,
    table,
    ``,
    `Structured data (JSON):`,
    JSON.stringify({
      dates: data.keys,
      users: data.users.map(u => ({ uid: u.uid, name: u.name, counts: u.counts, total: u.total }))
    }, null, 2)
  ].join('\n');

  if (!process.env.OPENAI_API_KEY) {
    return json({ response_type: 'ephemeral', text: 'Missing OPENAI_API_KEY—set it in Netlify environment variables.' });
  }

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: [
        { role: 'system', content: 'Be concise, upbeat, and specific. Keep it under 120 words.' },
        { role: 'user', content: prompt }
      ]
    })
  });

  const dataResp = await resp.json();
  if (!resp.ok) {
    return json({ response_type: 'in_channel', text: `OpenAI error: ${dataResp?.error?.message || 'Unknown error'}` });
  }

  const analysis = dataResp.choices?.[0]?.message?.content?.trim() || 'No analysis returned.';
  return json({ response_type: isPublic ? 'in_channel' : 'ephemeral', text: `*Weekly Analysis*\n${analysis}` });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const body = parseSlackBody(event);
  const rawText = (body.text || '').trim().toLowerCase();

  // 1) Interactivity (buttons) first
  if (body.payload) return await handleInteraction(body);

  // 2) Slash commands
  const userId = body.user_id || '';
  const userName = body.user_name || '';
  const today = new Date();
  const weekKey = getWeekKey(today);

  const parts = rawText.split(/\s+/);
  const command2 = parts.slice(0, 2).join(' '); // e.g., "star me"

  if (command2 === 'star me') {
    return await handleStarMe(body, userId, userName, rawText);
  }
  if (rawText === 'my stars' || command2 === 'my stars') {
    return await handleMyStars(userId, today);
  }
  if (rawText === 'weekly stars') {
    return await handleWeeklyStars(today, weekKey);
  }
  if (rawText.startsWith('weekly table')) {
    return await handleWeeklyTable(rawText, today);
  }
  if (rawText.startsWith('analyze')) {
    return await handleAnalyze(rawText, today);
  }

  // 3) Help / usage
  return json({
    response_type: 'ephemeral',
    text:
`Usage:
• \`/workout-wins star me\` – Add a star (today)
• \`/workout-wins star me for mm/dd/yyyy\` – Add a star for a specific day
• \`/workout-wins my stars\` – View your weekly total
• \`/workout-wins weekly stars\` – View the leaderboard
• \`/workout-wins weekly table\` – View the weekly table (visible only to you)
• \`/workout-wins weekly table public\` – Post the weekly table to the channel
• \`/workout-wins analyze\` – Get a private AI summary of this week
• \`/workout-wins analyze public\` – Post the AI summary to the channel`
  });
};
