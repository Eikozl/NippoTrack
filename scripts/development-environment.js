function selectDevelopmentServices(argumentsList = []) {
  const integration = argumentsList.includes('--integration');

  return [
    {
      name: 'API',
      directory: 'server',
      npmArguments: ['run', 'dev'],
      // Plain development uses the safe LOCAL runtime file and must never
      // fall through to server/.env.runtime (which may target Production).
      // See server/.env.development.example for the documented shape.
      environment: integration ? { POSTGRES_RUNTIME_ENV_FILE: '.env.integration' } : { POSTGRES_RUNTIME_ENV_FILE: '.env.development' }
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
