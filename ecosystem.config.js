module.exports = {
  apps: [
    {
      name: 'relux-laundry-api',
      script: './src/server.js',
      // ─────────────────────────────────────────────────────────────────────
      // SINGLE INSTANCE — do not raise without first adding a Socket.IO adapter.
      //
      // Each PM2 worker runs its own Socket.IO server with its own in-memory
      // adapter. A client's socket lives on exactly one worker, so an
      // io.to('user-X').emit() from worker 1 never reaches a client connected to
      // worker 3. Running multi-worker therefore delivers order updates, wallet
      // credits and chat messages to only a fraction of the people who should
      // get them — silently, with no error anywhere.
      //
      // Long-polling makes it worse: PM2 round-robins successive polling
      // requests across workers, so a handshake started on one worker is
      // unknown to the next ("Session ID unknown").
      //
      // Before scaling past 1, all of the following are required:
      //   1. @socket.io/redis-adapter (or equivalent) wired in server.js
      //   2. A shared rate-limit store — express-rate-limit defaults to
      //      in-memory, so N workers means N× the configured ceiling
      //   3. Nothing else: the interval jobs are already protected by the
      //      MongoDB lock in utils/jobLock.js
      //
      // A single Node process handles this workload comfortably.
      instances: 1,
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
