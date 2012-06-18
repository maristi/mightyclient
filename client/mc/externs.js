
/**
 * @fileoverview Declaration of externs for App Engine Channel API.
 */


var appengine = {};



/**
 * @param {string} token
 * @constructor
 */
appengine.Channel = function(token) {};


/**
 * @param {!Object=} opt_handler
 * @return {!appengine.Socket}
 */
appengine.Channel.prototype.open = function(opt_handler) {};



/**
 * @constructor
 */
appengine.Socket = function() {};


appengine.Socket.prototype.close = function() {};


/**
 * @type {!function()}
 */
appengine.Socket.prototype.onopen;


/**
 * @type {!function(string)}
 */
appengine.Socket.prototype.onmessage;


/**
 * @type {!function(!Object)}
 */
appengine.Socket.prototype.onerror;


/**
 * @type {!function()}
 */
appengine.Socket.prototype.onclose;
