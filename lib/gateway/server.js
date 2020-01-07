// @flow

const https = require('https')
const fs = require('fs')
const express = require('express')
const compression = require('compression')
const timeout = require('connect-timeout')
const morgan = require('morgan')
const helmet = require('helmet')

const logger = require('../shared/logger')
const { LOG_FORMAT, TLS_KEY_PATH, TLS_CERT_PATH, TLS_CHAIN_PATH } = require('../shared/config')
const redis = require('./redis')

const server = express()

server.use(timeout(30000))
server.use(compression())

let ca
if (TLS_CHAIN_PATH && fs.existsSync(TLS_CHAIN_PATH)) ca = TLS_CHAIN_PATH // eslint-disable-line

const httpsServer = https.createServer(
  {
    key: fs.readFileSync(TLS_KEY_PATH), // eslint-disable-line
    cert: fs.readFileSync(TLS_CERT_PATH), // eslint-disable-line
    ca: ca,
    honorCipherOrder: true
  },
  // $FlowIssue
  server
)

function getRealIp(req /*: express$Request */) {
  let realIp =
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for'] ||
    (req.connection && req.connection.remoteAddress) ||
    // $FlowIssue
    req.address // for websocket
  // Some proxies will append a list of ip addresses - the "remote ip" is the first in the list
  if (realIp && realIp.indexOf(',') > -1) {
    realIp = realIp.split(',')[0]
  }
  return realIp
}

// Don't spam the logs with health-check messages
function skipHealthCheckLogs(req, res) {
  return (req.path === '/health' || req.path === '/healthz') && res.statusCode === 200
}
server.use(morgan(LOG_FORMAT, { skip: skipHealthCheckLogs }))

server.use((
  req /*: express$Request */,
  res /*: express$Response */,
  next /*: express$NextFunction */
) => {
  res.header('X-Frame-Options', 'SAMEORIGIN')
  res.header('X-XSS-Protection', '1; mode=block')
  res.header('X-Content-Type-Options', 'nosniff')
  next()
})

server.get('/robots.txt', (req /*: express$Request */, res /*: express$Response */) => {
  res.setHeader('Cache-Control', 'public, max-age=604800')
  res.setHeader('Content-Type', 'text/plain')
  res.send('User-Agent: *\nDisallow: /\n')
})

server.disable('x-powered-by')

// Additional access logging tokens
morgan.token('remote-addr', getRealIp)
morgan.token('url', function(req) {
  return escape(req.path)
})

if (process.env.NODE_ENV !== 'development') {
  server.use(
    helmet.hsts({
      maxAge: 31536000000, // One year
      includeSubDomains: true,
      force: true
    })
  )
}

// Note that we _do not call_ next() - this -correctly- sends a 500 forward
// This should be considered a critical error that should _never_ be reached.
// If you are troubleshooting this code being reached in production by bad user input, then
// FIX WHATEVER CONTROLLER REACHED THIS HANDLER!!
// 500s should _never ever_ be a result of bad input, user error, or malicious behavior
// 500s mean _we had an issue_, and we _should never have issues_! :)
function serverErrorHandler(
  err /*: Error|number */,
  _req /*: express$Request */,
  res /*: express$Response */,
  _next /*: express$NextFunction */
) {
  if (typeof err === 'number' && err !== 500) {
    logger.error(`serverErrorHandler reached with err status of: ${err}`)
    return res.sendStatus(err)
    // $FlowIssue
  } else if (err.type === 'entity.parse.failed') {
    logger.warn('Got invalid JSON!', { err })
    return res.sendStatus(400)
  } else {
    const errObj = {}
    if (typeof err === 'number') errObj.code = err
    else {
      errObj.message = err.message
      errObj.stack = err.stack && err.stack.split('\n')
    }
    logger.error('Unhandled serverErrorHandler: ', errObj)
    if (!res.headersSent) {
      return res.sendStatus(500)
    }
  }
}

let listeningHttps = false
function listenHttps(port /*: number */, callback /*: Function */) {
  if (listeningHttps) {
    callback()
  } else {
    listeningHttps = true
    httpsServer.listen(port, callback)
  }
}

module.exports = {
  listenHttps,
  httpsServer,
  server,
  serverErrorHandler,
  getRealIp
}
