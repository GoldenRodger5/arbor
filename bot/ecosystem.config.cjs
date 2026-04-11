module.exports = {
  apps: [
    {
      name: 'arbor-arb',
      script: 'arb-bot.mjs',
      watch: false,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 10000,
      max_memory_restart: '200M',
      env: { NODE_ENV: 'production' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/arb-error.log',
      out_file: './logs/arb-out.log',
      merge_logs: true,
    },
    // Market maker disabled — thin sports markets cause one-sided fills
    // { name: 'arbor-mm', script: 'market-maker.mjs' },
    {
      name: 'arbor-health',
      script: 'healthcheck.mjs',
      cron_restart: '0 12 * * *',  // 12:00 UTC = 8:00 AM ET
      autorestart: false,          // don't restart after it finishes
      watch: false,
      env: { NODE_ENV: 'production' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/health-error.log',
      out_file: './logs/health-out.log',
      merge_logs: true,
    },
    {
      name: 'arbor-ai',
      script: 'ai-edge.mjs',
      watch: false,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 10000,
      max_memory_restart: '200M',
      env: { NODE_ENV: 'production' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/ai-error.log',
      out_file: './logs/ai-out.log',
      merge_logs: true,
    },
  ],
};
