const nats = require('nats')
const BB = require('bluebird')

class NatsEvents {
  constructor(config = {}) {
    this.config = config
    this.subscriptions = {}
  }

  async connect() {
    const nc = nats.connect({ ...this.config, json: true, name: this.name })

    return new BB.fromCallback(resolve => {
      const reject = err => {
        throw err
      }
      nc.on('error', reject)
      nc.on('connect', () => {
        nc.off('error', reject)
        this.nats = nc
        this.nats.on('error', err => {
          throw err
        })
        resolve()
      })
    })
  }

  async subscribe(subscriptionID, topic, handler) {
    const opts = { queue: subscriptionID }
    this.subscriptions[subscriptionID] = this.nats.subscribe(topic, opts, (data, replyTo, topic) =>
      handler(data, topic)
    )
  }

  async unsubscribe(subscriptionID) {
    const id = this.subscriptions[subscriptionID]
    this.nats.unsubscribe(this.subscriptions[id])
    delete this.subscriptions[subscriptionID]
  }

  async publish(topic, data) {
    return new BB.fromCallback(resolve => this.nats.publish(topic, data, resolve)).timeout(1000)
  }
}

module.exports = NatsEvents
