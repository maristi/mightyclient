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

"""Defines base class for datasource services.

For client-server communication protocol, see protocol_datasource.md.
"""

from collections import defaultdict, OrderedDict
import time
import json
import logging
import os
import random
import sys
import string
import threading
import urllib

from google.appengine.api import lib_config
from google.appengine.api import memcache
from google.appengine.api import urlfetch
from google.appengine.ext import ndb
import webapp2

from service import Service


class _ConfigDefaults(object):
  """Configurable constants.

  Attributes:
      NAMESPACE: a string to be prepended to memcache keys and datastore kinds
          used by this module.

      BASE_URL_PATH: base URL path for requests handled by this module.
  """

  NAMESPACE = 'mc_ds_'
  BASE_URL_PATH = '/mc_datasource'


_config = lib_config.register('mc_datasource', _ConfigDefaults.__dict__)


# Timeout in seconds for saving data to disk.
_SAVE_TIMEOUT = float(30)


# Data stored in memcache (all keys are prefixed with
# '<NAMESPACE><hash of datasource key>_'):
#
#     state: in-memory state of the datasource, a dictionary with the following
#         structure:
#
#         {
#           'token': <a random string which is reset whenever the state is
#               added to memcache>,
#           'version': <version before the last transaction, if last transaction
#               is present, or the version of the data on disk otherwise>,
#           # Last transaction (not present when the state has just been added
#           # to memcache and no updates have been made so far).
#           'last_transaction': [
#             # Update 1
#             {
#               'path': <path as a list>,
#               'new_value': <JSON-encoded value>,
#               'version': <version after the update>
#             },
#             # Update 2
#             {...},
#             ...
#           ],
#           # Connected clients.
#           'clients': set([<client ID 1>, <client ID 2>, ...])
#         }
#
#     update_<version>: the update resulting in the version embedded in the key.
#         The structure is
#
#         {'path': <path as a list>, 'new_value': <JSON-encoded value>}
#
#     saving_status: the status of saving data to disk, a dictionary with the
#         following structure:
#
#         {
#           'saving': <a boolean indicating if the datastore transaction that
#               writes updates to disk is in progress>,
#           'scheduled': <a boolean indicating whether a new transaction should
#               be started after the current one, if one is in progress,
#               completes>,
#           'timestamp': <the time the last transaction was started or None
#               initially>
#         }



# A factory function for infinitely nested defaultdicts, takes no arguments.
get_nested_defaultdict = lambda: defaultdict(get_nested_defaultdict)


def _decode_path(path_str):
  """Decodes a '/'-joined path.

  Args:
      path_str: path as a string.

  Returns:
      Path as a list.
  """
  if not path_str: return []
  else: return path_str.split('/')


def _get_consistency_group(path):
  """Returns root of the consistency group of the value at the supplied path.

  Args:
      path: path to a value

  Returns:
      Path to the root of consistency group as a tuple.
  """
  for index, path_el in enumerate(reversed(path)):
    if path_el == '#': return tuple(path[:- index])
  return tuple(path)


def _get_random_string():
  """Returns a random string.
  """
  return ''.join(random.choice(string.ascii_letters +
        string.digits) for x in range(12))


# Alias for time.time that allows using mock clock in unit tests.
_gettime = time.time


class _MemcacheReadFailure(Exception):
  """Memcache read failure.
  """


class _MemcacheWriteFailure(Exception):
  """Memcache write failure.
  """


class _MemcacheContentionError(Exception):
  """Compare-and-set failed because of high contention.
  """


class _MidAirCollision(Exception):
  """Concurrent updates attempted to modify data in the same consistency group.
  """


class _InMemoryStateTokenMismatch(Exception):
  """In-memory state token sent by the client does not match current token.
  """


class _Version(ndb.Model):
  """A model for entities that store the current version of the data.

  Properties:
      version: version number.
  """

  version = ndb.IntegerProperty('n', indexed=False)

  _use_cache = False
  _use_memcache = False

  @classmethod
  def _get_kind(cls):
    """Overrides the superclass static method.
    """
    return _config.NAMESPACE + 'N'


class _Value(ndb.Model):
  """A model for entities that store the current value at a given path.

  Properties:
      value: the JSON-encoded value.
  """

  value = ndb.TextProperty('v')

  _use_cache = False
  _use_memcache = False

  @classmethod
  def _get_kind(cls):
    """Overrides the superclass static method.
    """
    return _config.NAMESPACE + 'V'


@ndb.tasklet
def _get_updates(datasource_key, start, end):
  """Gets the updates for a range of versions.

  Args:
      datasource_key: datasource key.
      start: the version before the first update.
      end: the version after the last update.

  Returns:
      A future whose result is a list of updates sorted by version in the
      format {'path': <path as a list>, 'new_value': <JSON-encoded value>,
      'version': <resulting version>}.

  Raises:
      _MemcacheReadFailure: could not read the full sequence of updates from
          memcache.
  """
  memcache_client = memcache.Client()
  if start == end: raise ndb.Return([])
  memcache_prefix = _config.NAMESPACE + str(hash(datasource_key)) + '_'
  version_range = lambda: xrange(start + 1, end + 1)
  results_get_updates = yield memcache_client.get_multi_async(
        [str(x) for x in version_range()],
        key_prefix=(memcache_prefix + 'update_'))
  updates = []
  for version in version_range():
    update = results_get_updates.get(str(version))
    if update is None: raise _MemcacheReadFailure()
    update['version'] = version
    updates.append(update)
  raise ndb.Return(updates)


@ndb.tasklet
def _flush(service, datasource_key):
  """Attempts to delete the in-memory state from memcache and if successfully
  deleted, notifies clients.

  Args:
      service: service name.
      datasource_key: datasource key.
  """
  memcache_prefix = _config.NAMESPACE + str(hash(datasource_key)) + '_'
  state_key = memcache_prefix + 'state'
  memcache_client = memcache.Client()
  results_get_state = yield memcache_client.get_multi_async([state_key])
  state = results_get_state.get(state_key)
  if state is None:
    logging.warning('Memcache read failure')
    return
  results_delete_state = yield memcache_client.delete_multi_async([state_key])
  # Can't make sense of the values in the list returned by delete.
  if results_delete_state is None:
    logging.warning('Memcache write failure')
    return
  from channel import send
  for client_id in state['clients']:
    yield send(service, client_id, {'flush': state['token']})


def _send_save_request(service, datasource_key):
  """Sends HTTP request that initiates writing data to disk.

  Args:
      service: service name.
      datasource_key: datasource key.
  """
  host_port = os.environ['HTTP_HOST']
  query = urllib.urlencode({
    'datasource_key': datasource_key.urlsafe(),
    'service': service
  })
  # Required to circumvent checking for recursive requests. We are guaranteed
  # against inifinite loop by making sure 'scheduled' parameter of saving_status
  # is successfully set to False before sending request recursively.
  random_string = ''.join(random.choice(string.ascii_letters +
      string.digits) for x in range(12))
  url = ('http://' + host_port + _config.BASE_URL_PATH + '/' +
      _get_random_string() + '?' + query)
  try:
    urlfetch.fetch(url=url, method=urlfetch.POST, deadline=0.001)
  except: pass


class DatasourceService(Service):
  """Base class for services that root nodes on the client can connect to.

  Constructor should set attributes datastore_key and access_mode.

  Attributes:
      datastore_key: a datastore key used as base path for all data stored for
          this datasource.
      access_mode: type of access provided to the client, either 'r' or 'rw'.
  """

  datasource_key = None

  @property
  def __datasource_key(self):
    assert self.datasource_key is not None, 'Datasource key not set.'
    return self.datasource_key


  access_mode = None

  @property
  def __access_mode(self):
    assert self.access_mode is not None, 'Access mode not set.'
    return self.access_mode


  @property
  def __memcache_prefix(self):
    """A prefix to be added to memcache keys specific to the datasource.
    """
    return _config.NAMESPACE + str(hash(self.__datasource_key)) + '_'


  @ndb.tasklet
  def __get_disk_version(self):
    """Returns the version of the data on disk.

    Returns:
        A future whose result is version number.
    """
    version_key = ndb.Key(_Version, 1, parent=self.__datasource_key)
    version_entity = yield version_key.get_async()
    if version_entity is None:
      raise ndb.Return(0)
    else:
      raise ndb.Return(version_entity.version)


  @ndb.tasklet
  def __initialize_state(self):
    """Add to memcache the initial in-memory state.

    Raises:
        _MemcacheWriteFailure: could not write state to memcache.
    """
    state_key = self.__memcache_prefix + 'state'
    memcache_client = memcache.Client()
    disk_version = yield self.__get_disk_version()
    results_add_state = yield memcache_client.add_multi_async(
        {state_key: {
          'token': _get_random_string(),
          'version': disk_version,
          'clients': set()
        }})
    if (results_add_state is None or results_add_state[state_key] ==
        memcache.ERROR):
      raise _MemcacheWriteFailure()


  @ndb.tasklet
  def __connect(self):
    """Add this client's ID to connected clients.

    If necessary initializes the in-memory state.

    Returns:
        A future whose result is in-memory state known to include this client
        in the set of connected clients.

    Raises:
        _MemcacheWriteFailure, _MemcacheContentionError: could not update
            state in memcache.
    """
    state_key = self.__memcache_prefix + 'state'
    memcache_client = memcache.Client()
    attempt, max_attempts, extra_attempt = 0, 10, 0
    while (attempt <= max_attempts + extra_attempt):
      attempt += 1
      results_get_state = yield memcache_client.get_multi_async(
          [state_key], for_cas=True)
      state = results_get_state.get(state_key)
      if state is None:
        yield self.__initialize_state()
        extra_attempt = 1
        continue
      if self.client_id in state['clients']: raise ndb.Return(state)
      state['clients'].add(self.client_id)
      results_cas_state = yield memcache_client.cas_multi_async(
          {state_key: state})
      if (results_cas_state is None or results_cas_state[state_key] ==
          memcache.ERROR):
        raise _MemcacheWriteFailure()
      elif (results_cas_state[state_key] == memcache.STORED):
        break
    else:
      raise _MemcacheContentionError()
    raise ndb.Return(state)


  @ndb.tasklet
  def __disconnect(self):
    """Attempts to remove self.client_id from connected clients.
    """
    memcache_client = memcache.Client()
    state_key = self.__memcache_prefix + 'state'
    attempt, max_attempts = 0, 10
    while (attempt <= max_attempts):
      attempt += 1
      results_get_state = yield memcache_client.get_multi_async(
          [state_key], for_cas=True)
      state = results_get_state.get(state_key)
      if state is None:
        logging.warning('Memcache read failure.')
        return
      if self.client_id not in state['clients']: return
      state['clients'].remove(self.client_id)
      results_cas_state = yield memcache_client.cas_multi_async(
          {state_key: state})
      if (results_cas_state is None or results_cas_state[state_key] ==
          memcache.ERROR):
        logging.warning('Memcache write failure.')
        break
      elif (results_cas_state[state_key] == memcache.STORED):
        break
    else:
      logging.warning('Compare-and-set failed because of high contention.')


  @ndb.tasklet
  def __get_disk_state(self):
    """Reads the current state of the data on disk.

    Returns:
        A future whose result is a tuple (<version>, <data tree>).
    """
    version_key = ndb.Key(_Version, 1, parent=self.__datasource_key)
    values_query = _Value.query(ancestor=self.__datasource_key)
    @ndb.tasklet
    def txn():
      retval = yield version_key.get_async(), values_query.fetch_async()
      raise ndb.Return(retval)
    version_entity, value_entities = yield ndb.transaction_async(txn)
    if version_entity is None:
      version = 0
      data = {}
    else:
      version = version_entity.version
      data = get_nested_defaultdict()
      for valueEntity in value_entities:
        if valueEntity.key.id() == '/': path = []
        else: path = valueEntity.key.id().split('/')
        data_el = data
        for path_el in path: data_el = data_el[path_el]
        data_el['.'] = json.loads(valueEntity.value)
    raise ndb.Return(version, data)


  @ndb.tasklet
  def __handle_init(self, payload):
    """Handles request to connect to datasource or provide updates starting
    from some version.
    """
    assert self.__access_mode in ('r', 'rw'), ('Invalid access mode \'%s\'.'%
        self.__access_mode)

    base_version, request_token = payload['init']

    try:
      state = yield self.__connect()
    except _MemcacheWriteFailure, _MemcacheContentionError:
      logging.warning('Unable to connect a client.', exc_info=sys.exc_info())
      self.send({'init_failure': request_token})
      return
    memory_version = state['version']
    if 'last_transaction' in state:
      memory_version = state['last_transaction'][-1]['version']
    if base_version is None:
      if memory_version == 0:
        disk_version, init_data = 0, {}
      else:
        disk_version, init_data = yield self.__get_disk_state()
      updates_start = disk_version
    else:
      init_data = None
      updates_start = base_version
      if base_version == memory_version:
        # Because base_version <= disk version <= memory_version.
        disk_version = base_version
      else:
        disk_version = yield self.__get_disk_version()

    try:
      updates = yield _get_updates(self.__datasource_key, updates_start,
          state['version'])
    except _MemcacheReadFailure:
      if base_version is None:
        yield _flush(self.name, self.__datasource_key)
      else:
        self.send({'init_failure': request_token})
      return
    if ((base_version is None or memory_version > base_version) and
        'last_transaction' in state and
        state['last_transaction'][-1]['version'] > updates_start):
      for update in state['last_transaction']:
        updates.append(update)

    encoded_updates = [[
      '/'.join(update['path']),
      json.loads(update['new_value']),
      update['version']
    ] for update in updates]

    self.send({'init_success': [
      request_token,
      state['token'],
      disk_version,
      init_data,
      encoded_updates
    ]})


  @ndb.tasklet
  def __save_updates_to_memcache(self, updates):
    """Saves updates to memcache.

    Overwrites any existing updates with the same versions.

    Args:
        updates: A list of updates in the format {'path': <path as a list>,
            'new_value': <JSON-encoded value>, 'version': <resulting version>}.

    Raises:
        _MemcacheWriteFailure: could not save all updates to memcache.
    """
    memcache_client = memcache.Client()
    updates_dict = {}
    for update in updates:
      updates_dict[str(update['version'])] = {
        'path': update['path'],
        'new_value': update['new_value']
      }
    results_set_updates = yield (
        memcache_client.set_multi_async(
        updates_dict,
        key_prefix=self.__memcache_prefix + 'update_'))
    if results_set_updates is None or any(
        (result != memcache.STORED) for result in
        results_set_updates.itervalues()):
      raise _MemcacheWriteFailure()


  @ndb.tasklet
  def __apply_transaction(self, updates, cache, state_token):
    """Applies a transaction to the in-memory state of the data and notifies
    other clients.

    Args:
        updates: a list of updates that make up the transaction, in the format
            as they were sent by the client.
        cache: a dictionary used to cache data between calls for a list of
            transactions sent by the client, for description of items see
            __handle_updates().
        state_token: in-memory state token sent by the client.

    Returns:
        A future whose result is the version of the data after the transaction
        was applied.

    Raises:
        _MidAirCollision: transaction conflicted with another concurrent
            transaction.
        _MemcacheReadFailure: could not read state or updates stored in memory.
        _MemcacheWriteFailure, _MemcacheContentionError: could not write state
            or updates to memcache.
        _InMemoryStateTokenMismatch: supplied state_token doesn't match current
            in-memory state token.
    """
    memcache_client = memcache.Client()
    state_key = self.__memcache_prefix + 'state'
    attempt, max_attempts = 0, 10
    while (attempt <= max_attempts):
      attempt += 1
      results_get_state = yield memcache_client.get_multi_async(
          [state_key], for_cas=True)
      state = results_get_state.get(state_key)
      if state is None: raise _MemcacheReadFailure()
      if state['token'] != state_token: raise _InMemoryStateTokenMismatch()

      # Bring locked_consistency_groups up to date, may throw
      # _MemcacheReadFailure.
      concurrent_updates = yield _get_updates(self.__datasource_key,
          cache['last_checked_version'], state['version'])
      if 'last_transaction' in state:
        for update in state['last_transaction']:
          if (cache['last_checked_version'] < update['version']):
            concurrent_updates.append(update)
      for update in concurrent_updates:
        cache['locked_consistency_groups'].add(
            _get_consistency_group(update['path']))
      if concurrent_updates:
        cache['last_checked_version'] = update['version']

      # Check if any of the locked_consistency_groups would be modified and
      # update state.
      transaction = []
      version = cache['last_checked_version']
      for update in updates:
        version += 1
        client_path, client_new_value = update
        path = _decode_path(client_path)
        if _get_consistency_group(path) in cache['locked_consistency_groups']:
          raise _MidAirCollision()
        transaction.append({
          'path': path,
          'new_value': json.dumps(client_new_value),
          'version': version
        })
      previous_transaction = state.get('last_transaction')
      if previous_transaction is not None:
        state['version'] = previous_transaction[-1]['version']
      state['last_transaction'] = transaction
      cache['last_checked_version'] = version

      # Save to memcache the updates from the transaction that was swapped
      # out of state. May throw _MemcacheWriteFailure.
      if previous_transaction is not None:
        yield self.__save_updates_to_memcache(previous_transaction)

      results_cas_state = yield memcache_client.cas_multi_async(
          {state_key: state})
      if (results_cas_state is not None and
          results_cas_state[state_key] == memcache.STORED):
        break
    else:
      raise _MemcacheContentionError()

    encoded_updates = [[
      '/'.join(update['path']),
      json.loads(update['new_value']),
      update['version']
    ] for update in transaction]

    for client_id in state['clients']:
      if client_id != self.client_id:
        self.send({'updates': [state_token, encoded_updates]},
            client_id=client_id)

    raise ndb.Return(version)


  @ndb.tasklet
  def __initialize_saving_status(self):
    """Adds to memcache the saving status.

    Raises:
        _MemcacheWriteFailure: could not write saving status to memcache.
    """
    saving_status_key = self.__memcache_prefix + 'saving_status'
    memcache_client = memcache.Client()
    results_get_saving_status = yield memcache_client.get_multi_async(
        [saving_status_key])
    saving_status = results_get_saving_status.get(saving_status_key)
    if saving_status is not None: return
    saving_status = {
      'saving': False,
      'scheduled': False,
      'timestamp': None
    }
    results_add_saving_status = yield memcache_client.add_multi_async(
        {saving_status_key: saving_status})
    if (results_add_saving_status is None or results_add_saving_status[
        saving_status_key] == memcache.ERROR):
      raise _MemcacheWriteFailure()


  @ndb.tasklet
  def __initiate_saving(self):
    """Initiates saving in-memory updates to disk.

    If the datastore transaction is in progress, schedules a new transaction
    after the current one is completed, otherwise sends a POST request that
    starts the transaction.

    Raises:
        _MemcacheWriteFailure, _MemcacheContentionError: could not write saving
            status to memcache.
    """
    saving_status_key = self.__memcache_prefix + 'saving_status'
    memcache_client = memcache.Client()
    attempt, max_attempts, extra_attempt = 0, 10, 0
    should_send_request = False
    while (attempt <= max_attempts + extra_attempt):
      attempt += 1
      results_get_saving_status = yield memcache_client.get_multi_async(
          [saving_status_key], for_cas=True)
      saving_status = results_get_saving_status.get(saving_status_key)
      if saving_status is None:
        # May throw _MemcacheWriteFailure.
        yield self.__initialize_saving_status()
        extra_attempt = 1
        continue
      if (saving_status['timestamp'] is not None and
          _gettime() - saving_status['timestamp'] > _SAVE_TIMEOUT):
        should_send_request = True
        saving_status = {
          'saving': True,
          'scheduled': False,
          'timestamp': _gettime()
        }
      else:
        if not saving_status['saving']:
          should_send_request = True
          saving_status['saving'] = True
          saving_status['timestamp'] =_gettime()
        else:
          if saving_status['scheduled']:
            return
          else:
            saving_status['scheduled'] = True
      results_cas_saving_status = yield memcache_client.cas_multi_async(
          {saving_status_key: saving_status})
      if (results_cas_saving_status is None or
          results_cas_saving_status[saving_status_key] ==
          memcache.ERROR):
        raise _MemcacheWriteFailure()
      elif (results_cas_saving_status[saving_status_key] == memcache.STORED):
        break
    else:
      raise _MemcacheContentionError()

    if should_send_request:
      _send_save_request(self.name, self.__datasource_key)


  @ndb.tasklet
  def __handle_updates(self, payload):
    """Handles updates sent by a client.

    Args:
        payload: message received from the client.
    """
    if self.__access_mode != 'rw':
      logging.warning('Attempted to write to datasource in access mode %s.'%
          self.__access_mode)
      return
    state_token, base_version, transactions = payload['updates']
    cache = {
      # Such version number that any concurrent updates between base_version and
      # this version have been checked for consistency groups that they have
      # modified, with consistency group roots added to
      # locked_consistency_groups.
      'last_checked_version': base_version,
      # A set of paths (as tuples) corresponding to consistency groups that have
      # been modified by concurrent updates.
      'locked_consistency_groups': set()
    }
    outcomes = []
    should_save = False
    for updates in transactions:
      try:
        version = yield self.__apply_transaction(updates, cache, state_token)
        outcomes.append(version)
        should_save = True
      except _InMemoryStateTokenMismatch:
        return
      except _MidAirCollision:
        outcomes.append(None)
      except _MemcacheContentionError:
        outcomes.append(None)
        logging.warning(
            'Could not apply transaction because of high contention',
            exc_info=sys.exc_info())
      except (_MemcacheReadFailure, _MemcacheWriteFailure) as e:
        logging.warning('Memcache failure when applying transaction',
            exc_info=sys.exc_info())
        _flush(self.name, self.__datasource_key)
        return
    self.send({'outcomes': [state_token, base_version, outcomes]})
    if should_save:
      try:
        yield self.__initiate_saving()
      except (_MemcacheWriteFailure, _MemcacheContentionError) as e:
        logging.warning('Did not initiate saving.', exc_info=sys.exc_info())


  @ndb.tasklet
  def handle_message(self, payload):
    """Implements the abstract method of the superclass.
    """
    if 'init' in payload:
      yield self.__handle_init(payload)
    elif 'updates' in payload:
      yield self.__handle_updates(payload)
    elif 'disconnect' in payload:
      yield self.__disconnect()
    else:
      logging.warning('Datasource service %s received unrecognized message.'%
          self.name)


  @ndb.tasklet
  def handle_disconnected(self):
    """Implements the abstract method of the superclass.
    """
    yield self.__disconnect()


def _update_saving_status_after_saving(service, datasource_key):
  """Attempts to update saving status after data has been written to disk and
  initiates another datastore transaction if one is scheduled.

  Args:
      service: service name
      datasource_key: datasource key.
  """
  memcache_prefix = _config.NAMESPACE + str(hash(datasource_key)) + '_'
  saving_status_key = memcache_prefix + 'saving_status'
  memcache_client = memcache.Client()

  attempt, max_attempts = 0, 10
  while (attempt <= max_attempts):
    attempt += 1
    saving_status = memcache_client.gets(saving_status_key)
    if saving_status is None:
      logging.warning('Memcache read failure.')
      return

    saving_status['timestamp'] = _gettime()

    if saving_status['scheduled']:
      should_send_request = True
      saving_status['scheduled'] = False
    else:
      should_send_request = False
      saving_status['saving'] = False
    result_cas_saving_status = memcache_client.cas(saving_status_key,
        saving_status)
    if result_cas_saving_status is True: break
    elif result_cas_saving_status is False: pass
    else:
      logging.warning('Compare-and-set error \'#s\''%
          str(result_cas_saving_status))
      return
  else:
    logging.warning('Compare-and-set failed because of high contention.')
    return

  if should_send_request:
    _send_save_request(service, datasource_key)


class _SaveHandler(webapp2.RequestHandler):
  """Handler for requests that trigger saving in-memory data to disk.
  """
  def post(self):
    """Implements the abstract method of the superclass.
    """
    datasource_key_urlsafe = self.request.get('datasource_key',
        default_value=None)
    service = self.request.get('service', default_value=None)
    datasource_key = ndb.Key(urlsafe=datasource_key_urlsafe)
    memcache_prefix = _config.NAMESPACE + str(hash(datasource_key)) + '_'
    state_key = memcache_prefix + 'state'
    state = memcache.get(state_key)
    if state is None:
      logging.warning('Memcache read failure.')
      return

    def txn():
      last_version = state['version']
      version_key = ndb.Key(_Version, 1, parent=datasource_key)
      version_entity = version_key.get()
      if version_entity is None:
        version_entity = _Version(version=0, id=1, parent=datasource_key)
      try:
        updates = _get_updates(datasource_key, version_entity.version,
            last_version).get_result()
      except _MemcacheReadFailure:
        logging.warning('Memcache failure when saving data to disk.',
            exc_info=sys.exc_info())
        _flush(service, datasource_key)
        return
      if 'last_transaction' in state:
        for update in state['last_transaction']:
          updates.append(update)
          last_version = update['version']
      version_entity.version = last_version
      entities_put = [version_entity]
      keys_delete = []
      for update in updates:
        if len(update['path']) == 0: id = '/'
        else: id = '/'.join(update['path'])
        encoded_value = update['new_value']
        if json.loads(encoded_value) is not None:
          entities_put.append(_Value(id=id, parent=datasource_key,
              value=encoded_value))
        else:
          keys_delete.append(ndb.Key(_Value, id, parent=datasource_key))
      ndb.put_multi(entities_put)
      ndb.delete_multi(keys_delete)
      return last_version

    try:
      last_version = ndb.transaction(txn, retries=0)
    except ndb.google_imports.datastore_errors.TransactionFailedError:
      logging.warning('Datastore transaction failed.')
      return

    _update_saving_status_after_saving(service, datasource_key)
    from channel import send
    for client_id in state['clients']:
      send(service, client_id,
          {'saved': [state['token'], last_version]}).get_result()

    logging.info('Commited transaction.')


app = webapp2.WSGIApplication([
  (_config.BASE_URL_PATH + '.*', _SaveHandler),
], debug=True)
