# Client-server communication protocol: datasource #

## Messages sent from client to server ##

### Request to connect ###

Request to connect to the datasource, can be also used by connected clients to verify that their state of the data is up-to-date.

When the server receives such request, it connects the client to the datasource if the client is not already connected, and sends the response described in 'Response to request to connect'.

Format:

          {'init': [
            <the version of the data that the client already has (must be a
                version committed to disk), or null if the client does not have
                data>,
            <request token, a random string passed back in the response, used
                by the client to verify that response it received corresponds
                to the request it has sent>
          ]}


### Updates ###

Updates to be applied to the data.

Format:

        {'updates': [
          <in-memory state token>,
          <version over which changes were made>,
          [
            // Transaction 1
            [
              // Update 1
              [<'/'-joined path>, <new value>],
              // Update 2
              [...],
              ...
            ],
            // Transaction 2
            [...],
            ...
          ]
        ]}


### Request to disconnect ###

Request to disconnect this client from the datasource.

Format: `{'disconnect': null}`.


## Messages sent from server to client ##

### Response to request to connect ###

If the server was unable to connect the client, it responds with

        {'init_failure': <request token>}

If the server has successfully connected the client, the response is in the following format:

        {'init_success': [
          <request token>,
          <in-memory state token>,
          <version of the data on disk>,
          <data tree as stored on disk or null>,
          [
            // Update 1
            [<'/'-joined path>, <new value>, <version after the update>],
            // Update 2
            ...
          ]
        ]}

If the base version sent in the client request was `null`, the server will provide the current state of the data on disk and updates that bring the state up to the in-memory version. If the base version was not `null`, the server will provide updates between that version and the in-memory version.


### Response to client updates ###

After the client sends updates to the data, the server responds with information on which of the updates have been successfully applied in-memory.

Format:

        {'outcomes': [
          <in-memory state token>,
          <version in the update message sent by the client>,
          [<outcome for transaction 1>, <outcome for transaction 2>, ...]
        ]}

where the array of outcomes corresponds to the array of transactions sent by the client, and each outcome is either the version of the data after the transaction was applied, if it was applied successfully, or null otherwise.


### Server updates ###

Updates to the data not originating from this client.

Format:

        {'updates': [
          <in-memory state token>,
          [
            // Update 1
            [<'/'-joined path>, <new value>, <version after the update>],
            // Update 2
            ...
          ]
        ]}


### 'Saved' notification ###

Notification that all updates up to a given version have been saved to disk.

Format: `{'saved': [<in-memory state token>, <version>]}`.


### Flush notification ###

Notification that the in-memory state of the datasource has been flushed.

Format: `{'flush': <token for the in-memory state that was flushed>}`.
