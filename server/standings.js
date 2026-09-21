// 积分表的算法：只统计已经打完的场次。
// 名次按一条链逐级往下比，某一级分出高低就停下，后面的规则不能推翻前面的结论：
// 积分 → 净胜球 → 进球数 → 并列队之间的交手结果 → 客场进球数 → 队名
const { load } = require('./store');

// 每一级规则的编号与页面用语：label 是名次旁的短标签，text 是完整说明
const RULES = {
  points: { level: 1, label: '凭积分', text: '积分更高' },
  goalDiff: { level: 2, label: '凭净胜球', text: '净胜球更多' },
  goalsFor: { level: 3, label: '凭进球数', text: '进球数更多' },
  h2h: { level: 4, label: '凭交手结果', text: '与并列球队之间的交手成绩更好' },
  awayGoals: { level: 5, label: '凭客场进球', text: '客场进球数更多' },
  name: { level: 6, label: '按队名', text: '全部规则相同，按队名排列' },
};

function emptyRow(team) {
  return {
    teamId: team.id,
    name: team.name,
    shortName: team.shortName,
    city: team.city,
    status: team.status,
    played: 0,
    win: 0,
    draw: 0,
    loss: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDiff: 0,
    awayGoalsFor: 0,
    points: 0,
    latestRound: 0,
    // 与并列球队之间的交手小计，分组排到这一级时才算
    h2h: { played: 0, points: 0, goalsFor: 0, goalsAgainst: 0, goalDiff: 0 },
    // 名次最终是靠哪一级规则定下来的，排序完成后回填
    rankRule: '',
    rankReason: '',
    rankDetail: '',
  };
}

// 把一轮比赛的结果累加到两支队身上
function applyMatch(rows, match) {
  const home = rows.get(match.homeTeamId);
  const away = rows.get(match.awayTeamId);
  if (!home || !away) return;
  const homeGoals = Number(match.homeGoals);
  const awayGoals = Number(match.awayGoals);
  if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) return;

  const points = load().meta.points;
  home.played += 1;
  away.played += 1;
  home.goalsFor += homeGoals;
  home.goalsAgainst += awayGoals;
  away.goalsFor += awayGoals;
  away.goalsAgainst += homeGoals;
  away.awayGoalsFor += awayGoals;

  if (homeGoals > awayGoals) {
    home.win += 1;
    away.loss += 1;
    home.points += points.win;
    away.points += points.loss;
  } else if (homeGoals === awayGoals) {
    home.draw += 1;
    away.draw += 1;
    home.points += points.draw;
    away.points += points.draw;
  } else {
    away.win += 1;
    home.loss += 1;
    away.points += points.win;
    home.points += points.loss;
  }

  home.goalDiff = home.goalsFor - home.goalsAgainst;
  away.goalDiff = away.goalsFor - away.goalsAgainst;
  home.latestRound = Math.max(home.latestRound, match.round);
  away.latestRound = Math.max(away.latestRound, match.round);
}

// 前三道共用的门槛：积分、净胜球、进球数全部相同才算同分并列组
function sameOverall(a, b) {
  return a.points === b.points && a.goalDiff === b.goalDiff && a.goalsFor === b.goalsFor;
}

// 统计一个并列组内部、只在组内球队之间举行的已赛场次，填到每队的 h2h 小计上
function fillHeadToHead(group, playedMatches) {
  group.forEach((row) => {
    row.h2h = { played: 0, points: 0, goalsFor: 0, goalsAgainst: 0, goalDiff: 0 };
  });
  const index = new Map(group.map((row) => [row.teamId, row]));
  const pointsRule = load().meta.points;
  playedMatches.forEach((match) => {
    const home = index.get(match.homeTeamId);
    const away = index.get(match.awayTeamId);
    if (!home || !away) return;
    const homeGoals = Number(match.homeGoals);
    const awayGoals = Number(match.awayGoals);
    home.h2h.played += 1;
    away.h2h.played += 1;
    home.h2h.goalsFor += homeGoals;
    home.h2h.goalsAgainst += awayGoals;
    away.h2h.goalsFor += awayGoals;
    away.h2h.goalsAgainst += homeGoals;
    if (homeGoals > awayGoals) home.h2h.points += pointsRule.win;
    else if (homeGoals === awayGoals) {
      home.h2h.points += pointsRule.draw;
      away.h2h.points += pointsRule.draw;
    } else {
      away.h2h.points += pointsRule.win;
    }
  });
  group.forEach((row) => { row.h2h.goalDiff = row.h2h.goalsFor - row.h2h.goalsAgainst; });
}

// 交手结果这一级依次比：相互比赛积分 → 相互比赛净胜球 → 相互比赛进球。
// 返回正负数表示 a/b 谁在前，返回 0 表示这一级仍分不出
function compareHeadToHead(a, b) {
  if (b.h2h.points !== a.h2h.points) return b.h2h.points - a.h2h.points;
  if (b.h2h.goalDiff !== a.h2h.goalDiff) return b.h2h.goalDiff - a.h2h.goalDiff;
  if (b.h2h.goalsFor !== a.h2h.goalsFor) return b.h2h.goalsFor - a.h2h.goalsFor;
  return 0;
}

// 组内相邻两队按整条链逐级比较，同时记下这一对是在哪一级分出先后的
function compareWithinGroup(a, b) {
  if (b.points !== a.points) return { diff: b.points - a.points, rule: 'points' };
  if (b.goalDiff !== a.goalDiff) return { diff: b.goalDiff - a.goalDiff, rule: 'goalDiff' };
  if (b.goalsFor !== a.goalsFor) return { diff: b.goalsFor - a.goalsFor, rule: 'goalsFor' };
  const h2h = compareHeadToHead(a, b);
  if (h2h !== 0) return { diff: h2h, rule: 'h2h' };
  if (b.awayGoalsFor !== a.awayGoalsFor) return { diff: b.awayGoalsFor - a.awayGoalsFor, rule: 'awayGoals' };
  return { diff: a.name < b.name ? -1 : 1, rule: 'name' };
}

// 名次旁的依据明细
function ruleDetail(row, rule) {
  if (rule === 'points') return `积分 ${row.points} 分`;
  if (rule === 'goalDiff') {
    const diff = row.goalDiff > 0 ? `+${row.goalDiff}` : String(row.goalDiff);
    return `净胜球 ${diff}`;
  }
  if (rule === 'goalsFor') return `总进球 ${row.goalsFor} 个`;
  if (rule === 'h2h') {
    const diff = row.h2h.goalDiff > 0 ? `+${row.h2h.goalDiff}` : String(row.h2h.goalDiff);
    return `相互 ${row.h2h.played} 场：${row.h2h.points} 分、净胜 ${diff}、进 ${row.h2h.goalsFor} 球`;
  }
  if (rule === 'awayGoals') return `客场进球 ${row.awayGoalsFor} 个`;
  return '前五条全部相同，按队名排列';
}

// 按整条链排序，并把每一对相邻球队是在哪一级分出先后的记在边界上
function resolveOrder(rows, playedMatches) {
  // 先找出前三项（积分、净胜球、进球）全相同的并列组，交手成绩只在组内球队之间统计
  const prelim = rows.slice().sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.goalDiff !== a.goalDiff) return b.goalDiff - a.goalDiff;
    if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
    return a.name < b.name ? -1 : 1;
  });
  for (let i = 0; i < prelim.length; i += 1) {
    if (i + 1 >= prelim.length || !sameOverall(prelim[i], prelim[i + 1])) continue;
    const group = [prelim[i]];
    while (i + 1 < prelim.length && sameOverall(prelim[i], prelim[i + 1])) {
      i += 1;
      group.push(prelim[i]);
    }
    fillHeadToHead(group, playedMatches);
  }

  // 再走完整条链：每对球队逐级比较，第一次分出高低的那一级就是判定规则
  const ordered = rows.slice().sort((a, b) => compareWithinGroup(a, b).diff);

  // 最终名次里连续的前三项全同球队仍是同一个并列组（交手/客场进球只在组内起作用）
  const clusters = [];
  ordered.forEach((row) => {
    const last = clusters[clusters.length - 1];
    if (last && sameOverall(last[last.length - 1], row)) last.push(row);
    else clusters.push([row]);
  });

  let index = 0;
  clusters.forEach((cluster) => {
    cluster.forEach((row, offset) => {
      // 组内多行：名次由组内边界决定，优先看与后一名之间的边界，组末一名回看前一名；
      // 单独成组：名次与相邻组之间由积分/净胜球/进球隔开，同样优先看下边界
      let rule;
      if (cluster.length > 1 && offset + 1 < cluster.length) rule = compareWithinGroup(row, cluster[offset + 1]).rule;
      else if (cluster.length > 1 && offset > 0) rule = compareWithinGroup(cluster[offset - 1], row).rule;
      else if (index + 1 < ordered.length) rule = compareWithinGroup(row, ordered[index + 1]).rule;
      else rule = index > 0 ? compareWithinGroup(ordered[index - 1], row).rule : 'points';
      row.rank = index + 1;
      row.rankRule = rule;
      row.rankReason = RULES[rule].text;
      row.rankDetail = ruleDetail(row, rule);
      index += 1;
    });
  });
  return ordered;
}

function computeTable(options) {
  const input = options && typeof options === 'object' ? options : {};
  const data = load();
  const rows = new Map();
  data.teams.forEach((team) => rows.set(team.id, emptyRow(team)));

  const playedMatches = data.matches.filter((match) => match.status === '已赛');
  playedMatches.forEach((match) => applyMatch(rows, match));

  const list = resolveOrder(Array.from(rows.values()), playedMatches);

  const keyword = typeof input.keyword === 'string' ? input.keyword.trim().toLowerCase() : '';
  const filtered = keyword
    ? list.filter((row) => row.name.toLowerCase().includes(keyword) || row.city.toLowerCase().includes(keyword))
    : list;

  return {
    season: data.meta.season,
    points: data.meta.points,
    rankRules: RULES,
    playedRounds: new Set(playedMatches.map((m) => m.round)).size,
    totalRounds: Math.max(...data.matches.map((m) => m.round), 0),
    playedMatches: playedMatches.length,
    pendingMatches: data.matches.filter((m) => m.status === '待赛').length,
    postponedMatches: data.matches.filter((m) => m.status === '延期').length,
    table: filtered,
    computedAt: new Date().toISOString(),
  };
}

// 队伍与场地名称的速查表，供赛程清单展示用
function nameMaps() {
  const data = load();
  const teams = new Map(data.teams.map((item) => [item.id, item]));
  const venues = new Map(data.venues.map((item) => [item.id, item]));
  return { teams, venues };
}

module.exports = { computeTable, nameMaps, RULES };
