'use strict';

// Structured logger: JSON in production (parseable by any log tool),
// human-readable in development. Zero external dependencies.

const isProd = process.env.NODE_ENV === 'production';

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function write(level, msg, meta) {
  const ts = new Date().toISOString();
  if (isProd) {
    const entry = meta && Object.keys(meta).length
      ? { ts, level, msg, ...meta }
      : { ts, level, msg };
    process.stdout.write(JSON.stringify(entry) + '\n');
  } else {
    const metaStr = meta && Object.keys(meta).length
      ? ' ' + JSON.stringify(meta)
      : '';
    const time = ts.slice(11, 19);
    const out = level === 'error' ? process.stderr : process.stdout;
    out.write(`[${time}] [${level.toUpperCase()}] ${msg}${metaStr}\n`);
  }
}

const logger = {
  info:  (msg, meta) => write('info',  msg, meta),
  warn:  (msg, meta) => write('warn',  msg, meta),
  error: (msg, meta) => write('error', msg, meta),
  debug: (msg, meta) => write('debug', msg, meta),
  formatUptime,
};

module.exports = logger;
