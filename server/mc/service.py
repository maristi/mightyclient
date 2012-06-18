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


"""Defines the base class for channel services.
"""

class Service(object):
  """Base class for channel services.
  """

  def __init__(self, name, client_id):
    self.__name = name
    self.__client_id = client_id


  @property
  def name(self):
    """Name of the service for which the class was instantiated.
    """
    return self.__name


  @property
  def client_id(self):
    """ID of the client for which the service has been instantiated.
    """
    return self.__client_id


  def handle_message(self, payload):
    """A function or tasklet that handles an incoming message.

    Args:
        payload: deserialized payload.

    Returns:
        None or a future that fires when the tasklet completes.
    """
    pass


  def handle_disconnected(self):
    """A function or tasklet that is called when a client is detected to be
    permanently disconnected (i.e. the App Engine channel is disconnected and
    the timeout allowed for reconnecting has run out). Connection status is only
    checked when sending a message to the client via App Engine channel. Each
    time a message is sent to a permanently disconnected client, the callback
    will be called for the service matching the name of the service over which
    the message was sent. Because memcache is used to keep track of connections
    and disconnections, eviction of data from memcache may result in the
    callback being called even when in reality the client is still connected.

    TRACK_PRESENCE should be set to True to enable this callback.

    Returns:
        None or a future that fires when the tasklet completes.
    """
    pass


  def send(self, payload, service=None, client_id=None):
    """Sends a message to a client.

    Args:
        payload: payload that can be serialized to JSON.
        service: name of the service, self.name by default.
        client_id: client ID to which the message should be sent, self.client_id
            by default.
    """
    import channel
    if service is None: service = self.name
    if client_id is None: client_id = self.client_id
    channel.send(service, client_id, payload).get_result()
