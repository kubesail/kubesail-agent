// @flow

const http = require('http')
const logger = require('../shared/logger')

const testEndpoint = http.createServer((req, res) => {
  logger.info('Responding to request:', { url: req.url })
  if (req.url === '/qotm') {
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true, quote: 'Everything works, boss!' }))
  } else {
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true }))
  }
})

testEndpoint.listen(8000)
logger.info('Test endpoint listening!')
