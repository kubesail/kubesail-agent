// @flow

const net = require('net')
const socketIoStream = require('socket.io-stream')
const { isFQDN } = require('validator')

const {
  GATEWAY_HTTP_LISTEN_PORT,
  GATEWAY_HTTPS_LISTEN_PORT,
  GATEWAY_INTERNAL_ADDRESS,
  NO_SOCKETS_CONNECTED,
  SOCKET_CONNECTED_ELSEWHERE,
  SOCKET_CONNECTED_HERE
} = require('../shared/config')
const logger = require('../shared/logger')
const { writeHeader, getWeek } = require('../shared')

module.exports = async function handleStream(
  protocol /*: string */,
  host /*: string */,
  socket /*: Socket */,
  data /*: any */
) {
  // FQDN means we don't support being accessed with an IP Address (DNS only!)
  if (!host || !isFQDN(host)) {
    logger.debug('Received request with no host header', { protocol, host })
    return writeHeader(socket, data, 501, protocol, 'NO_HOST')
  }
  const { status, gatewayAddress } = await this.getSocketStatus(host)
  const debugInfo = { host, protocol }

  if (status === SOCKET_CONNECTED_HERE) {
    logger.silly('handleStream() getSocketStatus returned SOCKET_CONNECTED_HERE', debugInfo)
    const agentSocket = this.localSocketMapping[host]

    if (!agentSocket) {
      throw new Error(`Got SOCKET_CONNECTED_HERE, but no localSocketMapping existed. Host: ${host}`)
    }

    const stream = socketIoStream.createStream({ allowHalfOpen: true })

    socketIoStream(agentSocket).emit(protocol, stream, { host })

    // Cleanup when we're done!
    socket.on('close', async () => {
      stream.end()

      // Collect bandwidth metrics for this connection!
      const date = new Date()
      const key = `${host}-${getWeek()}`

      // One week in minutes is 604800 (7 * 24 * 60 * 60)
      // We will keep bandwidth stored to the minute, so 10080 slots (7 * 24 * 60)
      // To calculate what slot we're currently in: d.getDay() * d.getHours() * d.getMinutes()
      const currentSlot = date.getDay() * date.getHours() * date.getMinutes()

      // Expire bandwidth stats after 3 months
      const expireDate = new Date()
      expireDate.setMonth(expireDate.getMonth() + 3)
      const expireAt = Math.floor(expireDate.getTime() / 1000)

      await this.redis.zincrby(`${key}-rcv`, socket.bytesWritten, currentSlot)
      await this.redis.expireat(`${key}-rcv`, expireAt)

      await this.redis.zincrby(`${key}-sent`, socket.bytesRead, currentSlot)
      await this.redis.expireat(`${key}-sent`, expireAt)

      await this.redis.zincrby(`${key}-reqs`, 1, currentSlot)
      await this.redis.expireat(`${key}-reqs`, expireAt)
    })

    stream.on('close', () => socket.end())

    socket.on('error', err => {
      logger.warn('handleStream(SOCKET_CONNECTED_HERE) error on socket:', { errMsg: err.message })
      stream.end()
    })
    stream.on('error', err => {
      logger.warn('handleStream(SOCKET_CONNECTED_HERE) error on stream:', { errMsg: err.message })
      socket.end()
    })

    // Write the initial data in this chunk
    try {
      stream.write(data)
    } catch (err) {
      logger.error(
        'handleStream(SOCKET_CONNECTED_HERE) Failed to write initial HELO down agent-socket-stream',
        {
          errMsg: err.message
        }
      )
      writeHeader(socket, data, 503, protocol, 'AGENT_ERROR')
      stream.end()
      return
    }

    // Setup bi-directional pipe
    socket.pipe(stream).pipe(socket)
  } else if (status === NO_SOCKETS_CONNECTED) {
    logger.debug('handleStream() getSocketStatus returned NO_SOCKETS_CONNECTED', debugInfo)
    writeHeader(socket, data, 502, protocol, NO_SOCKETS_CONNECTED)
  } else if (status === SOCKET_CONNECTED_ELSEWHERE && gatewayAddress) {
    logger.debug('handleStream() getSocketStatus returned SOCKET_CONNECTED_ELSEWHERE', {
      ...debugInfo,
      proxyTo: gatewayAddress,
      GATEWAY_INTERNAL_ADDRESS
    })

    const proxySocket = new net.Socket()

    logger.debug('handleStream() Forwarding to adjacent gateway request', {
      host,
      protocol,
      gatewayAddress
    })
    proxySocket.connect(
      protocol === 'http' ? GATEWAY_HTTP_LISTEN_PORT : GATEWAY_HTTPS_LISTEN_PORT,
      gatewayAddress,
      () => {
        logger.debug('handleStream() Forwarding to gateway: connected!')
        proxySocket.write(data)
        proxySocket.pipe(socket).pipe(proxySocket)
      }
    )
    socket.on('close', () => {
      try {
        proxySocket.end()
      } catch (err) {
        logger.error('handleStream() failed to close proxySocket on socket close')
      }
    })
    proxySocket.on('close', () => {
      try {
        socket.end()
      } catch (err) {
        logger.error('handleStream() failed to close socket on proxySocket close')
      }
    })
    socket.on('error', err => {
      logger.warn('handleStream() error on socket:', {
        errMsg: err.message,
        code: err.code,
        type: err.type
      })
      proxySocket.end()
    })
    proxySocket.on('error', err => {
      logger.warn('handleStream(SOCKET_CONNECTED_ELSEWHERE) error on proxySocket:', {
        errMsg: err.message,
        code: err.code,
        type: err.type
      })
      socket.end()
    })
  } else {
    logger.error('handleStream() unknown status from getSocketStatus(), disconnecting')
    socket.end()
  }
}
