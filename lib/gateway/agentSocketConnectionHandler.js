// @flow

/* flow-include
export type KsGatewayConfig = {}
*/

const https = require('https')

const {
  GATEWAY_ADDRESS,
  GATEWAY_INTERNAL_ADDRESS,
  ALWAYS_VALID_DOMAINS,
  KUBESAIL_API_TARGET,
  KUBESAIL_API_SECRET
} = require('../shared/config')
const logger = require('../shared/logger')

const [KubeSailApiTarget, KubeSailApiPort] = KUBESAIL_API_TARGET.split(':')
const AGENT_REGISTER_VALID = 200
const AGENT_REGISTER_PENDING = 202

module.exports = async function agentSocketConnectionHandler(
  socket /*: Socket */,
  retries /*: number */ = 0
) /*: false|{ validDomains: Array<string>, clusterAddress: string } */ {
  const agentKey = socket.handshake.query.key
  const agentSecret = socket.handshake.query.secret
  const username = socket.handshake.query.username

  logger.debug('Setting socket id mapping:', {
    socketId: socket.id,
    gatewayAddress: GATEWAY_INTERNAL_ADDRESS
  })
  await this.redis.set(socket.id, GATEWAY_INTERNAL_ADDRESS)

  const postData = JSON.stringify({
    username,
    agentKey,
    agentSecret,
    gatewaySecret: KUBESAIL_API_SECRET,
    gatewayAddress: GATEWAY_ADDRESS
  })

  const options = {
    hostname: KubeSailApiTarget,
    headers: { 'Content-Type': 'application/json' },
    port: KubeSailApiPort,
    method: 'POST'
  }

  if (process.env.NODE_ENV === 'development') {
    options.insecure = true
    options.rejectUnauthorized = false
  }

  const req = https.request({ ...options, path: '/agent/register' }, res => {
    if (res.statusCode === AGENT_REGISTER_VALID || res.statusCode === AGENT_REGISTER_PENDING) {
      this.bindAgentSocketEvents(socket, agentKey, agentSecret, options)
    }
    if (res.statusCode === AGENT_REGISTER_VALID) {
      let buff = ''
      res.on('data', chunk => (buff = buff + chunk))
      res.on('end', () => {
        const parsed = JSON.parse(buff)
        const clusterAddress = parsed.clusterAddress
        const validDomains = parsed.validDomains.concat(ALWAYS_VALID_DOMAINS).filter(Boolean)
        logger.info('Agent registered! Sending configuration', {
          agentKey,
          validDomains,
          clusterAddress
        })
        socket.__clusterAddress = clusterAddress
        this.addSocketMapping(socket, [clusterAddress, ...validDomains])
        socket.emit('agent-data', { validDomains, clusterAddress })
      })
    } else if (res.statusCode === AGENT_REGISTER_PENDING) {
      logger.info('New agent pending', { agentKey })
    } else {
      logger.debug(
        'Disconnected agent due to invalid agentSocketConnectionHandler reply' + res.statusCode
      )
      socket.disconnect()
    }
  })

  req.on('error', e => {
    logger.error('Failed to register agent with KubeSail API', {
      errMsg: e.message,
      code: e.code,
      type: e.type,
      retries
    })
    const retry = () => {
      setTimeout(() => {
        this.agentSocketConnectionHandler(socket, retries)
      }, Math.min(retries, 30) * 1500)
      retries++
    }
    if (e.code === 'ECONNREFUSED') retry()
  })

  req.write(postData)
  req.end()
}
