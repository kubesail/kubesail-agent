// @flow

const { getRelease } = require('./node')
const RELEASE = getRelease().substr(0, 7)
const APP_ENV = process.env.APP_ENV || 'local'
const LOGGING_LABEL = process.env.LOGGING_LABEL || 'kubesail-agent'

const config = {
  LOG_FILE: process.env.LOG_FILE,
  LOG_LEVEL: process.env.LOG_LEVEL || 'debug',
  LOGGING_LABEL,
  APP_ENV,
  RELEASE,
  REDIS_SERVERS: [{ host: 'redis', port: 6379 }]
}

module.exports = config
