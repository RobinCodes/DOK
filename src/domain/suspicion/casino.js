// Detector: the casino (Rulebook §5, §8.3).
//
// Casino games are random walks with a small house edge: over a visit a
// player's chips drift slightly down and spread out roughly with the square
// root of the time played. Honest cash-outs therefore look alike, and the
// ways to cheat leave fingerprints:
//
//  - Return outliers: log(chips out / chips in), scaled by √minutes when the
//    visit length is known, compared with all other cash-outs (robust z).
//  - Staff lift: one staff member's cash-outs are systematically higher than
//    everyone else's (Mann–Whitney U test). A dealer "paying" friends looks like this.
//  - Reconciliation: a staff member recorded more chips than were physically
//    counted in their box, i.e. chips that never existed became points.
//  - Balance mismatch: in detailed mode the cash-out differs from the recorded balance.
//  - Dealer win rate: at house games, players of one dealer win far more often
//    than at the other dealers (binomial test against the others' rate).
//  - Chip dumping: in player-vs-player games, one player repeatedly losing most
//    of their stack to the same other player. With points per player, two
//    friends can concentrate chips; this finds the transfer.
//  - Big wins, own-class handling and repeat visits.

import { minutesBetween } from '../time.js';
import { binomialUpperTail, groupBy, mannWhitneyGreater, median, pStrength, ramp, robustZ, sumBy } from './stats.js';

function returns(data, flag) {
  const rows = data.cashouts.map((c) => {
    const r = Math.log((c.chips + 1) / (c.start_chips + 1));
    const minutes = c.recorded ? Math.max(minutesBetween(c.visit_at, c.created_at), 5) : null;
    return { c, r, scaled: minutes ? r / Math.sqrt(minutes) : null };
  });
  if (rows.length < 5) return rows;

  const useScaled = rows.every((x) => x.scaled !== null);
  const values = rows.map((x) => (useScaled ? x.scaled : x.r));
  for (const x of rows) {
    const z = robustZ(useScaled ? x.scaled : x.r, values, useScaled ? 0.03 : 0.1);
    if (z > 3) flag('cashout', x.c.id, 'casino', ramp(z, 3, 8), 'sus.casino.return', { z: z.toFixed(1) });
  }

  const overall = median(rows.map((x) => x.r));
  for (const mine of groupBy(rows, (x) => x.c.created_by).values()) {
    const others = rows.filter((x) => x.c.created_by !== mine[0].c.created_by);
    if (mine.length < 5 || others.length < 5) continue;
    const p = mannWhitneyGreater(mine.map((x) => x.r), others.map((x) => x.r));
    const strength = pStrength(p, 2, 5);
    if (strength === 0) continue;
    for (const x of mine) {
      if (x.r > overall) flag('cashout', x.c.id, 'casino', strength, 'sus.casino.staffLift', { staff: x.c.creator, p: p.toExponential(1) });
    }
  }
  return rows;
}

function bookkeeping(data, flag) {
  if (data.ownClassMode === 'flag') {
    for (const c of data.cashouts) if (c.creator_class && c.creator_class === c.class_id) flag('cashout', c.id, 'own_class', 1, 'sus.casino.ownClass');
  }

  const visitsPerPerson = groupBy(data.visits, (v) => `${v.program_id}:${v.person_key}`);
  for (const c of data.cashouts) {
    const visits = visitsPerPerson.get(`${c.program_id}:${c.person_key}`)?.length ?? 0;
    if (visits > 1) flag('cashout', c.id, 'casino', 0.6, 'sus.casino.repeat', { visits });
  }

  for (const count of data.counts) {
    const mine = data.cashouts.filter((c) => c.created_by === count.staff_id && c.program_id === count.program_id);
    const recorded = sumBy(mine, (c) => c.chips);
    const diff = count.chips - recorded;
    if (diff >= 0) continue;
    const strength = ramp(-diff / Math.max(recorded, 1), 0.02, 0.2);
    for (const c of mine) flag('cashout', c.id, 'casino', strength, 'sus.casino.reconciliation', { diff: -diff });
  }

  const deltas = groupBy(data.results, (r) => r.visit_id);
  for (const c of data.cashouts) {
    if (!deltas.has(c.visit_id)) continue;
    const balance = c.start_chips + sumBy(deltas.get(c.visit_id), (r) => r.delta);
    if (c.chips !== balance) {
      const strength = Math.max(0.3, ramp(Math.abs(c.chips - balance) / Math.max(balance, 1), 0, 0.5));
      flag('cashout', c.id, 'casino', strength, 'sus.casino.mismatch', { chips: c.chips, balance });
    }
  }
}

function games(data, flag) {
  const roundById = new Map(data.rounds.map((r) => [r.id, r]));
  const withRound = data.results.map((res) => ({ ...res, round: roundById.get(res.round_id) })).filter((res) => res.round);

  // Dealer win rate at house games.
  const house = withRound.filter((res) => res.round.game_kind === 'house');
  const wins = house.filter((res) => res.delta > 0).length;
  for (const mine of groupBy(house, (res) => res.round.created_by).values()) {
    const myWins = mine.filter((res) => res.delta > 0).length;
    const baseline = (wins - myWins + 1) / (house.length - mine.length + 2);
    if (mine.length < 10 || myWins / mine.length <= baseline) continue;
    const strength = pStrength(binomialUpperTail(myWins, mine.length, baseline));
    const vars = { staff: mine[0].round.creator, rate: Math.round((myWins / mine.length) * 100), baseline: Math.round(baseline * 100) };
    for (const res of mine) if (res.delta > 0) flag('round', res.round_id, 'casino', strength, 'sus.casino.winRate', vars);
  }

  // Chip dumping between players: each loser's loss is shared out among the winners of the round.
  const start = new Map(data.visits.map((v) => [v.id, v.start_chips]));
  const flows = new Map();
  for (const round of groupBy(withRound.filter((res) => res.round.game_kind === 'pvp'), (res) => res.round_id).values()) {
    const winners = round.filter((res) => res.delta > 0);
    const totalWon = sumBy(winners, (res) => res.delta);
    for (const loser of round.filter((res) => res.delta < 0)) {
      for (const winner of winners) {
        const key = `${loser.visit_id}>${winner.visit_id}`;
        const flow = flows.get(key) ?? { amount: 0, rounds: new Set(), loser: loser.visit_id };
        flow.amount += (-loser.delta * winner.delta) / totalWon;
        flow.rounds.add(loser.round_id);
        flows.set(key, flow);
      }
    }
  }
  for (const flow of flows.values()) {
    const ratio = flow.amount / Math.max(start.get(flow.loser) ?? 1, 1);
    const strength = ramp(ratio, 0.75, 1.5) * (flow.rounds.size >= 2 ? 1 : 0.4);
    if (strength > 0) for (const roundId of flow.rounds) flag('round', roundId, 'casino', strength, 'sus.casino.dumping', { share: Math.round(ratio * 100) });
  }

  // Unusually large single wins within the same kind of game.
  for (const list of groupBy(withRound.filter((res) => res.delta > 0), (res) => res.round.game_id).values()) {
    if (list.length < 5) continue;
    const values = list.map((res) => res.delta);
    for (const res of list) {
      const z = robustZ(res.delta, values);
      if (z > 3.5) flag('round', res.round_id, 'casino', ramp(z, 3.5, 10), 'sus.casino.bigWin', { z: z.toFixed(1) });
    }
  }
}

export function detectCasino(data, flag) {
  returns(data, flag);
  bookkeeping(data, flag);
  games(data, flag);
}
