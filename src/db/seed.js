// Initial content for a fresh database, taken from the rulebook.
// Everything here is only a starting point: the superadmin can change every
// program, reason, number and formula at runtime. Classes and accounts are
// NOT seeded; they are created by the superadmin (classes) and on the console (accounts).

const PROGRAMS = [
  {
    slug: 'nyitobuli',
    name_hu: 'Nyitóbuli',
    name_en: 'Opening party',
    when_hu: '2026. szeptember 18.',
    when_en: '18 September 2026',
    style_budget: 90, // Rulebook §4.2: 90 style points per organizer for the whole party
    description_hu:
      'A teaházban lehet szerezni ún. „menetlevelet”, amire az egész program során pecséteket vagy kilyukasztott formákat gyűjthettek. ' +
      'Minden programon lehet pecsétet szerezni, kivéve a kaszinóban és a mini bajnokságokon, mert ott egyedi pontozás lesz. ' +
      'A menetleveleket 17:30-kor, a zenés buli előtt gyűjtjük össze egy dobozban a Kis tornaterem előtt. ' +
      'Egész este lehet stíluspontokat szerezni, egyes programokon (társas, csocsó, darts, ping-pong) pedig részvételi pontokat is. ' +
      'A mini bajnokságok győztese nemcsak pontot szerez az osztályának, hanem egy 1000 Ft értékű büfékupont is nyer. ' +
      'A teaházban sem csak enni lehet: progi pontokat is szerezhettek.',
    description_en:
      'At the tea house you can pick up a “route sheet” and collect stamps or punched shapes on it throughout the event. ' +
      'Every station gives stamps except the casino and the mini championships, which have their own scoring. ' +
      'Route sheets are collected at 17:30, before the music party, in a box in front of the small gym. ' +
      'Style points can be earned all evening, and some stations (board games, foosball, darts, table tennis) also give participation points. ' +
      'Mini championship winners earn points for their class and a 1000 HUF buffet voucher. ' +
      'The tea house isn’t just for eating: you can earn program points there too.',
  },
  {
    slug: 'halloween',
    name_hu: 'Halloween-i napok',
    name_en: 'Halloween days',
    description_hu: 'Díjazzuk, hogy egy osztályból hányan öltöznek be, és a kreativitásotokra is odafigyelünk.',
    description_en: 'We reward how many people in a class dress up, and we look at creativity too.',
  },
  {
    slug: 'sutivasar',
    name_hu: 'Sütivásár',
    name_en: 'Bake sale',
    description_hu:
      'Főként az számít, hogy hányan készültök vagy süttök süteményt erre a napra, és hogy a zsűrinek melyik osztályok süteményei ízlenek a legjobban.',
    description_en: 'What matters most is how many of you bake for the day, and which classes’ cakes the jury likes best.',
  },
  {
    slug: 'sleepover',
    name_hu: 'Sleepover',
    name_en: 'Sleepover',
    description_hu: 'Játsszatok úgy, mint eddig, és gyűjtsetek minél több pontot az osztályotoknak!',
    description_en: 'Play like you always do and collect as many points as you can for your class!',
  },
  {
    slug: 'suliga',
    name_hu: 'Su-liga',
    name_en: 'School league (Su-liga)',
    description_hu: 'Jelentkezzetek minél többen, és szerezzetek minél több pontot az osztályotoknak!',
    description_en: 'Sign up in numbers and win as many points as you can for your class!',
  },
  {
    slug: 'temanapok',
    name_hu: 'Témanapok',
    name_en: 'Theme days',
    when_hu: 'Szerdánként',
    when_en: 'On Wednesdays',
    description_hu:
      'Legyetek ti az az osztály, ahol a legtöbben alkalmazkodnak a szerdai napok témáihoz! (Természetesen a kreativitást itt is pontozzuk.)',
    description_en: 'Be the class where the most people follow the Wednesday themes! (Creativity earns points here too.)',
  },
  {
    slug: 'istvan-nap',
    name_hu: 'István-nap',
    name_en: 'St. Stephen’s Day',
    when_hu: '2027. április 17.',
    when_en: '17 April 2027',
    description_hu:
      'Az utolsó program, ahol még pontot szerezhettek az osztályotoknak, hogy esélyetek legyen megnyerni a 2 szabad napot! (A 2. és 3. helyezett 1 szabad napot kap.)',
    description_en: 'The last chance to earn points for your class, and a shot at the 2 days off! (2nd and 3rd place get 1 day off.)',
  },
  {
    slug: 'arany-cikesz',
    name_hu: 'Arany cikesz',
    name_en: 'Golden Snitch',
    when_hu: 'Kéthetente',
    when_en: 'Every two weeks',
    description_hu: 'Kéthetente elrejtünk egy arany labdát az iskola területén. Ha megtaláljátok, 60 pontot szerezhettek.',
    description_en: 'Every two weeks we hide a golden ball somewhere on the school grounds. Find it and win 60 points.',
  },
];

const style = (name_hu, name_en) => ({ name_hu, name_en, kind: 'style', min_points: 1, max_points: 90 });
const minutes = (name_hu, name_en) => ({
  name_hu,
  name_en,
  kind: 'minutes',
  min_points: 1,
  max_points: 240,
  formula: 'minutes * points_per_minute', // Rulebook §4.3: 1 point per minute
  params: { points_per_minute: 1, max_minutes: 240 },
});
const classLevel = (name_hu, name_en, max_points = 500) => ({ name_hu, name_en, kind: 'manual', needs_person: 0, min_points: 1, max_points });

const REASONS = {
  nyitobuli: [
    style('Stíluspont – ivóverseny', 'Style points – drinking contest'),
    style('Stíluspont – evőverseny', 'Style points – eating contest'),
    style('Stíluspont – karaoke', 'Style points – karaoke'),
    style('Stíluspont – színjátszósok', 'Style points – drama club'),
    style('Stíluspont – győzelem (csocsó, darts, ping-pong, társas)', 'Style points – win (foosball, darts, table tennis, board games)'),
    minutes('Részvétel – csocsó', 'Participation – foosball'),
    minutes('Részvétel – darts', 'Participation – darts'),
    minutes('Részvétel – ping-pong', 'Participation – table tennis'),
    minutes('Részvétel – társasjáték', 'Participation – board games'),
    {
      name_hu: 'Menetlevél (osztályonként)',
      name_en: 'Route sheets (per class)',
      kind: 'formula',
      needs_person: 0,
      min_points: 1,
      max_points: 5000,
      formula: 'stamps * stamp_points + people * person_points', // Rulebook §4.1
      params: { stamp_points: 5, person_points: 2, max_entries_per_class: 1 },
    },
    {
      name_hu: 'Mini bajnokság – győzelem',
      name_en: 'Mini championship – win',
      kind: 'formula',
      min_points: 1,
      max_points: 200,
      formula: 'participants * per_participant + minutes * per_minute', // Rulebook §4.5 (proposal)
      params: { per_participant: 2, per_minute: 0.5, max_participants: 64, max_minutes: 120 },
    },
    {
      name_hu: 'TB barátnőt keres',
      name_en: '“TB barátnőt keres” show',
      kind: 'pool',
      min_points: 0,
      max_points: 100,
      formula: 'participants * per_participant', // Rulebook §4.6: performers × 10
      params: { per_participant: 10 },
    },
    {
      name_hu: 'Kaszinó',
      name_en: 'Casino',
      kind: 'casino',
      min_points: 0,
      max_points: 1000,
      formula: 'chips / chips_per_point', // Rulebook §5.7 (proposal)
      params: { chips_per_point: 10 },
    },
  ],
  halloween: [classLevel('Beöltözés (létszám alapján)', 'Costumes (headcount)'), classLevel('Kreativitás', 'Creativity')],
  sutivasar: [classLevel('Sütők száma', 'Number of bakers'), classLevel('Zsűri értékelése', 'Jury score')],
  sleepover: [classLevel('Sleepover pontok', 'Sleepover points')],
  suliga: [classLevel('Su-liga eredmény', 'League result')],
  temanapok: [classLevel('Témához alkalmazkodás (létszám alapján)', 'Following the theme (headcount)'), classLevel('Kreativitás', 'Creativity')],
  'istvan-nap': [classLevel('István-nap pontok', 'St. Stephen’s Day points')],
  'arany-cikesz': [{ name_hu: 'Arany labda megtalálása', name_en: 'Found the golden ball', kind: 'manual', min_points: 60, max_points: 60 }],
};

const CASINO_GAMES = [
  ['Rulett', 'Roulette', 'house'],
  ['Blackjack', 'Blackjack', 'house'],
  ['Póker', 'Poker', 'pvp'],
  ['Kocka', 'Dice', 'house'],
  ['Szerencsekerék', 'Wheel of fortune', 'house'],
  ['Egyéb (a ház ellen)', 'Other (against the house)', 'house'],
  ['Egyéb (játékosok között)', 'Other (between players)', 'pvp'],
];

export function seed(db) {
  const insertProgram = db.prepare(`
    INSERT INTO programs (slug, name_hu, name_en, description_hu, description_en, when_hu, when_en, style_budget, sort)
    VALUES ($slug, $name_hu, $name_en, $description_hu, $description_en, $when_hu, $when_en, $style_budget, $sort)`);
  const insertReason = db.prepare(`
    INSERT INTO reasons (program_id, name_hu, name_en, kind, needs_person, min_points, max_points, formula, sort)
    VALUES ($program_id, $name_hu, $name_en, $kind, $needs_person, $min_points, $max_points, $formula, $sort)`);
  const insertParam = db.prepare('INSERT INTO reason_params (reason_id, name, value) VALUES (?, ?, ?)');
  const insertGame = db.prepare('INSERT INTO casino_games (name_hu, name_en, kind, sort) VALUES (?, ?, ?, ?)');

  db.exec('BEGIN');
  try {
    PROGRAMS.forEach((p, i) => {
      const { lastInsertRowid: programId } = insertProgram.run({
        when_hu: '',
        when_en: '',
        style_budget: 0,
        ...p,
        sort: i,
      });
      REASONS[p.slug].forEach((r, j) => {
        const { params = {}, ...fields } = r;
        const { lastInsertRowid: reasonId } = insertReason.run({
          needs_person: 1,
          formula: '',
          ...fields,
          program_id: programId,
          sort: j,
        });
        for (const [name, value] of Object.entries(params)) insertParam.run(reasonId, name, value);
      });
    });
    CASINO_GAMES.forEach(([hu, en, kind], i) => insertGame.run(hu, en, kind, i));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
