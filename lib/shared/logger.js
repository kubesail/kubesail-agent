// @flow

const { createLogger, format, transports } = require('winston')
const { combine, timestamp, printf, label } = format
const { serializeError } = require('serialize-error')

const { LOG_LEVEL, LOGGING_LABEL, getRelease } = require('../shared/config')

const release = getRelease().substr(0, 7)

/* flow-include
type Logger = {
  info: Function,
  debug: Function,
  error: Function,
  warn: Function,
  silly: Function,
  onlyInProduction: Function,
  onlyInDevelopment: Function
}
*/

let loggingFormat = combine(
  timestamp(),
  label({ app: LOGGING_LABEL, release }),
  // $FlowIssue
  format.json({
    replacer: (key, value) => {
      if (value instanceof Buffer) {
        return value.toString('base64')
      } else if (value instanceof Error) {
        let err = value
        try {
          err = serializeError(value)
        } catch {}
        return err.message
      }
      return value
    }
  })
)
const loggingTransports = [new transports.Console()]

if (process.env.NODE_ENV === 'development') {
  const logFormat = printf(info => {
    const c = Object.assign({}, info)
    delete c.level
    delete c.message
    delete c.timestamp
    // Pretty print objects
    const obj = JSON.stringify(serializeError(c))
    return `${info.level}: ${info.message} ${Object.keys(c).length > 0 ? obj : ''}`
  })
  loggingFormat = combine(format.colorize(), timestamp(), logFormat)
}

const logger /*: Logger */ = createLogger({
  level: LOG_LEVEL,
  format: loggingFormat,
  transports: loggingTransports,
  colorize: true,
  prettyPrint: true
})

logger.onlyInProduction = function (loggerFunc /*: string */ = 'info') {
  Array.prototype.shift.apply(arguments)
  if (process.env.NODE_ENV !== 'development') logger[loggerFunc](...arguments)
}

logger.onlyInDevelopment = function (loggerFunc /*: string */ = 'info') {
  Array.prototype.shift.apply(arguments)
  if (process.env.NODE_ENV === 'development') logger[loggerFunc](...arguments)
}

module.exports = logger
