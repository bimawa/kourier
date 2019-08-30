const assert = require('assert')
const Request = require('kubernetes-client/backends/request')
const { Client } = require('kubernetes-client')
const JSONStream = require('json-stream')

class Cluster {
  constructor(name, config = {}, instances = {}) {
    const clusterConfig = process.env.KUBERNETES_SERVICE_PORT
      ? Request.config.getInCluster()
      : Request.config.fromKubeconfig()

    this.connectionURL = clusterConfig.url
    const backend = new Request(clusterConfig)
    this.client = new Client({ backend })
    this.logger = instances.logger || console
  }

  async connect() {
    await this.client.loadSpec()
    this.logger.info(`Connected to cluster ${this.connectionURL}`)
  }

  listenCRDUpdate(spec, handler) {
    assert.equal(spec.kind, 'CustomResourceDefinition')
    this.client.addCustomResourceDefinition(spec)
    this.emitCustomResourceUpdates(spec, handler)
  }

  emitCustomResourceUpdates(spec, handler) {
    const { plural } = spec.spec.names
    const specGroup = spec.spec.group
    const stream = this.client.apis[specGroup].v1.watch[plural].getStream()
    // restart stream on end
    stream.on('end', () => this.emitCustomResourceUpdates(...arguments))
    stream.on('error', err => {
      throw err
    })
    const jsonStream = new JSONStream()
    stream.pipe(jsonStream)
    jsonStream.on('data', data => handler(data))
  }
}

module.exports = { Cluster }
