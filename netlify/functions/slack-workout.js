// netlify/functions/slack-workout.js
// Netlify Function for Slack slash commands (pure function, no Express).

'use strict';

// In-memory store (resets on cold start/redeploy)
const userDailyStars = {}; // { userId: { 'YYYY-MM-DD': 1 } }
const userNames = {};      // { userId: username }

// --- Utilities ---
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

function getWeekDates(date) {
  const monday = new Date(date);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)); // Monday as start
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d.toISOString().split('T')[0];
  });
}

function generateWeeklyTableText(today) {
  const dates = getWeekDates(today);
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  const users = Object.keys(userDailyStars);
  if (users.length === 0) return 'No stars recorded yet this week.';

  let table = '*Weekly Workout Table*\n```\n';
  table += '| Name       | ' + days.join(' | ') + ' |\n';
  table += '|------------|-----|-----|-----|-----|-----|-----|-----|\n';

  for (const uid of users) {
    const name = (userNames[uid] || uid).slice(0, 20);
    const row  = dates.map(d => (userDailyStars[uid]?.[d] ? '⭐' : ' '));
    table += `| ${name.padEnd(10)} | ${row.join(' | ')} |\n`;
  }
  table += '```';
  return table;
}

function parseSlackBody(event) {
  const headers = event.headers || {};
  const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();

  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(event.body || '');
    return Object.fromEntries(params.entries());
  }

  if (ct.includes('application/json')) {
    try {
      return JSON.parse(event.body || '{}');
    } catch {
      return {};
    }
  }

  // Fallback: try form-encoded
  const params = new URLSearchParams(event.body || '');
  return Object.fromEntries(params.entries());
}

function json(obj) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(obj)
  };
}

// --- Handler ---
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const body = parseSlackBody(event);
  const userId = body.user_id || '';
  const userName = body.user_name || '';
  const rawText = (body.text || '').trim().toLowerCase();

  // track user
  if (userId && userName) userNames[userId] = userName;

  const parts = rawText.split(/\s+/); // e.g. ["star","me","8/18/2025"]
  const command2 = parts.slice(0, 2).join(' '); // "star me"

  // support optional "for"
    let dateArg = null;
    if (parts[2] === 'for') {
    dateArg = parts[3];
    } else {
    dateArg = parts[2];
    }

    // default target date = today
    let targetDate = new Date();
    if (dateArg) {
    const parsed = new Date(dateArg);
    if (!isNaN(parsed)) targetDate = parsed;
    }
    const dateStr = targetDate.toISOString().split('T')[0];

  const today = new Date();
  const weekKey = getWeekKey(today);

    // Routes
    if (command2 === 'star me') {
    if (!userId) {
        return json({
        response_type: 'ephemeral',
        text: 'Missing user_id.'
        });
    }

    if (!userDailyStars[userId]) {
        userDailyStars[userId] = {};
    }

  userDailyStars[userId][dateStr] = 1;

    await fetch(body.response_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        response_type: 'in_channel',
        text: `:star: ${userNames[userId] || userId} got a star for ${dateStr}`
    })
    });
    return { statusCode: 200, body: '' }; // no extra app message
}

  if (rawText === 'my stars' || command2 === 'my stars') {
    if (!userId) return json({ response_type: 'ephemeral', text: 'Missing user_id.' });
    const count = getWeekDates(today).filter(d => userDailyStars[userId]?.[d]).length;
    return json({ response_type: 'ephemeral', text: `:star: ${count} stars this week.` });
  }

  if (rawText === 'weekly stars') {
    const leaderboard = Object.keys(userDailyStars).map(uid => {
      const count = getWeekDates(today).filter(d => userDailyStars[uid]?.[d]).length;
      return { name: userNames[uid] || uid, count };
    }).filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count);

    if (leaderboard.length === 0) {
      return json({ response_type: 'in_channel', text: 'No stars this week yet!' });
    }

    const lines = leaderboard.map((e, i) => `${i + 1}. ${e.name} – ${e.count} :star:`);
    return json({
      response_type: 'in_channel',
      text: `:trophy: *Weekly Star Leaderboard (${weekKey})*\n${lines.join('\n')}`
    });
  }

    if (rawText.startsWith('weekly table')) {
    const isPublic = /\bpublic\b/.test(rawText);
    return json({
        response_type: isPublic ? 'in_channel' : 'ephemeral',
        text: generateWeeklyTableText(today)
    });
    }

  // Help / usage
  return json({
    response_type: 'ephemeral',
    text:
`Usage:
• \`/workout-wins star me\` – Add a star
• \`/workout-wins star me for mm/dd/yyyy\` – Add a star for a specific day
• \`/workout-wins my stars\` – View your weekly total
• \`/workout-wins weekly stars\` – View the leaderboard
• \`/workout-wins weekly table\` – View the weekly table`
  });
};
