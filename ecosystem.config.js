module.exports = {
  apps: [
    {
      name: 'relux-laundry-api',
      script: './src/server.js',
      instances: 'max', // Use all CPU cores for load balancing
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
      error_file: './src/logs/pm2-error.log',
      out_file: './src/logs/pm2-out.log',
      log_file: './src/logs/pm2-combined.log',
      time: true,
      watch: false,
      max_memory_restart: '1G',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
