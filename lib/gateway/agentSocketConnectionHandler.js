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

  if ((await this.redis.get(agentKey)) === 'removed') {
    return socket.emit('removed')
  }

  this.socketMapping[socket.id] = socket

  socket.on('disconnect', () => {
    this.removeAgentSocket(socket)
    delete this.socketMapping[socket.id]
    const options = {
      hostname: KubeSailApiTarget,
      headers: { 'Content-Type': 'application/json' },
      port: KubeSailApiPort,
      method: 'PUT'
    }
    if (process.env.NODE_ENV === 'development') {
      options.insecure = true
      options.rejectUnauthorized = false
    }
    const req = https.request({ ...options, path: '/agent/disconnect' }, res => {
      res.on('error', err => {
        logger.error('Gateway got error talking to KubeSail Api on socket disconnect!', {
          errMsg: err.message,
          code: err.code
        })
      })
    })
    req.write(
      JSON.stringify({
        agentKey,
        agentSecret,
        gatewaySecret: KUBESAIL_API_SECRET
      })
    )
    req.end()
  })
  socket.on('error', function (err) {
    logger.error('agentSocketConnectionHandler() socket error', { errMsg: err.message })
  })

  logger.debug('New socket connection!', { GATEWAY_INTERNAL_ADDRESS })
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
      res.on('end', async () => {
        let { clusterAddress, firewall, validDomains } = JSON.parse(buff)
        validDomains = validDomains.concat(ALWAYS_VALID_DOMAINS).filter(Boolean)
        logger.info('Agent registered! Sending configuration', {
          clusterAddress,
          firewall,
          validDomains
        })
        socket.__clusterAddress = clusterAddress
        await this.addSocketMapping(socket.id, [clusterAddress, ...validDomains])
        this.updateFirewall(firewall)
        socket.emit('agent-data', { validDomains, clusterAddress, firewall })
      })
      res.on('error', err => {
        logger.error('Gateway got error talking to KubeSail Api!', {
          errMsg: err.message,
          code: err.code
        })
        socket.disconnect()
      })
    } else if (res.statusCode === AGENT_REGISTER_PENDING) {
      logger.info('New agent pending', { agentKey })
    } else {
      logger.warn(
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
