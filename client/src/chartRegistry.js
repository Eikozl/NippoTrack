// Chart instance registry only — intentionally free of any chart.js import so the
// application shell (main.js) never pulls the charting library into the initial
// chunk. Page modules that render charts import builders from './charts', which
// register instances here.
const activeCharts = new Set();

export function registerChart(chart) {
  activeCharts.add(chart);
  return chart;
}

function themeColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    chartText: styles.getPropertyValue('--jlt-chart-text').trim() || '#4b5a74',
    border: styles.getPropertyValue('--jlt-border').trim() || '#ebe9e2'
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
