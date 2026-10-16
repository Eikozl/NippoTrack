import {
  Bell, BookMarked, BookOpen, BookOpenText, Bookmark, CalendarDays, CalendarRange, ChartNoAxesCombined, Check, Circle, CircleUserRound,
  Clock, createElement, Ellipsis, FileText, Flag, Flame, Globe, History, House, Library,
  Menu, Moon, Newspaper, PieChart, Plus, Search, Settings, SlidersHorizontal, Square, Star, Sun, Tag, Target, Trash2, Users, Volume2, VolumeX, X
} from 'lucide';

// V6 bespoke module glyphs (NippoTrack-authored, lucide-compatible IconNodes).
// Same 24-grid, same round caps/joins, same currentColor discipline as the
// kept Lucide set — authorship without a second visual language. Only
// rect/line/circle/polyline primitives; fills appear solely on seal dots.
export const CUSTOM_GLYPHS = {
  // Ledger card with a hanko seal: the study record itself.
  dashboard: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
    ['line', { x1: '7', y1: '9', x2: '17', y2: '9' }],
    ['line', { x1: '7', y1: '13', x2: '17', y2: '13' }],
    ['line', { x1: '7', y1: '17', x2: '12.5', y2: '17' }],
    ['rect', { x: '15', y: '15', width: '3.6', height: '3.6', fill: 'currentColor', stroke: 'none', transform: 'rotate(-8 16.8 16.8)' }]
  ],
  // Verdict stamp: the review decision, signed.
  review: [
    ['rect', { x: '4', y: '4', width: '16', height: '16', rx: '3' }],
    ['polyline', { points: '8 12.3 11 15.5 16.5 9', 'stroke-width': '2.4' }]
  ],
  // Session log: ruled lines with square bullets.
  sessions: [
    ['rect', { x: '3.5', y: '4.5', width: '3', height: '3', rx: '0.5' }],
    ['rect', { x: '3.5', y: '10.5', width: '3', height: '3', rx: '0.5' }],
    ['rect', { x: '3.5', y: '16.5', width: '3', height: '3', rx: '0.5' }],
    ['line', { x1: '9', y1: '6', x2: '19', y2: '6' }],
    ['line', { x1: '9', y1: '12', x2: '16', y2: '12' }],
    ['line', { x1: '9', y1: '18', x2: '19', y2: '18' }]
  ],
  // Word card with furigana: the ruby line above the word line.
  vocabulary: [
    ['rect', { x: '4', y: '7', width: '16', height: '13', rx: '2' }],
    ['line', { x1: '9.5', y1: '11', x2: '14.5', y2: '11' }],
    ['line', { x1: '7', y1: '15.5', x2: '17', y2: '15.5', 'stroke-width': '2.2' }]
  ],
  // 日 (sun/day): the practice character — study days, legible at any size.
  kanji: [
    ['rect', { x: '7', y: '3', width: '10', height: '18', rx: '1' }],
    ['line', { x1: '7', y1: '12', x2: '17', y2: '12' }]
  ],
  // Parse tree: grammar as structure, trunk with two branches.
  grammar: [
    ['line', { x1: '3.5', y1: '19', x2: '20.5', y2: '19' }],
    ['line', { x1: '9', y1: '19', x2: '9', y2: '6' }],
    ['line', { x1: '9', y1: '10.5', x2: '15', y2: '10.5' }],
    ['line', { x1: '9', y1: '6', x2: '18', y2: '6' }],
    ['circle', { cx: '15', cy: '10.5', r: '1.1', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '18', cy: '6', r: '1.1', fill: 'currentColor', stroke: 'none' }]
  ],
  // Lens over text lines: inspect the real sentence.
  analyzer: [
    ['line', { x1: '3', y1: '6', x2: '13', y2: '6' }],
    ['line', { x1: '3', y1: '10', x2: '10', y2: '10' }],
    ['circle', { cx: '15.5', cy: '15', r: '4.5' }],
    ['line', { x1: '18.7', y1: '18.2', x2: '21.5', y2: '21' }]
  ],
  // Stamped bars: three ascending measures over a ruled baseline.
  statistics: [
    ['line', { x1: '3', y1: '20.5', x2: '21', y2: '20.5' }],
    ['line', { x1: '7.5', y1: '20', x2: '7.5', y2: '14', 'stroke-width': '2.6' }],
    ['line', { x1: '12', y1: '20', x2: '12', y2: '9', 'stroke-width': '2.6' }],
    ['line', { x1: '16.5', y1: '20', x2: '16.5', y2: '5', 'stroke-width': '2.6' }]
  ]
};

const ICONS = {
  dashboard: CUSTOM_GLYPHS.dashboard,
  sessions: CUSTOM_GLYPHS.sessions,
  vocabulary: CUSTOM_GLYPHS.vocabulary,
  kanji: CUSTOM_GLYPHS.kanji,
  analyzer: CUSTOM_GLYPHS.analyzer,
  grammar: CUSTOM_GLYPHS.grammar,
  goals: Flag,
  content: Library,
  community: Globe,
  notes: FileText,
  tags: Tag,
  review: CUSTOM_GLYPHS.review,
  immersion: BookOpenText,
  reading: Newspaper,
  statistics: CUSTOM_GLYPHS.statistics,
  settings: Settings,
  today: CalendarDays,
  week: CalendarRange,
  streak: Flame,
  quickAdd: Plus,
  activity: ChartNoAxesCombined,
  distribution: PieChart,
  recent: History,
  clock: Clock,
  sun: Sun,
  moon: Moon,
  user: CircleUserRound,
  users: Users,
  home: House,
  bell: Bell,
  book: BookOpen,
  plus: Plus,
  dots: Ellipsis,
  menu: Menu,
  search: Search,
  filter: SlidersHorizontal,
  close: X,
  check: Check,
  bookmark: Bookmark,
  bookmarkSaved: BookMarked,
  trash: Trash2,
  star: Star,
  volume: Volume2,
  mute: VolumeX,
  stop: Square
};

const TITLES = {
  dashboard: 'dashboard',
  'study sessions': 'sessions',
  vocabulary: 'vocabulary',
  kanji: 'kanji',
  'text analyzer': 'analyzer',
  grammar: 'grammar',
  goals: 'goals',
  content: 'content',
  'content log': 'content',
  notes: 'notes',
  tags: 'tags',
  review: 'review',
  immersion: 'immersion',
  reading: 'reading',
  statistics: 'statistics',
  settings: 'settings'
};

export function icon(name, { className = '', size = 20, label } = {}) {
  const node = createElement(ICONS[name] || Circle, {
    width: size,
    height: size,
    class: `jlt-icon ${className}`.trim(),
    'stroke-width': 1.75,
    ...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true', focusable: 'false' })
  });
  return node;
}

export function iconTile(name, { className = '', size = 19, label } = {}) {
  const tile = document.createElement('span');
  tile.className = `icon-tile ${className}`.trim();
  tile.appendChild(icon(name, { size, label }));
  return tile;
}

export function iconForTitle(title) {
  return TITLES[String(title || '').toLowerCase()] || null;
}

export const moduleIconMap = Object.freeze({
  dashboard: 'dashboard', sessions: 'sessions', vocabulary: 'vocabulary', kanji: 'kanji', analyzer: 'analyzer', immersion: 'immersion', reading: 'reading', grammar: 'grammar', goals: 'goals', content: 'content', notes: 'notes', tags: 'tags', review: 'review', statistics: 'statistics', settings: 'settings', search: 'search', community: 'community'
});
