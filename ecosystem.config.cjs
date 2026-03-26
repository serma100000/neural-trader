module.exports = {
  apps: [
    {
      name: 'neural-trader',
      script: 'src/index.ts',
      interpreter: 'node_modules/.bin/tsx',
      instances: 1,
      autorestart: true,
      max_restarts: 100,
      restart_delay: 5000,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        NT_POSTGRES_URL: 'postgresql://nt:dev_password@localhost:5432/neural_trader',
        NT_REDIS_URL: 'redis://localhost:6379',
        NT_LOG_LEVEL: 'info',
      },
      error_file: 'logs/trader-error.log',
      out_file: 'logs/trader-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      kill_timeout: 35000, // 35s -- give graceful shutdown 30s + buffer
    },
    {
      name: 'data-recorder',
      script: 'scripts/record-data.ts',
      interpreter: 'node_modules/.bin/tsx',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 10000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        NT_POSTGRES_URL: 'postgresql://nt:dev_password@localhost:5432/neural_trader',
        NT_VENUE_1_WS_URL: 'wss://stream.binance.com:9443/ws',
        NT_LOG_LEVEL: 'info',
      },
      error_file: 'logs/recorder-error.log',
      out_file: 'logs/recorder-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      kill_timeout: 10000,
    },
  ],
};
