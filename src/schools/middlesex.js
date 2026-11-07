// Middlesex School class grid, 2026–27, transcribed from the student planner
// (weeks of Mar 29 and Apr 19, 2027) and the dorm study-hours sheet.
// Monday–Friday are the same every week; only Saturday differs between BF and ADB weeks (confirmed by the founder).
// Only class blocks are listed: chapel, community time, meetings and lunch are never treated as free time.
// A weekday set to `null` would mean "not confirmed" (no automatic free blocks that day).

const P = (code, start, end) => ({ code, start, end });

const TUE = [P('G', '08:15', '09:00'), P('D', '09:05', '09:50'), P('E', '10:55', '11:40'), P('Ex', '11:40', '12:05'),
  P('B', '12:30', '13:15'), P('A', '13:20', '14:05'), P('C', '14:10', '14:55'), P('Cx', '14:55', '15:20')];
const WED = [P('F', '08:15', '09:00'), P('E', '09:05', '09:50'), P('G', '10:45', '11:30'), P('A', '11:35', '12:20'), P('Ax', '12:20', '12:45')];
const MON = [P('E', '08:15', '09:00'), P('A', '09:05', '09:50'), P('C', '10:25', '11:10'), P('F', '11:15', '12:00'),
  P('D', '13:20', '14:05'), P('B', '14:10', '14:55')];
// Thursday starts with Faculty Meeting (8:15–9:00), so the first class is at 9:05.
const THU = [P('D', '09:05', '09:50'), P('C', '09:55', '10:40'), P('B', '10:45', '11:30'), P('Bx', '11:30', '11:55'),
  P('G', '12:30', '13:15'), P('E', '13:20', '14:05'), P('F', '14:10', '14:55'), P('Fx', '14:55', '15:20')];
const FRI = [P('C', '08:15', '09:00'), P('B', '09:05', '09:50'), P('A', '10:30', '11:15'), P('D', '11:20', '12:05'), P('Dx', '12:05', '12:30'),
  P('F', '12:55', '13:40'), P('G', '13:45', '14:30')];

export const MIDDLESEX = Object.freeze({
  id: 'middlesex',
  name: 'Middlesex School',
  source: 'Student planner 2026–27 (weeks of Mar 29 and Apr 19) and the dorm study-hours sheet',
  blocks: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
  weekTypes: ['BF', 'ADB'],
  weekTypeHint: 'Check Saturday in your planner: B and F blocks = BF week; A, D and B blocks = ADB week.',
  // Weekday (0 = Sunday … 6 = Saturday) → class periods. Sunday has no classes.
  grid: {
    BF: { 0: [], 1: MON, 2: TUE, 3: WED, 4: THU, 5: FRI,
      6: [P('Bx', '09:05', '09:30'), P('B', '09:30', '10:15'), P('F', '10:20', '11:05'), P('Fx', '11:05', '11:30')] },
    ADB: { 0: [], 1: MON, 2: TUE, 3: WED, 4: THU, 5: FRI,
      6: [P('A', '09:05', '09:50'), P('D', '09:55', '10:40'), P('B', '10:45', '11:30')] },
  },
  // Dorm study hours (same for every grade): Sun–Thu 7:30–9:30 PM, Fri 7:30–9:00 PM, none on Saturday.
  study: {
    0: { start: '19:30', stop: '21:30' }, 1: { start: '19:30', stop: '21:30' }, 2: { start: '19:30', stop: '21:30' },
    3: { start: '19:30', stop: '21:30' }, 4: { start: '19:30', stop: '21:30' }, 5: { start: '19:30', stop: '21:00' }, 6: null,
  },
  // Optional school calendar: fill in to preload week types and no-class days for everyone.
  calendar: { weekTypes: {}, noClassDates: [] },
});

export const SCHOOLS = { middlesex: MIDDLESEX };
