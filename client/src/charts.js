import Chart from 'chart.js/auto';
import { t } from './i18n';

const activeCharts = new Set();

function themeColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    muted: styles.getPropertyValue('--jlt-muted').trim() || '#6f7472',
    border: styles.getPropertyValue('--jlt-border').trim() || '#ebe9e2',
    chartText: styles.getPropertyValue('--jlt-chart-text').trim() || '#4b5a74'
  };
}

function commonOptions() {
  const { chartText } = themeColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: chartText, usePointStyle: true, boxWidth: 8 } },
      tooltip: { displayColors: false }
    }
  };
}

export function destroyCharts() {
  activeCharts.forEach((chart) => chart.destroy());
  activeCharts.clear();
}

export function refreshChartTheme() {
  const { chartText, border } = themeColors();
  activeCharts.forEach((chart) => {
    chart.options.plugins.legend.labels.color = chartText;
    if (chart.options.scales) {
      Object.values(chart.options.scales).forEach((scale) => {
        if (scale.ticks) scale.ticks.color = chartText;
        if (scale.grid && scale.grid.display !== false) scale.grid.color = border;
      });
    }
    chart.update('none');
  });
}

export function weeklyChart(canvas, activity) {
  const { chartText, border } = themeColors();
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: activity.map((item) => String(item.date).slice(0, 10)),
      datasets: [{
        label: t('Minutes'),
        data: activity.map((item) => Number(item.minutes || 0)),
        backgroundColor: '#c5533f',
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
  activeCharts.add(chart);
  return chart;
}

export function distributionChart(canvas, distribution) {
  const colors = ['#c5533f', '#d8876d', '#556b73', '#80949a', '#b59672', '#7c6f64', '#a16c62', '#647d68'];
  const chart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: distribution.map((item) => t(item.category)),
      datasets: [{
        data: distribution.map((item) => Number(item.minutes || 0)),
        backgroundColor: distribution.map((item, index) => colors[index % colors.length]),
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
  activeCharts.add(chart);
  return chart;
}
