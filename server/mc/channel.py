# Copyright 2012 MightyClient Authors. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS-IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.


"""GAE side of two-way communication channel between the client and the server.

For client-server communication protocol, see protocol_channel.md.
"""


from collections import defaultdict
import datetime
import json
import logging
import random
import re
import string
import threading

from google.appengine.api import channel
from google.appengine.api import lib_config
from google.appengine.api import memcache
from google.appengine.ext import ndb
import webapp2

from service import Service


class _ConfigDefaults(object):
  """Configurable constants.

  Sample appengine_config.py:
  --------
  from mc.service import Service


  class EchoService(Service):
    def handle_message(self, payload):
      # Echoes the message to the client who sent it.
      self.send(payload)


  class HelloService(Service):
    def handle_message(self, payload):
      # When one client sends another's ID, says hello to that other client.
      self.send('Hello!', client_id=payload)


  mc_channel_SERVICES = [
    ('echo', EchoService),
    ('hello', HelloService),
  ]
  --------

  Attributes:
      SERVICES: a list of touples (regex, service) where regex is a regular
          expression used to match service name, and service is a subclass of
          service.Service. ^ and $ are added to the regular expession if
          absent. When an incoming message is received, the first matching
          service in the list will be instantiated, and the message will be past
          to its handle_message method. None of the regular expressions should
          match the value of _SYSTEM_SERVICE constant.

      CONNECTED_HANDLERS: a list of callback functions or tasklets that take
          client ID as the single argument and which will be called when
          /_ah/channel/connected/ request is received.

      DISCONNECTED_HANDLERS: a list of callback functions or tasklets that take
          client ID as the single argument and which will be called when
          /_ah/channel/disconnected/ request is received.

      TRACK_PRESENCE: whether to track the clients' presence. When set to True,
          messages are buffered in memcache when the client is temporarily
          disconnected (while opening the channel or re-opening it after 2 hour
          lifespan of an App Engine channel ends). This also enables
          handle_disconnected callback method of the Service class. The value of
          TRACK_PRESENCE constant does not affect functionality provided by
          CONNECTED_HANDLERS and DISCONNECTED_HANDLERS.

      BASE_URL_PATH: base URL path for requests handled by this module.

      NAMESPACE: a string to be prepended to memcache keys used by this module.
  """

  SERVICES = []
  CONNECTED_HANDLERS = []
  DISCONNECTED_HANDLERS = []
  TRACK_PRESENCE = True
  BASE_URL_PATH = '/mc_channel'
  NAMESPACE = 'mc_channel_'


_config = lib_config.register('mc_channel', _ConfigDefaults.__dict__)


# Name of the service used internally by this module.
_SYSTEM_SERVICE = 'system'


# Expiration in seconds of data stored in memcache for pickup by the client.
_PICKUP_EXPIRATION = 60*60


# How long in seconds an App Engine channel can stay disconnected before it
# is considered permanently disconnected.
_CHANNEL_RECONNECT_TIMEOUT = 2*60


# The longest, in seconds, that an App Engine channel can stay open.
_CHANNEL_LIFESPAN = 2*60*60


# Prefix added to memcache keys when storing data for pickup.
_PICKUP_MEMCACHE_PREFIX = _config.NAMESPACE + 'pickup_'


# A lock used when accessing _open_requests.
_open_requests_lock = threading.Lock()


# A set of client IDs for which this server instance is currently handling
# forward channel requests.
_open_requests = set()


# A lock used when accessing _outgoing_messages.
_outgoing_messages_lock = threading.Lock()


# A two-level defaultdict, first-level keys are client IDs, second-level keys
# are service names, and values are lists of outgoing messages.
_outgoing_messages = defaultdict(lambda: defaultdict(list))


# Data stored in memcache (all keys are prefixed with NAMESPACE):
#
#     pickup_<pickup ID>: a dictionary where keys are service names and
#         values are lists of messages that can be picked up by a client.
#
#     connected_<client ID>: a boolean value indicating whether the client
#         is currently connected. When the value is False, the client is
#         considered to be temporarily disconnected, when the value is missing,
#         it is considered to be permanently disconnected.
#
#     buffered_messages_<client ID>: a dictionary where keys are service
#         names and values are lists of messages that will be sent to the
#         client if it reconnects before the correponding timeout expires.



class _SystemService(Service):
  @ndb.tasklet
  def handle_message(self, payload):
    """Implements the abstract method of the superclass.
    """
    assert isinstance(payload, dict)
    if 'getToken' in payload:
      token = channel.create_channel(self.client_id)
      self.send({'token': token})
    elif 'pickup' in payload:
      pickup_id = payload['pickup']
      memcache_key = _PICKUP_MEMCACHE_PREFIX + pickup_id
      results_get_pickup = yield memcache.Client().get_multi_async(
          [memcache_key])
      pickup_data = results_get_pickup.get(memcache_key)
      if pickup_data is not None:
        for service, messages_for_service in pickup_data.iteritems():
          for message in messages_for_service:
            self.send(message, service=service)
      else:
        logging.warning('Memcache read failure.')
    else: logging.error('Unrecognized system service message.')


for pattern, service_cls in _config.SERVICES:
  if re.match(pattern, _SYSTEM_SERVICE):
    assert False, ('Service name pattern "%s" matches the name of the'
        ' system service ("%s").'%(pattern, _SYSTEM_SERVICE))
_config.SERVICES.append((_SYSTEM_SERVICE, _SystemService))


@ndb.tasklet
def send(service, client_id, payload):
  """A tasklet that sends a message to a client.

  If currently we are handling one or more forward channel requests, the tasklet
  completes immediately. Otherwise it may take a little longer because if the
  message is large we may have to store it in message in memcache for pickup
  by a client.

  Args:
      service: name of the service.
      client_id: ID of the client to which to send the message.
      payload: payload that can be serialized to JSON.
  """
  with _open_requests_lock, _outgoing_messages_lock:
    if _open_requests:
      _outgoing_messages[client_id][service].append(payload)
      return
  yield _send_messages_by_channel(client_id, {service: [payload]})


@ndb.tasklet
def _send_messages_by_channel(client_id, messages):
  """Sends service messages using Channel API.

  If the payload size exceeds the limit imposed by the API, sends a pickup
  request to the client.

  Args:
      client_id: ID of the client to which to send the messages.
      messages: a dictionary where keys are service names and values are arrays
          of messages.

  Returns:
      A future whose result is a boolean indicating whether the message was
          successfully sent.
  """
  channel_message = json.dumps(messages)
  if len(channel_message) < 32 * 1024:
    try:
      channel.send_message(client_id, channel_message)
    except:
      raise ndb.Return(False)
    raise ndb.Return(True)
  else:
    pickup_id = ''.join(random.choice(string.ascii_letters + string.digits)
        for x in range(12))
    pickup_key = _PICKUP_MEMCACHE_PREFIX + pickup_id;
    memcache_client = memcache.Client()
    results_set_pickup = yield memcache_client.set_multi_async(
        {pickup_key: messages}, time=_PICKUP_EXPIRATION)
    if (results_set_pickup is None or results_set_pickup[pickup_key] !=
        memcache.STORED):
      logging.warning('Memcache write failure.')
      raise ndb.Return(False)
    try:
      channel.send_message(client_id, json.dumps(
          {_SYSTEM_SERVICE: [{'pickup': pickup_id}]}))
    except:
      raise ndb.Return(False)
    raise ndb.Return(True)


@ndb.tasklet
def _connected_handler(client_id):
  """System handler for when /_ah/channel/connected/ request is received.

  Args:
      client_id: Client ID.
  """
  memcache_client = memcache.Client()
  connected_key = _config.NAMESPACE + 'connected_' + client_id
  results_set_connected = yield memcache_client.set_multi_async(
      {connected_key: True},
      time=_CHANNEL_LIFESPAN + _CHANNEL_RECONNECT_TIMEOUT)
  if (results_set_connected is None or results_set_connected[connected_key] !=
      memcache.STORED):
    logging.warning('Memcache write failure.')
    return
  buffered_messages_key = _config.NAMESPACE + 'buffered_messages_' + client_id
  results_get_buffered_messages = yield memcache_client.get_multi_async(
      [buffered_messages_key])
  buffered_messages = results_get_buffered_messages.get(buffered_messages_key)
  if buffered_messages is not None:
    # Let messages be dropped if the return value is False.
    yield _send_messages_by_channel(client_id, buffered_messages)
    results_delete_buffered_messages = yield memcache_client.delete_multi_async(
        [buffered_messages_key])
    # Can't make sense of the value in the list returned by delete - in
    # unittest returns 2.
    if results_delete_buffered_messages is None:
      logging.warning('Memcache write failure.')

if _config.TRACK_PRESENCE:
  _config.CONNECTED_HANDLERS.append(_connected_handler)


@ndb.tasklet
def _disconnected_handler(client_id):
  """System handler for when /_ah/channel/disconnected/ request is received.

  Args:
      client_id: Client ID.
  """
  memcache_client = memcache.Client()
  connected_key = _config.NAMESPACE + 'connected_' + client_id
  results_set_connected = yield memcache_client.set_multi_async(
      {connected_key: False}, time=_CHANNEL_RECONNECT_TIMEOUT)
  if (results_set_connected is None or results_set_connected[connected_key] !=
      memcache.STORED):
    logging.warning('Memcache write failure.')


if _config.TRACK_PRESENCE:
  _config.DISCONNECTED_HANDLERS.append(_disconnected_handler)


def _get_service_instance(service, client_id):
  """Creates a Service instance.

  Args:
      service: service name.
      client_id: client ID.

  Returns:
      A new instance of Service or None of no services matched supplied name.
  """
  for pattern, service_cls in _config.SERVICES:
    if not pattern.startswith('^'):
      pattern = '^' + pattern
    if not pattern.endswith('$'):
      pattern += '$'
    if re.match(pattern, service):
      return service_cls(service, client_id)
  logging.warning('No services match service name "%s".'%service)


@ndb.tasklet
def _buffer_messages(client_id, messages):
  """Buffers messages in memcache.

  Args:
      client_id: ID of the client to which the messages are sent.
      messages: a dictionary where keys are service names and values are arrays
          of messages.
  """
  memcache_client = memcache.Client()
  buffered_messages_key = (_config.NAMESPACE + 'buffered_messages_' +
      client_id)
  attempt, max_attempts, extra_attempt = 0, 10, 0
  while (attempt <= max_attempts + extra_attempt):
    attempt += 1
    results_get_buffered_messages = yield memcache_client.get_multi_async(
        [buffered_messages_key], for_cas=True)
    buffered_messages = results_get_buffered_messages.get(
        buffered_messages_key)
    if buffered_messages is None:
      results_add_buffered_messages = (
          yield memcache_client.add_multi_async(
          {buffered_messages_key: {}}))
      if results_add_buffered_messages is None or (
          results_add_buffered_messages[buffered_messages_key] not in
          (memcache.STORED, memcache.EXISTS)):
        logging.warning('Memcache write failure.')
      extra_attempt = 1
      continue
    for service, messages_for_service in messages.iteritems():
      if service not in buffered_messages:
        buffered_messages[service] = []
      buffered_messages[service].extend(messages_for_service)
    results_cas_buffered_messages = yield memcache_client.cas_multi_async(
        {buffered_messages_key: buffered_messages},
        time=_CHANNEL_RECONNECT_TIMEOUT)
    if (results_cas_buffered_messages is None or
        results_cas_buffered_messages[buffered_messages_key] == memcache.ERROR):
      logging.warning('Memcache write failure.')
      break
    elif (results_cas_buffered_messages[buffered_messages_key] ==
        memcache.STORED):
      break
  else:
    logging.warning('Compare-and-set failed because of high contention.')


class _ForwardChannelHandler(webapp2.RequestHandler):
  """Request handler class for forward channel requests.
  """

  @ndb.synctasklet
  def post(self):
    """Implements the abstract method of the superclass.
    """
    client_id = self.request.get('cid', default_value=None)
    if client_id is None: webapp2.abort(400)
    with _open_requests_lock:
      # For simplicity, make sure that we are always handling one request from
      # a particular client at a time on this server instance.
      if client_id in _open_requests: webapp2.abort(400)
      _open_requests.add(client_id)

    try: messages = json.loads(self.request.get('m'))
    except: webapp2.abort(400)
    if not isinstance(messages, dict): webapp2.abort(400)

    # Make sure that if the client is in the process of opening the App Engine
    # channel, messages sent to it will get buffered.
    if _config.TRACK_PRESENCE:
      memcache_client = memcache.Client()
      connected_key = _config.NAMESPACE + 'connected_' + client_id
      results_add_connected = yield memcache_client.add_multi_async(
          {connected_key: False}, time=_CHANNEL_RECONNECT_TIMEOUT)
      if (results_add_connected is None or
          results_add_connected[connected_key] == memcache.ERROR):
        logging.warning('Memcache write failure.')

    # Call handlers of incoming messages.
    futures = []
    for service, messages_for_service in messages.iteritems():
      if not isinstance(messages_for_service, list): webapp2.abort(400)
      service_instance = _get_service_instance(service, client_id)
      if service_instance is not None:
        for message in messages_for_service:
          try:
            future = service_instance.handle_message(message)
            if future is not None: futures.append(future)
          except:
            logging.error(
                'An error raised in a message handler for service \'%s\'.'%
                service, exc_info=sys.exc_info())

    # Wait till _outgoing_messages has been populated.
    yield futures

    # Pick up all messages from _outgoing_messages except the ones for other
    # clients whose forward channel requests are currently being processed on
    # this server instance.
    with _outgoing_messages_lock, _open_requests_lock:
      _open_requests.remove(client_id)
      response_messages = _outgoing_messages.pop(client_id, None);
      channel_messages = {}
      for other_client_id, other_client_messages in (_outgoing_messages.
          iteritems()):
        if other_client_id not in _open_requests:
          channel_messages[other_client_id] = other_client_messages

    # Send messages in response to forward channel request.
    if response_messages:
      self.response.write(json.dumps(response_messages))

    # Send messages via App Engine Channel API.
    futures = []
    channel_messages_keys = channel_messages.keys()
    for client_id in channel_messages_keys:
      client_messages = channel_messages[client_id]
      futures.append(_send_messages_by_channel(client_id, client_messages))

    # Buffer messages for clients that are temporarily disconnected.
    if _config.TRACK_PRESENCE:
      send_messages_by_channel_results = yield futures
      futures = []
      has_sent_channel_message = dict(zip(channel_messages_keys,
          send_messages_by_channel_results))
      results_presence = yield memcache_client.get_multi_async(
          channel_messages.keys(), key_prefix = _config.NAMESPACE +
          'connected_')
      for client_id in channel_messages_keys:
        presence = results_presence.get(client_id)
        if presence is None:
          for service in channel_messages[client_id]:
            service_instance = _get_service_instance(service, client_id)
            if service_instance is not None:
              future = service_instance.handle_disconnected()
              if future is not None: futures.append(future)
        elif presence is False or not has_sent_channel_message[client_id]:
          futures.append(
              _buffer_messages(client_id, channel_messages[client_id]))
      yield futures


class _ConnectedHandler(webapp2.RequestHandler):
  """Request handler for /_ah/channel/connected/.
  """
  @ndb.toplevel
  def post(self):
    client_id = self.request.get('from')
    for callback in _config.CONNECTED_HANDLERS:
      callback(client_id)


class _DisconnectedHandler(webapp2.RequestHandler):
  """Request handler for /_ah/channel/disconnected/.
  """
  @ndb.toplevel
  def post(self):
    client_id = self.request.get('from')
    for callback in _config.DISCONNECTED_HANDLERS:
      callback(client_id)


app = webapp2.WSGIApplication([
  (_config.BASE_URL_PATH + '.*', _ForwardChannelHandler),
  ('/_ah/channel/connected/', _ConnectedHandler),
  ('/_ah/channel/disconnected/', _DisconnectedHandler),
], debug=True)
