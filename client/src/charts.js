import { ArcElement, BarController, BarElement, CategoryScale, Chart, DoughnutController, Legend, LinearScale, Tooltip } from 'chart.js';
import { t } from './i18n';
import { registerChart } from './chartRegistry';

// JLT renders only bar + doughnut charts, so register exactly the
// controllers/elements/scales/plugins those need instead of 'chart.js/auto'.
Chart.register(BarController, DoughnutController, BarElement, ArcElement, CategoryScale, LinearScale, Legend, Tooltip);

function themeColors() {
  const styles = getComputedStyle(document.documentElement);
  const pick = (names, fallback) => {
    for (const name of names) {
      const value = styles.getPropertyValue(name).trim();
      if (value) return value;
    }
    return fallback;
  };
  return {
    muted: pick(['--jlt-muted'], '#6f7472'),
    border: pick(['--jlt-border'], '#ebe9e2'),
    chartText: pick(['--jlt-chart-text'], '#4b5a74')
  };
}

/* Muted Indigo/neutral palette read from canonical tokens (Part B).
 * Keeps the themeColors() mechanism + --jlt-* aliases alive: each entry
 * prefers --jlt-chart-N (which aliases --nt-chart-N and flips per theme),
 * falling back to --nt-chart-N, then to a muted light hex for test envs
 * without computed CSS. No neon, no red-hot bars. */
function chartPalette() {
  const styles = getComputedStyle(document.documentElement);
  const fallbacks = ['#5A5A8D', '#7C7CA6', '#6E625E', '#A89E93', '#4E775E', '#8A6D3B', '#556B73', '#B59672'];
  return fallbacks.map((fallback, index) => {
    const n = index + 1;
    return styles.getPropertyValue(`--jlt-chart-${n}`).trim()
      || styles.getPropertyValue(`--nt-chart-${n}`).trim()
      || fallback;
  });
}

function chartPrimary() {
  const styles = getComputedStyle(document.documentElement);
  return styles.getPropertyValue('--jlt-primary').trim()
    || styles.getPropertyValue('--nt-accent').trim()
    || '#5A5A8D';
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function commonOptions() {
  const { chartText } = themeColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    // Respect reduced motion: Chart.js animates by default, which bypasses
    // the CSS reduced-motion handling. Functionality is unchanged.
    ...(prefersReducedMotion() ? { animation: false } : {}),
    plugins: {
      legend: { labels: { color: chartText, usePointStyle: true, boxWidth: 8 } },
      tooltip: { displayColors: false }
    }
  };
}

export { destroyCharts, refreshChartTheme } from './chartRegistry';

export function weeklyChart(canvas, activity) {
  const { chartText, border } = themeColors();
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: activity.map((item) => String(item.date).slice(0, 10)),
      datasets: [{
        label: t('Minutes'),
        data: activity.map((item) => Number(item.minutes || 0)),
        backgroundColor: chartPrimary(),
        borderRadius: 6,
        maxBarThickness: 38
      }]
    },
    options: {
      ...commonOptions(),
      scales: {
        x: { grid: { display: false }, ticks: { color: chartText } },
        y: { beginAtZero: true, grid: { color: border }, ticks: { color: chartText, precision: 0 } }
      }
    }
  });
  registerChart(chart);
  return chart;
}

export function distributionChart(canvas, distribution) {
  const palette = chartPalette();
  const chart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: distribution.map((item) => t(item.category)),
      datasets: [{
        data: distribution.map((item) => Number(item.minutes || 0)),
        backgroundColor: distribution.map((item, index) => palette[index % palette.length]),
        borderColor: 'transparent',
        borderWidth: 0
      }]
    },
    options: {
      ...commonOptions(),
      cutout: '68%',
      plugins: {
        ...commonOptions().plugins,
        legend: { position: 'bottom', labels: { color: themeColors().chartText, usePointStyle: true, padding: 18, boxWidth: 8 } }
      }
    }
  });
  registerChart(chart);
  return chart;
}
