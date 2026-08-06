/**
 * generate-stats.mjs
 * -------------------------------------------------------------------
 * Builds four static SVG cards (stats, streak, top-languages,
 * contributions heatmap) from GitHub's GraphQL API and writes them
 * into assets/svg/.
 *
 * Run on a schedule by .github/workflows/update-stats.yml and
 * committed back into the repo — the profile README never makes a
 * runtime call to any external service.
 *
 * Requires a token with `read:user` + `repo` scope, passed as the
 * STATS_TOKEN secret.
 * -------------------------------------------------------------------
 */

import { writeFileSync, mkdirSync } from "fs";

/* ------------------------------------------------------------------ */
/*  Configuration                                                      */
/* ------------------------------------------------------------------ */

const USERNAME = process.env.GH_USERNAME;
const TOKEN    = process.env.STATS_TOKEN;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

if (!USERNAME || !TOKEN) {
  console.error("Missing GH_USERNAME or STATS_TOKEN env vars.");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/*  Design Tokens — GitHub Primer–inspired                             */
/* ------------------------------------------------------------------ */

const theme = {
  dark: {
    bg:         "#0d1117",
    cardBg:     "#161b22",
    border:     "#30363d",
    text:       "#e6edf3",
    textSub:    "#8b949e",
    accent:     "#3fb950",
    accentBlue: "#58a6ff",
    accentPurple: "#bc8cff",
    heatEmpty:  "#161b22",
    heat1:      "#0e4429",
    heat2:      "#006d32",
    heat3:      "#26a641",
    heat4:      "#39d353",
  },
  light: {
    bg:         "#ffffff",
    cardBg:     "#f6f8fa",
    border:     "#d0d7de",
    text:       "#1f2328",
    textSub:    "#656d76",
    accent:     "#1a7f37",
    accentBlue: "#0969da",
    accentPurple: "#8250df",
    heatEmpty:  "#ebedf0",
    heat1:      "#9be9a8",
    heat2:      "#40c463",
    heat3:      "#30a14e",
    heat4:      "#216e39",
  },
};

/* ------------------------------------------------------------------ */
/*  GraphQL helpers with retry                                         */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const graphql = async (query, variables = {}) => {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "profile-stats-generator",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();
      if (json.errors) {
        throw new Error(JSON.stringify(json.errors));
      }
      return json.data;
    } catch (err) {
      lastError = err;
      console.warn(`Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
};

/* ------------------------------------------------------------------ */
/*  Single optimized GraphQL query                                     */
/* ------------------------------------------------------------------ */

const query = `
{
  user(login: "${USERNAME}") {
    name
    followers { totalCount }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, orderBy: { field: STARGAZERS, direction: DESC }) {
      totalCount
      nodes {
        stargazers { totalCount }
        primaryLanguage { name color }
      }
    }
    pullRequests(states: [OPEN, CLOSED, MERGED]) { totalCount }
    issues(states: [OPEN, CLOSED]) { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalRepositoryContributions
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays { date contributionCount color }
        }
      }
    }
  }
}`;

console.log(`Fetching stats for @${USERNAME}...`);
const data = await graphql(query);
const user = data.user;

/* ------------------------------------------------------------------ */
/*  Derived stats                                                      */
/* ------------------------------------------------------------------ */

const totalStars = user.repositories.nodes.reduce(
  (sum, r) => sum + r.stargazers.totalCount, 0
);
const totalRepos    = user.repositories.totalCount;
const followers     = user.followers.totalCount;
const totalCommits  = user.contributionsCollection.totalCommitContributions;
const totalPRs      = user.contributionsCollection.totalPullRequestContributions;
const totalIssues   = user.contributionsCollection.totalIssueContributions;
const totalContribs = user.contributionsCollection.contributionCalendar.totalContributions;

// Flatten contribution days
const days = user.contributionsCollection.contributionCalendar.weeks
  .flatMap((w) => w.contributionDays)
  .sort((a, b) => new Date(a.date) - new Date(b.date));

// Contribution weeks (for heatmap)
const weeks = user.contributionsCollection.contributionCalendar.weeks;

// Streaks
const computeStreaks = (days) => {
  let longest = 0, running = 0, current = 0;
  for (const d of days) {
    if (d.contributionCount > 0) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  }
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].contributionCount > 0) current += 1;
    else break;
  }
  return { current, longest };
};

const { current: currentStreak, longest: longestStreak } = computeStreaks(days);

// Top languages by repo count
const langCounts = {};
for (const r of user.repositories.nodes) {
  if (!r.primaryLanguage) continue;
  const { name, color } = r.primaryLanguage;
  langCounts[name] = langCounts[name] || { count: 0, color: color || "#8b949e" };
  langCounts[name].count += 1;
}
const topLangs  = Object.entries(langCounts).sort((a, b) => b[1].count - a[1].count).slice(0, 6);
const langTotal = topLangs.reduce((s, [, v]) => s + v.count, 0) || 1;

/* ------------------------------------------------------------------ */
/*  SVG helpers                                                        */
/* ------------------------------------------------------------------ */

/** GitHub Primer–inspired card shell with light/dark theme support */
const cardShell = (title, width, height, body, icon = "") => `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    /* Dark theme (default) */
    .card-bg   { fill: ${theme.dark.cardBg}; }
    .card-border { stroke: ${theme.dark.border}; }
    .title     { font: 600 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: ${theme.dark.text}; }
    .label     { font: 400 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: ${theme.dark.textSub}; }
    .value     { font: 600 18px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: ${theme.dark.text}; }
    .accent    { fill: ${theme.dark.accent}; }
    .accent-blue { fill: ${theme.dark.accentBlue}; }
    .accent-purple { fill: ${theme.dark.accentPurple}; }
    .icon-fill { fill: ${theme.dark.textSub}; }

    /* Light theme */
    @media (prefers-color-scheme: light) {
      .card-bg   { fill: ${theme.light.cardBg}; }
      .card-border { stroke: ${theme.light.border}; }
      .title     { fill: ${theme.light.text}; }
      .label     { fill: ${theme.light.textSub}; }
      .value     { fill: ${theme.light.text}; }
      .accent    { fill: ${theme.light.accent}; }
      .accent-blue { fill: ${theme.light.accentBlue}; }
      .accent-purple { fill: ${theme.light.accentPurple}; }
      .icon-fill { fill: ${theme.light.textSub}; }
    }
  </style>

  <!-- Card background -->
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" class="card-bg card-border" stroke-width="1" fill="none"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="11.5" class="card-bg"/>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="none" class="card-border" stroke-width="1"/>

  <!-- Title row -->
  <g transform="translate(20, 24)">
    ${icon}
    <text x="${icon ? "22" : "0"}" y="4" class="title">${title}</text>
  </g>

  <!-- Body -->
  ${body}
</svg>`.trim();

/** Format large numbers: 1234 → 1.2k */
const fmt = (n) => {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
};

/* ------------------------------------------------------------------ */
/*  SVG Icons (inline, minimal)                                        */
/* ------------------------------------------------------------------ */

const icons = {
  repo:    '<path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8.5Z" class="icon-fill"/>',
  star:    '<path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" class="icon-fill"/>',
  people:  '<path d="M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4.001 4.001 0 0 0-6.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 4.6 8.049 3.5 3.5 0 0 1 2 5.5ZM5.5 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm5.5 0a.75.75 0 0 1 .75-.75 3.5 3.5 0 0 1 2.878 5.498 5.502 5.502 0 0 1 2.808 3.886.75.75 0 0 1-1.482.235 4.001 4.001 0 0 0-2.804-3.203.75.75 0 0 1 .127-1.453A2 2 0 0 0 13.25 6.5a.75.75 0 0 1-.75-.75Z" class="icon-fill"/>',
  commit:  '<path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z" class="icon-fill"/>',
  pr:      '<path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" class="icon-fill"/>',
  issue:   '<path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" class="icon-fill"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" class="icon-fill"/>',
  fire:    '<path d="M7.998.002C7.998.002 5.248 3.752 5.248 6.002a2.75 2.75 0 1 0 5.5 0C10.748 3.752 7.998.002 7.998.002Z" class="icon-fill"/>',
  code:    '<path d="m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z" class="icon-fill"/>',
  calendar:'<path d="M4.75 0a.75.75 0 0 1 .75.75V2h5V.75a.75.75 0 0 1 1.5 0V2h1.25c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25V3.75C1 2.784 1.784 2 2.75 2H4V.75A.75.75 0 0 1 4.75 0ZM2.5 7.5v6.75c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V7.5Zm10.75-4H2.75a.25.25 0 0 0-.25.25V6h11V3.75a.25.25 0 0 0-.25-.25Z" class="icon-fill"/>',
};

const svgIcon = (name, x = 0, y = -6) =>
  `<svg x="${x}" y="${y}" width="16" height="16" viewBox="0 0 16 16">${icons[name]}</svg>`;

/* ------------------------------------------------------------------ */
/*  1. Stats Card                                                      */
/* ------------------------------------------------------------------ */

const statsRows = [
  { icon: "repo",   label: "Repositories", value: fmt(totalRepos) },
  { icon: "star",   label: "Stars Earned",  value: fmt(totalStars) },
  { icon: "people", label: "Followers",     value: fmt(followers) },
  { icon: "commit", label: "Commits",       value: fmt(totalCommits) },
  { icon: "pr",     label: "Pull Requests", value: fmt(totalPRs) },
  { icon: "issue",  label: "Issues",        value: fmt(totalIssues) },
];

const statsBody = statsRows
  .map((row, i) => {
    const col = i % 2;
    const rowIdx = Math.floor(i / 2);
    const x = col === 0 ? 20 : 210;
    const y = 52 + rowIdx * 36;
    return `
    <g transform="translate(${x}, ${y})">
      <svg width="16" height="16" viewBox="0 0 16 16">${icons[row.icon]}</svg>
      <text x="24" y="12" class="label">${row.label}</text>
      <text x="330" y="12" class="value" text-anchor="end" transform="translate(${col === 0 ? -190 : -190}, 0)">${row.value}</text>
    </g>`;
  })
  .join("\n");

const statsSvg = cardShell(
  "GitHub Stats", 420, 170, statsBody,
  svgIcon("repo")
);

/* ------------------------------------------------------------------ */
/*  2. Streak Card                                                     */
/* ------------------------------------------------------------------ */

const streakBody = `
  <!-- Current streak -->
  <g transform="translate(75, 52)">
    <text x="0" y="30" class="value accent" text-anchor="middle" style="font-size: 28px; font-weight: 700;">${currentStreak}</text>
    <text x="0" y="48" class="label" text-anchor="middle">Current Streak</text>
    <text x="0" y="64" class="label" text-anchor="middle" style="font-size: 10px;">days</text>
  </g>

  <!-- Separator -->
  <line x1="150" y1="48" x2="150" y2="124" class="card-border" stroke-width="1" opacity="0.3"/>

  <!-- Longest streak -->
  <g transform="translate(225, 52)">
    <text x="0" y="30" class="value accent-blue" text-anchor="middle" style="font-size: 28px; font-weight: 700;">${longestStreak}</text>
    <text x="0" y="48" class="label" text-anchor="middle">Longest Streak</text>
    <text x="0" y="64" class="label" text-anchor="middle" style="font-size: 10px;">days</text>
  </g>

  <!-- Separator -->
  <line x1="300" y1="48" x2="300" y2="124" class="card-border" stroke-width="1" opacity="0.3"/>

  <!-- Total contributions -->
  <g transform="translate(375, 52)">
    <text x="0" y="30" class="value accent-purple" text-anchor="middle" style="font-size: 28px; font-weight: 700;">${fmt(totalContribs)}</text>
    <text x="0" y="48" class="label" text-anchor="middle">Total Contributions</text>
    <text x="0" y="64" class="label" text-anchor="middle" style="font-size: 10px;">past year</text>
  </g>
`;

const streakSvg = cardShell(
  "Contribution Streak", 450, 150, streakBody,
  svgIcon("fire")
);

/* ------------------------------------------------------------------ */
/*  3. Languages Card                                                  */
/* ------------------------------------------------------------------ */

// Horizontal stacked bar
let barX = 25;
const barsWidth = 400;
const langBars = topLangs
  .map(([name, v]) => {
    const w = Math.max(6, (v.count / langTotal) * barsWidth);
    const rect = `<rect x="${barX}" y="52" width="${w}" height="10" rx="5" fill="${v.color}"/>`;
    barX += w;
    return rect;
  })
  .join("\n  ");

// Legend grid (2 rows of 3 cols)
const langLegend = topLangs
  .map(([name, v], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 25 + col * 140;
    const y = 88 + row * 24;
    const pct = ((v.count / langTotal) * 100).toFixed(1);
    return `
    <circle cx="${x}" cy="${y}" r="4" fill="${v.color}"/>
    <text x="${x + 10}" y="${y + 4}" class="label">${name} <tspan style="font-size:10px">${pct}%</tspan></text>`;
  })
  .join("\n  ");

const langsSvg = cardShell(
  "Most Used Languages", 450, 150,
  `${langBars}\n  ${langLegend}`,
  svgIcon("code")
);

/* ------------------------------------------------------------------ */
/*  4. Contributions Heatmap                                           */
/* ------------------------------------------------------------------ */

const buildContributionsHeatmap = () => {
  const cellSize = 11;
  const cellGap  = 3;
  const totalGap = cellSize + cellGap;
  const offsetX  = 45;
  const offsetY  = 50;
  const numWeeks = weeks.length;

  // Month labels
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthLabels = [];
  let lastMonth = -1;
  for (let w = 0; w < numWeeks; w++) {
    const firstDay = weeks[w].contributionDays[0];
    if (!firstDay) continue;
    const month = new Date(firstDay.date).getMonth();
    if (month !== lastMonth) {
      monthLabels.push(`<text x="${offsetX + w * totalGap}" y="${offsetY - 8}" class="label" style="font-size: 10px;">${months[month]}</text>`);
      lastMonth = month;
    }
  }

  // Day labels (Mon, Wed, Fri)
  const dayLabels = ["", "Mon", "", "Wed", "", "Fri", ""];
  const dayLabelsSvg = dayLabels
    .map((label, i) => {
      if (!label) return "";
      return `<text x="${offsetX - 10}" y="${offsetY + i * totalGap + 9}" class="label" text-anchor="end" style="font-size: 10px;">${label}</text>`;
    })
    .filter(Boolean)
    .join("\n  ");

  // Heat level function
  const getLevel = (count) => {
    if (count === 0) return 0;
    if (count <= 3) return 1;
    if (count <= 6) return 2;
    if (count <= 9) return 3;
    return 4;
  };

  // Build cells
  const cells = [];
  for (let w = 0; w < numWeeks; w++) {
    const week = weeks[w];
    for (let d = 0; d < week.contributionDays.length; d++) {
      const day = week.contributionDays[d];
      const level = getLevel(day.contributionCount);
      const x = offsetX + w * totalGap;
      const y = offsetY + d * totalGap;
      cells.push(`<rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="2" class="heat-${level}" data-count="${day.contributionCount}" data-date="${day.date}"><title>${day.date}: ${day.contributionCount} contribution${day.contributionCount !== 1 ? "s" : ""}</title></rect>`);
    }
  }

  const heatmapWidth = offsetX + numWeeks * totalGap + 20;
  const heatmapHeight = offsetY + 7 * totalGap + 40;

  // Legend
  const legendX = heatmapWidth - 150;
  const legendY = heatmapHeight - 24;
  const legend = `
    <text x="${legendX - 28}" y="${legendY + 9}" class="label" style="font-size: 10px;">Less</text>
    <rect x="${legendX}" y="${legendY}" width="${cellSize}" height="${cellSize}" rx="2" class="heat-0"/>
    <rect x="${legendX + totalGap}" y="${legendY}" width="${cellSize}" height="${cellSize}" rx="2" class="heat-1"/>
    <rect x="${legendX + totalGap * 2}" y="${legendY}" width="${cellSize}" height="${cellSize}" rx="2" class="heat-2"/>
    <rect x="${legendX + totalGap * 3}" y="${legendY}" width="${cellSize}" height="${cellSize}" rx="2" class="heat-3"/>
    <rect x="${legendX + totalGap * 4}" y="${legendY}" width="${cellSize}" height="${cellSize}" rx="2" class="heat-4"/>
    <text x="${legendX + totalGap * 5 + 4}" y="${legendY + 9}" class="label" style="font-size: 10px;">More</text>
  `;

  // Total contributions label
  const totalLabel = `<text x="${offsetX}" y="${heatmapHeight - 15}" class="label" style="font-size: 11px;">${totalContribs.toLocaleString()} contributions in the last year</text>`;

  return `
<svg width="${heatmapWidth}" height="${heatmapHeight}" viewBox="0 0 ${heatmapWidth} ${heatmapHeight}" xmlns="http://www.w3.org/2000/svg">
  <style>
    /* Dark theme */
    .card-bg     { fill: ${theme.dark.cardBg}; }
    .card-border { stroke: ${theme.dark.border}; }
    .title       { font: 600 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: ${theme.dark.text}; }
    .label       { font: 400 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; fill: ${theme.dark.textSub}; }
    .icon-fill   { fill: ${theme.dark.textSub}; }
    .heat-0      { fill: ${theme.dark.heatEmpty}; }
    .heat-1      { fill: ${theme.dark.heat1}; }
    .heat-2      { fill: ${theme.dark.heat2}; }
    .heat-3      { fill: ${theme.dark.heat3}; }
    .heat-4      { fill: ${theme.dark.heat4}; }

    /* Light theme */
    @media (prefers-color-scheme: light) {
      .card-bg     { fill: ${theme.light.cardBg}; }
      .card-border { stroke: ${theme.light.border}; }
      .title       { fill: ${theme.light.text}; }
      .label       { fill: ${theme.light.textSub}; }
      .icon-fill   { fill: ${theme.light.textSub}; }
      .heat-0      { fill: ${theme.light.heatEmpty}; }
      .heat-1      { fill: ${theme.light.heat1}; }
      .heat-2      { fill: ${theme.light.heat2}; }
      .heat-3      { fill: ${theme.light.heat3}; }
      .heat-4      { fill: ${theme.light.heat4}; }
    }
  </style>

  <!-- Card background -->
  <rect x="0.5" y="0.5" width="${heatmapWidth - 1}" height="${heatmapHeight - 1}" rx="12" class="card-bg card-border" stroke-width="1" fill="none"/>
  <rect x="1" y="1" width="${heatmapWidth - 2}" height="${heatmapHeight - 2}" rx="11.5" class="card-bg"/>
  <rect x="0.5" y="0.5" width="${heatmapWidth - 1}" height="${heatmapHeight - 1}" rx="12" fill="none" class="card-border" stroke-width="1"/>

  <!-- Title -->
  <g transform="translate(20, 24)">
    ${svgIcon("calendar")}
    <text x="22" y="4" class="title">Contribution Activity</text>
  </g>

  <!-- Month labels -->
  ${monthLabels.join("\n  ")}

  <!-- Day labels -->
  ${dayLabelsSvg}

  <!-- Heatmap cells -->
  ${cells.join("\n  ")}

  <!-- Legend -->
  ${legend}

  <!-- Total -->
  ${totalLabel}
</svg>`.trim();
};

const contributionsSvg = buildContributionsHeatmap();

/* ------------------------------------------------------------------ */
/*  Write files                                                        */
/* ------------------------------------------------------------------ */

mkdirSync("assets/svg", { recursive: true });

writeFileSync("assets/svg/stats.svg", statsSvg);
console.log("  ✓ stats.svg");

writeFileSync("assets/svg/streak.svg", streakSvg);
console.log("  ✓ streak.svg");

writeFileSync("assets/svg/langs.svg", langsSvg);
console.log("  ✓ langs.svg");

writeFileSync("assets/svg/contributions.svg", contributionsSvg);
console.log("  ✓ contributions.svg");

console.log(`\nAll SVGs written to assets/svg/ for @${USERNAME}`);
