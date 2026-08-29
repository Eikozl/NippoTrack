import Chart from 'chart.js/auto';

const activeCharts = new Set();

function commonOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#6f7472', usePointStyle: true, boxWidth: 8 } },
      tooltip: { displayColors: false }
    }
  };
}

export function destroyCharts() {
  activeCharts.forEach((chart) => chart.destroy());
  activeCharts.clear();
}

export function weeklyChart(canvas, activity) {
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: activity.map((item) => String(item.date).slice(0, 10)),
      datasets: [{
        label: 'Minutes',
        data: activity.map((item) => Number(item.minutes || 0)),
        backgroundColor: '#c5533f',
        borderRadius: 6,
        maxBarThickness: 38
      }]
    },
    options: {
      ...commonOptions(),
      scales: {
        x: { grid: { display: false }, ticks: { color: '#6f7472' } },
        y: { beginAtZero: true, grid: { color: '#ebe9e2' }, ticks: { color: '#6f7472', precision: 0 } }
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
      labels: distribution.map((item) => item.category),
      datasets: [{
        data: distribution.map((item) => Number(item.minutes || 0)),
        backgroundColor: distribution.map((item, index) => colors[index % colors.length]),
        borderColor: '#ffffff',
        borderWidth: 3
      }]
    },
    options: {
      ...commonOptions(),
      cutout: '68%',
      plugins: {
        ...commonOptions().plugins,
        legend: { position: 'bottom', labels: { color: '#6f7472', usePointStyle: true, padding: 18, boxWidth: 8 } }
      }
    }
  });
  activeCharts.add(chart);
  return chart;
}
