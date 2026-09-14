'use strict';
/**
 * KyyPureStatus — Logger minimal (timestamp + level)
 */

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Level log bisa diatur lewat env LOG_LEVEL = debug|info|warn|error|silent
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const current = () => LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function out(level, color, args) {
  if (LEVELS[level.toLowerCase()] < current()) return;
  const msg = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  // Log ke STDERR: stdout tetap bersih buat output terstruktur (mis. --json di CLI)
  // eslint-disable-next-line no-console
  console.error(`${ts()} ${color}[${level}]${'\x1b[0m'} ${msg}`);
}

const log = {
  info: (...a) => out('INFO', '\x1b[32m', a),
  warn: (...a) => out('WARN', '\x1b[33m', a),
  error: (...a) => out('ERROR', '\x1b[31m', a),
  debug: (...a) => out('DEBUG', '\x1b[36m', a),
};

module.exports = { log };
