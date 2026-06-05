module.exports = {
  apps: [{
    name:         'dt-manager',
    script:       './server.js',
    cwd:          '/opt/dt-manager',
    instances:    1,
    autorestart:  true,
    watch:        false,
    max_memory_restart: '256M',
    env: {
      NODE_ENV: 'production',
      PORT:     3847,
      DB_PATH:  '/opt/dt-manager/data/dt-manager.db',
    },
    error_file: '/opt/dt-manager/logs/error.log',
    out_file:   '/opt/dt-manager/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
