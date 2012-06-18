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
import unittest
import urllib

from google.appengine.api import memcache
from google.appengine.datastore import datastore_stub_util
from google.appengine.ext import ndb
from google.appengine.ext import testbed
import webtest

import channel as mcchannel
import datasource


class TestCase(unittest.TestCase):

  def setUp(self):
    self.testapp = webtest.TestApp(datasource.app)
    self.testbed = testbed.Testbed()
    self.testbed.activate()
    self.policy = datastore_stub_util.PseudoRandomHRConsistencyPolicy(
        probability=0)
    self.testbed.init_datastore_v3_stub(consistency_policy=self.policy)
    self.testbed.init_memcache_stub()
    self.testbed.init_channel_stub()
    self.datasource_key = ndb.Key('datasource', 1)
    self.memcache_prefix = (datasource._config.NAMESPACE +
        str(hash(self.datasource_key)) + '_')
    self.service = datasource.DatasourceService('service1', '1')
    self.service.datasource_key = self.datasource_key
    datasource._get_random_string = lambda: 'random_string'
    self.time = 0.
    datasource._gettime = lambda: self.time
    mcchannel._open_requests = set(['1'])


  def tearDown(self):
    self.testbed.deactivate()
    mcchannel._open_requests = set()
    mcchannel._outgoing_messages = defaultdict(lambda: defaultdict(list))
    self.time = 0.


  def test_decode_path(self):
    self.assertEquals([], datasource._decode_path(''))
    self.assertEquals(['a'], datasource._decode_path('a'))
    self.assertEquals(['a', 'b'], datasource._decode_path('a/b'))


  def test_get_consistency_group(self):
    self.assertEquals((), datasource._get_consistency_group([]))
    self.assertEquals(('a',), datasource._get_consistency_group(['a']))
    self.assertEquals(('a', '#'), datasource._get_consistency_group(
        ['a', '#', 'b']))
    self.assertEquals(('#', '#'), datasource._get_consistency_group(
        ['#', '#', 'b']))


  @ndb.synctasklet
  def test_get_updates(self):
    memcache_prefix = self.memcache_prefix + 'update_'
    memcache.set(memcache_prefix + '2', {'path': ['a'], 'new_value': '["v1"]'})
    memcache.set(memcache_prefix + '3', {'path': ['b'], 'new_value': '["v2"]'})
    self.assertEquals([
      {'path': ['a'], 'new_value': '["v1"]', 'version': 2},
      {'path': ['b'], 'new_value': '["v2"]', 'version': 3},
    ], (yield datasource._get_updates(self.datasource_key, 1, 3)))
    with self.assertRaises(datasource._MemcacheReadFailure):
      yield datasource._get_updates(self.datasource_key, 0, 3)


  @ndb.synctasklet
  def test_flush(self):
    memcache.set(self.memcache_prefix + 'state', {
      'clients': set('1'),
      'token': 'abc'
    })
    yield datasource._flush('service1', self.datasource_key)
    self.assertIs(None, memcache.get(self.memcache_prefix + 'state'))
    self.assertEquals({'1': {'service1': [{'flush': 'abc'}]}},
        mcchannel._outgoing_messages)


  @ndb.synctasklet
  def test_get_disk_version(self):
    version = yield self.service._DatasourceService__get_disk_version()
    self.assertEquals(0, version)
    datasource._Version(parent=self.datasource_key, id=1, version=3).put()
    version = yield self.service._DatasourceService__get_disk_version()
    self.assertEquals(3, version)


  @ndb.synctasklet
  def test_initialize_state(self):
    yield self.service._DatasourceService__initialize_state()
    state = memcache.get(self.memcache_prefix + 'state')
    self.assertEquals({
      'token': 'random_string',
      'version': 0,
      'clients': set()
    },  state)


  @ndb.synctasklet
  def test_connect(self):
    yield self.service._DatasourceService__connect()
    state = memcache.get(self.memcache_prefix + 'state')
    self.assertEquals({
      'token': 'random_string',
      'version': 0,
      'clients': set(['1'])
    },  state)


  @ndb.synctasklet
  def test_disconnect(self):
    memcache.set(self.memcache_prefix + 'state', {
      'token': 'random_string',
      'version': 0,
      'clients': set(['1', '2'])
    })
    yield self.service._DatasourceService__disconnect()
    state = memcache.get(self.memcache_prefix + 'state')
    self.assertEquals({
      'token': 'random_string',
      'version': 0,
      'clients': set(['2'])
    },  state)
    yield self.service._DatasourceService__disconnect()
    state = memcache.get(self.memcache_prefix + 'state')
    self.assertEquals({
      'token': 'random_string',
      'version': 0,
      'clients': set(['2'])
    },  state)


  @ndb.synctasklet
  def test_get_disk_state(self):
    disk_state = yield self.service._DatasourceService__get_disk_state()
    self.assertEquals((0, {}), disk_state)
    datasource._Version(parent=self.datasource_key, id=1, version=3).put()
    datasource._Value(parent=self.datasource_key, id='/',
        value='["v1"]').put()
    datasource._Value(parent=self.datasource_key, id='a0/a1',
        value='["v2"]').put()
    disk_state = yield self.service._DatasourceService__get_disk_state()
    self.assertEquals((3, {
      '.': ["v1"],
      'a0': {'a1': {'.': ["v2"]}}
    }), disk_state)


  @ndb.synctasklet
  def test_handle_init1(self):
    self.service.access_mode = 'r'
    memcache.set(self.memcache_prefix + 'update_' + '1',
        {'path': ['a'], 'new_value': '["v1"]'})
    memcache.set(self.memcache_prefix + 'state', {
      'token': 'state_token_1',
      'version': 1,
      'last_transaction': [
        {'path': ['b'], 'new_value': '["v2"]', 'version': 2},
      ],
      'clients': set(['1'])
    })

    yield self.service._DatasourceService__handle_init({'init': [None, 'abc']})
    self.assertEquals({'1': {'service1': [{'init_success': [
      'abc',
      'state_token_1',
      0,
      {},
      [
        ['a', ["v1"], 1],
        ['b', ["v2"], 2],
      ]
    ]}]}}, mcchannel._outgoing_messages)

    mcchannel._outgoing_messages = defaultdict(lambda: defaultdict(list))
    datasource._Version(parent=self.datasource_key, id=1, version=1).put()
    datasource._Value(parent=self.datasource_key, id='a',
        value='["v3"]').put()
    yield self.service._DatasourceService__handle_init({'init': [None, 'abc']})
    self.assertEquals({'1': {'service1': [{'init_success': [
      'abc',
      'state_token_1',
      1,
      {'a': {'.': ["v3"]}},
      [
        ['b', ["v2"], 2],
      ]
    ]}]}}, mcchannel._outgoing_messages)

    mcchannel._outgoing_messages = defaultdict(lambda: defaultdict(list))
    datasource._Version(parent=self.datasource_key, id=1, version=2).put()
    datasource._Value(parent=self.datasource_key, id='b',
        value='["v4"]').put()
    yield self.service._DatasourceService__handle_init({'init': [None, 'abc']})
    self.assertEquals({'1': {'service1': [{'init_success': [
      'abc',
      'state_token_1',
      2,
      {
        'a': {'.': ["v3"]},
        'b': {'.': ["v4"]}
      },
      []
    ]}]}}, mcchannel._outgoing_messages)


  @ndb.synctasklet
  def test_handle_init2(self):
    self.service.access_mode = 'r'
    memcache.set(self.memcache_prefix + 'update_' + '2',
        {'path': ['a'], 'new_value': '["v1"]'})
    memcache.set(self.memcache_prefix + 'state', {
      'token': 'state_token_1',
      'version': 2,
      'last_transaction': [
        {'path': ['b'], 'new_value': '["v2"]', 'version': 3},
      ],
      'clients': set(['1'])
    })

    yield self.service._DatasourceService__handle_init({'init': [1, 'abc']})
    self.assertEquals({'1': {'service1': [{'init_success': [
      'abc',
      'state_token_1',
      0,
      None,
      [
        ['a', ["v1"], 2],
        ['b', ["v2"], 3],
      ]
    ]}]}}, mcchannel._outgoing_messages)

    mcchannel._outgoing_messages = defaultdict(lambda: defaultdict(list))

    yield self.service._DatasourceService__handle_init({'init': [3, 'abc']})
    self.assertEquals({'1': {'service1': [{'init_success': [
      'abc',
      'state_token_1',
      3,
      None,
      []
    ]}]}}, mcchannel._outgoing_messages)

    mcchannel._outgoing_messages = defaultdict(lambda: defaultdict(list))

    yield self.service._DatasourceService__handle_init({'init': [0, 'abc']})
    self.assertEquals({'1': {'service1': [{'init_failure': 'abc'}]}},
        mcchannel._outgoing_messages)

    mcchannel._outgoing_messages = defaultdict(lambda: defaultdict(list))

    self.assertTrue(memcache.get(self.memcache_prefix + 'state'))
    yield self.service._DatasourceService__handle_init({'init': [None, 'abc']})
    self.assertEquals({'1': {'service1': [{'flush': 'state_token_1'}]}},
        mcchannel._outgoing_messages)
    # State should be flushed
    self.assertIs(None, memcache.get(self.memcache_prefix + 'state'))


  @ndb.synctasklet
  def test_save_updates_to_memcache(self):
    yield self.service._DatasourceService__save_updates_to_memcache([
      {'path': ['a'], 'new_value': '["v1"]', 'version': 2}
    ])
    self.assertEquals({'path': ['a'], 'new_value': '["v1"]'}, memcache.get(
        self.memcache_prefix + 'update_2'))


  @ndb.synctasklet
  def test_apply_transaction(self):
    memcache.set(self.memcache_prefix + 'update_' + '2',
        {'path': ['a'], 'new_value': '["v1"]'})
    memcache.set(self.memcache_prefix + 'state', {
      'token': 'state_token_1',
      'version': 2,
      'last_transaction': [
        {'path': ['b'], 'new_value': '["v2"]', 'version': 3},
      ],
      'clients': set(['1', '2'])
    })
    cache = {
      'last_checked_version': 1,
      'locked_consistency_groups': set()
    }

    with self.assertRaises(datasource._InMemoryStateTokenMismatch):
      yield self.service._DatasourceService__apply_transaction([
        ['c', ["v3"]]
      ], cache, 'state_token_2')

    retval = yield self.service._DatasourceService__apply_transaction([
      ['c', ["v3"]]
    ], cache, 'state_token_1')
    self.assertEquals({
      'last_checked_version': 4,
      'locked_consistency_groups': set([('a',), ('b',)])
    }, cache)
    self.assertEquals({'path': ['b'], 'new_value': '["v2"]'},
        memcache.get(self.memcache_prefix + 'update_' + '3'))
    self.assertEquals({
      'token': 'state_token_1',
      'version': 3,
      'last_transaction': [
        {'path': ['c'], 'new_value': '["v3"]', 'version': 4},
      ],
      'clients': set(['1', '2'])
    }, memcache.get(self.memcache_prefix + 'state'))
    self.assertEquals(({'2': {'service1': [{'updates': [
      'state_token_1',
      [
        ['c', ["v3"], 4]
      ]
    ]}]}}), mcchannel._outgoing_messages)
    self.assertEquals(4, retval)

    with self.assertRaises(datasource._MidAirCollision):
      yield self.service._DatasourceService__apply_transaction([
        ['a', ["v4"]]
      ], cache, 'state_token_1')


  @ndb.synctasklet
  def test_initialize_saving_status(self):
    yield self.service._DatasourceService__initialize_saving_status()
    self.assertEquals({
      'saving': False,
      'scheduled': False,
      'timestamp': None
    }, memcache.get(self.memcache_prefix + 'saving_status'))
    memcache.set(self.memcache_prefix + 'saving_status', 'test_value')
    yield self.service._DatasourceService__initialize_saving_status()
    self.assertEquals('test_value',
        memcache.get(self.memcache_prefix + 'saving_status'))


  @ndb.synctasklet
  def test_initiate_saving(self):
    send_save_request_calls = []
    original_send_save_request = datasource._send_save_request
    datasource._send_save_request = (lambda *args:
        send_save_request_calls.append(args))
    try:
      yield self.service._DatasourceService__initiate_saving()
      self.assertEquals({
        'saving': True,
        'scheduled': False,
        'timestamp': 0.
      }, memcache.get(self.memcache_prefix + 'saving_status'))
      self.assertEquals([('service1', self.datasource_key)],
          send_save_request_calls)
      send_save_request_calls = []

      yield self.service._DatasourceService__initiate_saving()
      self.assertEquals({
        'saving': True,
        'scheduled': True,
        'timestamp': 0.
      }, memcache.get(self.memcache_prefix + 'saving_status'))
      self.assertEquals([], send_save_request_calls)

      self.time += datasource._SAVE_TIMEOUT + 1.
      yield self.service._DatasourceService__initiate_saving()
      self.assertEquals({
        'saving': True,
        'scheduled': False,
        'timestamp': self.time
      }, memcache.get(self.memcache_prefix + 'saving_status'))
      self.assertEquals([('service1', self.datasource_key)],
          send_save_request_calls)

    finally:
      datasource._send_save_request = original_send_save_request


  @ndb.synctasklet
  def test_handle_updates(self):
    send_save_request_calls = []
    original_send_save_request = datasource._send_save_request
    datasource._send_save_request = (lambda *args:
        send_save_request_calls.append(args))
    flush_calls = []
    original_flush = datasource._flush
    datasource._flush = (lambda *args:
        flush_calls.append(args))
    try:
      self.service.access_mode = 'r'
      payload = {'updates': [
        'state_token_1',
        0,
        [
          'transaction1',
          'transaction2',
        ]
      ]}
      yield self.service._DatasourceService__handle_updates(payload)
      self.assertEquals({}, mcchannel._outgoing_messages)
      self.assertEquals([], send_save_request_calls)
      self.assertEquals([], flush_calls)

      self.service.access_mode = 'rw'
      def raise_exception(cls):
        raise cls()
      self.service._DatasourceService__apply_transaction = (
          lambda *args: raise_exception(datasource._InMemoryStateTokenMismatch))
      yield self.service._DatasourceService__handle_updates(payload)
      self.assertEquals({}, mcchannel._outgoing_messages)
      self.assertEquals([], send_save_request_calls)
      self.assertEquals([], flush_calls)

      self.service._DatasourceService__apply_transaction = (
          lambda *args: raise_exception(datasource._MidAirCollision))
      yield self.service._DatasourceService__handle_updates(payload)
      self.assertEquals({'1': {'service1': [{'outcomes': [
        'state_token_1',
        0,
        [None, None]
      ]}]}}, mcchannel._outgoing_messages)
      mcchannel._outgoing_messages = defaultdict(lambda: defaultdict(list))
      self.assertEquals([], send_save_request_calls)
      self.assertEquals([], flush_calls)

      @ndb.tasklet
      def apply_transaction(updates, cache, state_token):
        raise ndb.Return({
          'transaction1': 1,
          'transaction2': 2
        }[updates])
      self.service._DatasourceService__apply_transaction = apply_transaction
      yield self.service._DatasourceService__handle_updates(payload)
      self.assertEquals({'1': {'service1': [{'outcomes': [
        'state_token_1',
        0,
        [1, 2]
      ]}]}}, mcchannel._outgoing_messages)
      mcchannel._outgoing_messages = defaultdict(lambda: defaultdict(list))
      self.assertEquals([('service1', self.datasource_key)],
          send_save_request_calls)
      send_save_request_calls = []
      self.assertEquals([], flush_calls)

      self.service._DatasourceService__apply_transaction = (
          lambda *args: raise_exception(datasource._MemcacheReadFailure))
      yield self.service._DatasourceService__handle_updates(payload)
      # No flush message because _flush was stubbed out.
      self.assertEquals({}, mcchannel._outgoing_messages)
      mcchannel._outgoing_messages = defaultdict(lambda: defaultdict(list))
      self.assertEquals([], send_save_request_calls)
      self.assertEquals([('service1', self.datasource_key)],
          flush_calls)

    finally:
      datasource._send_save_request = original_send_save_request
      datasource._flush = original_flush


  def test_update_saving_status_after_saving(self):
    send_save_request_calls = []
    original_send_save_request = datasource._send_save_request
    datasource._send_save_request = (lambda *args:
        send_save_request_calls.append(args))
    try:
      memcache.set(self.memcache_prefix + 'saving_status', {
        'saving': True,
        'scheduled': False,
        'timestamp': 0
      })
      self.time = 1.
      datasource._update_saving_status_after_saving('service1',
          self.datasource_key)
      self.assertEquals({
        'saving': False,
        'scheduled': False,
        'timestamp': 1
      }, memcache.get(self.memcache_prefix + 'saving_status'))
      self.assertEquals([], send_save_request_calls)

      memcache.set(self.memcache_prefix + 'saving_status', {
        'saving': True,
        'scheduled': True,
        'timestamp': 1.
      })
      self.time = 2.
      datasource._update_saving_status_after_saving('service1',
          self.datasource_key)
      self.assertEquals({
        'saving': True,
        'scheduled': False,
        'timestamp': 2.
      }, memcache.get(self.memcache_prefix + 'saving_status'))
      self.assertEquals([('service1', self.datasource_key)],
          send_save_request_calls)
    finally:
      datasource._send_save_request = original_send_save_request


  def test_save_handler(self):
    update_saving_status_after_saving_calls = []
    original_update_saving_status_after_saving = (
        datasource._update_saving_status_after_saving)
    datasource._update_saving_status_after_saving = (lambda *args:
        update_saving_status_after_saving_calls.append(args))
    try:
      memcache.set(self.memcache_prefix + 'update_' + '1',
          {'path': [], 'new_value': '["v1"]'})
      memcache.set(self.memcache_prefix + 'state', {
        'token': 'state_token_1',
        'version': 1,
        'last_transaction': [
          {'path': ['b'], 'new_value': '["v2"]', 'version': 2},
        ],
        'clients': set(['1'])
      })

      query = urllib.urlencode({
        'datasource_key': self.datasource_key.urlsafe(),
        'service': 'service1'
      })
      self.testapp.post(
          datasource._config.BASE_URL_PATH + '/random?' + query)
      self.assertEquals(2, ndb.Key(datasource._Version, 1,
          parent=self.datasource_key).get().version)
      self.assertEquals('["v1"]', ndb.Key(datasource._Value, '/',
          parent=self.datasource_key).get().value)
      self.assertEquals('["v2"]', ndb.Key(datasource._Value, 'b',
          parent=self.datasource_key).get().value)
      self.assertEquals([('service1', self.datasource_key)],
          update_saving_status_after_saving_calls)
      update_saving_status_after_saving_calls = []
      self.assertEquals({'1': {'service1': [{'saved': [
        'state_token_1',
        2
      ]}]}}, mcchannel._outgoing_messages)
      mcchannel._outgoing_messages = defaultdict(lambda: defaultdict(list))

      # Modify what is stored on disk for paths '' and 'b' to make sure
      # the first two updates do not get saved again.
      datasource._Value(parent=self.datasource_key, id='/',
          value='["other_v1"]').put()
      datasource._Value(parent=self.datasource_key, id='b',
          value='["other_v2"]').put()
      datasource._Value(parent=self.datasource_key, id='c',
          value='["other_v3"]').put()
      memcache.set(self.memcache_prefix + 'update_' + '3',
          {'path': ['c'], 'new_value': 'null'})
      memcache.set(self.memcache_prefix + 'state', {
        'token': 'state_token_1',
        'version': 3,
        'clients': set(['1'])
      })
      self.testapp.post(
          datasource._config.BASE_URL_PATH + '/random?' + query)
      self.assertEquals(3, ndb.Key(datasource._Version, 1,
          parent=self.datasource_key).get().version)
      self.assertEquals('["other_v1"]', ndb.Key(datasource._Value, '/',
          parent=self.datasource_key).get().value)
      self.assertEquals('["other_v2"]', ndb.Key(datasource._Value, 'b',
          parent=self.datasource_key).get().value)
      self.assertIs(None, ndb.Key(datasource._Value, 'c',
          parent=self.datasource_key).get())
      self.assertEquals([('service1', self.datasource_key)],
          update_saving_status_after_saving_calls)
      update_saving_status_after_saving_calls = []
      self.assertEquals({'1': {'service1': [{'saved': [
        'state_token_1',
        3
      ]}]}}, mcchannel._outgoing_messages)
      mcchannel._outgoing_messages = defaultdict(lambda: defaultdict(list))

    finally:
      datasource._update_saving_status_after_saving = (
          original_update_saving_status_after_saving)
