// 积分表的算法：只统计已经打完的场次。
// 排名并列时按 积分→净胜球→进球数→两队交手结果→客场进球数 逐级往下比，
// 某一级分出高低就停下，后面的规则不能翻前面的结论；五级仍打平才按队名兜底。
const { load } = require('./store');

// 规则级别：排序比较器在第一处分出高低的那一级返回对应标记，页面照此写明名次来由
const TIE_LEVELS = {
  points: { key: 'points', label: '积分' },
  goalDiff: { key: 'goalDiff', label: '净胜球' },
  goalsFor: { key: 'goalsFor', label: '进球数' },
  h2h: { key: 'h2h', label: '交手结果' },
  awayGoals: { key: 'awayGoals', label: '客场进球' },
  name: { key: 'name', label: '队名' },
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
  };
}

// 把一轮比赛的结果累加到两支队身上
function applyMatch(rows, match, pointsRule) {
  const home = rows.get(match.homeTeamId);
  const away = rows.get(match.awayTeamId);
  if (!home || !away) return;
  const homeGoals = Number(match.homeGoals);
  const awayGoals = Number(match.awayGoals);
  if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) return;

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
    home.points += pointsRule.win;
    away.points += pointsRule.loss;
  } else if (homeGoals === awayGoals) {
    home.draw += 1;
    away.draw += 1;
    home.points += pointsRule.draw;
    away.points += pointsRule.draw;
  } else {
    away.win += 1;
    home.loss += 1;
    away.points += pointsRule.win;
    home.points += pointsRule.loss;
  }

  home.goalDiff = home.goalsFor - home.goalsAgainst;
  away.goalDiff = away.goalsFor - away.goalsAgainst;
  home.latestRound = Math.max(home.latestRound, match.round);
  away.latestRound = Math.max(away.latestRound, match.round);
}

// 汇总每一对球队之间已经打完的交手记录：各取多少积分、各进几球、各在客场进几球
function buildHeadToHead(playedMatches, pointsRule) {
  const map = new Map();
  playedMatches.forEach((match) => {
    const homeGoals = Number(match.homeGoals);
    const awayGoals = Number(match.awayGoals);
    if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) return;
    const pair = [match.homeTeamId, match.awayTeamId].sort().join('|');
    let record = map.get(pair);
    if (!record) {
      record = {
        points: { [match.homeTeamId]: 0, [match.awayTeamId]: 0 },
        goalsFor: { [match.homeTeamId]: 0, [match.awayTeamId]: 0 },
        awayGoalsFor: { [match.homeTeamId]: 0, [match.awayTeamId]: 0 },
        matches: [],
      };
      map.set(pair, record);
    }
    record.points[match.homeTeamId] += homeGoals > awayGoals ? pointsRule.win : homeGoals === awayGoals ? pointsRule.draw : pointsRule.loss;
    record.points[match.awayTeamId] += awayGoals > homeGoals ? pointsRule.win : awayGoals === homeGoals ? pointsRule.draw : pointsRule.loss;
    record.goalsFor[match.homeTeamId] += homeGoals;
    record.goalsFor[match.awayTeamId] += awayGoals;
    record.awayGoalsFor[match.awayTeamId] += awayGoals;
    record.matches.push(match);
  });
  return map;
}

function headToHeadBetween(headToHead, teamIdA, teamIdB) {
  return headToHead.get([teamIdA, teamIdB].sort().join('|')) || null;
}

// 逐级比较：返回 { order, level }，order 为负表示 a 排在 b 前面，level 是第一次分出高低的规则级别
function compareRowsAt(a, b, headToHead) {
  if (b.points !== a.points) return { order: b.points - a.points, level: TIE_LEVELS.points.key };
  if (b.goalDiff !== a.goalDiff) return { order: b.goalDiff - a.goalDiff, level: TIE_LEVELS.goalDiff.key };
  if (b.goalsFor !== a.goalsFor) return { order: b.goalsFor - a.goalsFor, level: TIE_LEVELS.goalsFor.key };

  // 前面三项全平才看两队直接交手：交手积分高的在前；还没碰过面或积分仍相等就继续往下
  const h2h = headToHeadBetween(headToHead, a.teamId, b.teamId);
  if (h2h) {
    const pointsA = h2h.points[a.teamId] || 0;
    const pointsB = h2h.points[b.teamId] || 0;
    if (pointsB !== pointsA) return { order: pointsB - pointsA, level: TIE_LEVELS.h2h.key };
  }

  if (b.awayGoalsFor !== a.awayGoalsFor) return { order: b.awayGoalsFor - a.awayGoalsFor, level: TIE_LEVELS.awayGoals.key };

  // 五级规则全部打平：用队名给出稳定名次，并如实标注不是靠竞赛数据分出的
  return { order: a.name === b.name ? 0 : (a.name < b.name ? -1 : 1), level: TIE_LEVELS.name.key };
}

// 供排序回调使用，只取先后、不暴露级别
function compareRows(a, b, headToHead) {
  return compareRowsAt(a, b, headToHead).order;
}

// 为每一行写明名次是靠哪一级定下来的：与上一名相比第一次分出高低的那一级即为定级规则
function annotateRanks(list, headToHead) {
  list.forEach((row, index) => {
    row.rank = index + 1;
    if (index === 0) {
      row.rankReason = TIE_LEVELS.points.key;
      row.rankReasonLabel = TIE_LEVELS.points.label;
      row.rankReasonNote = '';
      return;
    }
    const prev = list[index - 1];
    const { level } = compareRowsAt(row, prev, headToHead);
    row.rankReason = level;
    row.rankReasonLabel = TIE_LEVELS[level].label;
    row.rankReasonNote = rankReasonNote(level, prev, row, headToHead);
  });
}

function rankReasonNote(level, upper, lower, headToHead) {
  if (level === TIE_LEVELS.points.key) return '';
  if (level === TIE_LEVELS.goalDiff.key) {
    return `与${upper.name}积分相同，净胜球 ${lower.goalDiff} 对 ${upper.goalDiff}，净胜球少所以排在后面`;
  }
  if (level === TIE_LEVELS.goalsFor.key) {
    return `与${upper.name}积分、净胜球相同，进球数 ${lower.goalsFor} 对 ${upper.goalsFor}，进球少所以排在后面`;
  }
  if (level === TIE_LEVELS.h2h.key) {
    const record = headToHeadBetween(headToHead, upper.teamId, lower.teamId);
    const upperPts = record ? (record.points[upper.teamId] || 0) : 0;
    const lowerPts = record ? (record.points[lower.teamId] || 0) : 0;
    return `与${upper.name}积分、净胜球、进球数都相同，两队交手 ${lower.name} ${lowerPts} 分、${upper.name} ${upperPts} 分，靠交手结果分出先后`;
  }
  if (level === TIE_LEVELS.awayGoals.key) {
    return `与${upper.name}积分、净胜球、进球数及交手结果都相同，客场进球 ${lower.awayGoalsFor} 对 ${upper.awayGoalsFor}，客场进球少所以排在后面`;
  }
  return `与${upper.name}在五级规则下全部打平，按队名排序`;
}

function computeTable(options) {
  const input = options && typeof options === 'object' ? options : {};
  const data = load();
  const rows = new Map();
  data.teams.forEach((team) => rows.set(team.id, emptyRow(team)));

  const playedMatches = data.matches.filter((match) => match.status === '已赛');
  const pointsRule = { win: data.meta.points.win, draw: data.meta.points.draw, loss: data.meta.points.loss };
  playedMatches.forEach((match) => applyMatch(rows, match, pointsRule));
  const headToHead = buildHeadToHead(playedMatches, pointsRule);

  const list = Array.from(rows.values()).sort((a, b) => compareRows(a, b, headToHead));
  annotateRanks(list, headToHead);

  const keyword = typeof input.keyword === 'string' ? input.keyword.trim().toLowerCase() : '';
  const filtered = keyword
    ? list.filter((row) => row.name.toLowerCase().includes(keyword) || row.city.toLowerCase().includes(keyword))
    : list;

  return {
    season: data.meta.season,
    points: data.meta.points,
    tieRules: [
      { key: TIE_LEVELS.points.key, label: TIE_LEVELS.points.label },
      { key: TIE_LEVELS.goalDiff.key, label: TIE_LEVELS.goalDiff.label },
      { key: TIE_LEVELS.goalsFor.key, label: TIE_LEVELS.goalsFor.label },
      { key: TIE_LEVELS.h2h.key, label: TIE_LEVELS.h2h.label },
      { key: TIE_LEVELS.awayGoals.key, label: TIE_LEVELS.awayGoals.label },
    ],
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

module.exports = {
  computeTable,
  compareRows,
  compareRowsAt,
  buildHeadToHead,
  TIE_LEVELS,
  nameMaps,
};
