#!/usr/bin/python
#
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


from collections import defaultdict
import json
import unittest

from google.appengine.api import channel
from google.appengine.api import memcache
from google.appengine.ext import ndb
from google.appengine.ext import testbed
import webtest

import channel as mcchannel
from service import Service


class TestCase(unittest.TestCase):

  def setUp(self):
    self.testapp = webtest.TestApp(mcchannel.app)
    self.testbed = testbed.Testbed()
    self.testbed.activate()
    self.time = 0.
    stub = memcache.memcache_stub.MemcacheServiceStub(
        gettime=(lambda: self.time))
    self.testbed._register_stub(testbed.MEMCACHE_SERVICE_NAME, stub)
    self.testbed.init_channel_stub()
    mcchannel._open_requests = set(['1'])


  def tearDown(self):
    self.testbed.deactivate()
    mcchannel._open_requests = set()
    mcchannel._outgoing_messages = defaultdict(lambda: defaultdict(list))



  @ndb.synctasklet
  def test_send(self):
    sent_messages = []
    @ndb.tasklet
    def sent_messages_by_channel(client_id, messages):
      sent_messages.append([client_id, messages]);
    original_send_messages_by_channel = mcchannel._send_messages_by_channel
    mcchannel._send_messages_by_channel = sent_messages_by_channel
    try:
      mcchannel._open_requests = set()
      yield mcchannel.send('service1', '1', 'message1')
      self.assertEquals([['1', {'service1': ['message1']}]], sent_messages)
      sent_messages = []
      self.assertEqual({}, mcchannel._outgoing_messages)

      mcchannel._open_requests = set(['1'])
      yield mcchannel.send('service1', '1', 'message2')
      self.assertEquals([], sent_messages)
      self.assertEqual({'1': {'service1': ['message2']}},
          mcchannel._outgoing_messages)

    finally:
      mcchannel._send_messages_by_channel = original_send_messages_by_channel



  @ndb.synctasklet
  def test_handle_system_service_message_get_token(self):
    system_service = mcchannel._SystemService(mcchannel._SYSTEM_SERVICE, '1')
    yield system_service.handle_message({'getToken': None})
    channel_stub = self.testbed.get_stub('channel')
    token = mcchannel._outgoing_messages['1'][mcchannel._SYSTEM_SERVICE][-1][
        'token']
    self.assertEquals('1', channel_stub.client_id_from_token(token))


  @ndb.synctasklet
  def test_handle_system_service_message_pickup(self):
    system_service = mcchannel._SystemService(mcchannel._SYSTEM_SERVICE, '1')
    memcache.set(mcchannel._PICKUP_MEMCACHE_PREFIX + 'abc',
        {'service1': ['message1']})
    yield system_service.handle_message({'pickup': 'abc'})
    self.assertEquals(mcchannel._outgoing_messages,
        {'1': {'service1': ['message1']}})


  @ndb.synctasklet
  def test_send_messages_by_channel(self):
    channel_stub = self.testbed.get_stub('channel')
    token = channel.create_channel('1')
    channel_stub.connect_channel(token)

    # Case when message small enough to send over GAE channel

    messages = {'service1': ['message1']}
    retval = yield mcchannel._send_messages_by_channel('1', messages)
    self.assertIs(True, retval)
    channel_messages = channel_stub.get_channel_messages(token)
    channel_stub.clear_channel_messages(token)
    self.assertEquals(1, len(channel_messages))
    channel_message = json.loads(channel_messages[0])
    self.assertEquals(messages, channel_message)

    original_send_message = channel.send_message
    channel.send_message = lambda client_id, message: 1/0
    try:
      retval = yield mcchannel._send_messages_by_channel('1', messages)
      self.assertIs(False, retval)
    finally:
      channel.send_message = original_send_message

    # Case when message too large to send over GAE channel

    message = 'a'*(32 * 1024 + 1)
    messages = {'service1': [message]}
    retval = yield mcchannel._send_messages_by_channel('1', messages)
    self.assertIs(True, retval)
    channel_messages = channel_stub.get_channel_messages(token)
    self.assertEquals(1, len(channel_messages))
    channel_message = json.loads(channel_messages[0])
    pickup_id = channel_message[mcchannel._SYSTEM_SERVICE][0]['pickup']
    self.assertEquals({mcchannel._SYSTEM_SERVICE: [{'pickup': pickup_id}]},
        channel_message)
    self.assertEquals(messages, memcache.get(mcchannel._PICKUP_MEMCACHE_PREFIX +
        pickup_id))

    original_send_message = channel.send_message
    channel.send_message = lambda client_id, message: 1/0
    try:
      retval = yield mcchannel._send_messages_by_channel('1', messages)
      self.assertIs(False, retval)
    finally:
      channel.send_message = original_send_message


  def test_connected_handler(self):
    channel_stub = self.testbed.get_stub('channel')
    token1 = channel.create_channel('1')
    channel_stub.connect_channel(token1)
    self.testapp.post('/_ah/channel/connected/', {'from': '1'},
        {'Content-Type': 'application/x-www-form-urlencoded'})
    self.assertIs(True, memcache.get(
        mcchannel._config.NAMESPACE + 'connected_1'))
    channel_messages = channel_stub.get_channel_messages(token1)
    self.assertEquals([], channel_messages)
    self.time += (mcchannel._CHANNEL_LIFESPAN +
        mcchannel._CHANNEL_RECONNECT_TIMEOUT)
    self.assertIs(None, memcache.get(
        mcchannel._config.NAMESPACE + 'connected_1'))

    token2 = channel.create_channel('2')
    channel_stub.connect_channel(token2)
    memcache.set(mcchannel._config.NAMESPACE + 'buffered_messages_2',
        {'service1': ['message1']})
    self.testapp.post('/_ah/channel/connected/', {'from': '2'},
        {'Content-Type': 'application/x-www-form-urlencoded'})
    channel_messages = channel_stub.get_channel_messages(token2)
    self.assertEquals([json.dumps({'service1': ['message1']})],
        channel_messages)
    self.assertIs(None,
        memcache.get(mcchannel._config.NAMESPACE + 'buffered_messages_2'))


  def test_disconnected_handler(self):
    self.testapp.post('/_ah/channel/disconnected/', {'from': '1'},
        {'Content-Type': 'application/x-www-form-urlencoded'})
    self.assertIs(False, memcache.get(
        mcchannel._config.NAMESPACE + 'connected_1'))
    self.time += mcchannel._CHANNEL_RECONNECT_TIMEOUT + 1.
    self.assertIs(None, memcache.get(
        mcchannel._config.NAMESPACE + 'connected_1'))


  def test_get_service_instance(self):
    original_services = list(mcchannel._config.SERVICES)
    try:
      class Service1(Service): pass
      class Service2(Service): pass
      mcchannel._config.SERVICES.insert(0, ('aa.', Service1))
      mcchannel._config.SERVICES.insert(0, ('^bbb$', Service2))
      service = mcchannel._get_service_instance('aax', '1')
      self.assertIsInstance(service, Service1)
      self.assertEquals('1', service.client_id)
      self.assertEquals('aax', service.name)
      service = mcchannel._get_service_instance('bbb', '1')
      self.assertIsInstance(service, Service2)
      self.assertIs(None, mcchannel._get_service_instance('aaxy', '1'))
      self.assertIs(None, mcchannel._get_service_instance('yaax', '1'))
    finally:
      mcchannel._config.SERVICES = original_services


  @ndb.synctasklet
  def test_buffer_messages(self):
    client = memcache.Client()
    messages = {'service1': ['message1']}
    yield mcchannel._buffer_messages('1', messages)
    self.assertEquals(messages, memcache.get(mcchannel._config.NAMESPACE +
        'buffered_messages_1'))
    yield mcchannel._buffer_messages('1', {'service1': ['message2']})
    self.assertEquals({'service1': ['message1', 'message2']},
        memcache.get(mcchannel._config.NAMESPACE +
        'buffered_messages_1'))


  def test_forward_channel_handler(self):
    channel_stub = self.testbed.get_stub('channel')
    token1 = channel.create_channel('1')
    channel_stub.connect_channel(token1)
    token2 = channel.create_channel('2')
    channel_stub.connect_channel(token2)

    handle_message_callbacks = {'service1': [], 'service2': []}
    disconnected_callbacks = {'service1': [], 'service2': []}

    # Client 1 will be the one that sent the forward channel request, initially
    # not connected.

    # Client 2 will be connected.
    memcache.set(mcchannel._config.NAMESPACE + 'connected_2', True)

    # Client 3 will be temporarily disconnected.
    memcache.set(mcchannel._config.NAMESPACE + 'connected_3', False)

    # Client 4 will be permanently disconnected.

    class Service1(Service):
      @ndb.tasklet
      def handle_message(self, payload):
        handle_message_callbacks['service1'].append(
            {'client_id': self.client_id, 'payload': payload})
        self.send('back_message1', service='service2', client_id='1')
        self.send('back_message2', service='service3', client_id='2')
        yield memcache.Client().get_multi_async(['test'])
        self.send('back_message3', service='service4', client_id='2')
        self.send('back_message4', service='service2', client_id='3')
        self.send('back_message5', service='service2', client_id='4')

      def handle_disconnected(self):
        disconnected_callbacks['service1'].append(
            {'client_id': self.client_id})

    class Service2(Service):
      def handle_message(self, payload):
        handle_message_callbacks['service2'].append(
            {'client_id': self.client_id, 'payload': payload})

      @ndb.tasklet
      def handle_disconnected(self):
        yield memcache.Client().get_multi_async(['test'])
        disconnected_callbacks['service2'].append(
            {'client_id': self.client_id})

    original_services = list(mcchannel._config.SERVICES)
    mcchannel._config.SERVICES.insert(0, ('service2', Service2))
    mcchannel._config.SERVICES.insert(0, ('service1', Service1))
    mcchannel._open_requests = set()

    try:
      messages = {'service1': ['message1'],
        'service2': ['message2', 'message3']}
      response = self.testapp.post(mcchannel._config.BASE_URL_PATH + '?zx=abc',
          {'cid': '1', 'm': json.dumps(messages)},
          {'Content-Type':
          'application/x-www-form-urlencoded;char set=utf-8'})
      self.assertEquals({
        'service1': [
          {'client_id': '1', 'payload': 'message1'},
        ],
        'service2': [
          {'client_id': '1', 'payload': 'message2'},
          {'client_id': '1', 'payload': 'message3'},
        ]}, handle_message_callbacks)
      self.assertEquals({'service1': [], 'service2': [{'client_id': '4'}]},
          disconnected_callbacks)
      self.assertEquals(json.dumps({'service2': ['back_message1']}),
          response.body)
      channel_messages1 = channel_stub.get_channel_messages(token1)
      # No messages should be sent for GAE channel for client 1.
      self.assertEquals([], channel_messages1)
      channel_messages2 = channel_stub.get_channel_messages(token2)
      # Back messages 2 & 3 should be sent over GAE channel for client 2.
      self.assertEquals([json.dumps(
          {'service3': ['back_message2'], 'service4': ['back_message3']})],
          channel_messages2)
      # Client 1 should now be temporarily disconnected, the others without
      # changes.
      self.assertIs(False,
          memcache.get(mcchannel._config.NAMESPACE + 'connected_1'))
      self.assertIs(True,
          memcache.get(mcchannel._config.NAMESPACE + 'connected_2'))
      self.assertIs(False,
          memcache.get(mcchannel._config.NAMESPACE + 'connected_3'))
      self.assertIs(None,
          memcache.get(mcchannel._config.NAMESPACE + 'connected_4'))
      # Messages should be buffered only for client 3.
      self.assertEquals(None,
          memcache.get(mcchannel._config.NAMESPACE + 'buffered_messages_1'))
      self.assertEquals(None,
          memcache.get(mcchannel._config.NAMESPACE + 'buffered_messages_2'))
      self.assertEquals({'service2': ['back_message4']},
          memcache.get(mcchannel._config.NAMESPACE + 'buffered_messages_3'))
      self.assertEquals(None,
          memcache.get(mcchannel._config.NAMESPACE + 'buffered_messages_4'))
    finally:
      mcchannel._config.SERVICES = original_services


  def test_presence_handlers(self):
    callbacks_connected = [];
    callbacks_disconnected = [];
    original_connected_handlers = list(mcchannel._config.CONNECTED_HANDLERS)
    original_disconnected_handlers = list(
        mcchannel._config.DISCONNECTED_HANDLERS)
    try:
      mcchannel._config.CONNECTED_HANDLERS.append(
          lambda client_id: callbacks_connected.append(client_id))
      mcchannel._config.DISCONNECTED_HANDLERS.append(
          lambda client_id: callbacks_disconnected.append(client_id))
      self.testapp.post('/_ah/channel/connected/', {'from': '1'},
          {'Content-Type': 'application/x-www-form-urlencoded'})
      self.testapp.post('/_ah/channel/disconnected/', {'from': '2'},
          {'Content-Type': 'application/x-www-form-urlencoded'})
      self.assertEquals(callbacks_connected, ['1'])
      self.assertEquals(callbacks_disconnected, ['2'])
    finally:
      mcchannel._config.CONNECTED_HANDLERS = original_connected_handlers
      mcchannel._config.DISCONNECTED_HANDLERS = original_disconnected_handlers


if __name__ == '__main__':
  unittest.main()
