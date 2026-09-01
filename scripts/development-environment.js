function selectDevelopmentServices(argumentsList = []) {
  const integration = argumentsList.includes('--integration');

  return [
    {
      name: 'API',
      directory: 'server',
      npmArguments: ['run', 'dev'],
      environment: integration ? { POSTGRES_RUNTIME_ENV_FILE: '.env.integration' } : {}
    },
    {
      name: 'frontend',
      directory: 'client',
      npmArguments: integration ? ['run', 'dev', '--', '--mode', 'integration'] : ['run', 'dev'],
      environment: {}
    }
  ];
}

function selectNpmExecutable(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

module.exports = { selectDevelopmentServices, selectNpmExecutable };
