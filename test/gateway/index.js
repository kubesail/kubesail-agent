// @flow

// $FlowIssue
const http = require('http')
const https = require('https')
const { expect } = require('chai')

const { GATEWAY_HTTP_LISTEN_PORT, GATEWAY_HTTPS_LISTEN_PORT } = require('../../lib/shared/config')

const httpReqOpts = {
  hostname: '127.0.0.1',
  port: GATEWAY_HTTP_LISTEN_PORT,
  method: 'GET'
}
const httpsReqOpts = {
  hostname: '127.0.0.1',
  port: GATEWAY_HTTPS_LISTEN_PORT,
  method: 'GET'
}

const describe = global.describe
const it = global.it

describe('Gateway tests', function() {
  describe('HTTP Tunnel handling', function() {
    it('Returns a 503 when a bad host is requested', function(done) {
      const req = http.request(
        Object.assign({}, httpReqOpts, {
          headers: { host: 'foobar.com' }
        }),
        res => {
          expect(res.statusCode).to.equal(503)
          done()
        }
      )
      req.on('error', error => {
        console.error(error)
      })
      req.end()
    })
  })

  describe('HTTPS Tunnel handling', function() {
    it('Returns a 503 when a bad host is requested', function(done) {
      const req = https.request(
        Object.assign({}, httpsReqOpts, {
          headers: { host: 'foobar.com' }
        }),
        res => {
          expect(res.statusCode).to.equal(503)
          done()
        }
      )
      req.on('error', error => {
        console.error(error)
      })
      req.end()
    })
  })
})
