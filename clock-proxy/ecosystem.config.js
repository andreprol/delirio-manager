module.exports = {
  apps: [{
    name: 'DtClockProxy',
    script: 'server.js',
    cwd: 'C:\\DtClockProxy',
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    watch: false,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    out_file: 'C:\\DtClockProxy\\logs\\out.log',
    error_file: 'C:\\DtClockProxy\\logs\\error.log',
    merge_logs: true,
  }]
};
