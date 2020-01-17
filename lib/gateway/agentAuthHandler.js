// @flow

const https = require('https')

const logger = require('../shared/logger')
const { KUBESAIL_API_SECRET } = require('../shared/config')

module.exports = function agentAuthHandler(req, res) {
  logger.debug('agentAuthHandler', { headers: req.headers })
  res.sendStatus(200)
}
