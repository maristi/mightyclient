// Copyright 2012 MightyClient Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Implementation of mc.Channel for when the server runs on
 * Google Appengine.
 *
 * For client-server communication protocol, see protocol_channel.md.
 */

goog.require('goog.debug.Logger');
goog.require('goog.json');
goog.require('goog.net.XhrIo');
goog.require('goog.object');
goog.require('goog.async.Delay');
goog.require('goog.Uri');
goog.require('mc.Channel');

goog.provide('mc.GaeChannel');



/**
 * Implementation of mc.Channel for when the server runs on Google Appengine.
 * Messages in either direction are not guaranteed to be always delivered, or
 * not to be delivered multiple times.
 * @param {string} clientID Unique ID of this client.
 * @param {!goog.net.XhrIo=} opt_xhr Optional XhrIo to use for forward channel
 *     requests. If not provided, one will be instantiated.
 * @constructor
 * @extends {mc.Channel}
 */
mc.GaeChannel = function(clientID, opt_xhr) {
  goog.base(this);


  /**
   * Unique ID of this client.
   * @type {string}
   * @private
   */
  this.clientID_ = clientID;


  /**
   * XhrIo for forward channel requests.
   * @type {!goog.net.XhrIo}
   * @private
   */
  this.xhr_ = opt_xhr || new goog.net.XhrIo();
  this.registerDisposable(this.xhr_);
  this.xhr_.setTimeoutInterval(mc.GaeChannel.FORWARD_CHANNEL_TIMEOUT);
  goog.events.listen(this.xhr_, goog.net.EventType.COMPLETE,
      this.handleXhrComplete_, undefined, this);


  var location = window.location;
  /**
   * Uri for forward channel requests.
   * @type {!goog.Uri}
   * @private
   */
  this.forwardChannelUri_ = goog.Uri.create(location.protocol, null,
      location.hostname, location.port, mc.GaeChannel.BASE_URL_PATH);


  /**
   * An object where keys are service names and values are arrays of messages
   * not yet sent to the server.
   * @type {!Object.<!Array>}
   * @private
   */
  this.bufferedMessages_ = {};


  /**
   * An object where keys are service names and values are arrays of messages
   * that have been sent to the server but for which have not yet received a
   * successful response.
   * @type {!Object.<!Array>}
   * @private
   */
  this.sentMessages_ = {};


  /**
   * Number of forward channel retries so far, not counting the initial request.
   * @type {number}
   * @private
   */
  this.forwardChannelRetryCount_ = 0;


  /**
   * A timer for deferring sending of XHR request to the next cycle of brower
   * event loop.
   * @type {!goog.async.Delay}
   * @private
   */
  this.sendDelay_ = new goog.async.Delay(this.sendDelayCallback_, 0, this);
  this.registerDisposable(this.sendDelay_);


  /**
   * Set to true when this.sendDelay_ has fired but sending XHR was deferred
   * until channel is unsuspended, XHR response is received, or retry delay
   * expires.
   * @type {boolean}
   * @private
   */
  this.sendPending_ = false;


  /**
   * A timer that fires when the earliest of canWait delays expires, restarted
   * whenever a call to send method is made.
   * @type {!goog.async.Delay}
   * @private
   */
  this.retryDelay_ = new goog.async.Delay(this.retryDelayCallback_,
      mc.GaeChannel.RETRY_DELAY, this);
  this.registerDisposable(this.retryDelay_);


  /**
   * GAE socket.
   * @type {?appengine.Socket}
   * @private
   */
  this.socket_ = null;


  /**
   * Set to true when openBackwardChannel is called.
   * @type {boolean}
   */
  this.backwardChannelInitiated_ = false;


  /**
   * A timer that fires GAE socket opening times out.
   * @type {!goog.async.Delay}
   * @private
   */
  this.socketTimeout_ = new goog.async.Delay(this.socketTimeoutCallback_,
      mc.GaeChannel.SOCKET_OPEN_TIMEOUT, this);
  this.registerDisposable(this.socketTimeout_);


  this.registerService(mc.GaeChannel.SYSTEM_SERVICE_,
      this.handleSystemServiceMessage_, this);
};
goog.inherits(mc.GaeChannel, mc.Channel);


/**
 * The base relative path for making requests to the server.
 * @type {string}
 */
mc.GaeChannel.BASE_URL_PATH = '/mc_channel';


/**
 * Name of the service used internally by this module.
 * @type {string}
 * @private
 * @const
 */
mc.GaeChannel.SYSTEM_SERVICE_ = 'system';


/**
 * The timeout in milliseconds for a forward channel request.
 * @type {number}
 */
mc.GaeChannel.FORWARD_CHANNEL_TIMEOUT = 20 * 1000;


/**
 * Maximum number of retries for forward channel requests, not counting the
 * initial request.
 * @type {number}
 */
mc.GaeChannel.FORWARD_CHANNEL_MAX_RETRIES = 1;


/**
 * Delay in milliseconds before a retry of a forward channel request.
 * @type {number}
 */
mc.GaeChannel.RETRY_DELAY = 5 * 1000;


/**
 * The timeout in milliseconds for opening a GAE socket.
 * @type {number}
 */
mc.GaeChannel.SOCKET_OPEN_TIMEOUT = 20 * 1000;


/**
 * Logger.
 * @type {!goog.debug.Logger}
 * @private
 */
mc.GaeChannel.prototype.logger_ = goog.debug.Logger.getLogger(
    'mc.GaeChannel');


/** @inheritDoc */
mc.GaeChannel.prototype.unsuspend = function() {
  goog.base(this, 'unsuspend');
  if (this.sendPending_ && !this.xhr_.isActive() &&
      !this.retryDelay_.isActive()) {
    this.sendPending_ = false;
    this.sendXhr_();
  }
  if (goog.isNull(this.socket_)) {
    this.openBackwardChannel_();
  }
};


/**
 * Moves all messages in bufferedMessages_ to sentMessages_ and then sends the
 * a forward channel request with all messages in sentMessages_.
 * @private
 */
mc.GaeChannel.prototype.sendXhr_ = function() {
  this.logger_.info('sendXhr_');
  goog.object.forEach(this.bufferedMessages_,
      function(bufferedMessagesForService, service) {
        var sentMessagesForService = goog.object.setIfUndefined(
            this.sentMessages_, service, []);
        goog.asserts.assertArray(sentMessagesForService);
        goog.array.extend(sentMessagesForService, bufferedMessagesForService);
      }, this);
  this.bufferedMessages_ = {};
  var jsonMessages = goog.json.serialize(this.sentMessages_);
  var postParams = [
    'cid=' + encodeURIComponent(this.clientID_),
    'm=' + encodeURIComponent(jsonMessages)
  ];
  this.xhr_.send(this.forwardChannelUri_.clone().makeUnique(), 'POST',
      postParams.join('&'));
};


/**
 * A callback for when sendDelay_ fires.
 * @private
 */
mc.GaeChannel.prototype.sendDelayCallback_ = function() {
  this.logger_.info('sendDelay_ has fired.');
  if (this.isSuspended() || this.xhr_.isActive() ||
      this.retryDelay_.isActive()) {
    this.sendPending_ = true;
    this.logger_.info('Sending forward channel request was deferred.');
  } else {
    this.sendXhr_();
  }
};


/**
 * A callback for when retryDelay_ fires.
 * @private
 */
mc.GaeChannel.prototype.retryDelayCallback_ = function() {
  this.logger_.info('retryDelay_ has fired.');
  if (!this.isSuspended()) {
    this.sendPending_ = false;
    this.sendXhr_();
  }
};


/**
 * Relays incoming messages to appropriate services.
 * @param {*} messages Incoming messages as an object where keys are serivice
 *     names and values are arrays of payloads.
 */
mc.GaeChannel.prototype.relayIncomingMessages_ = function(messages) {
  goog.asserts.assertObject(messages);
  goog.object.forEach(messages, function(messagesForService, service) {
    goog.asserts.assertArray(messagesForService);
    goog.array.forEach(messagesForService, function(payload) {
      this.handleIncomingMessage(service, payload);
    }, this);
  }, this);
};


/**
 * Handles XhrIo's COMPLETE event.
 * @private
 */
mc.GaeChannel.prototype.handleXhrComplete_ = function() {
  if (this.xhr_.isSuccess()) {
    this.logger_.info('Forward channel request completed successfully.');
  } else if (this.xhr_.getLastErrorCode() == goog.net.ErrorCode.ABORT) {
    this.logger_.info('Forward channel request was aborted.');
  } else if (this.xhr_.getLastErrorCode() == goog.net.ErrorCode.TIMEOUT) {
    this.logger_.info('Forward channel request timed out.');
  } else {
    this.logger_.info(goog.string.subs(
        'Forward channel request failed before timing out, ' +
        ' status code %s, status text "%s".',
        this.xhr_.getStatus(), this.xhr_.getStatusText()));
  }
  if (this.xhr_.isSuccess()) {
    var responseText = this.xhr_.getResponseText();
    if (responseText.length) {
      this.logger_.info('Messages received through response to' +
          ' forward channel request.');
      var data;
      try {
        data = goog.json.unsafeParse(responseText);
      } catch (e) {
        this.logger_.warning(
            'Could not parse response to forward channel request.', e);
      }
      if (goog.isDef(data)) {
        this.relayIncomingMessages_(data);
      }
    }
    this.forwardChannelRetryCount_ = 0;
    this.sentMessages_ = {};
    if (this.sendPending_) {
      this.sendPending_ = false;
      // XHR must be sent asyncroniously because at this point XhrIo is still
      // active.
      this.sendDelay_.start();
    }
  } else if (!this.isSuspended()) {
    if (this.forwardChannelRetryCount_ <
        mc.GaeChannel.FORWARD_CHANNEL_MAX_RETRIES) {
      this.forwardChannelRetryCount_++;
      this.retryDelay_.start();
      this.logger_.info(goog.string.subs(
          'Scheduled retry #%s of forward channel request.',
          this.forwardChannelRetryCount_))
    } else {
      this.forwardChannelRetryCount_ = 0;
      this.logger_.info('Reached maximum number of retries of forward' +
          ' channel request.');
      this.suspend();
    }
  }
};


/**
 * Opens the GAE socket.
 * @param {string} token GAE token.
 * @private
 */
mc.GaeChannel.prototype.openSocket_ = function(token) {
  goog.asserts.assert(goog.isNull(this.socket_), 'Socket already open.');
  this.logger_.info('openSocket_');
  this.socket_ = new appengine.Channel(token).open();
  this.socket_.onopen = goog.bind(this.handleSocketOpen_, this);
  this.socket_.onmessage = goog.bind(this.handleSocketMessage_, this);
  this.socket_.onerror = goog.bind(this.handleSocketError_, this);
  this.socket_.onclose = goog.bind(this.handleSocketClose_, this);
  this.socketTimeout_.start();
};


/**
 * Handles socket message.
 * @param {string} message Text Message.
 * @private
 */
mc.GaeChannel.prototype.handleSocketMessage_ = function(message) {
  var messageText = message['data'];
  this.logger_.info('GAE socket message received.');
  if (messageText.length) {
    var messageData;
    try {
      messageData = goog.json.unsafeParse(messageText);
    } catch (e) {
      this.logger_.warning('Could not parse GAE socket message.', e);
    }
    if (messageData) {
      this.relayIncomingMessages_(messageData);
    }
  } else {
    this.logger_.warning('Received an empty message through GAE socket.');
  }
};


/**
 * Handles socket open event.
 * @private
 */
mc.GaeChannel.prototype.handleSocketOpen_ = function() {
  this.logger_.info('GAE socket open.');
  this.socketTimeout_.stop();
};


/**
 * Handles socket close event.
 * @private
 */
mc.GaeChannel.prototype.handleSocketClose_ = function() {
  this.logger_.info('GAE socket closed.');
};


/**
 * Handles socket error.
 * @param {!Object} error An object containing error description.
 * @private
 */
mc.GaeChannel.prototype.handleSocketError_ = function(error) {
  this.logger_.info('GAE socket error: ' + error.description);
  this.maybeDisposeSocket_();
  this.openBackwardChannel_();
};


/**
 * Disposes the socket if this.socket_ is not null.
 * @private
 */
mc.GaeChannel.prototype.maybeDisposeSocket_ = function() {
  this.logger_.info('maybeDisposeSocket_');
  if (!goog.isNull(this.socket_)) {
    this.logger_.info('Will call this.socket_.close.');
    /** @preserveTry */
    try {
      this.socket_.close();
    } catch (e) {
      this.logger_.warning('Error when closing socket.', e);
    };
    this.socket_ = null;
  }
};


/**
 * A callback for when GAE socket opening times out.
 * @private
 */
mc.GaeChannel.prototype.socketTimeoutCallback_ = function() {
  this.logger_.info('GAE socket opening has timed out.');
  this.maybeDisposeSocket_();
  this.suspend();
};


mc.GaeChannel.prototype.handleSystemServiceMessage_ = function(payload) {
  goog.asserts.assertObject(payload);
  if ('token' in payload) {
    this.logger_.info('GAE Channel token received from the server.')
    if (goog.isNull(this.socket_) && !this.isSuspended()) {
      this.openSocket_(payload['token']);
    }
  } else if ('pickup' in payload) {
    this.logger_.info('Pickup request received from the server.');
    this.send(mc.GaeChannel.SYSTEM_SERVICE_, {'pickup': payload['pickup']});
  } else {
    goog.asserts.assert(false, 'Unrecognized system service message.');
  }
};


/**
 * Opens the backward channel.
 * @private
 */
mc.GaeChannel.prototype.openBackwardChannel_ = function() {
  this.logger_.info('openBackwardChannel_');
  this.send(mc.GaeChannel.SYSTEM_SERVICE_, {'getToken': null});
};


/**
 * Opens the backward channel. Should be called exactly once.
 */
mc.GaeChannel.prototype.openBackwardChannel = function() {
  goog.asserts.assert(!this.backwardChannelInitiated_,
      'openBackwardChannel already called.');
  this.backwardChannelInitiated_ = true;
  this.openBackwardChannel_();
};


/** @inheritDoc */
mc.GaeChannel.prototype.sendInternal = function(service, payload) {
  this.logger_.info('sendInternal');
  var messagesForService = goog.object.setIfUndefined(this.bufferedMessages_,
      service, []);
  messagesForService.push(payload);
  this.sendDelay_.start();
};


/** @inheritDoc */
mc.GaeChannel.prototype.disposeInternal = function() {
  this.logger_.info('disposeInternal');
  goog.base(this, 'disposeInternal');
  this.maybeDisposeSocket_();
};