const express = require('express');
const bodyParser = require('body-parser');
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// In-memory store
const userDailyStars = {}; // { userId: { 'YYYY-MM-DD': 1 } }
const userNames = {};      // { userId: username }

app.post('/slack/workout', (req, res) => {
  const userId = req.body.user_id;
  const userName = req.body.user_name;

  const rawText = (req.body.text || "").trim().toLowerCase();
  const parts = rawText.split(/\s+/); // ["star","me","8/18/2025"]
  const command = parts.slice(0, 2).join(" "); // "star me"
  const dateArg = parts[2]; // optional

  // default to today
  let targetDate = new Date();
  if (dateArg) {
    const parsed = new Date(dateArg);
    if (!isNaN(parsed)) {
      targetDate = parsed;
    }
  }

  const today = new Date();
  const weekKey = getWeekKey(today);

  // Track user
  userNames[userId] = userName;

  if (command === 'star me') {

    const dateStr = targetDate.toISOString().split("T")[0]; // YYYY-MM-DD

    if (!userDailyStars[userId]) userDailyStars[userId] = {};
    userDailyStars[userId][dateStr] = 1;

    return res.json({
      response_type: 'in_channel',
      text: `:star: ${userName} got a star for ${dateStr}`
    });
  }

  if (command === 'my stars') {
    const count = getWeekDates(today).filter(date =>
      userDailyStars[userId]?.[date]
    ).length;

    return res.json({
      response_type: 'ephemeral',
      text: `:star: ${count} stars this week.`
    });
  }

  if (command === 'weekly stars') {
    const leaderboard = Object.keys(userDailyStars).map(uid => {
      const count = getWeekDates(today).filter(date =>
        userDailyStars[uid]?.[date]
      ).length;
      return { name: userNames[uid] || uid, count };
    }).filter(entry => entry.count > 0)
      .sort((a, b) => b.count - a.count);

    if (leaderboard.length === 0) {
      return res.json({ response_type: 'in_channel', text: "No stars this week yet!" });
    }

    const textLines = leaderboard.map((entry, i) =>
      `${i + 1}. ${entry.name} – ${entry.count} :star:`
    );

    return res.json({
      response_type: 'in_channel',
      text: `:trophy: *Weekly Star Leaderboard (${weekKey})*\n${textLines.join('\n')}`
    });
  }

  if (command === 'weekly table') {
    return res.json({
      response_type: 'in_channel',
      text: generateWeeklyTable(today)
    });
  }

  return res.json({
    response_type: 'ephemeral',
    text: `Usage:
• \`/workout-wins star me\` – Add a star
• \`/workout-wins star me dd/mm/yyyy \` – Add a star for a specific day
• \`/workout-wins my stars\` – View your weekly total
• \`/workout-wins weekly stars\` – View the leaderboard
• \`/workout-wins weekly table\` – View the weekly table`
  });
});

// Utilities
function getWeekKey(date) {
  const [year, week] = getISOWeekYearAndWeek(date);
  return `${year}-W${week}`;
}

function getISOWeekYearAndWeek(date) {
  const tmp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return [tmp.getUTCFullYear(), weekNo];
}

function getWeekDates(date) {
  const monday = new Date(date);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)); // Monday
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d.toISOString().split('T')[0];
  });
}

function generateWeeklyTable(today) {
  const dates = getWeekDates(today);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  let table = `*Weekly Workout Table*\n\`\`\`\n`;
  table += '| Name       | ' + days.join(' | ') + ' |\n';
  table += '|------------' + '|----'.repeat(7) + '|\n';

  const users = Object.keys(userDailyStars);
  if (users.length === 0) return 'No stars recorded yet this week.';

  for (const uid of users) {
    const name = userNames[uid] || uid;
    const row = dates.map(d => userDailyStars[uid]?.[d] ? '⭐' : ' ');
    table += `| ${name.padEnd(10)} | ${row.join(' | ')} |\n`;
  }

  table += '```';
  return table;
}

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Slackbot running on port ${PORT}`));