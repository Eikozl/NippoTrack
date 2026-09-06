import {
  BookOpen, CalendarDays, CalendarRange, ChartNoAxesCombined, Circle, CircleUserRound,
  Clock, createElement, FileText, Flame, History, LayoutDashboard, Library, Languages,
  Menu, MessagesSquare, Moon, PieChart, RefreshCw, ScanText, Search, Settings, Sun, Tag, Target, X, Zap
} from 'lucide';

const ICONS = {
  dashboard: LayoutDashboard,
  sessions: CalendarDays,
  vocabulary: BookOpen,
  kanji: Languages,
  analyzer: ScanText,
  grammar: MessagesSquare,
  goals: Target,
  content: Library,
  notes: FileText,
  tags: Tag,
  review: RefreshCw,
  statistics: ChartNoAxesCombined,
  settings: Settings,
  today: CalendarDays,
  week: CalendarRange,
  streak: Flame,
  quickAdd: Zap,
  activity: ChartNoAxesCombined,
  distribution: PieChart,
  recent: History,
  clock: Clock,
  sun: Sun,
  moon: Moon,
  user: CircleUserRound,
  menu: Menu,
  search: Search,
  close: X
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
  statistics: 'statistics',
  settings: 'settings'
};

export function icon(name, { className = '', size = 20, label } = {}) {
  const node = createElement(ICONS[name] || Circle, {
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
  dashboard: 'dashboard', sessions: 'sessions', vocabulary: 'vocabulary', kanji: 'kanji', analyzer: 'analyzer', grammar: 'grammar', goals: 'goals', content: 'content', notes: 'notes', tags: 'tags', review: 'review', statistics: 'statistics', settings: 'settings', search: 'search'
});
