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
 * @fileoverview Defines an API to access a JSON-like data structure syncronized
 * in real time with the server through optimistic concurrency mechanism.
 * Optionally, a schema can be defined that will be enforced by run-time checks.
 *
 * For client-server communication protocol, see protocol_datasource.md.
 */


goog.require('goog.Disposable');
goog.require('goog.array');
goog.require('goog.asserts');
goog.require('goog.async.Delay');
goog.require('goog.date');
goog.require('goog.date.UtcDateTime');
goog.require('goog.debug.Logger');
goog.require('goog.events.EventHandler');
goog.require('goog.events.EventTarget');
goog.require('goog.math');
goog.require('goog.object');
goog.require('goog.string');
goog.require('mc.Channel');

goog.provide('mc.ds');


/**
 * @define {boolean} Whether to strip out schema definitions and runtime checks
 *     based on them.
 */
mc.ds.ENABLE_SCHEMA = goog.DEBUG;


/**
 * An array of string keys.
 * @typedef {!Array.<string>}
 */
mc.ds.Path;


/**
 * Utility function that sets a value in a nested hierarchy of objects at
 * supplied path. If the supplied value is undefined, removes the existing value
 * and the objects that will become empty as a result, if any. If the value is
 * not undefined, if necessary creates the objects that form the required path.
 * @param {!Object} tree A tree of nested objects.
 * @param {mc.ds.Path} path An array of keys. Must be non-empty. No prefix
 *     should point to a primitive value.
 * @param {*=} opt_value Value to set.
 * @return {*} The value which was at provided path originally, or undefined if
 *     there wasn't any.
 */
mc.ds.setValueByKeys = function(tree, path, opt_value) {
  goog.asserts.assert(path.length);
  if (!goog.isDef(opt_value)) {
    var removeObj = null;
    var removeKey;
    path = goog.array.clone(path);
    while (path.length) {
      var pathEl = path.shift();
      if (!(pathEl in tree)) {
        return;
      }
      var child = tree[pathEl];
      if (path.length) {
        goog.asserts.assertObject(child,
            'No prefix of the path should point to a primitive value.');
      }
      if (path.length && goog.object.getCount(child) > 1) {
        removeObj = null;
      } else if (goog.isNull(removeObj)) {
        removeObj = tree;
        removeKey = pathEl;
      }
      tree = child;
    }
    goog.object.remove(removeObj, removeKey);
    return tree;
  } else {
    goog.array.forEach(goog.array.slice(path, 0, -1),
        function(pathEl) {
          tree = goog.asserts.assertObject(
              goog.object.setIfUndefined(tree, pathEl, {}),
              'No prefix of the path should point to a primitive value.');
        });
    var key = path[path.length - 1];
    var oldValue = tree[key];
    tree[key] = opt_value;
    return oldValue;
  }
};


/**
 * Utility function that sets a value in a nested hierarchy of objects at
 * supplied path if none already exists, if necessary creating the objects that
 * form the required path.
 * @param {!Object} tree A tree of nested objects.
 * @param {mc.ds.Path} path An array of keys. Must be non-empty. No prefix
 *     should point to a non-object value.
 * @param {*} value Value to set, must not be undefined.
 * @return {*} The resulting value at provided path.
 */
mc.ds.setValueByKeysIfUndefined = function(tree, path, value) {
  goog.asserts.assert(path.length);
  goog.asserts.assert(goog.isDef(value));
  goog.array.forEach(goog.array.slice(path, 0, -1),
      function(pathEl) {
        tree = goog.asserts.assertObject(
            goog.object.setIfUndefined(tree, pathEl, {}),
            'No prefix of the path should point to a non-object value.');
      });
  var key = path[path.length - 1];
  if (key in tree) {
    return tree[key];
  } else {
    return tree[key] = value;
  }
};


/**
 * Utility function that iterates over each element in a nested hierarchy of
 * objects that matches the supplied path.
 * @param {!Object} tree A tree made of nested objects.
 * @param {mc.ds.Path} path Path over which to iterate, can contain '*' (any
 *     key) wildcards.
 * @param {function(*, mc.ds.Path)} f The function to call for every
 *     matching element. This function takes 2 arguments (the element
 *     and the fully qualified path to it).
 * @param {Object=} opt_obj Optional scope within which to call f.
 * @param {!Object=} opt_leafKeys If provided, will not iterate over paths
 *     that have any of the supplied object's keys as elements. Provided path
 *     must not include any of such keys.
 */
mc.ds.forEach = function(tree, path, f, opt_obj, opt_leafKeys) {
  var forEach = function(treeElement, pathLeft, pathRight) {
    if (!pathRight.length) {
      f.call(opt_obj || null, treeElement, pathLeft);
    } else if (goog.isObject(treeElement)) {
      if (pathRight[0] == '*') {
        goog.object.forEach(treeElement,
            function(childElement, childElementKey) {
              if (!opt_leafKeys || !(childElementKey in opt_leafKeys)) {
                forEach(childElement,
                    goog.array.concat(pathLeft, childElementKey),
                    goog.array.slice(pathRight, 1));
              }
            });
      } else if (pathRight[0] in treeElement) {
        if (opt_leafKeys) {
          goog.asserts.assert(!(pathRight[0] in opt_leafKeys),
              'Path must not contain any of the keys in opt_leafKeys');
        }
        forEach(treeElement[pathRight[0]],
            goog.array.concat(pathLeft, pathRight[0]),
            goog.array.slice(pathRight, 1));
      }
    }
  };
  forEach(tree, [], path);
};


/**
 * Asserts that the supplied value is a valid key in a data tree path, i.e. (1)
 * it is a string; (2) it is not zero-length and does not contain a slash ('/')
 * as it should be possible to encode a path to string using slash as separator;
 * (3) it is not one of strings in mc.ds.LEAF_KEYS as these keys have special
 * meaning in the tree of nested objects where the data is stored.
 * @param {string} pathEl Path element to check.
 */
mc.ds.assertValidPathElement = function(pathEl) {
  goog.asserts.assertString(pathEl, 'Path element must be a string.');
  goog.asserts.assert(pathEl.length,
      'Path element string must not be zero-length.');
  goog.asserts.assert(!goog.string.contains(pathEl, '/'),
      'Path element must not contain a slash (\'/\').');
  goog.asserts.assert(!(pathEl in mc.ds.LEAF_KEYS),
      'Path element must not be one of the keys in mc.ds.LEAF_KEYS.');
};


/**
 * Asserts that the supplied value is an array of valid data tree keys, and
 * optionally checks for presence of wildcards.
 * @param {mc.ds.Path} path Path to check.
 * @param {boolean=} opt_fullyQualified Is path additionally required to be
 *      fully qualified, i.e. not to contain any wildcards.
 */
mc.ds.assertValidPath = function(path, opt_fullyQualified) {
  goog.asserts.assertArray(path, 'Path must be an array.');
  goog.array.forEach(path, function(pathEl, index) {
    mc.ds.assertValidPathElement(pathEl);
    if (opt_fullyQualified) {
      goog.asserts.assert(pathEl != '*', 'Path is not fully qualified.');
    }
  });
};


/**
 * Decodes a path joined with /'s. A zero-length string represents an empty
 *     path.
 * @param {string} str Path as a string.
 * @return {mc.ds.Path} Path as an array.
 */
mc.ds.decodePath = function(str) {
  if (!str.length) { return []; }
  return str.split('/');
};


/**
 * Optional map of unobfuscated names to obfuscated names used with
 * mc.ds.getName().
 * @type {!Object.<string>|undefined}
 * @private
 */
mc.ds.nameMapping_;


/**
 * Used to minify keys in the data tree, works similarly to goog.getCssName.
 * If a renaming map has been set with mc.ds.setNameMapping, will replace the
 * string passed as argument according to the map. If the string is not in the
 * map or the map has not been set, will pass the argument through unaltered.
 * @param {string} name Element of a path.
 * @return {string} Element of a path.
 */
mc.ds.getName = function(name) {
  if (mc.ds.nameMapping_) {
    return mc.ds.nameMapping_[name] || name;
  } else {
    return name;
  }
};


/**
 * Sets the map to check when returning a value from mc.ds.getName().
 * @param {!Object.<string>} mapping A map of strings to strings where keys are
 *     possible arguments to mc.ds.getName() and values are the corresponding
 *     values that should be returned.
 */
mc.ds.setNameMapping = function(mapping) {
  mc.ds.nameMapping_ = mapping;
};


/**
 * Token object used as event source for updates not originating from this
 * client.
 * @type {Object}
 * @const
 */
mc.ds.SERVER = {};


/**
 * Token object used as event source for rollbacks.
 * @type {Object}
 * @const
 */
mc.ds.ROLLBACK = {};



/**
 * An event with a fully or partially qualified path attached to it that can
 * be dispatched with dispatchEvent() method of a data node.
 * @param {mc.ds.Path} path Fully or partially qualified path from root.
 * @constructor
 */
mc.ds.Event = function(path) {
  mc.ds.assertValidPath(path);


  /**
   * Path associated with the event.
   * @type {mc.ds.Path}
   */
  this.path = path;
};



/**
 * Event dispatched when a primitive value changes.
 * @param {mc.ds.Path} path Fully qualified path to the changed value.
 * @param {*} oldValue Value before the change.
 * @param {*} newValue Value after the change.
 * @param {Object=} opt_source Optional event source object.
 * @constructor
 * @extends {mc.ds.Event}
 * @private
 */
mc.ds.ChangeEvent = function(path, oldValue, newValue, opt_source) {
  goog.base(this, path);


  /**
   * Value before the change.
   * @type {*}
   */
  this.oldValue = oldValue;


  /**
   * Value after the change.
   * @type {*}
   */
  this.newValue = newValue;


  /**
   * Event source or null if not provided. For an object that both listens to
   * changes in data and can also modify the data, it can be useful to be able
   * to distinguish the events it has itself initiated by supplying a reference
   * to itself as source argument of set() method.
   * @type {?Object}
   */
  this.source = opt_source || null;
};
goog.inherits(mc.ds.ChangeEvent, mc.ds.Event);



/**
 * A class which allows to easily stop listening by calling the dispose() method
 * of the listener instance. Can be used as follows:
 * <pre>
 * disposable.registerDisposable(listen(...));
 * </pre>
 * where disposable is any instance of goog.Disposable.
 * @param {!mc.ds.RootNode} rootNode Root data node.
 * @param {number} listenerID Listener's unique ID.
 * @param {mc.ds.Path} path Path from root which is listened to.
 * @param {boolean=} opt_descendants The value of the argument passed to listen
 *     method.
 * @constructor
 * @extends {goog.Disposable}
 * @private
 */
mc.ds.EventListener = function(rootNode, listenerID, path, opt_descendants) {
  /**
   * Root data node.
   * @type {!mc.ds.RootNode}
   * @private
   */
  this.rootNode_ = rootNode;


  /**
   * Listener's unique ID.
   * @type {number}
   * @private
   */
  this.listenerID_ = listenerID;


  /**
   * Path from root which is listened to.
   * @type {mc.ds.Path}
   * @private
   */
  this.path_ = path;


  /**
   * The value of the argument passed to listen method.
   * @type {boolean}
   * @private
   */
  this.descendants_ = opt_descendants || false;
};
goog.inherits(mc.ds.EventListener, goog.Disposable);


/** @inheritDoc */
mc.ds.EventListener.prototype.disposeInternal = function() {
  goog.base(this, 'disposeInternal');
  var key = this.descendants_ ? mc.ds.LISTENER_KEYS_.WITH_DESCENDANTS :
    mc.ds.LISTENER_KEYS_.WITHOUT_DESCENDANTS;
  mc.ds.setValueByKeys(this.rootNode_.listeners_,
      goog.array.concat(this.path_, key, this.listenerID_));
};


/**
 * A set of special keys used in the data tree which unlike all other keys, are
 * not associated with a path element. mc.ds.assertValidPathElement enforses
 * the rule that a path should not contain one of these keys.
 * @type {!Object.<null>}
 * @const
 */
mc.ds.LEAF_KEYS = {
  '.': null,
  '$': null
};


/**
 * Strings used as special keys in the data tree, values must be from
 * mc.ds.LEAF_KEYS set.
 * @enum {string}
 * @private
 */
mc.ds.DATA_KEYS_ = {
  VALUE: '.',
  NODE: '$'
};


/**
 * Strings used to identify the type of a value.
 * @enum {string}
 * @private
 */
mc.ds.VALUE_KEYS_ = {
  DATE: '%',
  DATETIME: '^',
  JSON: '&'
};


/**
 * Strings used as special keys in the event listeners index, values must be
 * from mc.ds.LEAF_KEYS set.
 * @enum {string}
 * @private
 */
mc.ds.LISTENER_KEYS_ = {
  WITHOUT_DESCENDANTS: '.',
  WITH_DESCENDANTS: '$'
};


/**
 * Decodes a value from the format in which it is stored in the data tree.
 * @param {*} value Encoded value.
 * @return {*}  Decoded value.
 * @private
 */
mc.ds.decodeValue_ = function(value) {
  if (goog.isNull(value) || goog.isBoolean(value) ||
      goog.isNumber(value) || goog.isString(value)) {
    return value;
  } else if (mc.ds.VALUE_KEYS_.DATE in value) {
    return new goog.date.Date(goog.date.fromIsoString(
        goog.asserts.assertString(value[mc.ds.VALUE_KEYS_.DATE])));
  } else if (mc.ds.VALUE_KEYS_.DATETIME in value) {
    return new goog.date.DateTime(goog.date.UtcDateTime.fromIsoString(
        value[mc.ds.VALUE_KEYS_.DATETIME]));
  } else if (mc.ds.VALUE_KEYS_.JSON in value) {
    return goog.object.unsafeClone(value[mc.ds.VALUE_KEYS_.JSON]);
  } else {
    goog.asserts.fail();
  }
};


/**
 * Encodes a value into the format in which it is stored in the data tree.
 * @param {*} value Unencoded value, assumed to be one of the accepted types.
 * @return {*}  Encoded value.
 * @private
 */
mc.ds.encodeValue_ = function(value) {
  if (goog.isNull(value) || goog.isBoolean(value) ||
      goog.isNumber(value) || goog.isString(value)) {
    return value;
  } else if (value instanceof goog.date.DateTime) {
    var encodedValue = {};
    encodedValue[mc.ds.VALUE_KEYS_.DATETIME] = value.toUTCIsoString();
    return encodedValue;
  } else if (value instanceof goog.date.Date) {
    var encodedValue = {};
    encodedValue[mc.ds.VALUE_KEYS_.DATE] = value.toUTCIsoString();
    return encodedValue;
  } else {
    var encodedValue = {};
    encodedValue[mc.ds.VALUE_KEYS_.JSON] = goog.object.unsafeClone(value);
    return encodedValue;
  }
};



/**
 * A class whose instances encapsulate a reference to a root node and a fully
 * qualified path from it.
 * @param {!mc.ds.RootNode} rootNode Root node.
 * @param {mc.ds.Path} path Fully qualified path to this node.
 * @param {!Object} data Element of the data tree at the same path as the node's
 *     path.
 * @constructor
 * @extends {goog.Disposable}
 * @private
 */
mc.ds.Node = function(rootNode, path, data) {
  goog.base(this);


  /**
   * Root node.
   * @type {!mc.ds.RootNode}
   * @private
   */
  this.rootNode_ = rootNode;


  /**
   * Fully qualified path to this node.
   * @type {mc.ds.Path}
   * @private
   */
  this.path_ = path;


  /**
   * Element of the data tree at the same path as the node's path.
   * @type {!Object}
   * @private
   */
  this.data_ = data;


  /**
   * Associated element of the schema, a value type or an object (never a custom
   * type name, such names must be de-aliased).
   * @type {!Object|string|undefined}
   * @private
   */
  this.schemaElement_;
};
goog.inherits(mc.ds.Node, goog.Disposable);


/**
 * @return {!mc.ds.RootNode} The root node.
 */
mc.ds.Node.prototype.getRootNode = function() {
  return this.rootNode_;
};


/**
 * @return {mc.ds.Path} Path that this node points to.
 */
mc.ds.Node.prototype.getPath = function() {
  return this.path_;
};


/**
 * Returns a node at supplied path relative to this node. If such node doesn't
 * already exist, creates one.
 * @param {mc.ds.Path} path Fully qualified path relative to this node.
 * @return {!mc.ds.Node} The node at provided relative path.
 */
mc.ds.Node.prototype.getNode = function(path) {
  mc.ds.assertValidPath(path, true);
  goog.asserts.assert(this.rootNode_.initialized_, 'Not yet initialized.');
  if (!path.length) { return this; }
  var data = mc.ds.setValueByKeysIfUndefined(this.data_, path, {});
  if (mc.ds.DATA_KEYS_.NODE in data) {
    return data[mc.ds.DATA_KEYS_.NODE];
  } else {
    var node = new mc.ds.Node(this.rootNode_,
        goog.array.concat(this.path_, path), goog.asserts.assertObject(data));
    if (mc.ds.ENABLE_SCHEMA && goog.isDef(this.schemaElement_)) {
      node.schemaElement_ = mc.ds.schemaGet_(this.path_, this.schemaElement_,
          path);
    }
    return data[mc.ds.DATA_KEYS_.NODE] = node;
  }
};



/**
 * Iterates over each leaf in the data tree with the supplied leaf key.
 * @param {string} leafKey Leaf key to look for.
 * @param {mc.ds.Path} path Relative path to leafs, can contain wildcards.
 * @param {!Function} f The function to call for every leaf. This function takes
 *     2 arguments (the leaf and the fully qualified
 *     path to it relative to this node).
 * @param {Object=} opt_obj Scope within which to call f.
 * @param {boolean=} opt_descendants Also walk all leafs at descendant paths.
 * @private
 */
mc.ds.Node.prototype.forEachLeaf_ = function(leafKey, path, f, opt_obj,
    opt_descendants) {
  if (opt_descendants) {
    var walk = function(dataElement, path) {
      goog.object.forEach(dataElement, function(value, key) {
        if (key == leafKey) {
          f.call(opt_obj || null, value, path);
        } else if (!(key in mc.ds.LEAF_KEYS)) {
          walk.call(this, value, goog.array.concat(path, key));
        }
      }, this);
    };
    mc.ds.forEach(this.data_, path, walk, this, mc.ds.LEAF_KEYS);
  } else {
    mc.ds.forEach(this.data_, path, function(dataElement, path) {
      if (leafKey in dataElement) {
        f.call(opt_obj || null, dataElement[leafKey], path)
      }
    }, this, mc.ds.LEAF_KEYS);
  }
};


/**
 * Iterates over each node whose path matches the supplied relative path from
 * this node. Can be used to dispose nodes to free up the memory.
 * @param {mc.ds.Path} path Relative path to nodes, can contain wildcards.
 * @param {function(!mc.ds.Node, mc.ds.Path)} f The function to call for every
 *     node. This function takes 2 arguments (the node and the fully qualified
 *     path to it relative to this node).
 * @param {boolean=} opt_descendants Also walk all nodes at descendant paths.
 * @param {Object=} opt_obj Scope within which to call f.
 */
mc.ds.Node.prototype.forEachNode = function(path, f, opt_obj,
    opt_descendants) {
  mc.ds.assertValidPath(path);
  goog.asserts.assert(this.rootNode_.initialized_, 'Not yet initialized.');
  if (mc.ds.ENABLE_SCHEMA && goog.isDef(this.schemaElement_)) {
    var foundSchemaElement = mc.ds.schemaForEach_(this.schemaElement_, path,
        function() {
          return true;
        }, this);
    if (!foundSchemaElement) {
      goog.asserts.assert(false,
          'Called forEachNode for path \'%s\' which according to schema' +
          ' will never match any nodes.',
          goog.array.concat(this.path_, path)).join('/');
    }
  }
  this.forEachLeaf_(mc.ds.DATA_KEYS_.NODE, path, f, opt_obj, opt_descendants);
};


/**
 * Returns the value at provided path relative to this node.
 * @param {mc.ds.Path} path Fully qualified relative path.
 * @param {*=} opt_default Optional value to return if the value at this path
 *     does not exist. If this argument is omitted, when the value does not
 *     exist will return null.
 * @return {*} Value at provided path, the default value, or null.
 */
mc.ds.Node.prototype.get = function(path, opt_default) {
  mc.ds.assertValidPath(path, true);
  goog.asserts.assert(this.rootNode_.initialized_, 'Not yet initialized.');
  if (mc.ds.ENABLE_SCHEMA && goog.isDef(this.schemaElement_)) {
    var schemaElement = mc.ds.schemaGet_(this.path_, this.schemaElement_,
        path);
    goog.asserts.assert(schemaElement in mc.ds.valueTypes_,
        'Called get for path \'%s\' which according to schema does not point' +
        ' to a value.',
        goog.array.concat(this.path_, path).join('/'));
  }
  var encodedValue = goog.object.getValueByKeys(this.data_,
      goog.array.concat(path, mc.ds.DATA_KEYS_.VALUE));
  if (goog.isDef(encodedValue)) {
    return mc.ds.decodeValue_(encodedValue);
  }
  return goog.isDef(opt_default) ? opt_default : null;
};


/**
 * Iterates over each value whose path matches the supplied relative path from
 * this node.
 * @param {mc.ds.Path} path Relative path to values, can contain wildcards.
 * @param {function(*, mc.ds.Path)} f The function to call for every value.
 *     This function takes 2 arguments (the value and the fully qualified path
 *     to it relative to this node).
 * @param {boolean=} opt_descendants Also walk all values at descendant paths.
 * @param {Object=} opt_obj Scope within which to call f.
 */
mc.ds.Node.prototype.forEach = function(path, f, opt_obj, opt_descendants) {
  mc.ds.assertValidPath(path);
  goog.asserts.assert(this.rootNode_.initialized_, 'Not yet initialized.');
  if (mc.ds.ENABLE_SCHEMA && goog.isDef(this.schemaElement_)) {
    var foundSchemaElement = mc.ds.schemaForEach_(this.schemaElement_, path,
        function(schemaElement) {
          if (opt_descendants) {
            // We are looking for either objects or primitive value types.
            return schemaElement !== 'EventPath';
          } else {
            return goog.isString(schemaElement) && schemaElement != 'EventPath';
          }
        }, this);
    if (!foundSchemaElement) {
      goog.asserts.assert(false,
          'Called forEach for path \'%s\' which according to schema' +
          ' will never match any values.',
          goog.array.concat(this.path_, path).join('/'));
    }
  }
  this.forEachLeaf_(mc.ds.DATA_KEYS_.VALUE, path,
      function(encodedValue, path) {
        var value = mc.ds.decodeValue_(encodedValue);
        f.call(opt_obj || null, value, path);
      }, this, opt_descendants);
};


/**
 * Sets a primitive value at provided path relative to his node and dispatches
 * the corresponding change event (mc.ds.ChangeEvent).
 * @param {mc.ds.Path} path Fully qualified relative path.
 * @param {*} value Value to set.
 * @param {*} encodedValue The same value encoded.
 * @param {Object=} opt_source Optional event source object to attach to the
 *     change event.
 * @return {!{encodedOldValue: *, oldValue: *}} Previous value at provided path
 *     in encoded and unencoded form.
 * @private
 */
mc.ds.Node.prototype.set_ = function(path, value, encodedValue, opt_source) {
  var encodedOldValue = mc.ds.setValueByKeys(this.data_,
      goog.array.concat(path, mc.ds.DATA_KEYS_.VALUE),
      goog.isNull(encodedValue) ? undefined : encodedValue);
  encodedOldValue = goog.isDef(encodedOldValue) ? encodedOldValue : null;
  var absPath = goog.array.concat(this.path_, path);
  if (opt_source !== mc.ds.SERVER && opt_source !== mc.ds.ROLLBACK) {
    this.rootNode_.buffer_(absPath, encodedOldValue, encodedValue);
  }
  var oldValue = goog.isDef(encodedOldValue) ?
      mc.ds.decodeValue_(encodedOldValue) : null;
  if (goog.asserts.ENABLE_ASSERTS) {
    this.rootNode_.lock_ = true;
  }
  this.rootNode_.dispatchEvent_(new mc.ds.ChangeEvent(
      absPath, mc.ds.decodeValue_(encodedOldValue), value, opt_source));
  if (goog.asserts.ENABLE_ASSERTS) {
    this.rootNode_.lock_ = false;
  }
  return {encodedOldValue: encodedOldValue, oldValue: oldValue};
};


/**
 * Sets a primitive value at provided path relative to his node and dispatches
 * the corresponding change event (mc.ds.ChangeEvent). Must not be called by a
 * callback to a change event as this can interfere with rollbacks.
 * @param {mc.ds.Path} path Fully qualified relative path.
 * @param {*} value Value to set.
 * @param {Object=} opt_source Optional event source object to attach to the
 *     change event.
 * @return {*} Previous value at provided path.
 */
mc.ds.Node.prototype.set = function(path, value, opt_source) {
  mc.ds.assertValidPath(path, true);
  goog.asserts.assert(this.rootNode_.initialized_, 'Not yet initialized.');
  goog.asserts.assert(!this.rootNode_.lock_,
      'set() must not be called by a callback to mc.ds.Change event.');
  if (mc.ds.ENABLE_SCHEMA && goog.isDef(this.schemaElement_)) {
    var schemaElement = mc.ds.schemaGet_(this.path_, this.schemaElement_,
        path);
    goog.asserts.assert(schemaElement in mc.ds.valueTypes_,
        'According to schema, the path \'%s\' does not point to a value.',
        goog.array.concat(this.path_, path).join('/'));
    if (!goog.isNull(value)) {
      mc.ds.assertType_(value, goog.asserts.assertString(schemaElement),
          goog.array.concat(this.path_, path));
    }
  }
  return this.set_(path, value, mc.ds.encodeValue_(value), opt_source).
      oldValue;
};


/**
 * Adds a listenter to events whose associated path is not mutually exclusive
 * with the supplied path relative to this node.
 * @param {mc.ds.Path} path Relative path, can contain wildcards.
 * @param {!Function} callback Function to call when the event is fired, takes
 *     the event as the single argument.
 * @param {!Object=} opt_obj Optional object to use as scope for callback.
 * @param {boolean=} opt_descendants Also listen to events with any number of
 *     extra elements added at the end of the path.
 * @return {!mc.ds.EventListener} An object which should be disposed to stop
 *     listening.
 */
mc.ds.Node.prototype.listen = function(path, callback, opt_obj,
    opt_descendants) {
  mc.ds.assertValidPath(path);
  if (mc.ds.ENABLE_SCHEMA && goog.isDef(this.schemaElement_)) {
    var foundSchemaElement = mc.ds.schemaForEach_(this.schemaElement_, path,
        function(schemaElement) {
          // We are looking for value types or EventPath.
          return goog.isString(schemaElement);
        }, this);
    if (!foundSchemaElement) {
      goog.asserts.assert(false,
          'Called listen for path \'%s\' which according to schema' +
          ' will never match any events.',
          goog.array.concat(this.path_, path).join('/'));
    }
  }
  return this.rootNode_.listen_(goog.array.concat(this.path_, path), callback,
      opt_obj, opt_descendants);
};


/** @inheritDoc */
mc.ds.Node.prototype.disposeInternal = function() {
  goog.base(this, 'disposeInternal');
  mc.ds.setValueByKeys(this.rootNode_.data_,
      goog.array.concat(this.path_, mc.ds.DATA_KEYS_.NODE));
};



/**
 * Root node of the data tree.
 * @param {!mc.Channel} channel Channel through which to communicate with the
 *     server.
 * @param {string} service Service name to use for two-way messaging through the
 *     channel.
 * @constructor
 * @extends {mc.ds.Node}
 */
mc.ds.RootNode = function(channel, service) {
  goog.base(this, this, [], {});


  /**
   * An index of event listeners. A single listener with ID listenerID and path
   * ['pathEl1', 'pathEl2'] and will create the following index:
   * <pre>
   * {'pathEl1': {'pathEl2': {'.': {listenerID: <callback function bound to
   *     scope object>}}}}
   * </pre>
   * @type {!Object}
   * @private
   */
  this.listeners_ = {};


  /**
   * Counter used for listener IDs.
   * @type {number}
   * @private
   */
  this.listenerIdCounter_ = 0;


  /**
   * When true, calling set() method will throw an assertion error.
   * @type {boolean}
   * @private
   */
  this.lock_;
  if (goog.asserts.ENABLE_ASSERTS) {
    this.lock_ = false;
  }


  /**
   * EventTarget for dispatching events though standand mechanism.
   * @type {!goog.events.EventTarget}
   * @private
   */
  this.eventTarget_ = new goog.events.EventTarget();
  this.registerDisposable(this.eventTarget_);


  /**
   * Channel through which to communicate with the server.
   * @type {!mc.Channel}
   * @private
   */
  this.channel_ = channel;
  channel.registerService(service, this.handleMessage_, this);
  var eh = new goog.events.EventHandler(this);
  this.registerDisposable(eh);
  eh.listen(this.channel_, mc.Channel.EventType.SEND,
      this.handleChannelSend_);


  /**
   * Service name to use for two-way messaging through the channel.
   * @type {string}
   * @private
   */
  this.service_ = service;


  /**
   * Whether the initial state of the data has been loaded.
   * @type {boolean}
   * @private
   */
  this.initialized_ = false;


  /**
   * Token that identifies the request to connect that has been sent to the
   * server, while such request is pending, otherwise null.
   * @type {?string}
   * @private
   */
  this.initRequestToken_ = null;


  /**
   * The token of the in-memory state of the data on the server.
   * @type {string}
   * @private
   */
  this.inMemoryStateToken_;


  /**
   * An array of messages other than 'init_success' and 'init_failure' received
   * before the RootNode has been initialized.
   * @type {!Array}
   * @private
   */
  this.bufferedServerMessages_ = [];


  /**
   * A version of the data such that all updates up to this version, possibly
   * including those only committed in-memory, have been applied on this client.
   * @type {number}
   * @private
   */
  this.version_;


  /**
   * The last version of the data that is known to be committed on disk.
   * @type {number}
   * @private
   */
  this.diskVersion_;


  /**
   * If a transaction is in progress, array containing the updates, otherwise
   * null. oldValue and newValue are stored in encoded form.
   * @type {?Array.<{path: mc.ds.Path, oldValue: *, newValue: *}>}
   * @private
   */
  this.transaction_ = null;


  /**
   * An array of transactions that have not yet been sent to the server. Each
   * transaction is an array of updates. oldValue and newValue are stored in
   * encoded form.
   * @type {!Array.<!Array.<{path: mc.ds.Path, oldValue: *, newValue: *}>>}
   * @private
   */
  this.bufferedUpdates_ = [];


  /**
   * An array of transactions that have been sent to the server but for which
   * the outcomes have not yet been received. Each transaction is an array of
   * updates. oldValue and newValue are stored in encoded form.
   * @type {!Array.<!Array.<{path: mc.ds.Path, oldValue: *, newValue: *}>>}
   * @private
   */
  this.sentUpdates_ = [];


  /**
   * An array of transactions originating from this client that are known to be
   * committed on the server in-memory and which are later than this.version_.
   * Each transaction is an array of updates. oldValue and newValue are stored
   * in encoded form.
   * @type {!Array.<!Array.<{path: mc.ds.Path, oldValue: *, newValue: *,
   *     version: number}>>}
   * @private
   */
  this.committedUpdates_ = [];


  /**
   * An object where keys are versions and values are updates not originating
   * from this client that have been received from the server but not yet
   * applied. newValue is stored in encoded form.
   * @type {!Object.<{path: mc.ds.Path, newValue: *}>}
   * @private
   */
  this.receivedUpdates_ = {};


  /**
   * All updates whose resulting versions are strictly greater than
   * this.diskVersion_ and are less or equal to this.version_. The keys are
   * versions. oldValue and newValue are stored in encoded form. The update's
   * property 'local' is true iff the change originated from this client.
   * @type {!Object.<{path: mc.ds.Path, oldValue: *, newValue: *,
   *     local: boolean}>}
   * @private
   */
  this.unsavedUpdates_ = {};


  /**
   * The return value of areChangesSaved_(), last time it was called.
   * @type {boolean}
   * @private
   */
  this.lastChangesSavedStatus_ = true;


  /**
   * Whether sending updates to the server has been put on hold.
   * @type {boolean}
   * @private
   */
  this.horsesHeld_ = false;


  /**
   * A timer that fires when the minimal time before we can check for updates
   * has elapsed.
   * @type {!goog.async.Delay}
   * @private
   */
  this.minCheckDelay_ = new goog.async.Delay(this.minCheckDelayCallback_,
      mc.ds.RootNode.MIN_CHECK_DELAY, this);
  this.registerDisposable(this.minCheckDelay_);


  /**
   * Whether a check for updates is pending to be sent when maxCheckDelay_ fires
   * or before.
   * @type {boolean}
   * @private
   */
  this.checkPending_ = false;


  /**
   * A timer that fires when the maximal time before we can check for updates
   * has elapsed.
   * @type {!goog.async.Delay}
   * @private
   */
  this.maxCheckDelay_ = new goog.async.Delay(this.maxCheckDelayCallback_,
      mc.ds.RootNode.MAX_CHECK_DELAY - mc.ds.RootNode.MIN_CHECK_DELAY, this);
  this.registerDisposable(this.maxCheckDelay_);


  /**
   * A timer for making a call to send_ method in the next cycle of browser
   * event loop.
   * @type {!goog.async.Delay}
   * @private
   */
  this.sendDelay_ = new goog.async.Delay(this.send_, 0, this);
  this.registerDisposable(this.sendDelay_);


  /**
   * A timer that fires when 'init' request times out.
   * @type {!goog.async.Delay}
   * @private
   */
  this.initRequestTimeoutDelay_ = new goog.async.Delay(
      this.initRequestTimeoutCallback_,
      mc.ds.RootNode.INIT_REQUEST_TIMEOUT, this);
  this.registerDisposable(this.initRequestTimeoutDelay_);
};
goog.inherits(mc.ds.RootNode, mc.ds.Node);


/**
 * Types of events dispatched by a RootNode though event target accessible with
 * getEventTarget() method.
 * @enum {string}
 */
mc.ds.RootNode.EventType = {
  // Dispatched when the datasource has been initialized, i.e. the initial state
  // of the data has been loaded. The data is not accessible before the
  // datasource has been initialized.
  INITIALIZED: 'initialized',

  // Dispatched when return value of areChangesSaved() method changes.
  SAVED_STATUS_CHANGE: 'savedStatusChange',

  // Dispatched when some changes made locally have been rolled back.
  ROLLBACK: 'rollback',

  // Dispatched when there is an error on the server that cannot be remedied by
  // flushing in-memory state, or when the response is not received from the
  // server within a certain timeout despite the channel being connected. When
  // this event is dispatched, the RootNode (and descendant nodes) should be
  // disposed and re-instantiated.
  ERROR: 'error'
};


/**
 * The timeout in milliseconds for 'init' request.
 * @type {number}
 */
mc.ds.RootNode.INIT_REQUEST_TIMEOUT = 60 * 1000;


/**
 * The minimal time in milliseconds allowed to elapse before sending 'init'
 * request to the server to check for missed updates.
 * @type {number}
 */
mc.ds.RootNode.MIN_CHECK_DELAY = 60 * 1000;


/**
 * The maximal time in milliseconds allowed to elapse before sending 'init'
 * request to the server to check for missed updates.
 * @type {number}
 */
mc.ds.RootNode.MAX_CHECK_DELAY = 2 * 60 * 1000;


/**
 * Logger.
 * @type {!goog.debug.Logger}
 * @private
 */
mc.ds.RootNode.prototype.logger_ = goog.debug.Logger.getLogger(
    'mc.ds.RootNode');


/**
 * Adds an event listenter.
 * @param {mc.ds.Path} path Path from root, can contain wildcards.
 * @param {!Function} callback Function to call when the event is fired, takes
 *     the event as the single argument.
 * @param {!Object=} opt_obj Optional object to use as scope for callback.
 * @param {boolean=} opt_descendants Also listen to events with any number of
 *     extra elements added at the end of the path.
 * @return {!mc.ds.EventListener} An object which should be disposed to stop
 *     listening.
 * @private
 */
mc.ds.RootNode.prototype.listen_ = function(path, callback, opt_obj,
    opt_descendants) {
  var id = ++this.listenerIdCounter_;
  var key = opt_descendants ? mc.ds.LISTENER_KEYS_.WITH_DESCENDANTS :
      mc.ds.LISTENER_KEYS_.WITHOUT_DESCENDANTS;
  mc.ds.setValueByKeys(this.listeners_,
      goog.array.concat(path, key, id), goog.bind(callback, opt_obj || null));
  return new mc.ds.EventListener(this, id, path, opt_descendants);
};


/**
 * Dispatches an event.
 * @param {!mc.ds.Event} event Event to dispatch.
 * @private
 */
mc.ds.RootNode.prototype.dispatchEvent_ = function(event) {
  var dispatchEvent = function(path, listeners) {
    if (mc.ds.LISTENER_KEYS_.WITH_DESCENDANTS in listeners) {
      goog.object.forEach(listeners[mc.ds.LISTENER_KEYS_.WITH_DESCENDANTS],
          function(callback) {
            callback.call(null, event);
          });
    }
    if (path.length) {
      if (path[0] == '*') {
        goog.object.forEach(listeners, function(value, key) {
          if (key != '.') {
            dispatchEvent(goog.array.slice(path, 1), value);
          }
        });
      } else {
        if ('*' in listeners) {
          dispatchEvent(goog.array.slice(path, 1), listeners['*']);
        }
        if (path[0] in listeners) {
          dispatchEvent(goog.array.slice(path, 1),
              listeners[path[0]]);
        }
      }
    } else {
      if (mc.ds.LISTENER_KEYS_.WITHOUT_DESCENDANTS in listeners) {
        goog.object.forEach(
            listeners[mc.ds.LISTENER_KEYS_.WITHOUT_DESCENDANTS],
            function(callback) {
              callback.call(null, event);
            });
      }
    }
  };
  dispatchEvent(event.path, this.listeners_);
};


/**
 * Dispatches a custom event. When type checking is on, we check that the
 * event's path matches an 'EventPath' special element in the schema.
 * @param {!mc.ds.Event} event Event to dispatch.
 */
mc.ds.RootNode.prototype.dispatchEvent = function(event) {
  if (mc.ds.ENABLE_SCHEMA && goog.isDef(this.schemaElement_)) {
    var foundSchemaElement;
    mc.ds.schemaForEach_(this.schemaElement_, event.path,
        function(schemaElement) {
          goog.asserts.assert(schemaElement === 'EventPath',
              'Tried to dispatch a custom event for path \'%s\' which ' +
              ' according to schema can match an element other' +
              ' than \'EventPath\'',
              event.path.join('/'));
          foundSchemaElement = true;
        }, this);
    if (!foundSchemaElement) {
      goog.asserts.assert(false,
          'Tried to dispatch a custom event for path \'%s\' which ' +
          ' according to schema does not match an \'EventPath\'',
          event.path.join('/'));
    }
  }
  this.dispatchEvent_(event);
};


/**
 * @return {boolean} Whether the datasource has been initialized, i.e. the
 *     initial state of the data has been loaded.
 */
mc.ds.RootNode.prototype.isInitialized = function() {
  return this.initialized_;
};


/**
 * @return {boolean} Whether the changes made locally, if any, have been saved
 *     to disk on the server.
 * @private
 */
mc.ds.RootNode.prototype.areChangesSaved_ = function() {
  if (!goog.isNull(this.transaction_) && this.transaction_.length) {
    return false;
  }
  if (this.bufferedUpdates_.length || this.sentUpdates_.length ||
      this.committedUpdates_.length) {
    return false;
  }
  if (goog.object.some(this.unsavedUpdates_, function(update) {
    return update.local;
  })) {
    return false;
  }
  return true;
};


/**
 * @return {boolean} Whether the changes made locally, if any, have been saved
 *     to disk on the server.
 */
mc.ds.RootNode.prototype.areChangesSaved = function() {
  return this.lastChangesSavedStatus_;
};


/**
 * @return {!goog.events.EventTarget} The EventTarget used by the RootNode to
 *     dispatch events via standard mechanism.
 */
mc.ds.RootNode.prototype.getEventTarget = function() {
  return this.eventTarget_;
};


/**
 * Starts or stops this.sendDelay_ timer depending on whether all of the
 * following holds: (1) there are buffered updates to send, (2) outcome was
 * received for any previous updates sent to the server, (3) sending updates to
 * the server was not put on hold with holdHorses().
 * @private
 */
mc.ds.RootNode.prototype.startOrStopSendDelay_ = function() {
  if (this.bufferedUpdates_.length && !this.sentUpdates_.length &&
      !this.horsesHeld_) {
    this.logger_.info('sendDelay_ started.');
    this.sendDelay_.start();
  } else {
    this.logger_.info('sendDelay_ stopped.');
    this.sendDelay_.stop();
  }
};


/**
 * Runs a function in transaction.
 * @param {!function()} f Callback function.
 * @param {Object=} opt_obj Optional context object for f.
 */
mc.ds.RootNode.prototype.inTransaction = function(f, opt_obj) {
  goog.asserts.assert(goog.isNull(this.transaction_),
      'Transaction is already in progress.');
  this.transaction_ = [];
  f.call(opt_obj || null);
  if (this.transaction_.length) {
    this.bufferedUpdates_.push(this.transaction_);
    this.startOrStopSendDelay_();
  }
  this.transaction_ = null;
};


/**
 * @return {boolean} Whether sending updates to the server has been put on hold.
 */
mc.ds.RootNode.prototype.areHorsesHeld = function() {
  return this.horsesHeld_;
};


/**
 * Put on hold sending updates to the server.
 */
mc.ds.RootNode.prototype.holdHorses = function() {
  goog.asserts.assert(!(this.horsesHeld_),
      'Sending updates to the server is already on hold.');
  this.horsesHeld_ = true;
  this.logger_.info('Put sending updates on hold.');
  this.startOrStopSendDelay_();
};


/**
 * Resume sending updates to the server.
 */
mc.ds.RootNode.prototype.releaseHorses = function() {
  goog.asserts.assert(this.horsesHeld_,
      'Sending updates to the server is not on hold.');
  this.horsesHeld_ = false;
  this.logger_.info('Released hold on sending updates.');
  this.startOrStopSendDelay_();
};


/**
 * Sends 'init' request to the server.
 * @param {?number} version Version to supply in the message.
 */
mc.ds.RootNode.prototype.sendInitRequest_ = function(version) {
  this.initRequestToken_ = goog.string.getRandomString();
  this.logger_.info('Will send init request.');
  this.channel_.send(this.service_,
      {'init': [version, this.initRequestToken_]});
  this.initRequestTimeoutDelay_.start();
};


/**
 * Loads initial state of the data from the server. RootNode fires an
 * INITIALIZED event once the datasource has been initialized.
 */
mc.ds.RootNode.prototype.connect = function() {
  this.sendInitRequest_(null);
};


/**
 * Buffers an update before sending to the server.
 * @param {mc.ds.Path} path Path to changed value.
 * @param {*} oldValue Encoded value before the change.
 * @param {*} newValue Encoded value after the change.
 * @private
 */
mc.ds.RootNode.prototype.buffer_ = function(path, oldValue, newValue) {
  var transaction;
  if (!goog.isNull(this.transaction_)) {
    transaction = this.transaction_;
  } else {
    transaction = [];
    this.bufferedUpdates_.push(transaction);
  }
  transaction.push({path: path, oldValue: oldValue, newValue: newValue});
  if (this.lastChangesSavedStatus_) {
    this.lastChangesSavedStatus_ = false;
    this.eventTarget_.dispatchEvent(
        mc.ds.RootNode.EventType.SAVED_STATUS_CHANGE);
  }
  if (goog.isNull(this.transaction_)) {
    this.startOrStopSendDelay_();
  }
};


/**
 * Sends bufferedUpdates_ to the server.
 * @private
 */
mc.ds.RootNode.prototype.send_ = function() {
  goog.asserts.assert(!this.sentUpdates_.length);
  this.logger_.info('Will send buffered updates to the server.');
  this.channel_.send(this.service_, {'updates': [
    this.inMemoryStateToken_,
    this.version_,
    goog.array.map(this.bufferedUpdates_, function(transaction) {
      return goog.array.map(transaction, function(update) {
        return [update.path.join('/'), update.newValue];
      }, this);
    }, this)
  ]});
  this.sentUpdates_ = this.bufferedUpdates_;
  this.bufferedUpdates_ = [];
};


/**
 * Applies this.receivedUpdates_, advancing this.version_ as far as is possible
 * without encountering a version absent from both this.receivedUpdates_ and
 * this.committedUpdates_. Does not do anything if sentUpdates_ is not empty.
 * @private
 */
mc.ds.RootNode.prototype.applyReceivedUpdates_ = function() {
  if (this.sentUpdates_.length) {
    return;
  }
  while (true) {
    var version = this.version_ + 1;
    if (version in this.receivedUpdates_) {
      var update = this.receivedUpdates_[version];
      delete this.receivedUpdates_[version];
      var oldValue = this.set_(update.path,
          mc.ds.decodeValue_(update.newValue),
          update.newValue, mc.ds.SERVER).encodedOldValue;
      update.oldValue = oldValue;
      update.local = false;
      goog.asserts.assert(!(version in this.unsavedUpdates_));
      if (version > this.diskVersion_) {
        this.unsavedUpdates_[version] = /** @type {{path: mc.ds.Path,
        oldValue: *, newValue: *, local: boolean}} */ (update);
      }
    } else if (this.committedUpdates_.length &&
        this.committedUpdates_[0][0].version == version) {
      var transaction = this.committedUpdates_.shift();
      goog.array.forEach(transaction, function(update) {
        update.local = true;
        version = update.version;
        delete update.version;
        goog.asserts.assert(!(version in this.unsavedUpdates_));
        if (version > this.diskVersion_) {
          this.unsavedUpdates_[version] = update;
        }
      }, this);
    } else {
      break;
    }
    this.version_ = version;
  }
};


/**
 * Processes an array of server updates received in 'init_success' or 'updates'
 * message, adding them to this.receivedUpdates_.
 * @param {!Array} updates Array of updates as received from the server.
 * @private
 */
mc.ds.RootNode.prototype.processServerUpdates_ = function(updates) {
  goog.array.forEach(updates, function(update) {
    var updateVersion = goog.asserts.assertNumber(update[2]);
    if (updateVersion > this.version_) {
      var path = mc.ds.decodePath(goog.asserts.assertString(update[0]));
      var newValue = update[1];
      if (updateVersion in this.receivedUpdates_) {
        return;
      }
      this.receivedUpdates_[updateVersion] = {path: path, newValue: newValue};
    }
  }, this);
};


/**
 * Rolls back all updates after min(this.version_, this.diskVersion_).
 * @private
 */
mc.ds.RootNode.prototype.flush_ = function() {
  this.logger_.info('flush_');
  var rollback = false;
  goog.array.forEachRight(goog.array.concat(this.committedUpdates_,
      this.sentUpdates_, this.bufferedUpdates_), function(transaction) {
    rollback = true;
    goog.array.forEachRight(transaction, function(update) {
      this.set_(update.path, mc.ds.decodeValue_(update.oldValue),
          update.oldValue, mc.ds.ROLLBACK);
    }, this);
  }, this);
  for (var version = this.version_; version > this.diskVersion_; version--) {
    var update = this.unsavedUpdates_[version];
    if (update.local) {
      rollback = true;
    }
    this.set_(update.path, mc.ds.decodeValue_(update.oldValue),
        update.oldValue, mc.ds.ROLLBACK);
  }
  this.bufferedUpdates_ = [];
  this.sentUpdates_ = [];
  this.committedUpdates_ = []
  this.receivedUpdates_ = {};
  this.unsavedUpdates_ = {};
  this.diskVersion_ = this.version_ = Math.min(this.version_,
      this.diskVersion_);
  this.startOrStopSendDelay_();
  if (rollback) {
    this.eventTarget_.dispatchEvent(mc.ds.RootNode.EventType.ROLLBACK);
  }
  if (!this.lastChangesSavedStatus_ && this.areChangesSaved_()) {
    this.lastChangesSavedStatus_ = true;
    this.eventTarget_.dispatchEvent(
        mc.ds.RootNode.EventType.SAVED_STATUS_CHANGE);
  }
};


/**
 * Advances this.diskVersion_ to the supplied version.
 * @private
 */
mc.ds.RootNode.prototype.advanceDiskVersion_ = function(version) {
  goog.asserts.assert(version >= this.diskVersion_);
  for (var updateVersion = this.diskVersion_ + 1; updateVersion <= version;
      updateVersion++) {
    // Would not actually remove a key if disk version overtakes
    // this.version_ and so this.unsavedUpdates_ is empty and
    // this.version_ < updateVersion.
    goog.object.remove(this.unsavedUpdates_, updateVersion);
  }
  this.diskVersion_ = version;
  if (!this.lastChangesSavedStatus_ && this.areChangesSaved_()) {
    this.lastChangesSavedStatus_ = true;
    this.eventTarget_.dispatchEvent(
        mc.ds.RootNode.EventType.SAVED_STATUS_CHANGE);
  }
};


/**
 * Handles 'init_success' message from the server.
 * @param {*} payload Deserialized payload.
 * @private
 */
mc.ds.RootNode.prototype.handleInitSuccessMessage_ = function(payload) {
  this.logger_.info('handleInitSuccessMessage_');
  if (goog.isNull(this.initRequestToken_) ||
      this.initRequestToken_ != payload['init_success'][0]) {
    return;
  }
  this.initRequestToken_ = null;
  this.initRequestTimeoutDelay_.stop();

  var inMemoryStateToken = goog.asserts.assertString(
      payload['init_success'][1]);
  var diskVersion = goog.asserts.assertNumber(payload['init_success'][2]);
  if (!this.initialized_) {
    this.inMemoryStateToken_ = inMemoryStateToken;
    this.version_ = diskVersion;
    this.diskVersion_ = diskVersion;
    var data = goog.asserts.assertObject(payload['init_success'][3]);
    this.data_ = data;
    this.initialized_ = true;
    this.eventTarget_.dispatchEvent(mc.ds.RootNode.EventType.INITIALIZED);
  } else {
    if (this.inMemoryStateToken_ != inMemoryStateToken) {
      this.flush_();
    }
    if (this.diskVersion_ < diskVersion) {
      this.advanceDiskVersion_(diskVersion);
    }
  }

  var updates = goog.asserts.assertArray(payload['init_success'][4]);
  if (updates.length) {
    this.processServerUpdates_(updates);
    this.applyReceivedUpdates_();
  }

  if (this.checkPending_) {
    this.checkPending_ = false;
    this.maxCheckDelay_.stop();
  }
  this.minCheckDelay_.start();

  goog.array.forEach(this.bufferedServerMessages_, function(payload) {
    this.handleMessage_(payload);
  }, this);
};


/**
 * Handles 'init_failure' message from the server.
 * @param {*} payload Deserialized payload.
 * @private
 */
mc.ds.RootNode.prototype.handleInitFailureMessage_ = function(payload) {
  this.logger_.info('handleInitFailureMessage_');
  if (goog.isNull(this.initRequestToken_) ||
      this.initRequestToken_ != payload['init_failure']) {
    return;
  }
  this.initRequestToken_ = null;
  this.initRequestTimeoutDelay_.stop();
  this.checkPending_ = false;
  this.minCheckDelay_.stop();
  this.maxCheckDelay_.stop();
  this.eventTarget_.dispatchEvent(mc.ds.RootNode.EventType.ERROR);
};


/**
 * Handles a message from the server with outcomes of updates previously sent
 * from this client.
 * @param {*} payload Deserialized payload.
 * @private
 */
mc.ds.RootNode.prototype.handleOutcomesMessage_ = function(payload) {
  this.logger_.info('handleOutcomesMessage_');
  var token = goog.asserts.assertString(payload['outcomes'][0]);
  if (token != this.inMemoryStateToken_) {
    return;
  }
  var version = goog.asserts.assertNumber(payload['outcomes'][1]);
  if (version != this.version_) {
    return;
  }
  var outcomes = goog.asserts.assertArray(payload['outcomes'][2]);
  goog.asserts.assert(outcomes.length == this.sentUpdates_.length);
  var rollback = false;
  goog.array.forEachRight(outcomes, function(outcome, transactionIndex) {
    var transaction = this.sentUpdates_[transactionIndex];
    if (goog.isNull(outcome)) {
      rollback = true;
      goog.array.forEachRight(transaction, function(update) {
        this.set_(update.path, mc.ds.decodeValue_(update.oldValue),
            update.oldValue, mc.ds.ROLLBACK);
      }, this);
    } else {
      var newCommitedTransaction = [];
      var lastUpdateVersion = outcome;
      for (var index = transaction.length; index > 0; index--) {
        var updateVersion = lastUpdateVersion - index + 1;
        var update = transaction[transaction.length - index];
        update.version = updateVersion;
        newCommitedTransaction.push(update);
      }
      this.committedUpdates_.unshift(newCommitedTransaction);
    }
  }, this);
  this.sentUpdates_ = [];
  this.applyReceivedUpdates_();

  if (rollback) {
    this.eventTarget_.dispatchEvent(mc.ds.RootNode.EventType.ROLLBACK);
  }
  goog.asserts.assert(!this.lastChangesSavedStatus_);
  if (this.areChangesSaved_()) {
    this.lastChangesSavedStatus_ = true;
    this.eventTarget_.dispatchEvent(
        mc.ds.RootNode.EventType.SAVED_STATUS_CHANGE);
  }
  this.startOrStopSendDelay_();
};


/**
 * Handles a message from the server with updates not originating from this
 * client.
 * @param {*} payload Deserialized payload.
 * @private
 */
mc.ds.RootNode.prototype.handleUpdatesMessage_ = function(payload) {
  this.logger_.info('handleUpdatesMessage_');
  var token = goog.asserts.assertString(payload['updates'][0]);
  if (token != this.inMemoryStateToken_) {
    return;
  }
  var updates = goog.asserts.assertArray(payload['updates'][1]);
  this.processServerUpdates_(updates);
  this.applyReceivedUpdates_();
};


/**
 * Handles a 'saved' notification from the server.
 * @param {*} payload Deserialized payload.
 * @private
 */
mc.ds.RootNode.prototype.handleSavedMessage_ = function(payload) {
  this.logger_.info('handleSavedMessage_');
  var token = goog.asserts.assertString(payload['saved'][0]);
  if (token != this.inMemoryStateToken_) {
    return;
  }
  var version = goog.asserts.assertNumber(payload['saved'][1]);
  if (version > this.diskVersion_) {
    this.advanceDiskVersion_(version);
  }
};


/**
 * Handles a flush notification from the server.
 * @param {*} payload Deserialized payload.
 * @private
 */
mc.ds.RootNode.prototype.handleFlushMessage_ = function(payload) {
  this.logger_.info('handleFlushMessage_');
  var token = goog.asserts.assertString(payload['flush']);
  if (token != this.inMemoryStateToken_) {
    return;
  }
  this.sendInitRequest_(this.diskVersion_);
};


/**
 * Handles a message from the server.
 * @param {*} payload Deserialized payload.
 * @private
 */
mc.ds.RootNode.prototype.handleMessage_ = function(payload) {
  goog.asserts.assertObject(payload);
  if ('init_success' in payload) {
    this.handleInitSuccessMessage_(payload);
  } else if ('init_failure' in payload) {
    this.handleInitFailureMessage_(payload);
  } else {
    if (!this.initialized_) {
      this.bufferedServerMessages_.push(payload);
    } else {
      if ('outcomes' in payload) {
        this.handleOutcomesMessage_(payload);
      } else if ('updates' in payload) {
        this.handleUpdatesMessage_(payload);
      } else if ('saved' in payload) {
        this.handleSavedMessage_(payload);
      } else if ('flush' in payload) {
        this.handleFlushMessage_(payload);
      } else {
        goog.asserts.fail();
      }
    }
  }
};


/**
 * A callback for when minCheckDelay_ fires.
 * @private
 */
mc.ds.RootNode.prototype.minCheckDelayCallback_ = function() {
  this.checkPending_ = true;
  this.maxCheckDelay_.start();
};


/**
 * Handles SEND event dispatched by the channel.
 * @private
 */
mc.ds.RootNode.prototype.handleChannelSend_ = function() {
  if (this.checkPending_) {
    this.checkPending_ = false;
    this.maxCheckDelay_.stop();
    this.sendInitRequest_(this.diskVersion_);
  }
};


/**
 * A callback for when maxCheckDelay_ fires.
 * @private
 */
mc.ds.RootNode.prototype.maxCheckDelayCallback_ = function() {
  if (this.checkPending_) {
    this.checkPending_ = false;
    this.sendInitRequest_(this.diskVersion_);
  }
};


/**
 * A callback for when initRequestTimeoutDelay_ fires.
 * @private
 */
mc.ds.RootNode.prototype.initRequestTimeoutCallback_ = function() {
  this.logger_.warning('\'init\' request timed out.');
  this.checkPending_ = false;
  this.minCheckDelay_.stop();
  this.maxCheckDelay_.stop();
  this.eventTarget_.dispatchEvent(mc.ds.RootNode.EventType.ERROR);
};


/** @inheritDoc */
mc.ds.RootNode.prototype.disposeInternal = function() {
  this.logger_.info('Will send disconnect message.')
  this.channel_.send(this.service_, {'disconnect': null});
  goog.Disposable.prototype.disposeInternal.call(this);
};


/**
 * An object whose keys are type names and values are type schemas.
 * @type {!Object}
 * @private
 */
mc.ds.schema_ = {};


/**
 * The set of value types, an object where keys are type names and values are
 * nulls.
 * @type {!Object.<null>}
 * @private
 */
mc.ds.valueTypes_ = {
  // Values are numbers other than NaN and Infinity.
  'Number': null,
  // Values are booleans.
  'Boolean': null,
  // Values are strings.
  'String': null,
  // Values are instances of goog.date.Date but not goog.date.DateTime.
  'Date': null,
  // Values are instances of goog.date.DateTime.
  'Datetime': null,
  // Values are anything that can be serialized to JSON.
  'Json': null
};


/**
 * The set of types that can be used in the schema like value types but have a
 * special meaning.
 * @type {!Object.<null>}
 * @private
 */
mc.ds.specialTypes_ = {
  // Marks paths at which no value is stored but which can be used to dispatch
  // custom events.
  'EventPath': null
};


/**
 * Asserts that the value is of supplied type.
 * @param {*} value Value to check.
 * @param {string} type Expected type.
 * @param {mc.ds.Path} path Renamed path to value.
 * @private
 */
mc.ds.assertType_ = function(value, type, path) {
  var msg = goog.string.subs(
      'Invalid value type: expected %s at path \'%s\'.',
      type, path.join('/'));
  switch (type) {
    case 'Number':
      goog.asserts.assert(goog.isNumber(value) &&
          goog.math.isFiniteNumber(value), msg);
      break;
    case 'Boolean':
      goog.asserts.assertBoolean(value, msg);
      break;
    case 'String':
      goog.asserts.assertString(value, msg);
      break;
    case 'Date':
      goog.asserts.assert(value instanceof goog.date.Date &&
          !(value instanceof goog.date.DateTime), msg);
      break;
    case 'Datetime':
      goog.asserts.assert(value instanceof goog.date.DateTime, msg);
      break;
    case 'Json':
      break;
    default:
      goog.asserts.fail();
  }
};


/**
 * Registers schema for a data tree element type.
 * @param {string} type Type name, any unique string.
 * @param {*} schema Schema of descendant elements of the data tree. A tree of
 *     nested objects containing strings, each describing an element at a given
 *     path from any element with the type that is being defined. The string can
 *     be either a value type or a client-defined type.
 *
 *     Keys are replaced using mc.ds.getName.
 *
 *     A '*' key is a wildcard matching any path element and should be the only
 *     key of its object.
 */
mc.ds.defineType = function(type, schema) {
  goog.asserts.assert(!(type in mc.ds.schema_),
      'Type already registered.');
  goog.asserts.assert(!(type in mc.ds.valueTypes_),
      'Type name clashes with a value type.');
  goog.asserts.assert(!(type in mc.ds.specialTypes_),
      'Type name clashes with a special type.');
  /**
   * Checks the schema for errors and replaces keys using mc.ds.getName.
   * @param {*} schema Schema element to check.
   */
  var walk = function(schema) {
    goog.asserts.assert((goog.isObject(schema) || goog.isString(schema)) &&
        !goog.isArray(schema) && !goog.isFunction(schema),
        'Schema must only contain strings or' +
        ' objects other than arrays and functions.');
    if (goog.isObject(schema)) {
      if ('*' in schema) {
        goog.asserts.assert(
            goog.object.getCount(goog.asserts.assertObject(schema)) == 1,
            'If an object in the schema contains a wildcard key,' +
            ' this object should have no other keys.');
      }
      var retval = {};
      goog.object.forEach(goog.asserts.assertObject(schema),
          function(value, key) {
            mc.ds.assertValidPathElement(key);
            retval[mc.ds.getName(key)] = walk(value);
          });
      return retval;
    } else {
      return schema;
    }
  };
  mc.ds.schema_[type] = walk(schema);
};


/**
 * Sets the type of a root node. This is required to enable schema-based checks.
 * Should be called after defining schema and before any calls to getNode method
 * of the root node.
 * @param {!mc.ds.RootNode} rootNode A root node.
 * @param {string} type Type name.
 */
mc.ds.setType = function(rootNode, type) {
  if (mc.ds.ENABLE_SCHEMA) {
    rootNode.schemaElement_ = mc.ds.schemaDealias_(type);
  }
};


/**
 * Takes an element of the schema, and if it is a custom type name, looks up an
 * object or value type that the custom type points to, possibly via
 * intermediate custom types.
 * @param {!Object|string} el Element of the schema.
 * @return {!Object|string} Element of the schema.
 * @private
 */
mc.ds.schemaDealias_ = function(el) {
  while (goog.isString(el) && !(el in mc.ds.valueTypes_)
      && !(el in mc.ds.specialTypes_)) {
    goog.asserts.assert(el in mc.ds.schema_,
        'Schema references type \'%s\' which is not defined.', el);
    el = mc.ds.schema_[el];
  }
  return el;
};


/**
 * Key lookup for schema objects that understands wildcard key.
 * @param {!Object} obj Object in which to look.
 * @param {string} lookupKey Non-wildcard data tree key.
 * @return {!Object|string|null} Child element in the schema or null if no
 *     matching element.
 * @private
 */
mc.ds.schemaGetChild_ = function(obj, lookupKey) {
  var key;
  if ('*' in obj) {
    key = '*';
  } else {
    if (!(lookupKey in obj)) {
      return null;
    }
    key = lookupKey;
  }
  return obj[key];
};


/**
 * Returns the schema element that corresponds to data tree elements matching a
 * given path, taking as argument a type registry element that is known to
 * correspond to data tree elements matching a prefix of this path. Calling this
 * function implies expectation that such schema  element exists - if it is not
 * found, assertion error is thrown.
 * @param {mc.ds.Path} prefix Renamed path prefix, can contain wildcards.
 * @param {!Object|string} el Schema element associated with prefix, must be
 *     dealiased.
 * @param {mc.ds.Path} suffix Renamed remainder of the path, must be fully
 *     qualified.
 * @return {!Object|string} Type registry element that corresponds to a path
 *     which is concatenation of prefix and suffix. Custom type names are
 *     dealiased.
 * @private
 */
mc.ds.schemaGet_ = function(prefix, el, suffix) {
  if (!suffix.length) {
    return el;
  }

  if (goog.isString(el)) {
    goog.asserts.assert(false,
        'Invalid path \'%s\': according to schema, prefix \'%s\' points to a' +
        ' value.',
        goog.array.concat(prefix, suffix).join('/'), prefix.join('/'));
  }

  var childEl = mc.ds.schemaGetChild_(goog.asserts.assertObject(el),
      suffix[0]);
  goog.asserts.assert(!goog.isNull(childEl),
      'Invalid path \'%s\': unexpected path element \'%s\' following \'%s\'.',
      goog.array.concat(prefix, suffix).join('/'), suffix[0],
      prefix.join('/'));
  goog.asserts.assert(goog.isObject(childEl) || goog.isString(childEl));
  childEl = mc.ds.schemaDealias_(/** @type {!Object|string} */ (childEl));
  return mc.ds.schemaGet_(goog.array.concat(prefix, suffix[0]), childEl,
      goog.array.slice(suffix, 1));
};


/**
 * Iterates over all schema elements that can be associated with data tree
 * elements matching a given, possibly not fully qualified path. Takes as
 * argument the schema element that is known to correspond to data tree elements
 * matching some prefix of the path.
 * @param {!Object|string} el Schema element, must be dealiased.
 * @param {mc.ds.Path} path Renamed relative path, can contain wildcards.
 * @param {function((!Object|string)): *} f The callback function, takes the
 *     schema element (for custom types this will be type schema, not type name)
 *     as argument. Iteration stops if f returns a value that evaluates to true.
 * @param {Object=} opt_obj Optional scope in which to call f.
 * @return {*} A value that was returned by callback function if the iteration
 *     stopped early.
 * @private
 */
mc.ds.schemaForEach_ = function(el, path, f, opt_obj) {
  if (!path.length) {
    return f.call(opt_obj, el);
  }

  if (goog.isString(el)) {
    return;
  }

  if (path[0] == '*') {
    for (var key in el) {
      var childEl = mc.ds.schemaGetChild_(el, key);
      if (!goog.isNull(childEl)) {
        var retval = mc.ds.schemaForEach_(mc.ds.schemaDealias_(childEl),
            goog.array.slice(path, 1), f, opt_obj);
        if (retval) { return retval; }
      }
    }
  } else {
    var childEl = mc.ds.schemaGetChild_(el, path[0]);
    if (!goog.isNull(childEl)) {
      return mc.ds.schemaForEach_(mc.ds.schemaDealias_(childEl),
          goog.array.slice(path, 1), f, opt_obj);
    }
  }
};
