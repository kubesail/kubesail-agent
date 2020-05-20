// @flow

const express = require('express')

const bodyParser = require('body-parser')
const timeout = require('connect-timeout')
const helmet = require('helmet')
const morgan = require('morgan')
const { isFQDN } = require('validator')

const logger = require('../shared/logger')
const { LOG_FORMAT, KUBESAIL_API_SECRET } = require('../shared/config')

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
  const ipv4 = realIp.substring(realIp.lastIndexOf(':') + 1, realIp.length)
  return ipv4
}

morgan.token('remote-addr', getRealIp)

module.exports = function () {
  const server = express()
  server.use(bodyParser.urlencoded({ extended: false }))
  const bodyParserJson = bodyParser.json()
  server.use(timeout(30000))
  server.use(bodyParserJson)
  server.use(
    morgan(LOG_FORMAT, {
      skip: function skipHealthCheckLogs(req, res) {
        return (req.path === '/health' || req.path === '/healthz') && res.statusCode === 200
      }
    })
  )
  if (process.env.NODE_ENV !== 'development') {
    server.use(helmet.hsts({ maxAge: 31536000000, includeSubDomains: true, force: true }))
  }

  // Webhook called when verified by user from KubeSail.com
  server.post('/agent/verify/:secret', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    const { agentKey, clusterAddress } = req.body
    if (!isFQDN(clusterAddress)) {
      logger.debug('/agent/verify recieved non-FQDN clusterAddress', { clusterAddress })
      return res.sendStatus(400)
    }
    // Update the mapping for this agentKey
    await this.addAgentSocketMapping({ agentKey, clusterAddress, domains: { [clusterAddress]: 1 } })

    // Request that the agent send its configuration
    await this.messageAgent(agentKey, 'config-request')

    logger.info('/agent/verify complete', { agentKey, clusterAddress })
    res.sendStatus(202)
  })

  server.put('/agent/:secret/:agentKey', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    const { agentKey } = req.params
    const { firewall, clusterAddress } = req.body
    logger.info('Got update to config', { agentKey, clusterAddress, domains: firewall })
    await this.addAgentSocketMapping({ agentKey, clusterAddress, domains: firewall })
    return res.sendStatus(200)
  })

  server.delete('/agent/:secret/:agentKey', async (req, res) => {
    if (req.params.secret !== KUBESAIL_API_SECRET) return res.sendStatus(403)
    const { agentKey } = req.params
    logger.info('Unregistering agent', { agentKey })
    await this.redis.setex(agentKey, process.env.NODE_ENV ? 30 : 3600 * 24, 'removed')
    await this.messageAgent(agentKey, 'remove-cluster')
    return res.sendStatus(200)
  })

  server.get('/agent/health/:secret/:agentKey', async (req, res) => {
    if (req.params.agentKey && req.params.secret === KUBESAIL_API_SECRET) {
      const agentKey = req.params.agentKey
      await this.messageAgent(agentKey, 'health-check')
      const connected = await this.redis.get(`akhm|${agentKey}`)
      return res.send({ connected: !!connected })
    } else return res.sendStatus(403)
  })

  server.put('/agent/watch/:startOrStop/:secret', async (req, res) => {
    if (KUBESAIL_API_SECRET !== req.params.secret) return res.sendStatus(403)
    const { startOrStop } = req.params
    const { username, agentKey, namespace } = req.body
    await this.messageAgent(agentKey, 'kube-watch', { username, startOrStop, namespace })
    logger.debug('Emitting kube-watch request to agent', { username, agentKey, startOrStop })
    res.status(202).send('{}')
  })

  server.get('/health', (req, res) => {
    res.sendStatus(200)
  })

  return server
}
