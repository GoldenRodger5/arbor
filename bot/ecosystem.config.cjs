module.exports = {
  apps: [{
    name: 'arbor-bot',
    script: 'arb-bot.mjs',
    watch: false,
    autorestart: true,
    max_restarts: 50,
    restart_delay: 10000,  // 10s between restarts
    max_memory_restart: '200M',
    env: {
      NODE_ENV: 'production',
    },
    // Logs
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
  }],
};
