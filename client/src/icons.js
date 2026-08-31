import * as Lucide from 'lucide/dist/cjs/lucide.js';

const ICONS = {
  dashboard: Lucide.LayoutDashboard,
  sessions: Lucide.CalendarDays,
  vocabulary: Lucide.BookOpen,
  kanji: Lucide.Languages,
  grammar: Lucide.MessagesSquare,
  goals: Lucide.Target,
  content: Lucide.Library,
  notes: Lucide.FileText,
  tags: Lucide.Tag,
  review: Lucide.RefreshCw,
  statistics: Lucide.ChartNoAxesCombined,
  settings: Lucide.Settings,
  today: Lucide.CalendarDays,
  week: Lucide.CalendarRange,
  streak: Lucide.Flame,
  quickAdd: Lucide.Zap,
  activity: Lucide.ChartNoAxesCombined,
  distribution: Lucide.PieChart,
  recent: Lucide.History,
  clock: Lucide.Clock,
  sun: Lucide.Sun,
  moon: Lucide.Moon,
  menu: Lucide.Menu,
  close: Lucide.X
};

const TITLES = {
  dashboard: 'dashboard',
  'study sessions': 'sessions',
  vocabulary: 'vocabulary',
  kanji: 'kanji',
  grammar: 'grammar',
  goals: 'goals',
  content: 'content',
  notes: 'notes',
  tags: 'tags',
  review: 'review',
  statistics: 'statistics',
  settings: 'settings'
};

export function icon(name, { className = '', size = 20, label } = {}) {
  const node = Lucide.createElement(ICONS[name] || Lucide.Circle, {
    width: size,
    height: size,
    class: `jlt-icon ${className}`.trim(),
    'stroke-width': 1.9,
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
  dashboard: 'dashboard', sessions: 'sessions', vocabulary: 'vocabulary', kanji: 'kanji', grammar: 'grammar', goals: 'goals', content: 'content', notes: 'notes', tags: 'tags', review: 'review', statistics: 'statistics', settings: 'settings'
});
