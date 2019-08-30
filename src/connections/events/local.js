const EventEmitter = require('events')

class LocalEvents extends EventEmitter {
  constructor() {
    super()
    this.subscriptions = {}
  }

  async connect() {
    //
  }

  async subscribe(subscriptionID, topic, handler) {
    this.subscriptions[subscriptionID] = { topic, handler }
    this.on(topic, event => handler(event, topic))
  }

  async unsubscribe(subscriptionID) {
    const subscription = this.subscriptions[subscriptionID]
    const { topic, handler } = subscription
    this.off(topic, handler)
    delete this.subscriptions[subscriptionID]
  }

  async publish(topic, data) {
    this.emit(topic, data)
  }
}

module.exports = LocalEvents
