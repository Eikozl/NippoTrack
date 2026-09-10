# NippoTrack V3 Icon System

NippoTrack uses the `lucide` package for its interface icons. It provides lightweight, outline-based SVG icons and supports importing only the icons used by the application.

## Usage rules

- Icons identify existing modules and actions only; they never introduce functionality.
- Sidebar icons are flat. The active navigation item uses the existing inset/active treatment.
- Major cards and panel headers can use a small raised icon tile.
- Decorative SVGs are hidden from assistive technology. Icon-only controls retain their existing accessible labels.
- A semantic module always uses the same icon across navigation, page headers, and dashboard content.

## Existing module mapping

| Existing module | Lucide icon |
| --- | --- |
| Dashboard | LayoutDashboard |
| Sessions | CalendarDays |
| Vocabulary | BookOpen |
| Kanji | Languages |
| Grammar | MessagesSquare |
| Goals | Target |
| Content | Library |
| Notes | FileText |
| Tags | Tag |
| Review | RefreshCw |
| Statistics | ChartNoAxesCombined |
| Settings | Settings |

## Existing dashboard and preview mapping

| Existing component | Lucide icon |
| --- | --- |
| Today | CalendarDays |
| This week / Weekly minutes | CalendarRange |
| Current streak / Longest streak | Flame |
| Due reviews | RefreshCw |
| Quick add session | Zap |
| Study activity / Last seven days | ChartNoAxesCombined |
| Study distribution / Category balance | PieChart |
| Recent sessions | History |
| Activity calendar / session preview | CalendarDays |
| Vocabulary preview | BookOpen |
| Kanji preview | Languages |
| Grammar preview | MessagesSquare |
| Review preview | RefreshCw |
