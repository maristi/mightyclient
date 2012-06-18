# Client-server communication protocol: channel #

## Messages sent from client to server ##

These messages are sent through HTTP requests with the following properties:

- URL path: the value of `mc.GaeChannel.BASE_URL_PATH` on the client and `channel._config.BASE_URL_PATH` on the server.

- Method: POST.

- Query parameters:

    - `zx`: a random value to make URI unique.

- Post parameters:

    - `cid`: client ID.
    - `m`: messages, a JSON-encoded object where keys are service names and values are arrays of messages.

- Headers:

    - `Content-Type: application/x-www-form-urlencoded;char set=utf-8`


## Messages sent from server to client ##

Messages are sent JSON-encoded either though GAE Channel or, when possible, as response to a forward channel request sent by the client. The structure of JSON data is as follows:

        {
            '<Service name 1>': <Array of messages>,
            '<Service name 2>': <Array of messages>,
            ...
        }

Response to a forward channel request can be empty, a message sent over GAE Channel is expected to be non-empty.


## System service messages ##

When messages need to be sent over the channel for the channel's internal purposes, this is done though a dedicated system service. The name of the service is the value of `mc.GaeChannel.SYSTEM_SERVICE_` constant of the client and `channel._SYSTEM_SERVICE` constant on the server.


### Channel token requests ###

When the client needs to open a GAE channel, it requires a token string that is provided by server-side GAE API and should be passed to the client-side GAE API. The client requests this token by sending a message `{'getToken': null}` to the server over the system service.

The server should respond over the system service with message `{'token': '<token>'}`. When the server receives an HTTP request containing token request message, it should send successful response to this request only if this response will include the message with the token.


### Pickups ###

The server can send a message {'pickup': <pickup ID>} to the client over the system service, which instructs the client to send the same message {'pickup': <pickup ID>} over the system service to the server. This allows us to send data to the client in the response to a forward channel request in cases when the data is too large to be sent over GAE Channel.
