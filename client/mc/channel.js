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
 * @fileoverview Defines an abstract class for two-way communication channel
 * between the client and the server.
 */


goog.require('goog.asserts');
goog.require('goog.debug.Logger');
goog.require('goog.events.EventTarget');

goog.provide('mc.Channel');



/**
 * An abstract class for two-way communication channel between the client and
 * the server. Messages in either direction are not guaranteed to be always
 * delivered, or not to be delivered multiple times.
 * @constructor
 * @extends {goog.events.EventTarget}
 */
mc.Channel = function() {
  goog.base(this);


  /**
   * Map of service names to callbacks pre-bound to context objects.
   * @type {!Object.<!function(*)>}
   * @private
   */
  this.services_ = {};


  /**
   * Whether the channel is suspended, see also isSuspended() method.
   * @type {boolean}
   * @private
   */
  this.suspended_ = false;


  /**
   * Whether a call to send() is in progress.
   * @type {boolean}
   * @private
   */
  this.inSend_ = false;
};
goog.inherits(mc.Channel, goog.events.EventTarget);


/**
 * Types of events dispatched by the channel.
 * @enum {string}
 */
mc.Channel.EventType = {
  // When send() method is called, this event is dispatched unless that call is
  // made in the callback to the same event.
  SEND: 'send',

  // Dispatched when the channel is suspended or unsuspended.
  SUSPENDED_CHANGE: 'suspended_change'
};


/**
 * Logger.
 * @type {!goog.debug.Logger}
 * @private
 */
mc.Channel.prototype.channelLogger_ = goog.debug.Logger.getLogger(
    'mc.Channel');


/**
 * Registers a service and the associated handler of incoming messages.
 * @param {string} service Service name, any unique string.
 * @param {!function(*)} messageHandler Handler for incoming messages that takes
 *     the non-serialized payload as a single argument.
 * @param {Object=} opt_obj Optional scope in which to call the handler.
 */
mc.Channel.prototype.registerService = function(service, messageHandler,
    opt_obj) {
  goog.asserts.assert(!(service in this.services_),
      'Service \'%s\' already registered.', service);
  this.services_[service] = goog.bind(messageHandler, opt_obj || null);
};


/**
 * Should be called by subclasses when an incoming message is received. Calls
 * the handler of incoming messages that was registered for supplied service or
 * throws an assertion error if the service is not registered.
 * @param {string} service Service name.
 * @param {*} payload Non-serialized payload.
 * @protected
 */
mc.Channel.prototype.handleIncomingMessage = function(service, payload) {
  goog.asserts.assert(service in this.services_,
      'Received a message for service \'%s\' which is not registered.',
      service);
  if (window.JSON) {
    this.channelLogger_.info(goog.string.subs(
        'Received \'%s\' through service \'%s\'.',
        window.JSON.stringify(payload), service));
  }
  this.services_[service].call(null, payload);
};


/**
 * Sends a message over the channel, should be overridden by subclasses.
 * @param {string} service Service name.
 * @param {*} payload Non-serialized payload.
 * @protected
 */
mc.Channel.prototype.sendInternal = goog.abstractMethod;


/**
 * Sends a message over the channel and dispatches a SEND event if not called in
 * a callback to SEND event.
 * @param {string} service Service name.
 * @param {*} payload Non-serialized payload.
 */
mc.Channel.prototype.send = function(service, payload) {
  if (window.JSON) {
    this.channelLogger_.info(goog.string.subs(
        'Will send \'%s\' through service \'%s\'.',
        window.JSON.stringify(payload), service));
  }
  this.sendInternal(service, payload);
  var inSend = this.inSend_;
  if (!inSend) {
    this.inSend_ = true;
    this.dispatchEvent(mc.Channel.EventType.SEND);
  }
  this.inSend_ = inSend;
};


/**
 * @return {boolean} Whether the channel is currently not sending messages to
 *     the server when the send() method is called, for example because there is
 *     no network connection. Messages are buffered and sent to the server once
 *     the channel is unsuspended.
 */
mc.Channel.prototype.isSuspended = function() {
  return this.suspended_;
};


/**
 * Suspends the channel. Channel must not be already suspended.
 */
mc.Channel.prototype.suspend = function() {
  goog.asserts.assert(!this.suspended_,
      'Called suspend when the channel is already suspended.');
  this.suspended_ = true;
  this.channelLogger_.info('Channel suspended.');
  this.dispatchEvent(mc.Channel.EventType.SUSPENDED_CHANGE);
};


/**
 * Unsuspends the channel. Channel must be currently suspended.
 */
mc.Channel.prototype.unsuspend = function() {
  goog.asserts.assert(this.suspended_,
      'Called unsuspend when the channel is not suspended.');
  this.suspended_ = false;
  this.channelLogger_.info('Channel unsuspended.');
  this.dispatchEvent(mc.Channel.EventType.SUSPENDED_CHANGE)
};
