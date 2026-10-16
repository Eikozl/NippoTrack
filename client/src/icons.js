import {
  Bell, BookMarked, BookOpen, BookOpenText, Bookmark, CalendarDays, CalendarRange, ChartNoAxesCombined, Check, Circle, CircleUserRound,
  Clock, createElement, Ellipsis, FileText, Flag, Flame, Globe, History, House, LayoutDashboard, Library, Languages,
  Menu, Moon, Newspaper, PieChart, Plus, RefreshCw, ScanText, Search, Settings, SlidersHorizontal, Square, Star, Sun, Tag, Target, Trash2, Users, Volume2, VolumeX, X, Zap
} from 'lucide';
import vocabularyRasterUrl from './assets/icon-vocabulary.png';
import grammarRasterUrl from './assets/icon-grammar.png';

// Brand raster glyphs: hand-drawn brush characters (あ for vocabulary, 文
// for grammar) supplied as thresholded transparent PNGs. Lucide IconNodes
// cannot carry raster art, so these resolve to <img> through the same
// icon()/iconTile() API — same sizes, same labels, same tiles. Dark theme
// inverts them back to paper ink via CSS (.jlt-icon-img), which is exact
// for monochrome threshold art. Keys stay stable, so every surface (sidebar,
// headers, tiles) picks the new art with zero markup changes.
const RASTER_ICONS = {
  vocabulary: vocabularyRasterUrl,
  grammar: grammarRasterUrl
};

function rasterIcon(url, { className = '', size = 20, label } = {}) {
  const img = document.createElement('img');
  img.setAttribute('src', url);
  img.setAttribute('width', String(size));
  img.setAttribute('height', String(size));
  img.setAttribute('class', `jlt-icon jlt-icon-img ${className}`.trim());
  img.setAttribute('draggable', 'false');
  if (label) {
    img.setAttribute('role', 'img');
    img.setAttribute('aria-label', label);
  } else {
    img.setAttribute('aria-hidden', 'true');
  }
  return img;
}

const ICONS = {
  dashboard: LayoutDashboard,
  sessions: CalendarDays,
  vocabulary: 'raster:vocabulary',
  kanji: Languages,
  analyzer: ScanText,
  grammar: 'raster:grammar',
  goals: Flag,
  content: Library,
  community: Globe,
  notes: FileText,
  tags: Tag,
  review: RefreshCw,
  immersion: BookOpenText,
  reading: Newspaper,
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
  const mapped = ICONS[name];
  if (typeof mapped === 'string' && mapped.startsWith('raster:')) {
    const key = mapped.slice('raster:'.length);
    if (RASTER_ICONS[key]) return rasterIcon(RASTER_ICONS[key], { className, size, label });
  }
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
  dashboard: 'dashboard', sessions: 'sessions', vocabulary: 'vocabulary', kanji: 'kanji', analyzer: 'analyzer', immersion: 'immersion', reading: 'reading', grammar: 'grammar', goals: 'goals', content: 'content', notes: 'notes', tags: 'tags', review: 'review', statistics: 'statistics', settings: 'settings', search: 'search', community: 'community'
});
